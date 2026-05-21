import { describe, expect, it, vi } from "vitest";
import { ingestRawMail } from "../src/core/ingest.js";
import type { MailIngestedEvent } from "../src/core/event.js";
import type { MessageStore, SkeletonRow, StoredMessage } from "../src/core/store.js";

const enc = new TextEncoder();

// Smallest well-formed RFC 5322 message that exercises the structured headers
// the event payload cares about. Each test reuses this and overrides only what
// it needs by re-encoding a tweaked variant.
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

const baseInput = {
  raw: SAMPLE_RAW,
  internalId: "01HF7E0000000000000000DYNAMO",
  address: "alice@acme.com",
  receivedAt: "2026-05-19T14:23:10.901Z",
  rawS3Uri:
    "s3://opensesame-raw-mime-123456789012/2026/05/19/<msg-1@example.com>.eml",
  verdicts: {
    spam: "PASS",
    virus: "PASS",
    dkim: "PASS",
    spf: "PASS",
    dmarc: "PASS",
  },
  deploymentId: "deploy-acme-prod",
} as const;

function makeStore(overrides: Partial<MessageStore> = {}): MessageStore {
  return {
    writeMessage: overrides.writeMessage ?? vi.fn(async () => {}),
    writeSkeleton: overrides.writeSkeleton ?? vi.fn(async () => {}),
  };
}

function makeDeps(overrides: Partial<{
  now: () => Date;
  newEventId: () => string;
  publish: (e: MailIngestedEvent) => Promise<void>;
  store: MessageStore;
}> = {}) {
  return {
    // Default to the same fixed instant the existing event tests use, so any
    // future cross-test invariants stay consistent.
    now: overrides.now ?? (() => new Date("2026-05-19T14:23:11.482Z")),
    newEventId: overrides.newEventId ?? (() => "01HF7E0000000000000000EVENTX"),
    publish: overrides.publish ?? vi.fn(async () => {}),
    store: overrides.store ?? makeStore(),
  };
}

describe("ingestRawMail", () => {
  it("parses, builds, and publishes a MailIngested event for a happy-path message", async () => {
    const deps = makeDeps();
    const event = await ingestRawMail(baseInput, deps);

    // Composer returns the same event it published — round-trip identity is
    // important for callers that want to log/assert without re-deriving it.
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.publish).toHaveBeenCalledWith(event);

    expect(event.schema_version).toBe("1");
    expect(event.event_type).toBe("MailIngested");
    expect(event.data.message_id).toBe("<msg-1@example.com>");
    expect(event.data.address).toBe("alice@acme.com");
    expect(event.data.from).toEqual({
      address: "sender@example.com",
      name: "Sender Name",
    });
    expect(event.data.raw_s3_uri).toBe(baseInput.rawS3Uri);
  });

  it("sources event_id from deps.newEventId and occurred_at from deps.now()", async () => {
    const deps = makeDeps({
      newEventId: () => "01HF7EZZZZZZZZZZZZZZZZZZZZ",
      now: () => new Date("2099-12-31T23:59:59.999Z"),
    });
    const event = await ingestRawMail(baseInput, deps);

    expect(event.event_id).toBe("01HF7EZZZZZZZZZZZZZZZZZZZZ");
    // ADR-0010 specifies ISO-8601 with millisecond precision in UTC. The
    // composer must call toISOString() rather than passing a Date through.
    expect(event.occurred_at).toBe("2099-12-31T23:59:59.999Z");
  });

  it("forwards deployment_id, internal_id, address, received_at, and verdicts verbatim", async () => {
    const deps = makeDeps();
    const event = await ingestRawMail(
      {
        ...baseInput,
        verdicts: {
          spam: "FAIL",
          virus: "PASS",
          dkim: "GRAY",
          spf: "PASS",
          dmarc: "FAIL",
        },
      },
      deps,
    );

    expect(event.deployment_id).toBe("deploy-acme-prod");
    expect(event.data.internal_id).toBe("01HF7E0000000000000000DYNAMO");
    expect(event.data.received_at).toBe("2026-05-19T14:23:10.901Z");
    expect(event.data.spam_verdict).toBe("FAIL");
    expect(event.data.dkim_verdict).toBe("GRAY");
    expect(event.data.dmarc_verdict).toBe("FAIL");
  });

  it("derives size_bytes from the raw byte length, not from decoded body text", async () => {
    // The whole point of having SES SNS hand us the raw bytes is that on-the-
    // wire size is recoverable. parsed.bodyText is post-decoding and would
    // understate or overstate the truth — the composer must use raw.byteLength.
    const deps = makeDeps();
    const event = await ingestRawMail(baseInput, deps);

    expect(event.data.size_bytes).toBe(SAMPLE_RAW.byteLength);
  });

  it("writes the message to the store before publishing on the happy path", async () => {
    // ADR-0012's durability contract: the event must not fire until the
    // DynamoDB row is durable. Tests order via mock.invocationCallOrder so a
    // future refactor can't accidentally swap them.
    const writeMessage = vi.fn(async () => {});
    const publish = vi.fn(async () => {});
    const deps = makeDeps({
      store: makeStore({ writeMessage }),
      publish,
    });

    await ingestRawMail(baseInput, deps);

    expect(writeMessage).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    const writeOrder = writeMessage.mock.invocationCallOrder[0]!;
    const publishOrder = publish.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(publishOrder);
  });

  it("writes a skeleton row and emits parse_status:failed when MIME parsing fails", async () => {
    // ADR-0012: "every reader handles the partially-parsed state, in exchange
    // for never silently losing a message from the user's point of view."
    // The composer must not throw on poison MIME — it stores a skeleton row
    // and still fires MailIngested so downstream consumers can choose to
    // ignore or surface them.
    // Typed mocks so tsc can see the call args; default vi.fn(async () => {})
    // widens to () => Promise<void> and erases the row type.
    const writeMessage = vi.fn<(row: StoredMessage) => Promise<void>>(
      async () => {},
    );
    const writeSkeleton = vi.fn<(row: SkeletonRow) => Promise<void>>(
      async () => {},
    );
    const publish = vi.fn(async () => {});
    const deps = makeDeps({
      store: makeStore({ writeMessage, writeSkeleton }),
      publish,
    });

    const poison = enc.encode(
      [
        "From: bad@example.com",
        "To: alice@acme.com",
        "Subject: oops",
        "Content-Type: multipart/mixed",
        "",
        "irrelevant",
        "",
      ].join("\r\n"),
    );

    const event = await ingestRawMail({ ...baseInput, raw: poison }, deps);

    expect(writeSkeleton).toHaveBeenCalledTimes(1);
    expect(writeMessage).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(event);

    // Skeleton row carries everything ADR-0012 specifies: parse_status,
    // parse_error reason, the raw S3 pointer, and the recipient address.
    const row = writeSkeleton.mock.calls[0]![0];
    expect(row.parse_status).toBe("failed");
    expect(row.parse_error).toMatch(/multipart.*boundary/i);
    expect(row.raw_s3_uri).toBe(baseInput.rawS3Uri);
    expect(row.address).toBe(baseInput.address);
    expect(row.internal_id).toBe(baseInput.internalId);
    expect(row.received_at).toBe(baseInput.receivedAt);
    expect(row.schema_v).toBe("1");

    // Event still fires — downstream consumers can filter on parse_status.
    expect(event.data.parse_status).toBe("failed");
    expect(event.data.parse_error).toMatch(/multipart.*boundary/i);
    expect(event.data.address).toBe(baseInput.address);
    expect(event.data.raw_s3_uri).toBe(baseInput.rawS3Uri);
    expect(event.data.size_bytes).toBe(poison.byteLength);
  });

  it("does not publish if the skeleton-row write fails", async () => {
    // Inverse of the happy-path ordering invariant: if DDB is unavailable for
    // the skeleton write, the event must not fire either — SQS retry replays
    // the whole flow.
    const writeSkeleton = vi.fn(async () => {
      throw new Error("dynamo throttled");
    });
    const publish = vi.fn(async () => {});
    const deps = makeDeps({
      store: makeStore({ writeSkeleton }),
      publish,
    });

    const poison = enc.encode(
      [
        "From: bad@example.com",
        "To: alice@acme.com",
        "Content-Type: multipart/mixed",
        "",
        "x",
      ].join("\r\n"),
    );

    await expect(
      ingestRawMail({ ...baseInput, raw: poison }, deps),
    ).rejects.toThrow(/dynamo throttled/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("propagates publish errors so the caller (Lambda) can drive SQS retry", async () => {
    // Under the ADR-0012 topology, retry is owned by SQS, not by the composer.
    // The composer must surface publish failures so the Lambda can fail and
    // let visibility timeout do its job.
    const boom = new Error("eventbridge unavailable");
    const deps = makeDeps({
      publish: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(ingestRawMail(baseInput, deps)).rejects.toBe(boom);
  });

  it("calls newEventId and now exactly once each (no retry inside the composer)", async () => {
    const newEventId = vi.fn(() => "01HF7E0000000000000000EVENTX");
    const now = vi.fn(() => new Date("2026-05-19T14:23:11.482Z"));
    const deps = makeDeps({ newEventId, now });

    await ingestRawMail(baseInput, deps);

    expect(newEventId).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
  });
});
