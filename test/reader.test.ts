import { describe, expect, it } from "vitest";
import { assembleBody, type StoredChunk } from "../src/core/reader.js";
import { chunkBody } from "../src/core/chunking.js";

const enc = new TextEncoder();

// assembleBody is the inverse of chunkBody — given the chunk rows DynamoDB
// hands back (already ordered by chunk_seq), reconstruct the original UTF-8
// text losslessly. Overlap stripping mirrors the round-trip math the parser
// test pins for chunkBody so the contract stays in one place.

function toStored(
  internalId: string,
  chunks: ReturnType<typeof chunkBody>,
): StoredChunk[] {
  return chunks.map((c) => ({
    internal_id: internalId,
    chunk_seq: c.index.toString().padStart(4, "0"),
    text: c.text,
    start_byte: c.startByte,
    end_byte: c.endByte,
  }));
}

describe("assembleBody", () => {
  it("returns empty string for an empty chunk list (matches ADR-0013 empty-body case)", () => {
    expect(assembleBody([])).toBe("");
  });

  it("returns the single chunk's text verbatim when only one chunk exists", () => {
    const text = "hi bob\n";
    const chunks = chunkBody(text);
    expect(chunks).toHaveLength(1);
    expect(assembleBody(toStored("01HX", chunks))).toBe(text);
  });

  it("losslessly reassembles a multi-chunk body, stripping the byte-level overlap window", () => {
    // Same shape the parser round-trip test exercises (Swedish + emoji over
    // many chunks) — proves overlap arithmetic agrees on the seam.
    const flavor = "åäö Björn slutfaktura 🇸🇪 — räkning ✉️ ";
    const text = flavor.repeat(20_000);
    const chunks = chunkBody(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(assembleBody(toStored("01HX", chunks))).toBe(text);
  });

  it("preserves order when input rows are already sorted by chunk_seq (the only contract DDB Query honours)", () => {
    // DDB Query with ScanIndexForward=true on SK=chunk_seq returns rows in
    // ascending lex order, which (because chunk_seq is zero-padded) is the
    // numeric chunk order. assembleBody must trust that ordering — it must
    // not re-sort, and must not silently reorder if rows arrive shuffled
    // (defensive: throw, because the alternative is silent corruption).
    const text = "x".repeat(700_000);
    const chunks = chunkBody(text);
    const rows = toStored("01HX", chunks);
    // Rotate the array so seq "0001" appears before "0000" — assembleBody
    // should refuse to silently glue these in the wrong order.
    const shuffled = [rows[1]!, rows[0]!, ...rows.slice(2)];
    expect(() => assembleBody(shuffled)).toThrow(/chunk_seq/);
  });

  it("throws when the first chunk's chunk_seq is not '0000' (defensive: detects a missed first chunk)", () => {
    // If the chunks Query started after seq=0000 (e.g. wrong cursor), the
    // body would be silently truncated at the start. Loud failure beats
    // serving a half-message.
    const text = "x".repeat(700_000);
    const chunks = chunkBody(text);
    const rows = toStored("01HX", chunks).slice(1);
    expect(() => assembleBody(rows)).toThrow(/chunk_seq/);
  });

  it("treats a sub-chunkSize ascii body as a single chunk (no overlap math needed)", () => {
    const text = "hello world";
    const rows: StoredChunk[] = [
      {
        internal_id: "01HX",
        chunk_seq: "0000",
        text,
        start_byte: 0,
        end_byte: enc.encode(text).length,
      },
    ];
    expect(assembleBody(rows)).toBe(text);
  });
});
