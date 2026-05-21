import {
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { MailIngestedEvent, SesVerdicts } from "../core/event.js";
import {
  handleRawMail as defaultHandleRawMail,
  type RawMailEnvelope,
  type HandleRawMailDeps,
} from "../core/handle-raw-mail.js";

// SES Lambda receipt-action shim per ADR-0012 (amended 2026-05-21):
//   SES → S3 (canonical body, key = mail.messageId) +
//         Lambda receipt action (this handler, async invocation)
//
// We replaced the previous SES→SNS→SQS→Lambda topology because the SES SNS
// receipt action embeds the entire email body in the SNS payload and bounces
// anything over 150 KB. Lambda receipt actions carry only the SES event JSON
// (metadata) and have no message-size limit — the canonical raw bytes still
// live in S3 from the parallel S3 action.
//
// One non-obvious constraint: the SES event tells us about the action that
// invoked us (the Lambda action), not the parallel S3 action. So neither the
// bucket name nor the S3 object key are present in event.receipt.action. The
// bucket comes from an env var (set by the ComputePlaneStack) and the key is
// `mail.messageId` — SES uses the message ID verbatim as the S3 object key
// when it writes via the S3 receipt action.
//
// Failure semantics:
//   - thrown errors propagate to Lambda's async retry mechanism
//   - 2 automatic retries with exponential backoff, then async DLQ
//   - DLQ is the existing opensesame-ingest-dlq SQS queue, re-purposed from
//     its prior role as an SQS-event-source-mapping DLQ to a Lambda async DLQ

export type IngestComposer = (
  envelope: RawMailEnvelope,
  deps: HandleRawMailDeps,
) => Promise<MailIngestedEvent>;

export type IngestHandlerDeps = {
  s3: S3Client;
  region: string;
  deploymentId: string;
  // Bucket SES writes the raw MIME to. Provided by the ComputePlaneStack
  // env wiring; required because the SES event doesn't tell us where the
  // parallel S3 action wrote.
  rawMimeBucket: string;
  handleRawMail?: IngestComposer;
  now?: () => Date;
  store?: HandleRawMailDeps["store"];
  publish?: HandleRawMailDeps["publish"];
  logError?: (line: string) => void;
};

// SES Lambda-action invocation envelope. Documented at
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda.html
export type SesLambdaEvent = {
  Records: SesLambdaRecord[];
};

export type SesLambdaRecord = {
  eventSource: "aws:ses";
  eventVersion: string;
  ses: SesReceiptPayload;
};

// Minimal subset of the SES Lambda payload that the handler depends on. Pinned
// here so a downstream SDK upgrade or schema change can't quietly silence the
// parser.
type SesReceiptPayload = {
  mail: {
    timestamp: string;
    messageId: string;
    destination: string[];
  };
  receipt: {
    spamVerdict: { status: string };
    virusVerdict: { status: string };
    spfVerdict: { status: string };
    dkimVerdict: { status: string };
    dmarcVerdict: { status: string };
  };
};

export type IngestHandler = (event: SesLambdaEvent) => Promise<void>;

function validatePayload(payload: SesReceiptPayload): void {
  if (
    !payload?.mail?.timestamp ||
    typeof payload.mail.messageId !== "string" ||
    payload.mail.messageId.length === 0 ||
    !Array.isArray(payload.mail.destination) ||
    payload.mail.destination.length === 0
  ) {
    throw new Error(
      "SES event missing mail.timestamp, mail.messageId, or mail.destination",
    );
  }
  const r = payload.receipt;
  if (
    !r?.spamVerdict?.status ||
    !r.virusVerdict?.status ||
    !r.spfVerdict?.status ||
    !r.dkimVerdict?.status ||
    !r.dmarcVerdict?.status
  ) {
    throw new Error("SES event missing one or more receipt verdicts");
  }
}

function extractVerdicts(receipt: SesReceiptPayload["receipt"]): SesVerdicts {
  return {
    spam: receipt.spamVerdict.status,
    virus: receipt.virusVerdict.status,
    dkim: receipt.dkimVerdict.status,
    spf: receipt.spfVerdict.status,
    dmarc: receipt.dmarcVerdict.status,
  };
}

async function fetchObjectBytes(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body as
    | { transformToByteArray?: () => Promise<Uint8Array> }
    | undefined;
  if (!body || typeof body.transformToByteArray !== "function") {
    throw new Error("S3 GetObject body is not a stream-shaped response");
  }
  return body.transformToByteArray();
}

async function processRecord(
  record: SesLambdaRecord,
  deps: Required<
    Pick<IngestHandlerDeps, "s3" | "deploymentId" | "rawMimeBucket">
  > &
    Pick<IngestHandlerDeps, "now" | "store" | "publish"> & {
      handleRawMail: IngestComposer;
    },
): Promise<void> {
  const payload = record.ses;
  validatePayload(payload);

  // The SES event for a Lambda action describes the Lambda action — it does
  // not echo the parallel S3 action. The S3 key is mail.messageId because
  // that's what SES uses by default when no `objectKeyPrefix` is configured.
  const key = payload.mail.messageId;
  const bucket = deps.rawMimeBucket;
  const recipient = payload.mail.destination[0]!;
  const receivedAt = payload.mail.timestamp;
  const verdicts = extractVerdicts(payload.receipt);

  const raw = await fetchObjectBytes(deps.s3, bucket, key);

  const envelope: RawMailEnvelope = {
    raw,
    s3Bucket: bucket,
    s3Key: key,
    address: recipient,
    receivedAt,
    verdicts,
  };

  const composerDeps: HandleRawMailDeps = {
    deploymentId: deps.deploymentId,
    now: deps.now ?? (() => new Date()),
    store: deps.store as HandleRawMailDeps["store"],
    publish: deps.publish as HandleRawMailDeps["publish"],
  };

  await deps.handleRawMail(envelope, composerDeps);
}

export function makeIngestHandler(deps: IngestHandlerDeps): IngestHandler {
  const composer = deps.handleRawMail ?? defaultHandleRawMail;
  const logError =
    deps.logError ?? ((line: string) => process.stderr.write(line));
  return async function ingestHandler(event: SesLambdaEvent): Promise<void> {
    if (!Array.isArray(event?.Records) || event.Records.length === 0) {
      throw new Error("SES Lambda event missing Records");
    }
    // SES async invocations always carry exactly one record per call
    // (one email = one invocation). Loop defensively anyway: if SES ever
    // batches in the future, we shouldn't silently drop tail records.
    for (const record of event.Records) {
      try {
        await processRecord(record, {
          s3: deps.s3,
          deploymentId: deps.deploymentId,
          rawMimeBucket: deps.rawMimeBucket,
          handleRawMail: composer,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
          ...(deps.store !== undefined ? { store: deps.store } : {}),
          ...(deps.publish !== undefined ? { publish: deps.publish } : {}),
        });
      } catch (err) {
        // Log + rethrow so Lambda's async retry kicks in. After retries
        // exhaust, the invocation lands on the Lambda async DLQ.
        logError(
          `ingest: messageId ${record.ses?.mail?.messageId ?? "<unknown>"} failed: ${
            (err as Error).stack ?? String(err)
          }\n`,
        );
        throw err;
      }
    }
  };
}
