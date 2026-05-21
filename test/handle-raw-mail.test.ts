import { describe, expect, it, vi } from "vitest";
import { handleRawMail } from "../src/core/handle-raw-mail.js";
import type { MailIngestedEvent } from "../src/core/event.js";
import type { MessageStore, SkeletonRow, StoredMessage } from "../src/core/store.js";

const enc = new TextEncoder();

const SAMPLE_RAW = enc.encode(
  [
    "From: Sender Name <sender@example.com>",
    "To: alice@acme.com",
    "Subject: Re: Q2 invoice",
    "Message-ID: <msg-1@example.com>",
    "Date: Tue, 19 May 2026 14:23:10 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hi",
    "",
  ].join("\r\n"),
);

function makeStore(): MessageStore & {
  writeMessage: ReturnType<typeof vi.fn>;
  writeSkeleton: ReturnType<typeof vi.fn>;
} {
  return {
    writeMessage: vi.fn(async () => {}),
    writeSkeleton: vi.fn(async () => {}),
  } as MessageStore & {
    writeMessage: ReturnType<typeof vi.fn>;
    writeSkeleton: ReturnType<typeof vi.fn>;
  };
}

const baseEnvelope = {
  raw: SAMPLE_RAW,
  s3Key: "2026/05/19/<msg-1@example.com>.eml",
  s3Bucket: "opensesame-raw-mime-123456789012",
  address: "alice@acme.com",
  receivedAt: "2026-05-19T14:23:10.901Z",
  verdicts: {
    spam: "PASS",
    virus: "PASS",
    dkim: "PASS",
    spf: "PASS",
    dmarc: "PASS",
  },
} as const;

const baseConfig = {
  deploymentId: "deploy-acme-prod",
} as const;

describe("handleRawMail", () => {
  it("orchestrates parse → DDB write → EventBridge publish for the happy path", async () => {
    const store = makeStore();
    const publish = vi.fn(async () => {});
    const event = await handleRawMail(baseEnvelope, {
      ...baseConfig,
      store,
      publish,
      now: () => new Date("2026-05-19T14:23:11.482Z"),
    });

    expect(store.writeMessage).toHaveBeenCalledTimes(1);
    expect(store.writeSkeleton).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);

    expect(event.event_type).toBe("MailIngested");
    expect(event.data.address).toBe("alice@acme.com");
    expect(event.data.message_id).toBe("<msg-1@example.com>");
    expect(event.data.raw_s3_uri).toBe(
      `s3://${baseEnvelope.s3Bucket}/${baseEnvelope.s3Key}`,
    );
    expect(event.data.parse_status).toBeUndefined();

    // internal_id is derived deterministically from s3Key+receivedAt and is a
    // 26-char ULID-shaped string. Pinned here so the contract surfaces if the
    // scheme ever changes.
    expect(event.data.internal_id).toHaveLength(26);
    const writeArg = store.writeMessage.mock.calls[0]![0] as StoredMessage;
    expect(writeArg.internal_id).toBe(event.data.internal_id);
  });

  it("produces the same internal_id for the same (s3Key, receivedAt) — SQS retry idempotency", async () => {
    // ADR-0012: re-running the ingest Lambda on the same input rewrites the
    // same items. Pinning the linkage here ensures the orchestrator wires
    // makeInternalId correctly into the composer.
    const env = baseEnvelope;
    const e1 = await handleRawMail(env, {
      ...baseConfig,
      store: makeStore(),
      publish: vi.fn(async () => {}),
      now: () => new Date("2026-05-19T14:23:11.482Z"),
    });
    const e2 = await handleRawMail(env, {
      ...baseConfig,
      store: makeStore(),
      publish: vi.fn(async () => {}),
      now: () => new Date("2099-12-31T23:59:59.999Z"),
    });
    expect(e1.data.internal_id).toBe(e2.data.internal_id);
  });

  it("falls through to skeleton-row branch on MimeParseError", async () => {
    const store = makeStore();
    const publish = vi.fn(async () => {});
    const poison = enc.encode(
      [
        "From: bad@example.com",
        "To: alice@acme.com",
        "Content-Type: multipart/mixed",
        "",
        "x",
      ].join("\r\n"),
    );

    const event = await handleRawMail(
      { ...baseEnvelope, raw: poison },
      {
        ...baseConfig,
        store,
        publish,
        now: () => new Date("2026-05-19T14:23:11.482Z"),
      },
    );

    expect(store.writeSkeleton).toHaveBeenCalledTimes(1);
    expect(store.writeMessage).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(event.data.parse_status).toBe("failed");
    expect(event.data.parse_error).toMatch(/multipart.*boundary/i);

    // Skeleton row also gets the deterministic internal_id.
    const skeleton = store.writeSkeleton.mock.calls[0]![0] as SkeletonRow;
    expect(skeleton.internal_id).toBe(event.data.internal_id);
  });

  it("uses the injected ULID factory for event_id (separate from internal_id)", async () => {
    // event_id and internal_id are intentionally distinct identifiers per
    // ADR-0010: event_id changes per emission (e.g. retry); internal_id does
    // not. The orchestrator must pass the factory through, not collapse them.
    const store = makeStore();
    const publish = vi.fn<(e: MailIngestedEvent) => Promise<void>>(
      async () => {},
    );
    const newEventId = vi.fn(() => "01HF7EZZZZZZZZZZZZZZZZZZZZ");

    const event = await handleRawMail(baseEnvelope, {
      ...baseConfig,
      store,
      publish,
      now: () => new Date("2026-05-19T14:23:11.482Z"),
      newEventId,
    });

    expect(newEventId).toHaveBeenCalledTimes(1);
    expect(event.event_id).toBe("01HF7EZZZZZZZZZZZZZZZZZZZZ");
    expect(event.event_id).not.toBe(event.data.internal_id);
  });

  it("propagates store errors so SQS visibility timeout drives retry", async () => {
    const store = makeStore();
    store.writeMessage.mockRejectedValueOnce(new Error("dynamo throttled"));
    const publish = vi.fn(async () => {});

    await expect(
      handleRawMail(baseEnvelope, {
        ...baseConfig,
        store,
        publish,
        now: () => new Date("2026-05-19T14:23:11.482Z"),
      }),
    ).rejects.toThrow(/dynamo throttled/);
    expect(publish).not.toHaveBeenCalled();
  });
});
