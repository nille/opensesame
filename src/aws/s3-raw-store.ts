import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { RawMessageWriter } from "../core/raw-store.js";

// S3-bound implementation of RawMessageWriter (ADR-0017). The bucket has
// versioning + BPA + Glacier-Deep-Archive lifecycle baked in at the data-
// plane layer; this adapter just hands SES bytes to S3 with the right
// content-type and key.

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
