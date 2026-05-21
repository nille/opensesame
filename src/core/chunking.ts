export type Chunk = {
  index: number;
  text: string;
  // Byte range (in UTF-8 bytes of the source text) that this chunk covers.
  // startByte is inclusive; endByte is exclusive. Adjacent chunks may have
  // endByte > next.startByte (the overlap window). Actual overlap can be
  // smaller than the configured `overlap` option when codepoints span the
  // boundary; consumers that need precise overlap should use these fields
  // rather than assuming the configured value.
  startByte: number;
  endByte: number;
};

export type ChunkOptions = {
  chunkSize?: number;
  overlap?: number;
};

const DEFAULT_CHUNK_SIZE = 300_000;
const DEFAULT_OVERLAP = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function chunkBody(text: string, opts: ChunkOptions = {}): Chunk[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (text.length === 0) return [];

  const bytes = encoder.encode(text);

  if (bytes.length <= chunkSize) {
    return [{ index: 0, text, startByte: 0, endByte: bytes.length }];
  }

  const stride = chunkSize - overlap;
  const chunks: Chunk[] = [];

  let start = 0;
  let index = 0;

  while (start < bytes.length) {
    // Advance forward to the next codepoint start. If `start` already points
    // to a lead byte this is a no-op.
    while (start < bytes.length && isContinuationByte(bytes[start]!)) start++;
    if (start >= bytes.length) break;

    // Greedy-fill: extend `end` one whole codepoint at a time until the next
    // codepoint would exceed the byte budget.
    let end = start;
    while (end < bytes.length) {
      const cpLen = codepointLengthAt(bytes, end);
      if (end - start + cpLen > chunkSize) break;
      end += cpLen;
    }

    if (end === start) {
      // chunkSize is smaller than a single codepoint — input cannot be chunked.
      throw new Error(
        `chunkSize=${chunkSize} too small for input (codepoint at byte ${start} requires ${codepointLengthAt(bytes, start)} bytes)`,
      );
    }

    chunks.push({
      index,
      text: decoder.decode(bytes.subarray(start, end)),
      startByte: start,
      endByte: end,
    });
    index++;

    if (end >= bytes.length) break;
    start += stride;
  }

  return chunks;
}

function isContinuationByte(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

function codepointLengthAt(bytes: Uint8Array, i: number): number {
  const b = bytes[i]!;
  if (b < 0x80) return 1;
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 1;
}
