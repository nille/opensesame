import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import type {
  RawMessageReader,
  RawMessageWriter,
} from "../core/raw-store.js";

// S3-bound implementation of RawMessageWriter (ADR-0017) and
// RawMessageReader (ADR-0042). The bucket has versioning + BPA + Glacier-
// Deep-Archive lifecycle baked in at the data-plane layer; this adapter
// just hands bytes to/from S3 with the right content-type and key.

export type S3RawMessageWriterDeps = {
  client: S3Client;
};

export function makeS3RawMessageWriter(
  deps: S3RawMessageWriterDeps,
): RawMessageWriter {
  return {
    putRaw: async (input) => {
      await deps.client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.raw,
          // RFC 5322 wire bytes — SES inbound objects are stored as
          // application/octet-stream by the SES receipt action; we mirror
          // that for symmetry rather than message/rfc822 (which some
          // tooling treats as a multipart envelope to recurse into).
          ContentType: "application/octet-stream",
        }),
      );
    },
  };
}

export type S3RawMessageReaderDeps = {
  client: S3Client;
};

const S3_URI_PREFIX = "s3://";

export function parseS3Uri(
  uri: string,
): { bucket: string; key: string } | null {
  if (!uri.startsWith(S3_URI_PREFIX)) return null;
  const rest = uri.slice(S3_URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

// ADR-0042 (slice 8.21). Read-side adapter for the BFF's re-parse-on-read
// path. Returns the bytes verbatim (no decoding) so the consumer's MIME
// parser sees the same bytes SES delivered.
export function makeS3RawMessageReader(
  deps: S3RawMessageReaderDeps,
): RawMessageReader {
  return {
    getRaw: async (s3Uri) => {
      const parsed = parseS3Uri(s3Uri);
      if (parsed === null) return null;

      try {
        const result = await deps.client.send(
          new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
        );
        const body = result.Body;
        if (body === undefined) return null;
        // The aws-sdk v3 Body is a `StreamingBlobPayloadOutputTypes` union;
        // every concrete shape exposes `transformToByteArray()` in node and
        // the browser-shimmed s3-client. We rely on it rather than
        // re-implementing stream readers per platform.
        const bytes = await (
          body as { transformToByteArray: () => Promise<Uint8Array> }
        ).transformToByteArray();
        return bytes;
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        if (
          err instanceof S3ServiceException &&
          err.name === "NoSuchKey"
        ) {
          return null;
        }
        throw err;
      }
    },
  };
}
