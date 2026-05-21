import { type MailIngestedEvent, type SesVerdicts } from "./event.js";
import { ingestRawMail } from "./ingest.js";
import { makeInternalId } from "./internal-id.js";
import { makeUlidFactory } from "./ids.js";
import type { MessageStore } from "./store.js";

// One-call orchestration: parse → DDB write → EventBridge publish.
// The Lambda entry point becomes a thin shim around this — anything
// SES/SQS-shaped happens before this boundary, so smoke tests can drive
// `handleRawMail` directly with a real .eml.

export type RawMailEnvelope = {
  // Raw on-the-wire MIME exactly as written to the canonical S3 object.
  raw: Uint8Array;
  s3Bucket: string;
  // Object key under the bucket — used both for the s3:// URI and as the
  // determinism seed for internal_id (ADR-0013).
  s3Key: string;
  address: string;
  // ISO-8601 UTC ms; SES timestamp the message was received.
  receivedAt: string;
  verdicts: SesVerdicts;
};

export type HandleRawMailDeps = {
  store: MessageStore;
  publish: (event: MailIngestedEvent) => Promise<void>;
  // Wall-clock for `occurred_at`. Distinct from `receivedAt`.
  now: () => Date;
  // Defaults to the project ULID factory; tests inject a fixed factory to
  // assert the wire shape.
  newEventId?: () => string;
  deploymentId: string;
};

export async function handleRawMail(
  envelope: RawMailEnvelope,
  deps: HandleRawMailDeps,
): Promise<MailIngestedEvent> {
  const internalId = makeInternalId({
    s3Key: envelope.s3Key,
    receivedAt: envelope.receivedAt,
  });

  // ULID factory only used for the per-emission event_id. internal_id is
  // derived deterministically and is not affected by this dep.
  const newEventId =
    deps.newEventId ?? makeUlidFactory({ now: () => deps.now().getTime() });

  return ingestRawMail(
    {
      raw: envelope.raw,
      internalId,
      address: envelope.address,
      receivedAt: envelope.receivedAt,
      rawS3Uri: `s3://${envelope.s3Bucket}/${envelope.s3Key}`,
      verdicts: envelope.verdicts,
      deploymentId: deps.deploymentId,
    },
    {
      now: deps.now,
      newEventId,
      publish: deps.publish,
      store: deps.store,
    },
  );
}
