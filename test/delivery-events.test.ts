import { describe, expect, it } from "vitest";
import {
  categorize,
  deriveDeliveryStatus,
  handleDeliveryEvent,
  makeRfcMessageIdFromSes,
  parseSnsDeliveryEvent,
  type BounceLogWriter,
  type DeliveryEvent,
  type MessageStatusUpdater,
} from "../src/core/delivery-events.js";
import type {
  SuppressionUpsertInput,
  SuppressionWriter,
} from "../src/core/suppression.js";

// ADR-0018: SES delivery-event handling.
//
// These tests pin two contracts:
//   - the SNS-payload parser produces a DeliveryEvent shape decoupled from
//     SES wire JSON (so storage/projection code never sees raw SES schema)
//   - the orchestrator writes BounceLog FIRST, then projects status —
//     forensic invariant: the per-event row always lands even if the
//     Messages update fails.

const REGION = "eu-north-1";
const SES_MID = "0110019e4bb5e3d1-423e267c-5d38-4816-9b71-73be985d1a8b-000000";

function bouncePayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: "Bounce",
    mail: {
      messageId: SES_MID,
      timestamp: "2026-05-21T18:05:00.000Z",
      source: "test@nille.net",
    },
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [
        {
          emailAddress: "bounce@simulator.amazonses.com",
          diagnosticCode: "smtp; 550 5.1.1 user unknown",
        },
      ],
      timestamp: "2026-05-21T18:05:01.000Z",
      feedbackId: "feedback-bounce-1",
      ...over,
    },
  });
}

function complaintPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: "Complaint",
    mail: { messageId: SES_MID, source: "test@nille.net" },
    complaint: {
      complainedRecipients: [
        { emailAddress: "complaint@simulator.amazonses.com" },
      ],
      timestamp: "2026-05-21T18:10:00.000Z",
      feedbackId: "feedback-complaint-1",
      complaintFeedbackType: "abuse",
      ...over,
    },
  });
}

function delayPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType: "DeliveryDelay",
    mail: { messageId: SES_MID, source: "test@nille.net" },
    deliveryDelay: {
      delayType: "MailboxFull",
      delayedRecipients: [
        {
          emailAddress: "delayed@example.com",
          diagnosticCode: "smtp; 421 4.2.2 mailbox full",
        },
      ],
      timestamp: "2026-05-21T18:15:00.000Z",
      ...over,
    },
  });
}

describe("parseSnsDeliveryEvent", () => {
  it("parses a permanent bounce into the canonical DeliveryEvent shape", () => {
    const result = parseSnsDeliveryEvent(bouncePayload());
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);
    const e = result.event;
    expect(e.ses_message_id).toBe(SES_MID);
    expect(e.event_id).toBe("feedback-bounce-1");
    expect(e.event_at).toBe("2026-05-21T18:05:01.000Z");
    expect(e.category).toBe("bounce_permanent");
    expect(e.sub_category).toBe("General");
    expect(e.recipients).toEqual(["bounce@simulator.amazonses.com"]);
    expect(e.diagnostic).toBe("smtp; 550 5.1.1 user unknown");
    // Raw must round-trip the parsed JSON so forensic queries can recover
    // any field SES added that we didn't promote to the canonical shape.
    expect(e.raw["eventType"]).toBe("Bounce");
  });

  it("categorizes transient bounces as bounce_transient", () => {
    const result = parseSnsDeliveryEvent(
      bouncePayload({ bounceType: "Transient" }),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.event.category).toBe("bounce_transient");
  });

  it("collapses Undetermined bounces to bounce_unknown", () => {
    const result = parseSnsDeliveryEvent(
      bouncePayload({ bounceType: "Undetermined" }),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.event.category).toBe("bounce_unknown");
  });

  it("parses a complaint event", () => {
    const result = parseSnsDeliveryEvent(complaintPayload());
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);
    const e = result.event;
    expect(e.category).toBe("complaint");
    expect(e.event_id).toBe("feedback-complaint-1");
    expect(e.recipients).toEqual(["complaint@simulator.amazonses.com"]);
    expect(e.sub_category).toBe("abuse");
  });

  it("parses a delivery-delay event and synthesizes a stable event_id", () => {
    // SES delivery-delay events don't ship feedbackId. The parser synthesizes
    // `delay-{timestamp}` so distinct delay events get distinct SKs but a
    // duplicate SNS delivery of the same delay event collapses on PutItem.
    const result = parseSnsDeliveryEvent(delayPayload());
    if (!result.ok) throw new Error(`expected ok: ${result.error}`);
    expect(result.event.category).toBe("delivery_delay");
    expect(result.event.event_id).toBe("delay-2026-05-21T18:15:00.000Z");
    expect(result.event.sub_category).toBe("MailboxFull");
  });

  it("accepts the legacy `notificationType` field as well as `eventType`", () => {
    // Operators who still have legacy SES SNS notifications wired (vs the
    // configuration-set destination) emit `notificationType` instead. The
    // parser should accept both so a migration window doesn't drop events.
    const legacy = JSON.stringify({
      notificationType: "Bounce",
      mail: { messageId: SES_MID },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "x@example.com" }],
        timestamp: "2026-05-21T18:05:00.000Z",
        feedbackId: "fb-1",
      },
    });
    const result = parseSnsDeliveryEvent(legacy);
    if (!result.ok) throw new Error("expected ok");
    expect(result.event.category).toBe("bounce_permanent");
  });

  it("returns an error result for invalid JSON instead of throwing", () => {
    const result = parseSnsDeliveryEvent("not-json");
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/invalid JSON/);
  });

  it("returns an error result for unsupported event types", () => {
    const json = JSON.stringify({
      eventType: "Send",
      mail: { messageId: SES_MID },
    });
    const result = parseSnsDeliveryEvent(json);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/unsupported eventType: Send/);
  });

  it("returns an error result when mail.messageId is missing", () => {
    const json = JSON.stringify({ eventType: "Bounce", mail: {} });
    const result = parseSnsDeliveryEvent(json);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/missing mail.messageId/);
  });
});

describe("categorize / deriveDeliveryStatus", () => {
  it("maps each category to a single delivery_status", () => {
    expect(deriveDeliveryStatus("bounce_permanent")).toBe("bounced_permanent");
    expect(deriveDeliveryStatus("bounce_transient")).toBe("bounced_transient");
    expect(deriveDeliveryStatus("bounce_unknown")).toBe("bounced_unknown");
    expect(deriveDeliveryStatus("complaint")).toBe("complained");
    expect(deriveDeliveryStatus("delivery_delay")).toBe("delayed");
  });

  it("returns null for SES event types we don't subscribe to", () => {
    expect(categorize({ eventType: "Send" })).toBeNull();
    expect(categorize({ eventType: "Delivery" })).toBeNull();
  });
});

describe("makeRfcMessageIdFromSes", () => {
  it("matches the wire format ADR-0017 pinned for outbound rows", () => {
    expect(
      makeRfcMessageIdFromSes({ sesMessageId: SES_MID, region: REGION }),
    ).toBe(`<${SES_MID}@eu-north-1.amazonses.com>`);
  });
});

describe("handleDeliveryEvent", () => {
  function makeStubDeps(): {
    deps: { bounceLog: BounceLogWriter; messageStatus: MessageStatusUpdater; awsRegion: string };
    writes: DeliveryEvent[];
    statusUpdates: Array<{
      ses_message_id: string;
      rfc_message_id: string;
      status: string;
      event_at: string;
    }>;
    setRowFound: (found: boolean) => void;
  } {
    const writes: DeliveryEvent[] = [];
    const statusUpdates: Array<{
      ses_message_id: string;
      rfc_message_id: string;
      status: string;
      event_at: string;
    }> = [];
    let rowFound = true;
    return {
      writes,
      statusUpdates,
      setRowFound: (found) => {
        rowFound = found;
      },
      deps: {
        awsRegion: REGION,
        bounceLog: {
          async writeEvent(event) {
            writes.push(event);
          },
        },
        messageStatus: {
          async applyDeliveryStatus(input) {
            statusUpdates.push(input);
            return { updated: rowFound };
          },
        },
      },
    };
  }

  it("writes BounceLog first, then projects delivery_status onto Messages", async () => {
    const result = parseSnsDeliveryEvent(bouncePayload());
    if (!result.ok) throw new Error("expected ok");

    const order: string[] = [];
    const writes: DeliveryEvent[] = [];
    const statusUpdates: Array<Record<string, string>> = [];
    const deps = {
      awsRegion: REGION,
      bounceLog: {
        async writeEvent(event: DeliveryEvent) {
          order.push("bounceLog");
          writes.push(event);
        },
      },
      messageStatus: {
        async applyDeliveryStatus(input: {
          ses_message_id: string;
          rfc_message_id: string;
          status: string;
          event_at: string;
        }) {
          order.push("messageStatus");
          statusUpdates.push(input);
          return { updated: true };
        },
      },
    };

    const out = await handleDeliveryEvent(result.event, deps);

    // BounceLog must precede the Messages update (forensic invariant).
    expect(order).toEqual(["bounceLog", "messageStatus"]);
    expect(writes).toHaveLength(1);
    expect(out).toEqual({ status: "bounced_permanent", messageRowUpdated: true });
    expect(statusUpdates[0]).toMatchObject({
      ses_message_id: SES_MID,
      rfc_message_id: `<${SES_MID}@eu-north-1.amazonses.com>`,
      status: "bounced_permanent",
      event_at: "2026-05-21T18:05:01.000Z",
    });
  });

  it("returns messageRowUpdated=false when the Messages row can't be located", async () => {
    // The Messages row may be missing if persist-outbound failed silently
    // or hasn't completed yet. We still write BounceLog (forensic) but
    // surface the no-update flag so callers can log a warning.
    const result = parseSnsDeliveryEvent(complaintPayload());
    if (!result.ok) throw new Error("expected ok");

    const ctx = makeStubDeps();
    ctx.setRowFound(false);

    const out = await handleDeliveryEvent(result.event, ctx.deps);
    expect(out.messageRowUpdated).toBe(false);
    expect(out.status).toBe("complained");
    // Forensic write still happened.
    expect(ctx.writes).toHaveLength(1);
  });

  it("upserts suppressions for a permanent bounce — one upsert per recipient", async () => {
    // ADR-0019: only bounce_permanent + complaint suppress.
    const result = parseSnsDeliveryEvent(
      bouncePayload({
        bouncedRecipients: [
          { emailAddress: "Alice@Example.com" },
          { emailAddress: "bob@example.com" },
        ],
      }),
    );
    if (!result.ok) throw new Error("expected ok");

    const upserts: SuppressionUpsertInput[] = [];
    const suppression: SuppressionWriter = {
      async upsert(input) {
        upserts.push(input);
        return true;
      },
    };
    const deps = {
      awsRegion: REGION,
      bounceLog: { async writeEvent() {} },
      messageStatus: {
        async applyDeliveryStatus() {
          return { updated: true };
        },
      },
      suppression,
    };

    await handleDeliveryEvent(result.event, deps);

    expect(upserts).toHaveLength(2);
    expect(upserts.map((u) => u.recipient).sort()).toEqual([
      "Alice@Example.com",
      "bob@example.com",
    ]);
    for (const u of upserts) {
      expect(u.reason).toBe("bounced_permanent");
      expect(u.ses_message_id).toBe(SES_MID);
      expect(u.event_id).toBe("feedback-bounce-1");
      expect(u.event_at).toBe("2026-05-21T18:05:01.000Z");
    }
  });

  it("upserts suppressions for a complaint", async () => {
    const result = parseSnsDeliveryEvent(complaintPayload());
    if (!result.ok) throw new Error("expected ok");

    const upserts: SuppressionUpsertInput[] = [];
    const deps = {
      awsRegion: REGION,
      bounceLog: { async writeEvent() {} },
      messageStatus: {
        async applyDeliveryStatus() {
          return { updated: true };
        },
      },
      suppression: {
        async upsert(input: SuppressionUpsertInput) {
          upserts.push(input);
          return true;
        },
      },
    };

    await handleDeliveryEvent(result.event, deps);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.reason).toBe("complained");
    expect(upserts[0]!.recipient).toBe("complaint@simulator.amazonses.com");
  });

  it("does NOT upsert for transient bounces, unknown bounces, or delays", async () => {
    const upserts: SuppressionUpsertInput[] = [];
    const suppression: SuppressionWriter = {
      async upsert(input) {
        upserts.push(input);
        return true;
      },
    };
    const baseDeps = {
      awsRegion: REGION,
      bounceLog: { async writeEvent() {} },
      messageStatus: {
        async applyDeliveryStatus() {
          return { updated: true };
        },
      },
      suppression,
    };

    for (const payload of [
      bouncePayload({ bounceType: "Transient" }),
      bouncePayload({ bounceType: "Undetermined" }),
      delayPayload(),
    ]) {
      const r = parseSnsDeliveryEvent(payload);
      if (!r.ok) throw new Error("expected ok");
      await handleDeliveryEvent(r.event, baseDeps);
    }
    expect(upserts).toHaveLength(0);
  });

  it("does not require the suppression writer (back-compat)", async () => {
    // Deployments that haven't shipped slice 5 (no Suppressions table) keep
    // working because the dep is optional.
    const result = parseSnsDeliveryEvent(bouncePayload());
    if (!result.ok) throw new Error("expected ok");

    const ctx = makeStubDeps();
    await expect(handleDeliveryEvent(result.event, ctx.deps)).resolves.toMatchObject(
      { status: "bounced_permanent" },
    );
    expect(ctx.writes).toHaveLength(1);
  });

  it("logs but does not throw when the suppression upsert fails (forensic invariant)", async () => {
    // BounceLog + Messages already succeeded; a suppression-write failure
    // shouldn't roll those back. Replay handles drift later.
    const result = parseSnsDeliveryEvent(bouncePayload());
    if (!result.ok) throw new Error("expected ok");

    const warnings: string[] = [];
    const deps = {
      awsRegion: REGION,
      bounceLog: { async writeEvent() {} },
      messageStatus: {
        async applyDeliveryStatus() {
          return { updated: true };
        },
      },
      suppression: {
        async upsert(): Promise<boolean> {
          throw new Error("DDB throttle");
        },
      },
      warn: (m: string) => warnings.push(m),
    };

    await expect(handleDeliveryEvent(result.event, deps)).resolves.toMatchObject({
      status: "bounced_permanent",
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/suppression upsert failed/);
  });

  it("does NOT write to BounceLog if the Messages-row update would fail (no — order matters: BounceLog wins)", async () => {
    // Reverse case: Messages update raises. BounceLog already wrote, so the
    // raise propagates but the forensic record is durable. SES will retry
    // SNS delivery — the next attempt re-writes BounceLog (idempotent on
    // event_id) and re-tries the Messages update.
    const result = parseSnsDeliveryEvent(bouncePayload());
    if (!result.ok) throw new Error("expected ok");

    const writes: DeliveryEvent[] = [];
    const deps = {
      awsRegion: REGION,
      bounceLog: {
        async writeEvent(event: DeliveryEvent) {
          writes.push(event);
        },
      },
      messageStatus: {
        async applyDeliveryStatus() {
          throw new Error("DDB throttle");
        },
      },
    };

    await expect(handleDeliveryEvent(result.event, deps)).rejects.toThrow(
      /DDB throttle/,
    );
    // Forensic invariant: BounceLog row landed even though the projection
    // failed. SNS retries the same event; PutItem on the same SK overwrites.
    expect(writes).toHaveLength(1);
  });
});
