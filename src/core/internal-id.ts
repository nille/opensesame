import { createHash } from "node:crypto";
import { encodeUlid } from "./ids.js";

// internal_id contract per ADR-0013:
//   1. Lexicographically sortable so DynamoDB Query w/ ScanIndexForward=false
//      returns newest-first (the dominant inbox access pattern).
//   2. Deterministic per canonical S3 key so retried Lambda invocations
//      rewrite the same items (ADR-0012 idempotency).
//
// Built as a ULID where the time component is `received_at` (preserves
// ordering) and the random tail is SHA-256(s3Key) truncated to 10 bytes
// (preserves determinism). No actual entropy — that's the whole point.

export type MakeInternalIdInput = {
  s3Key: string;
  receivedAt: string;
};

const RANDOM_BYTES = 10;

export function makeInternalId(input: MakeInternalIdInput): string {
  const ms = Date.parse(input.receivedAt);
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `makeInternalId: receivedAt must be ISO-8601, got ${JSON.stringify(input.receivedAt)}`,
    );
  }

  const digest = createHash("sha256").update(input.s3Key, "utf8").digest();
  const tail = new Uint8Array(
    digest.buffer,
    digest.byteOffset,
    RANDOM_BYTES,
  );

  return encodeUlid(ms, tail);
}

// Lower bound on internal_id for a given ISO timestamp. Used by
// listInbox(since) to push the time filter into DynamoDB's KeyCondition
// rather than scanning + filtering in app code.
//
// A ULID is `<10-char time><16-char random>`. The lex-smallest random tail
// in Crockford base32 is "0000000000000000". Anything received at or after
// `iso` will encode with a time prefix >= the encoded prefix here, so
// `internal_id > makeInternalIdLowerBound(iso)` matches "strictly after iso"
// up to ms granularity.
export function makeInternalIdLowerBound(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `makeInternalIdLowerBound: iso must be ISO-8601, got ${JSON.stringify(iso)}`,
    );
  }
  return encodeUlid(ms, new Uint8Array(RANDOM_BYTES));
}
