import { describe, expect, it, vi } from "vitest";
import {
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  makeIngestHandler,
  type SesLambdaEvent,
  type SesLambdaRecord,
} from "../src/lambda/ingest.js";
import type { MailIngestedEvent } from "../src/core/event.js";

// SES Lambda receipt-action shim tests (ADR-0012, amended 2026-05-21). The
// trigger is now SES → S3 + Lambda receipt action → this handler. Each
// invocation carries one SES event JSON wrapped in a Records array.
//
// Contract pinned here:
//   - bucket comes from deps.rawMimeBucket (env-supplied; SES event
//     describes the Lambda action, NOT the parallel S3 action)
//   - S3 key is mail.messageId (SES default)
//   - recipient is mail.destination[0] (ADR-0002 — SES is authoritative)
//   - verdicts come from receipt.{spam,virus,dkim,spf,dmarc}Verdict.status
//   - receivedAt is mail.timestamp (ISO-8601 from SES)
//   - any thrown error propagates to Lambda's async retry mechanism;
//     after exhausting retries, Lambda routes to the configured async DLQ
//   - poison records (malformed envelope) throw and follow the same path

const enc = new TextEncoder();

const VALID_RAW = enc.encode(
  [
    "From: Sender <sender@example.com>",
    "To: alice@acme.com",
    "Subject: hello",
    "Message-ID: <m1@example.com>",
    "Date: Tue, 19 May 2026 14:23:10 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hi",
    "",
  ].join("\r\n"),
);

const BUCKET = "opensesame-raw-mime-925039213717";
const MESSAGE_ID = "ses-msg-1";
const RECIPIENT = "alice@acme.com";
const RECEIVED_AT = "2026-05-19T14:23:10.901Z";

type SesVerdictTuple = {
  spam?: string;
  virus?: string;
  dkim?: string;
  spf?: string;
  dmarc?: string;
};

function makeSesRecord(opts: {
  messageId?: string;
  destinations?: string[];
  timestamp?: string;
  verdicts?: SesVerdictTuple;
} = {}): SesLambdaRecord {
  const v = opts.verdicts ?? {};
  return {
    eventSource: "aws:ses",
    eventVersion: "1.0",
    ses: {
      mail: {
        timestamp: opts.timestamp ?? RECEIVED_AT,
        messageId: opts.messageId ?? MESSAGE_ID,
        destination: opts.destinations ?? [RECIPIENT],
      },
      receipt: {
        spamVerdict: { status: v.spam ?? "PASS" },
        virusVerdict: { status: v.virus ?? "PASS" },
        spfVerdict: { status: v.spf ?? "PASS" },
        dkimVerdict: { status: v.dkim ?? "PASS" },
        dmarcVerdict: { status: v.dmarc ?? "PASS" },
      },
    },
  };
}

function makeS3Stub(opts: { body?: Uint8Array; getThrows?: Error } = {}) {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetObjectCommand) {
      if (opts.getThrows) throw opts.getThrows;
      const buf = opts.body ?? VALID_RAW;
      return {
        Body: {
          transformToByteArray: async () => buf,
        },
      };
    }
    throw new Error(
      `unexpected command: ${(cmd as { constructor: { name: string } }).constructor.name}`,
    );
  });
  return { send } as unknown as S3Client & { send: typeof send };
}

const baseDeps = {
  region: "eu-north-1",
  deploymentId: "deploy-test",
  rawMimeBucket: BUCKET,
  logError: () => {},
};

describe("makeIngestHandler — happy path (SES Lambda action)", () => {
  it("drives parse → DDB write → publish for a single SES record", async () => {
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn<
      (envelope: unknown, deps: unknown) => Promise<MailIngestedEvent>
    >(async () => ({ event_id: "evt-1" }) as unknown as MailIngestedEvent);

    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });
    const event: SesLambdaEvent = {
      Records: [makeSesRecord()],
    };

    await expect(handler(event)).resolves.toBeUndefined();
    expect(handleRawMail).toHaveBeenCalledTimes(1);
    const [envelope, deps] = handleRawMail.mock.calls[0]!;
    expect(envelope).toMatchObject({
      s3Bucket: BUCKET,
      s3Key: MESSAGE_ID,
      address: RECIPIENT,
      receivedAt: RECEIVED_AT,
    });
    expect((envelope as { raw: Uint8Array }).raw).toEqual(VALID_RAW);
    expect((deps as { deploymentId: string }).deploymentId).toBe("deploy-test");
  });

  it("propagates real SES verdicts (no hardcoded PASS placeholder)", async () => {
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn<
      (envelope: unknown, deps: unknown) => Promise<MailIngestedEvent>
    >(async () => ({}) as MailIngestedEvent);
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    await handler({
      Records: [
        makeSesRecord({
          verdicts: {
            spam: "FAIL",
            virus: "PASS",
            dkim: "GRAY",
            spf: "PASS",
            dmarc: "PROCESSING_FAILED",
          },
        }),
      ],
    });

    const [envelope] = handleRawMail.mock.calls[0]!;
    expect((envelope as { verdicts: Record<string, string> }).verdicts).toEqual({
      spam: "FAIL",
      virus: "PASS",
      dkim: "GRAY",
      spf: "PASS",
      dmarc: "PROCESSING_FAILED",
    });
  });

  it("issues a single GET against the configured bucket using mail.messageId as the key", async () => {
    // Bucket comes from env (deps.rawMimeBucket), key is mail.messageId.
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn(async () => ({}) as MailIngestedEvent);
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    await handler({
      Records: [makeSesRecord({ messageId: "abc123" })],
    });

    const gets = s3.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is GetObjectCommand => c instanceof GetObjectCommand);
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.input).toMatchObject({ Bucket: BUCKET, Key: "abc123" });
  });
});

describe("makeIngestHandler — failure paths", () => {
  it("throws when destination is missing", async () => {
    // ADR-0002: row is owned by recipient address; SES is the only
    // authoritative source. Empty destinations = misconfigured rule.
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn(async () => ({}) as MailIngestedEvent);
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    await expect(
      handler({ Records: [makeSesRecord({ destinations: [] })] }),
    ).rejects.toThrow(/mail.timestamp|mail.messageId|mail.destination/);
    expect(handleRawMail).not.toHaveBeenCalled();
  });

  it("throws when messageId is missing", async () => {
    // Without messageId we can't form the S3 key.
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn(async () => ({}) as MailIngestedEvent);
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    await expect(
      handler({ Records: [makeSesRecord({ messageId: "" })] }),
    ).rejects.toThrow(/mail.timestamp|mail.messageId|mail.destination/);
    expect(handleRawMail).not.toHaveBeenCalled();
  });

  it("throws when verdicts are missing", async () => {
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn(async () => ({}) as MailIngestedEvent);
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    const broken = {
      Records: [
        {
          eventSource: "aws:ses",
          eventVersion: "1.0",
          ses: {
            mail: {
              timestamp: RECEIVED_AT,
              messageId: MESSAGE_ID,
              destination: [RECIPIENT],
            },
            receipt: {
              spamVerdict: { status: "PASS" },
              // virus, spf, dkim, dmarc missing
            },
          },
        },
      ],
    } as unknown as SesLambdaEvent;
    await expect(handler(broken)).rejects.toThrow(/verdict/);
    expect(handleRawMail).not.toHaveBeenCalled();
  });

  it("throws when the composer throws (DDB or publish failure)", async () => {
    // The throw propagates out so Lambda's async retry kicks in.
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn<
      (envelope: unknown, deps: unknown) => Promise<MailIngestedEvent>
    >(async () => {
      throw new Error("dynamo throttled");
    });
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    await expect(
      handler({ Records: [makeSesRecord()] }),
    ).rejects.toThrow("dynamo throttled");
  });

  it("throws when the event has no records", async () => {
    const s3 = makeS3Stub();
    const handleRawMail = vi.fn(async () => ({}) as MailIngestedEvent);
    const handler = makeIngestHandler({ ...baseDeps, s3, handleRawMail });

    await expect(
      handler({ Records: [] } as unknown as SesLambdaEvent),
    ).rejects.toThrow(/Records/);
    expect(handleRawMail).not.toHaveBeenCalled();
  });
});
