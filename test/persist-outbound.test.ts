import { describe, expect, it } from "vitest";
import {
  persistOutbound,
  makeSesRewrittenMessageId,
} from "../src/core/persist-outbound.js";
import { composeRawMime } from "../src/core/composer.js";
import type { RawMessageWriter } from "../src/core/raw-store.js";
import type { MessageStore, StoredMessage } from "../src/core/store.js";

// Slice 3 (ADR-0017) persists a copy of the outbound message after SES has
// accepted. The orchestrator owns three invariants pinned by these tests:
//   - raw bytes go to S3 under `outbound/{sesMessageId}` first
//   - the Messages row uses `direction: "out"` and `address = fromAddress`
//   - the row's `message_id` is the SES-rewritten RFC form (so an inbound
//     reply quoting it round-trips through GSI1)

const FIXED_NOW = new Date("2026-05-21T17:00:00.000Z");
const FIXED_RANDOM = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const REGION = "eu-north-1";
const BUCKET = "opensesame-raw-mime-925039213717";

type S3Call = {
  bucket: string;
  key: string;
  raw: Uint8Array;
};

function makeStubRawWriter(): {
  writer: RawMessageWriter;
  calls: S3Call[];
  failNext?: () => void;
} {
  const calls: S3Call[] = [];
  let shouldFail = false;
  const writer: RawMessageWriter = {
    async putRaw(input) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("S3 unavailable");
      }
      calls.push({ bucket: input.bucket, key: input.key, raw: input.raw });
    },
  };
  return {
    writer,
    calls,
    failNext: () => {
      shouldFail = true;
    },
  };
}

function makeStubStore(opts: { failWrite?: boolean } = {}): {
  store: MessageStore;
  written: StoredMessage[];
} {
  const written: StoredMessage[] = [];
  const store: MessageStore = {
    async writeMessage(row) {
      if (opts.failWrite) throw new Error("DDB write failed");
      written.push(row);
    },
    async writeSkeleton() {
      throw new Error("persist-outbound must never write skeleton rows");
    },
  };
  return { store, written };
}

function compose() {
  return composeRawMime(
    {
      from: "test@nille.net",
      to: ["alice@example.com"],
      subject: "Hello",
      bodyText: "Hi there.",
    },
    { now: () => FIXED_NOW, randomBytes: () => FIXED_RANDOM },
  );
}

describe("persistOutbound", () => {
  it("writes raw bytes to S3 under outbound/{sesMessageId} before the DDB row", async () => {
    const composed = compose();
    const raw = makeStubRawWriter();
    const store = makeStubStore();

    const writeOrder: string[] = [];
    const tracedWriter: RawMessageWriter = {
      async putRaw(input) {
        writeOrder.push(`s3:${input.key}`);
        await raw.writer.putRaw(input);
      },
    };
    const tracedStore: MessageStore = {
      async writeMessage(row) {
        writeOrder.push("ddb:writeMessage");
        await store.store.writeMessage(row);
      },
      async writeSkeleton() {
        throw new Error("unused");
      },
    };

    await persistOutbound(
      {
        raw: composed.raw,
        fromAddress: composed.fromAddress,
        composerMessageId: composed.messageId,
        sesMessageId: "ses-msgid-abc",
        sentAt: "2026-05-21T17:00:01.000Z",
        awsRegion: REGION,
        rawMimeBucket: BUCKET,
      },
      { store: tracedStore, rawWriter: tracedWriter },
    );

    expect(raw.calls).toHaveLength(1);
    expect(raw.calls[0]!.bucket).toBe(BUCKET);
    expect(raw.calls[0]!.key).toBe("outbound/ses-msgid-abc");
    expect(raw.calls[0]!.raw).toBe(composed.raw);

    // S3 must precede DDB so a Messages row never points at a missing object.
    expect(writeOrder).toEqual(["s3:outbound/ses-msgid-abc", "ddb:writeMessage"]);
  });

  it("writes a Messages row with direction='out' and address=fromAddress", async () => {
    const composed = compose();
    const raw = makeStubRawWriter();
    const store = makeStubStore();

    await persistOutbound(
      {
        raw: composed.raw,
        fromAddress: composed.fromAddress,
        composerMessageId: composed.messageId,
        sesMessageId: "ses-id-1",
        sentAt: "2026-05-21T17:00:01.000Z",
        awsRegion: REGION,
        rawMimeBucket: BUCKET,
      },
      { store: store.store, rawWriter: raw.writer },
    );

    expect(store.written).toHaveLength(1);
    const row = store.written[0]!;
    expect(row.parse_status).toBe("ok");
    expect(row.direction).toBe("out");
    expect(row.address).toBe("test@nille.net");
    expect(row.received_at).toBe("2026-05-21T17:00:01.000Z");
    expect(row.raw_s3_uri).toBe(
      `s3://${BUCKET}/outbound/ses-id-1`,
    );
    expect(row.schema_v).toBe("1");
  });

  it("stores the SES-rewritten message_id (not the composer's attempted id)", async () => {
    // ADR-0015 + ADR-0017: GSI1 indexes the recipient-visible RFC Message-ID
    // so an inbound reply quoting it round-trips. The composer's id is for
    // the audit log, not for threading.
    const composed = compose();
    const raw = makeStubRawWriter();
    const store = makeStubStore();

    await persistOutbound(
      {
        raw: composed.raw,
        fromAddress: composed.fromAddress,
        composerMessageId: composed.messageId,
        sesMessageId: "ses-xyz-789",
        sentAt: "2026-05-21T17:00:01.000Z",
        awsRegion: REGION,
        rawMimeBucket: BUCKET,
      },
      { store: store.store, rawWriter: raw.writer },
    );

    const row = store.written[0]!;
    if (row.parse_status !== "ok") throw new Error("expected ok row");
    expect(row.parsed.headers.messageId).toBe(
      `<ses-xyz-789@${REGION}.amazonses.com>`,
    );
    expect(row.parsed.headers.messageId).not.toBe(composed.messageId);
  });

  it("derives internal_id deterministically from the s3Key + sentAt", async () => {
    const composed = compose();
    const raw = makeStubRawWriter();
    const store = makeStubStore();

    const result1 = await persistOutbound(
      {
        raw: composed.raw,
        fromAddress: composed.fromAddress,
        composerMessageId: composed.messageId,
        sesMessageId: "ses-determ-1",
        sentAt: "2026-05-21T17:00:01.000Z",
        awsRegion: REGION,
        rawMimeBucket: BUCKET,
      },
      { store: store.store, rawWriter: raw.writer },
    );

    // Re-running with the same SES id + sentAt produces the same internal_id —
    // a retry rewrites the same row instead of duplicating.
    const result2 = await persistOutbound(
      {
        raw: composed.raw,
        fromAddress: composed.fromAddress,
        composerMessageId: composed.messageId,
        sesMessageId: "ses-determ-1",
        sentAt: "2026-05-21T17:00:01.000Z",
        awsRegion: REGION,
        rawMimeBucket: BUCKET,
      },
      { store: store.store, rawWriter: raw.writer },
    );

    expect(result1.internalId).toBe(result2.internalId);
    expect(result1.s3Key).toBe(result2.s3Key);
  });

  it("propagates S3 errors so the DDB row never lands without an S3 object", async () => {
    const composed = compose();
    const raw = makeStubRawWriter();
    raw.failNext!();
    const store = makeStubStore();

    await expect(
      persistOutbound(
        {
          raw: composed.raw,
          fromAddress: composed.fromAddress,
          composerMessageId: composed.messageId,
          sesMessageId: "ses-fail-1",
          sentAt: "2026-05-21T17:00:01.000Z",
          awsRegion: REGION,
          rawMimeBucket: BUCKET,
        },
        { store: store.store, rawWriter: raw.writer },
      ),
    ).rejects.toThrow(/S3 unavailable/);

    expect(store.written).toHaveLength(0);
  });

  it("propagates DDB errors verbatim", async () => {
    const composed = compose();
    const raw = makeStubRawWriter();
    const store = makeStubStore({ failWrite: true });

    await expect(
      persistOutbound(
        {
          raw: composed.raw,
          fromAddress: composed.fromAddress,
          composerMessageId: composed.messageId,
          sesMessageId: "ses-fail-2",
          sentAt: "2026-05-21T17:00:01.000Z",
          awsRegion: REGION,
          rawMimeBucket: BUCKET,
        },
        { store: store.store, rawWriter: raw.writer },
      ),
    ).rejects.toThrow(/DDB write failed/);

    // S3 still wrote — we accept the orphan object (lifecycle policy reaps).
    expect(raw.calls).toHaveLength(1);
  });
});

describe("makeSesRewrittenMessageId", () => {
  it("matches the live-observed SES rewrite shape (ADR-0015)", () => {
    // SES `SendEmail` returns `MessageId` already including the recipient
    // index suffix (e.g. `-000000`). The wire-format Message-ID wraps that
    // value verbatim — we do not append another suffix.
    expect(
      makeSesRewrittenMessageId({
        sesMessageId:
          "0110019e4af585ab-c072c1c8-9db7-431c-8104-603dd0c3b7fa-000000",
        region: "eu-north-1",
      }),
    ).toBe(
      "<0110019e4af585ab-c072c1c8-9db7-431c-8104-603dd0c3b7fa-000000@eu-north-1.amazonses.com>",
    );
  });

  it("varies by region", () => {
    const eu = makeSesRewrittenMessageId({
      sesMessageId: "abc",
      region: "eu-north-1",
    });
    const us = makeSesRewrittenMessageId({
      sesMessageId: "abc",
      region: "us-east-1",
    });
    expect(eu).not.toBe(us);
  });
});
