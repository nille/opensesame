import { parseMime } from "./parser.js";
import { makeInternalId } from "./internal-id.js";
import type { RawMessageWriter } from "./raw-store.js";
import type { MessageStore } from "./store.js";
import { deriveThreadId } from "./threading.js";

// Persist an outbound copy after a successful SES send (ADR-0017).
//
// Order of operations:
//   1. Write the composed raw bytes to S3 under `outbound/{sesMessageId}`.
//   2. Re-parse those bytes so the row's headers / body / snippet match what
//      the recipient will see (modulo the SES Message-ID rewrite below).
//   3. Overwrite the parsed `message_id` with the SES-rewritten RFC form so
//      GSI1 indexes the recipient-visible id (ADR-0015 + ADR-0017).
//   4. Write the Messages row + chunks via the existing MessageStore port.
//
// Caller invariant: this runs *after* `sendWithAudit` has returned success.
// SES has already accepted the message; failures here are degraded but not
// catastrophic. The CLI driver wraps the call in try/catch and logs to
// stderr — we don't swallow errors here because higher layers (future MCP
// server) may want to surface the failure differently.

export type PersistOutboundInput = {
  // Composer outputs.
  raw: Uint8Array;
  fromAddress: string;
  composerMessageId: string;
  // SES adapter outputs.
  sesMessageId: string;
  sentAt: string;
  // SES region — used to construct the recipient-visible RFC Message-ID
  // that SES rewrites onto the wire (e.g. eu-north-1 → "@eu-north-1.amazonses.com").
  awsRegion: string;
  // S3 bucket for the raw archive. Same bucket as inbound; the `outbound/`
  // prefix in the key is what separates direction.
  rawMimeBucket: string;
};

export type PersistOutboundDeps = {
  store: MessageStore;
  rawWriter: RawMessageWriter;
};

export type PersistOutboundResult = {
  internalId: string;
  s3Key: string;
  rawS3Uri: string;
  // The SES-rewritten id stored on the row; what an inbound reply would
  // quote in In-Reply-To / References.
  storedMessageId: string;
};

export async function persistOutbound(
  input: PersistOutboundInput,
  deps: PersistOutboundDeps,
): Promise<PersistOutboundResult> {
  const s3Key = `outbound/${input.sesMessageId}`;
  const rawS3Uri = `s3://${input.rawMimeBucket}/${s3Key}`;

  await deps.rawWriter.putRaw({
    bucket: input.rawMimeBucket,
    key: s3Key,
    raw: input.raw,
  });

  // Re-parsing the composed bytes is one extra in-memory pass but gives the
  // same projection shape inbound has — headers_blob, decoded subject,
  // bodyText, custom headers — without a parallel "build a Messages row from
  // ComposeInput" code path that would drift from the parser.
  const parsed = parseMime(input.raw);

  const storedMessageId = makeSesRewrittenMessageId({
    sesMessageId: input.sesMessageId,
    region: input.awsRegion,
  });
  // Overwrite parsed.headers.messageId so DDB GSI1 indexes the recipient-
  // visible form. The composer's `<ULID@from-domain>` value lives in the
  // audit log under `rfc_message_id`; it is not the threading key.
  const stitched = {
    ...parsed,
    headers: { ...parsed.headers, messageId: storedMessageId },
  };

  const internalId = makeInternalId({
    s3Key,
    receivedAt: input.sentAt,
  });

  // ADR-0026: derive thread_id from the same headers — for an outbound reply
  // the `In-Reply-To`/`References` lines flow through `parseMime`, so this
  // resolves to the inbound parent's thread root and the row clusters with it.
  const threadId = deriveThreadId({
    messageId: stitched.headers.messageId,
    inReplyTo: stitched.headers.inReplyTo,
    references: stitched.headers.references,
  });

  await deps.store.writeMessage({
    parse_status: "ok",
    internal_id: internalId,
    address: input.fromAddress,
    received_at: input.sentAt,
    raw_s3_uri: rawS3Uri,
    schema_v: "1",
    parsed: stitched,
    direction: "out",
    thread_id: threadId,
  });

  return { internalId, s3Key, rawS3Uri, storedMessageId };
}

// SES rewrites the RFC Message-ID on accepted sends to the form
//   <{sesMessageId}@{region}.amazonses.com>
// (ADR-0015). The `MessageId` returned by SES `SendEmail` already contains
// the recipient-index suffix (e.g. `-000000`), so callers must pass it
// through unchanged — we don't append another suffix here.
export function makeSesRewrittenMessageId(input: {
  sesMessageId: string;
  region: string;
}): string {
  return `<${input.sesMessageId}@${input.region}.amazonses.com>`;
}
