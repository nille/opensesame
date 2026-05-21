import { describe, expect, it } from "vitest";
import { chunkBody, type Chunk } from "../src/core/chunking.js";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

// Byte-aware reconstruction using each chunk's reported byte range. Robust
// against actual-vs-configured overlap drift caused by codepoint alignment.
function reconstruct(chunks: Chunk[]): string {
  if (chunks.length === 0) return "";
  const buffers: Uint8Array[] = [enc.encode(chunks[0]!.text)];
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1]!.endByte;
    const currStart = chunks[i]!.startByte;
    const actualOverlap = prevEnd - currStart;
    const bytes = enc.encode(chunks[i]!.text);
    buffers.push(bytes.subarray(actualOverlap));
  }
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return dec.decode(out);
}

describe("chunkBody", () => {
  it("returns zero chunks for empty input (nothing to store)", () => {
    expect(chunkBody("")).toEqual([]);
  });

  it("returns a single chunk containing the entire text when input fits in one chunk", () => {
    const text = "Hello, agentic world.";

    const chunks = chunkBody(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.text).toBe(text);
  });

  it("splits input larger than chunk size and reconstructs losslessly when overlap is removed", () => {
    // 1000 bytes of distinguishable content; chunk=400, overlap=50.
    // Expect ~3 chunks of 400 bytes with 50-byte overlap between adjacent ones.
    const text = Array.from({ length: 1000 }, (_, i) =>
      String.fromCharCode(33 + (i % 90)),
    ).join("");

    const chunks = chunkBody(text, { chunkSize: 400, overlap: 50 });

    expect(chunks.length).toBeGreaterThan(1);

    // Reconstruct by concatenating chunk[0] in full, then trimming the overlap
    // prefix from each subsequent chunk.
    const reconstructed = chunks.reduce((acc, chunk, i) => {
      if (i === 0) return chunk.text;
      return acc + chunk.text.slice(50);
    }, "");

    expect(reconstructed).toBe(text);
  });

  it("adjacent chunks share exactly `overlap` bytes — the suffix of chunk N equals the prefix of chunk N+1", () => {
    const text = Array.from({ length: 1000 }, (_, i) =>
      String.fromCharCode(33 + (i % 90)),
    ).join("");
    const overlap = 50;

    const chunks = chunkBody(text, { chunkSize: 400, overlap });

    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 0; i < chunks.length - 1; i++) {
      const current = chunks[i]!.text;
      const next = chunks[i + 1]!.text;
      const suffix = current.slice(current.length - overlap);
      const prefix = next.slice(0, overlap);
      expect(prefix).toBe(suffix);
    }
  });

  it("a search term up to `overlap` bytes that straddles a naive chunk boundary is fully contained in some chunk", () => {
    const chunkSize = 400;
    const overlap = 50;
    const stride = chunkSize - overlap;
    const needle = "FAKTURA-12345-NEEDLE";

    // Place the needle straddling the first naive boundary at offset = stride.
    // Anchor it so the needle starts a few bytes before stride and ends a few
    // bytes after — guaranteeing chunk[0] would not contain it without overlap.
    const needleStart = stride - 5;
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        String.fromCharCode(33 + (i % 90)),
      ).join("");

    const text =
      filler(needleStart) +
      needle +
      filler(1000 - needleStart - needle.length);

    const chunks = chunkBody(text, { chunkSize, overlap });

    const containing = chunks.filter((c) => c.text.includes(needle));
    expect(containing.length).toBeGreaterThanOrEqual(1);
  });

  it("reconstructs losslessly from a Swedish corpus (mixed 1-byte ASCII and 2-byte å/ä/ö)", () => {
    const text =
      "Hej Anna, slutfakturan för båtuthyrningen är på 12 450 kr. " +
      "Mvh, Sjöfartsverket. Påminnelse: förfallodatum är imorgon. " +
      "Härmed bekräftar vi mottagandet av er ansökan. Återkom om något är oklart. " +
      "Köpvillkor och ångerrätt enligt distansavtalslagen — se bifogad PDF. " +
      "Vänliga hälsningar / Lars-Åke Öhrström";
    const overlap = 16;
    const chunkSize = 64;

    const chunks = chunkBody(text, { chunkSize, overlap });
    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk fits the byte budget and is valid UTF-8.
    for (const c of chunks) {
      const bytes = enc.encode(c.text);
      expect(bytes.length).toBeLessThanOrEqual(chunkSize);
      expect(() => dec.decode(bytes)).not.toThrow();
    }

    expect(reconstruct(chunks)).toBe(text);
  });

  it("each chunk reports its byte range; reconstruction from byte ranges is lossless under pathological codepoint alignment", () => {
    // Same input as the cross-boundary needle case — first boundary lands
    // inside a 4-byte emoji, producing actual overlap < configured overlap.
    const prefix = "AAAAAAAAAAAAAAAAAA"; // 18 bytes
    const emoji = "🚀"; // 4 bytes
    const suffix = "ZZZZZZZZZZZZZZZZZZZZZZZZ"; // 24 bytes
    const text = prefix + emoji + suffix;

    const chunks = chunkBody(text, { chunkSize: 20, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    // startByte/endByte are present and consistent with the chunk's text.
    for (const c of chunks) {
      const bytes = enc.encode(c.text);
      expect(c.endByte - c.startByte).toBe(bytes.length);
    }

    // Adjacent chunks overlap by at least 1 byte and at most `overlap` bytes.
    // Actual overlap may be less than configured when codepoints span the
    // boundary, but it must never be negative or exceed the configured budget.
    for (let i = 0; i < chunks.length - 1; i++) {
      const actualOverlap = chunks[i]!.endByte - chunks[i + 1]!.startByte;
      expect(actualOverlap).toBeGreaterThanOrEqual(0);
      expect(actualOverlap).toBeLessThanOrEqual(10);
    }

    // Reconstruction using actual byte ranges round-trips losslessly even
    // though configured overlap (10) does not match actual overlap (8).
    expect(reconstruct(chunks)).toBe(text);
  });

  it("a cross-boundary needle survives even when the boundary lands inside a 4-byte codepoint", () => {
    // chunkSize = 20, overlap = 10, stride = 10.
    // First boundary is at byte 20. Place a 4-byte emoji at bytes 18..21 so
    // the chunk-end backoff and stride-start advance both shift.
    const chunkSize = 20;
    const overlap = 10;
    const stride = chunkSize - overlap;

    // Build prefix of exactly 18 ASCII bytes, then emoji, then suffix.
    const prefix = "AAAAAAAAAAAAAAAAAA"; // 18 bytes
    const emoji = "🚀"; // 4 bytes
    const suffix = "ZZZZZZZZZZZZZZZZZZZZZZZZ"; // 24 bytes
    const text = prefix + emoji + suffix;

    // Needle: 9 bytes that straddle the boundary. Less than configured
    // `overlap` (10), so by the ADR-0004 contract it must live in some chunk.
    const needle = "AAA" + emoji + "ZZ"; // 3 + 4 + 2 = 9 bytes, < overlap (10)

    const chunks = chunkBody(text, { chunkSize, overlap });

    expect(chunks.length).toBeGreaterThan(1);

    // The invariant under test: any needle ≤ overlap bytes that crosses a
    // chunk boundary is fully contained in some chunk.
    const containing = chunks.filter((c) => c.text.includes(needle));
    expect(containing.length).toBeGreaterThanOrEqual(1);

    // Byte budget still holds.
    for (const c of chunks) {
      expect(enc.encode(c.text).length).toBeLessThanOrEqual(chunkSize);
    }
  });

  it("reconstructs losslessly from emoji-heavy input (4-byte UTF-8 codepoints)", () => {
    // 🚀 = U+1F680, encoded as 4 UTF-8 bytes (F0 9F 9A 80).
    // Mix with ASCII so chunk boundaries land at varied alignments.
    const text =
      "Launch update: 🚀 ready. Status: 🟢🟢🟢. " +
      "Roadmap: ✅ ingest, 🛠️ search, 🔜 webmail. " +
      "Cheers — the team 🎉🎉🎉";
    const overlap = 16;
    const chunkSize = 48;

    const chunks = chunkBody(text, { chunkSize, overlap });
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      const bytes = enc.encode(c.text);
      expect(bytes.length).toBeLessThanOrEqual(chunkSize);
      expect(() => dec.decode(bytes)).not.toThrow();
    }

    expect(reconstruct(chunks)).toBe(text);
  });

  it("chunks a representative HTML email body correctly", () => {
    const text =
      `<!doctype html>\r\n` +
      `<html><head><meta charset="utf-8"><title>Faktura #2026-0481</title></head>\r\n` +
      `<body style="font-family:Arial,sans-serif;color:#222;">\r\n` +
      `<p>Hej Anna,</p>\r\n` +
      `<p>Tack för din beställning hos <strong>Sjöfartsbutiken AB</strong>. ` +
      `Bifogat finner du fakturan på <em>12&nbsp;450&nbsp;kr</em> ` +
      `med förfallodag 2026-06-02.</p>\r\n` +
      `<p>Frågor? Svara på det här mejlet eller ring 08&ndash;123&nbsp;45&nbsp;67.</p>\r\n` +
      `<p style="color:#888;font-size:12px;">— Detta meddelande skickades automatiskt 🤖</p>\r\n` +
      `</body></html>\r\n`;
    const overlap = 24;
    const chunkSize = 96;

    const chunks = chunkBody(text, { chunkSize, overlap });
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      const bytes = enc.encode(c.text);
      expect(bytes.length).toBeLessThanOrEqual(chunkSize);
      expect(() => dec.decode(bytes)).not.toThrow();
    }

    expect(reconstruct(chunks)).toBe(text);
  });

  it("never splits multi-byte UTF-8 sequences at chunk boundaries (Swedish content)", () => {
    // 'å' is 2 UTF-8 bytes (0xC3 0xA5). 50 of them is 100 UTF-8 bytes.
    const text = "å".repeat(50);
    const chunkSizeBytes = 11; // odd byte budget forces a backup off the å boundary
    const overlapBytes = 4;

    const chunks = chunkBody(text, {
      chunkSize: chunkSizeBytes,
      overlap: overlapBytes,
    });

    expect(chunks.length).toBeGreaterThan(1);

    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8", { fatal: true });

    for (const c of chunks) {
      const bytes = enc.encode(c.text);
      // Chunk fits in the byte budget.
      expect(bytes.length).toBeLessThanOrEqual(chunkSizeBytes);
      // Chunk is valid UTF-8 — fatal: true throws on a half-codepoint.
      expect(() => dec.decode(bytes)).not.toThrow();
      // Chunk text is whole 'å' characters only — no replacement chars, no
      // mid-codepoint truncation that snuck through as U+FFFD.
      expect(c.text).toMatch(/^å+$/);
    }
  });
});
