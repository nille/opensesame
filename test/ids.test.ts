import { describe, expect, it } from "vitest";
import {
  CROCKFORD_BASE32,
  encodeUlid,
  makeUlidFactory,
} from "../src/core/ids.js";

// 16 zero bytes — used to assert that the random tail is encoded exactly,
// without any "i, l, o, u" remap drama. Zero in Crockford base32 is "0".
const ZERO_RANDOM = new Uint8Array(10);

describe("encodeUlid", () => {
  it("encodes the canonical zero ULID as 26 zero characters", () => {
    expect(encodeUlid(0, ZERO_RANDOM)).toBe("00000000000000000000000000");
  });

  it("encodes a known ms timestamp into the 10-char time prefix", () => {
    // 2026-05-19T14:23:11.482Z = 1779798191482 ms — chosen so the same instant
    // appears in event.test.ts / ingest.test.ts; future cross-suite reads of a
    // ULID prefix stay consistent.
    const ms = Date.UTC(2026, 4, 19, 14, 23, 11, 482);
    const ulid = encodeUlid(ms, ZERO_RANDOM);
    expect(ulid).toHaveLength(26);
    expect(ulid.slice(10)).toBe("0000000000000000");
    // Round-trip the prefix: decode base32 manually to verify the timestamp.
    const decoded = decodeBase32Ms(ulid.slice(0, 10));
    expect(decoded).toBe(ms);
  });

  it("uses Crockford base32 (no I, L, O, U) for the random tail", () => {
    // 0xFF byte = 11111111 → split across base32 chars must use Crockford,
    // never standard base32. Picking all-FF makes the high bits land on the
    // letters that diverge from RFC 4648.
    const allFf = new Uint8Array(10).fill(0xff);
    const tail = encodeUlid(0, allFf).slice(10);
    expect(tail).toBe("ZZZZZZZZZZZZZZZZ");
    // And no banned letters appear anywhere in any output.
    for (const ch of tail) expect("ILOU").not.toContain(ch);
  });

  it("rejects timestamps outside the 48-bit range", () => {
    // ULID spec: time component is 48 bits (max ms = 2^48 - 1, year ~10889).
    // Negative or overflowing values are programmer errors, not runtime data.
    expect(() => encodeUlid(-1, ZERO_RANDOM)).toThrow(/timestamp/i);
    expect(() => encodeUlid(2 ** 48, ZERO_RANDOM)).toThrow(/timestamp/i);
  });

  it("rejects random buffers that are not exactly 10 bytes", () => {
    expect(() => encodeUlid(0, new Uint8Array(9))).toThrow(/random/i);
    expect(() => encodeUlid(0, new Uint8Array(11))).toThrow(/random/i);
  });
});

describe("makeUlidFactory", () => {
  it("produces 26-char ULIDs whose time prefix matches the injected clock", () => {
    const ms = Date.UTC(2026, 4, 19, 14, 23, 11, 482);
    const factory = makeUlidFactory({
      now: () => ms,
      randomBytes: () => ZERO_RANDOM,
    });

    const ulid = factory();
    expect(ulid).toHaveLength(26);
    expect(decodeBase32Ms(ulid.slice(0, 10))).toBe(ms);
  });

  it("calls randomBytes once per ULID and returns distinct values", () => {
    let counter = 0;
    const factory = makeUlidFactory({
      now: () => 0,
      randomBytes: () => {
        const buf = new Uint8Array(10);
        // Vary one byte so each call's encoded tail differs.
        buf[9] = counter++;
        return buf;
      },
    });

    const a = factory();
    const b = factory();
    expect(a).not.toBe(b);
    expect(counter).toBe(2);
  });

  it("uses node:crypto by default when randomBytes is omitted", () => {
    // No randomBytes passed → factory must still produce a valid 26-char
    // ULID. We check shape, not entropy quality (that's node's job).
    const factory = makeUlidFactory({ now: () => 0 });
    const ulid = factory();
    expect(ulid).toHaveLength(26);
    expect(ulid.slice(0, 10)).toBe("0000000000");
    for (const ch of ulid) expect(CROCKFORD_BASE32).toContain(ch);
  });
});

// Tiny helper local to this test file: invert the Crockford alphabet to
// recover the millisecond timestamp from the 10-char prefix.
function decodeBase32Ms(prefix: string): number {
  let n = 0;
  for (const ch of prefix) {
    const idx = CROCKFORD_BASE32.indexOf(ch);
    if (idx === -1) throw new Error(`bad char: ${ch}`);
    n = n * 32 + idx;
  }
  return n;
}
