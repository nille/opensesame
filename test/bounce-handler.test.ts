import { describe, expect, it } from "vitest";
import {
  makeBounceHandler,
  type BounceHandlerLogger,
  type SnsEvent,
} from "../src/lambda/bounce-handler.js";
import type {
  BounceLogWriter,
  DeliveryEvent,
  MessageStatusUpdater,
} from "../src/core/delivery-events.js";

// Lambda-shim tests for the bounce handler (ADR-0018). The orchestrator
// itself is covered in delivery-events.test.ts; these tests pin the SNS
// envelope handling: per-record loop, malformed payload skip, logger calls.

const REGION = "eu-north-1";
const SES_MID = "ses-msg-1";

function bouncePayload(): string {
  return JSON.stringify({
    eventType: "Bounce",
    mail: { messageId: SES_MID, source: "test@nille.net" },
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [
        {
          emailAddress: "bounce@simulator.amazonses.com",
          diagnosticCode: "smtp; 550 user unknown",
        },
      ],
      timestamp: "2026-05-21T18:05:01.000Z",
      feedbackId: "feedback-bounce-1",
    },
  });
}

function snsEvent(messages: string[]): SnsEvent {
  return {
    Records: messages.map((m, i) => ({
      Sns: { Message: m, MessageId: `sns-${i}` },
    })),
  };
}

type Captured = {
  writes: DeliveryEvent[];
  updates: Array<{
    ses_message_id: string;
    rfc_message_id: string;
    status: string;
    event_at: string;
  }>;
  logs: { warn: unknown[][]; info: unknown[][] };
};

function makeStubDeps(): {
  deps: {
    awsRegion: string;
    bounceLog: BounceLogWriter;
    messageStatus: MessageStatusUpdater;
    logger: BounceHandlerLogger;
  };
  captured: Captured;
} {
  const captured: Captured = {
    writes: [],
    updates: [],
    logs: { warn: [], info: [] },
  };
  return {
    captured,
    deps: {
      awsRegion: REGION,
      bounceLog: {
        async writeEvent(event) {
          captured.writes.push(event);
        },
      },
      messageStatus: {
        async applyDeliveryStatus(input) {
          captured.updates.push(input);
          return { updated: true };
        },
      },
      logger: {
        warn: (m, f) => captured.logs.warn.push([m, f ?? {}]),
        info: (m, f) => captured.logs.info.push([m, f ?? {}]),
      },
    },
  };
}

describe("makeBounceHandler", () => {
  it("processes one SNS record end-to-end (parse → BounceLog → Messages)", async () => {
    const ctx = makeStubDeps();
    const handler = makeBounceHandler(ctx.deps);

    await handler(snsEvent([bouncePayload()]));

    expect(ctx.captured.writes).toHaveLength(1);
    expect(ctx.captured.writes[0]!.category).toBe("bounce_permanent");
    expect(ctx.captured.updates).toHaveLength(1);
    expect(ctx.captured.updates[0]!.status).toBe("bounced_permanent");
    // info log records the outcome; warn log untouched.
    expect(ctx.captured.logs.info).toHaveLength(1);
    expect(ctx.captured.logs.warn).toHaveLength(0);
  });

  it("processes every record in a multi-record SNS event", async () => {
    // SNS-to-Lambda is normally one record per invocation, but the handler
    // is defensive — a future batched topology shouldn't drop events.
    const ctx = makeStubDeps();
    const handler = makeBounceHandler(ctx.deps);

    await handler(snsEvent([bouncePayload(), bouncePayload()]));

    expect(ctx.captured.writes).toHaveLength(2);
    expect(ctx.captured.updates).toHaveLength(2);
  });

  it("skips records whose SES payload fails to parse, logs warn, continues", async () => {
    // SES occasionally publishes types we don't subscribe to (e.g.
    // AmazonSesPublish health checks). The handler must skip them
    // without throwing — throwing would push the SNS notification onto
    // the DLQ for what's actually expected behavior.
    const ctx = makeStubDeps();
    const handler = makeBounceHandler(ctx.deps);

    await handler(snsEvent(["not-json", bouncePayload()]));

    // Bad record skipped, good record processed.
    expect(ctx.captured.writes).toHaveLength(1);
    expect(ctx.captured.logs.warn).toHaveLength(1);
    const warn = ctx.captured.logs.warn[0]!;
    expect(warn[0]).toMatch(/unparseable SES event/);
  });

  it("warns when an SNS record is missing the Message field", async () => {
    const ctx = makeStubDeps();
    const handler = makeBounceHandler(ctx.deps);

    const malformed: SnsEvent = {
      Records: [{ Sns: { Message: undefined as unknown as string } }],
    };
    await handler(malformed);

    expect(ctx.captured.writes).toHaveLength(0);
    expect(ctx.captured.logs.warn).toHaveLength(1);
    expect(ctx.captured.logs.warn[0]![0]).toMatch(/missing Sns.Message/);
  });

  it("warns and exits when Records is empty (defensive)", async () => {
    const ctx = makeStubDeps();
    const handler = makeBounceHandler(ctx.deps);

    await handler({ Records: [] });

    expect(ctx.captured.writes).toHaveLength(0);
    expect(ctx.captured.logs.warn[0]![0]).toMatch(/no records/);
  });

  it("propagates errors from handleDeliveryEvent so SNS retries", async () => {
    // If the BounceLog write or Messages projection raises, the handler
    // must propagate — SNS retries the same record, and the per-event
    // PutItem on BounceLog is idempotent on (ses_message_id, event_id).
    const ctx = makeStubDeps();
    ctx.deps.messageStatus = {
      async applyDeliveryStatus() {
        throw new Error("DDB throttle");
      },
    };
    const handler = makeBounceHandler(ctx.deps);

    await expect(handler(snsEvent([bouncePayload()]))).rejects.toThrow(
      /DDB throttle/,
    );
  });
});
