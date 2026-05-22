// Port for the per-attachment S3 writer (slice 8.1).
//
// Attachment bytes live in the same raw-MIME bucket as the canonical envelope,
// under a separate `attachments/` prefix. Keying on (address, internal_id,
// part_index) keeps writes idempotent — re-running the backfill or re-ingest
// overwrites the same key byte-for-byte. S3 versioning is on at the bucket
// (ADR-0012), so a retry leaves an old version, not a corrupted object.

export type AttachmentObjectInput = {
  bucket: string;
  // Full object key. The orchestrator builds it as
  // `attachments/{address}/{internal_id}/{part_index}` so the layout stays
  // greppable and the BFF can mint presigned URLs without a roundtrip lookup.
  key: string;
  bytes: Uint8Array;
  // The MIME Content-Type from the original part. Echoed onto the S3 object so
  // browsers handle a presigned download with the right Content-Type header.
  contentType: string;
  // The original filename from Content-Disposition (or Content-Type name=).
  // Used to set Content-Disposition on the S3 object so a presigned download
  // saves with the right name. Null collapses to a stable fallback at the
  // orchestrator boundary.
  filename: string | null;
};

export interface AttachmentWriter {
  putAttachment(input: AttachmentObjectInput): Promise<void>;
}

// Read-side port for minting presigned GET URLs on attachment objects. The
// BFF's get_attachment RPC delegates here; the S3 implementation lives in
// src/aws/s3-attachment-store.ts. Tests stub this directly so dispatcher
// tests don't need an AWS client.
export type PresignAttachmentInput = {
  bucket: string;
  key: string;
  // Echoed back to the browser through ResponseContentType so the download
  // arrives with the right header even if the stored object was written with
  // application/octet-stream as a fallback.
  contentType: string;
  // Drives ResponseContentDisposition so the download saves with the
  // attachment's original filename. Null collapses to a part-index fallback.
  filename: string | null;
  // Short-lived per ADR-0021 — the BFF only needs a one-shot URL for the
  // browser to fetch immediately. 60 seconds is the dispatcher default.
  expiresInSeconds: number;
};

export type PresignedAttachment = {
  url: string;
  // ISO-8601 wall-clock expiry. The presigned URL itself encodes the same
  // info; surfacing it on the wire saves the client from parsing X-Amz-Date.
  expiresAt: string;
};

export interface AttachmentPresigner {
  presignDownload(input: PresignAttachmentInput): Promise<PresignedAttachment>;
}

export function makeAttachmentS3Key(
  address: string,
  internalId: string,
  partIndex: number,
): string {
  return `attachments/${address}/${internalId}/${partIndex}`;
}
