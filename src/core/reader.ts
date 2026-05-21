// Read-side primitive: assemble a body from MessageBodyChunks rows.
//
// Inverse of chunkBody() (src/core/chunking.ts). Adjacent chunks may have an
// overlap window — endByte of chunk i can exceed startByte of chunk i+1. The
// overlap exists so a single search match never straddles a chunk boundary;
// for assembly we want exactly the original bytes, so we strip the overlap
// from chunk i+1 by slicing its UTF-8 encoding before stitching.
//
// Rows are expected pre-sorted by chunk_seq (DDB Query with
// ScanIndexForward=true on SK=chunk_seq, where chunk_seq is zero-padded so
// lex order matches numeric order, per ADR-0013). assembleBody refuses to
// reorder defensively — silent corruption beats loud failure here.

export type StoredChunk = {
  internal_id: string;
  chunk_seq: string;
  text: string;
  start_byte: number;
  end_byte: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function assembleBody(chunks: readonly StoredChunk[]): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0]!.text;

  if (chunks[0]!.chunk_seq !== "0000") {
    throw new Error(
      `assembleBody: first chunk has chunk_seq=${chunks[0]!.chunk_seq}, expected "0000" — refusing to assemble a body that would silently truncate at the start`,
    );
  }
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i]!.chunk_seq <= chunks[i - 1]!.chunk_seq) {
      throw new Error(
        `assembleBody: chunk_seq not strictly ascending at index ${i} (${chunks[i - 1]!.chunk_seq} → ${chunks[i]!.chunk_seq}) — refusing to silently reorder`,
      );
    }
  }

  // Stitch: keep chunk 0 verbatim; for each later chunk, drop the leading
  // bytes that overlap the previous chunk.
  const buffers: Uint8Array[] = [encoder.encode(chunks[0]!.text)];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const cur = chunks[i]!;
    const overlapBytes = prev.end_byte - cur.start_byte;
    const bytes = encoder.encode(cur.text);
    if (overlapBytes < 0 || overlapBytes > bytes.length) {
      throw new Error(
        `assembleBody: overlap=${overlapBytes} bytes between chunk ${prev.chunk_seq} and ${cur.chunk_seq} is out of range for a chunk of ${bytes.length} bytes`,
      );
    }
    buffers.push(bytes.subarray(overlapBytes));
  }

  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return decoder.decode(out);
}
