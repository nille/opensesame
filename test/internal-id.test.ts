import { describe, expect, it } from "vitest";
import { makeInternalId } from "../src/core/internal-id.js";
import { CROCKFORD_BASE32 } from "../src/core/ids.js";

// internal_id contract per ADR-0013:
//   1. lexicographically sortable so DynamoDB Query w/ ScanIndexForward=false
//      returns newest-first
//   2. deterministic per canonical S3 key so retried Lambda invocations rewrite
//      the same items (ADR-0012 idempotency)

const KEY_A = "2026/05/19/<msg-1@example.com>.eml";
const KEY_B = "2026/05/19/<msg-2@example.com>.eml";
const T1 = "2026-05-19T14:23:10.901Z";
const T2 = "2026-05-19T15:00:00.000Z";

describe("makeInternalId", () => {
  it("produces a 26-char ULID-shaped string", () => {
    const id = makeInternalId({ s3Key: KEY_A, receivedAt: T1 });
    expect(id).toHaveLength(26);
    for (const ch of id) expect(CROCKFORD_BASE32).toContain(ch);
  });

  it("is deterministic for the same (s3Key, receivedAt) pair", () => {
    // Idempotency is the whole point — SQS retry must rewrite the same items.
    const a = makeInternalId({ s3Key: KEY_A, receivedAt: T1 });
    const b = makeInternalId({ s3Key: KEY_A, receivedAt: T1 });
    expect(a).toBe(b);
  });

  it("differs when the s3Key differs (so two messages don't collide)", () => {
    const a = makeInternalId({ s3Key: KEY_A, receivedAt: T1 });
    const b = makeInternalId({ s3Key: KEY_B, receivedAt: T1 });
    expect(a).not.toBe(b);
  });

  it("encodes received_at into the time prefix so older < newer lexically", () => {
    const earlier = makeInternalId({ s3Key: KEY_A, receivedAt: T1 });
    const later = makeInternalId({ s3Key: KEY_A, receivedAt: T2 });
    expect(earlier < later).toBe(true);
  });

  it("derives the random tail deterministically from the s3Key", () => {
    // Two messages received at the same instant but with different S3 keys
    // must produce different random tails — collision would fail the "two
    // messages don't share a primary key" invariant.
    const t = T1;
    const a = makeInternalId({ s3Key: KEY_A, receivedAt: t });
    const b = makeInternalId({ s3Key: KEY_B, receivedAt: t });
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // same time prefix
    expect(a.slice(10)).not.toBe(b.slice(10)); // different random tails
  });

  it("rejects invalid receivedAt", () => {
    expect(() =>
      makeInternalId({ s3Key: KEY_A, receivedAt: "not a date" }),
    ).toThrow(/receivedAt/i);
  });
});
