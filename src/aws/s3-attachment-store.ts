import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  AttachmentPresigner,
  AttachmentWriter,
} from "../core/attachment-store.js";

// S3-bound implementation of AttachmentWriter (slice 8.1). Mirrors
// s3-raw-store: the bucket is created with versioning + BPA at the data-plane
// layer; this adapter just hands bytes to S3 with the right headers.

export type S3AttachmentWriterDeps = {
  client: S3Client;
};

export function makeS3AttachmentWriter(
  deps: S3AttachmentWriterDeps,
): AttachmentWriter {
  return {
    putAttachment: async (input) => {
      // RFC 6266 attachment with quoted filename — quotes around the value
      // are intentional, and the filename is encoded so high-bit characters
      // round-trip through HTTP headers.
      const dispositionFilename = input.filename ?? `part-${nextPartTag()}`;
      await deps.client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.bytes,
          ContentType: input.contentType,
          ContentDisposition: contentDisposition(dispositionFilename),
        }),
      );
    },
  };
}

// S3-bound implementation of AttachmentPresigner. Used by the BFF's
// get_attachment RPC. Override response headers so the presigned URL
// carries Content-Type and Content-Disposition the browser wants — the
// stored S3 object already has them, but echoing through the URL also
// covers older objects written before slice 8.1 carried the right metadata.
export type S3AttachmentPresignerDeps = {
  client: S3Client;
  // Injectable for tests; defaults to the real getSignedUrl. Type matches
  // the AWS SDK export so adapters can swap it without ceremony.
  signer?: typeof getSignedUrl;
  // Wall-clock provider so expiresAt is deterministic in tests.
  now?: () => Date;
};

export function makeS3AttachmentPresigner(
  deps: S3AttachmentPresignerDeps,
): AttachmentPresigner {
  const sign = deps.signer ?? getSignedUrl;
  const now = deps.now ?? (() => new Date());
  return {
    presignDownload: async (input) => {
      const dispositionFilename = input.filename ?? `part-${nextPartTag()}`;
      const url = await sign(
        deps.client,
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          ResponseContentType: input.contentType,
          ResponseContentDisposition: contentDisposition(dispositionFilename),
        }),
        { expiresIn: input.expiresInSeconds },
      );
      const expiresAt = new Date(
        now().getTime() + input.expiresInSeconds * 1000,
      ).toISOString();
      return { url, expiresAt };
    },
  };
}

// 8 hex chars is enough to avoid collisions when multiple unnamed attachments
// land in one message; the part index already disambiguates within a message.
function nextPartTag(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function contentDisposition(filename: string): string {
  // Encode per RFC 5987 so non-ASCII filenames survive HTTP header round-trip.
  // Browsers honor `filename*=UTF-8''…` first, fall back to plain `filename=`.
  const safeAscii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}
