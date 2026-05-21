import { randomFillSync } from "node:crypto";

// ULID spec (https://github.com/ulid/spec):
//   - 128 bits = 48-bit ms timestamp + 80 bits of randomness
//   - encoded as 26 chars in Crockford's base32 (no I, L, O, U)
//   - lexicographically sortable by encoded form
//
// Hand-rolled rather than via the `ulid` npm package: spec is frozen, surface
// is ~50 lines, and this repo deliberately keeps deps small for audit.
// Crypto and time are injected so the factory stays fully unit-testable.

export const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_BYTES = 10;
const MAX_TIME_MS = 2 ** 48 - 1;

export type UlidFactoryDeps = {
  now: () => number;
  // Caller-supplied entropy source. Default uses node:crypto so production
  // code doesn't need to wire it; tests inject deterministic bytes.
  randomBytes?: () => Uint8Array;
};

export function makeUlidFactory(deps: UlidFactoryDeps): () => string {
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  return () => encodeUlid(deps.now(), randomBytes());
}

export function encodeUlid(timestampMs: number, random: Uint8Array): string {
  if (
    !Number.isInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > MAX_TIME_MS
  ) {
    throw new RangeError(
      `ULID timestamp must be an integer in [0, 2^48 - 1], got ${timestampMs}`,
    );
  }
  if (random.length !== RANDOM_BYTES) {
    throw new RangeError(
      `ULID random must be exactly ${RANDOM_BYTES} bytes, got ${random.length}`,
    );
  }

  return encodeTime(timestampMs) + encodeRandom(random);
}

function encodeTime(ms: number): string {
  // Build right-to-left so each step is a clean 5-bit slice. Math on 48-bit
  // integers is safe in JS — Number.MAX_SAFE_INTEGER is 2^53 - 1.
  let remaining = ms;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const idx = remaining % 32;
    out[i] = CROCKFORD_BASE32[idx]!;
    remaining = Math.floor(remaining / 32);
  }
  return out.join("");
}

function encodeRandom(random: Uint8Array): string {
  // 10 bytes = 80 bits → 16 base32 chars. Stream bits through a small buffer
  // so we never have to think about boundary conditions per byte.
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (let i = 0; i < random.length; i++) {
    buffer = (buffer << 8) | random[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const idx = (buffer >> bits) & 0x1f;
      out += CROCKFORD_BASE32[idx]!;
    }
  }
  // 80 is divisible by 5, so no leftover bits. Length check below is a
  // belt-and-suspenders against a future change to RANDOM_BYTES that would
  // silently produce a wrong-length ULID.
  if (out.length !== RANDOM_LEN) {
    throw new Error(`internal: random encode produced ${out.length} chars`);
  }
  return out;
}

// Read-side counterpart to encodeUlid: audit_query (ADR-0020) uses the bounds
// as `audit_id BETWEEN :lo AND :hi` on GSI1's sort key. The lower bound is
// the canonical zero ULID at `since.ms` (random tail = 16 zero chars), the
// upper bound is the canonical max ULID at `until.ms` (random tail = 16 'Z'
// chars). DDB BETWEEN is inclusive on both ends, so a row written at exactly
// `since.ms` lex-sorts after `lo` (any non-zero random tail beats all zeros)
// and a row written at exactly `until.ms` lex-sorts at-or-before `hi` (any
// random tail loses to all-Z). When a bound is omitted we fall back to the
// 48-bit floor / ceiling so the query still ranges across the whole table.
const TIME_FLOOR = "0000000000";
const TIME_CEILING = "7ZZZZZZZZZ"; // 2^48 - 1 in Crockford base32, 10 chars.
const RANDOM_FLOOR = "0000000000000000";
const RANDOM_CEILING = "ZZZZZZZZZZZZZZZZ";

export function ulidBoundsForTimeRange(
  since?: Date,
  until?: Date,
): { lo: string; hi: string } {
  if (since !== undefined && until !== undefined && since.getTime() > until.getTime()) {
    throw new RangeError(
      `ulidBoundsForTimeRange: since (${since.toISOString()}) is after until (${until.toISOString()})`,
    );
  }
  const lo =
    since === undefined
      ? TIME_FLOOR + RANDOM_FLOOR
      : encodeTime(since.getTime()) + RANDOM_FLOOR;
  const hi =
    until === undefined
      ? TIME_CEILING + RANDOM_CEILING
      : encodeTime(until.getTime()) + RANDOM_CEILING;
  return { lo, hi };
}

function defaultRandomBytes(): Uint8Array {
  const buf = new Uint8Array(RANDOM_BYTES);
  randomFillSync(buf);
  return buf;
}
