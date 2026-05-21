import {
  buildMailIngestedEvent,
  buildMailIngestedSkeletonEvent,
  type MailIngestedEvent,
  type SesVerdicts,
} from "./event.js";
import { MimeParseError, parseMime } from "./parser.js";
import type { MessageStore } from "./store.js";

export type IngestRawMailInput = {
  // Raw on-the-wire MIME bytes, exactly as written to the canonical S3
  // object. The composer derives `size_bytes` from `raw.byteLength`, so the
  // caller must not pre-decode or re-encode this buffer.
  raw: Uint8Array;
  internalId: string;
  address: string;
  receivedAt: string;
  rawS3Uri: string;
  verdicts: SesVerdicts;
  deploymentId: string;
};

export type IngestRawMailDeps = {
  // Wall-clock at the moment the event is being emitted. Distinct from
  // `receivedAt` (when SES accepted the message). ADR-0010 specifies ISO-8601
  // millisecond precision in UTC, so the composer formats this via toISOString.
  now: () => Date;
  // ULID factory for `event.event_id`. Injected so the composer is free of
  // crypto/time dependencies and remains fully unit-testable.
  newEventId: () => string;
  publish: (event: MailIngestedEvent) => Promise<void>;
  store: MessageStore;
};

export async function ingestRawMail(
  input: IngestRawMailInput,
  deps: IngestRawMailDeps,
): Promise<MailIngestedEvent> {
  // ULID + occurred_at are sampled exactly once and reused across both
  // branches — invariant pinned by tests so retry logic can't accidentally
  // call them twice.
  const eventId = deps.newEventId();
  const occurredAt = deps.now().toISOString();

  let parsed;
  try {
    parsed = parseMime(input.raw);
  } catch (error) {
    if (error instanceof MimeParseError) {
      return ingestSkeleton(input, deps, error.reason, eventId, occurredAt);
    }
    throw error;
  }

  const event = buildMailIngestedEvent({
    parsed,
    internalId: input.internalId,
    address: input.address,
    receivedAt: input.receivedAt,
    sizeBytes: input.raw.byteLength,
    rawS3Uri: input.rawS3Uri,
    verdicts: input.verdicts,
    eventId,
    occurredAt,
    deploymentId: input.deploymentId,
  });

  // Durability ordering (ADR-0012): the row must be in DynamoDB before the
  // event fires, so any consumer reacting to the event can find the message.
  await deps.store.writeMessage({
    parse_status: "ok",
    internal_id: input.internalId,
    address: input.address,
    received_at: input.receivedAt,
    raw_s3_uri: input.rawS3Uri,
    schema_v: "1",
    parsed,
  });

  await deps.publish(event);
  return event;
}

async function ingestSkeleton(
  input: IngestRawMailInput,
  deps: IngestRawMailDeps,
  parseError: string,
  eventId: string,
  occurredAt: string,
): Promise<MailIngestedEvent> {
  // Skeleton write happens before publish for the same reason as the happy
  // path: never fire MailIngested for a row the reader can't find.
  await deps.store.writeSkeleton({
    parse_status: "failed",
    parse_error: parseError,
    internal_id: input.internalId,
    address: input.address,
    received_at: input.receivedAt,
    raw_s3_uri: input.rawS3Uri,
    schema_v: "1",
  });

  const event = buildMailIngestedSkeletonEvent({
    internalId: input.internalId,
    address: input.address,
    receivedAt: input.receivedAt,
    sizeBytes: input.raw.byteLength,
    rawS3Uri: input.rawS3Uri,
    parseError,
    verdicts: input.verdicts,
    eventId,
    occurredAt,
    deploymentId: input.deploymentId,
  });

  await deps.publish(event);
  return event;
}
