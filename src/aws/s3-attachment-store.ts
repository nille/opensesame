import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import type {
  AttachmentPresigner,
  AttachmentWriter,
} from "../core/attachment-store.js";
import type {
  AttachmentStager,
  StageAttachmentInput,
  StageAttachmentResult,
} from "../core/store.js";

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

// ADR-0043 (slice 8.22). S3-bound implementation of AttachmentStager.
// Writes draft attachment bytes under outbound-staging/<address>/<draft_id>/<idx>
// in the raw-mime bucket. The reader has no part in this — bytes don't
// touch DDB; only the ref does, on the next save_draft call.
export type S3AttachmentStagerDeps = {
  client: S3Client;
  bucket: string;
  // Caller supplies the next index per draft. The stager itself doesn't
  // know what indices already exist — that lives in the dispatcher,
  // which reads existing refs off the draft row before staging.
  nextIndex: (input: { address: string; draftId: string }) => Promise<number>;
};

export function makeS3AttachmentStager(
  deps: S3AttachmentStagerDeps,
): AttachmentStager {
  return {
    stageAttachment: async (
      input: StageAttachmentInput,
    ): Promise<StageAttachmentResult> => {
      const bytes = Buffer.from(input.content_base64, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const idx = await deps.nextIndex({
        address: input.address,
        draftId: input.draft_id,
      });
      const s3Key = makeStagingS3Key(input.address, input.draft_id, idx);
      await deps.client.send(
        new PutObjectCommand({
          Bucket: deps.bucket,
          Key: s3Key,
          Body: bytes,
          ContentType: input.content_type,
          ContentDisposition: contentDisposition(input.filename),
        }),
      );
      return {
        filename: input.filename,
        content_type: input.content_type,
        size: bytes.byteLength,
        sha256,
        s3_key: s3Key,
      };
    },
    cleanupStagedAttachments: async ({ s3_keys }) => {
      // Best-effort. Each delete is independent; one failure doesn't
      // block the others. Lifecycle rule sweeps anything we miss.
      await Promise.allSettled(
        s3_keys.map((key) =>
          deps.client.send(
            new DeleteObjectCommand({ Bucket: deps.bucket, Key: key }),
          ),
        ),
      );
    },
    getStagedAttachment: async ({ s3_key }) => {
      // Send-from-restored-draft path: hand bytes back inline so the
      // composer can re-emit them as content_base64 on send. A NoSuchKey
      // error means the lifecycle rule swept the blob (or it never
      // landed); collapse to null so the dispatcher can render 404.
      try {
        const out = await deps.client.send(
          new GetObjectCommand({ Bucket: deps.bucket, Key: s3_key }),
        );
        const body = out.Body;
        if (body === undefined) return null;
        const bytes = await streamToBuffer(body);
        return {
          filename: parseDispositionFilename(out.ContentDisposition ?? null),
          content_type: out.ContentType ?? null,
          size: bytes.byteLength,
          content_base64: bytes.toString("base64"),
        };
      } catch (err) {
        if (isNoSuchKey(err)) return null;
        throw err;
      }
    },
  };
}

function isNoSuchKey(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { Code?: unknown }).Code;
  return name === "NoSuchKey" || code === "NoSuchKey";
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  // The S3 SDK returns either a web ReadableStream (Node 18+) or a
  // Node Readable depending on the runtime. transformToByteArray()
  // covers both shapes when present; fall back to manual collection.
  if (
    body !== null &&
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray: unknown }).transformToByteArray ===
      "function"
  ) {
    const arr = await (body as {
      transformToByteArray: () => Promise<Uint8Array>;
    }).transformToByteArray();
    return Buffer.from(arr);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseDispositionFilename(disposition: string | null): string | null {
  if (disposition === null) return null;
  // Prefer RFC 5987 `filename*=UTF-8''…` over the plain ASCII fallback,
  // mirroring what contentDisposition() emits on staging writes.
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (star !== null && star[1] !== undefined) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/.exec(disposition);
  if (plain !== null && plain[1] !== undefined) return plain[1];
  return null;
}

// ADR-0043 (slice 8.22). Canonical staging key shape. The dispatcher
// validates incoming `attachments[].s3_key` matches this prefix for the
// caller's (address, draft_id) so a ref can't be smuggled across mailboxes.
export function makeStagingS3Key(
  address: string,
  draftId: string,
  index: number,
): string {
  return `outbound-staging/${address}/${draftId}/${index}`;
}

// ADR-0043 (slice 8.22). Validates a ref's s3_key carries the expected
// (address, draft_id) prefix. Used by the BFF dispatcher on save_draft
// to reject smuggled refs before they land on the DDB row.
export function isStagingKeyForDraft(
  s3Key: string,
  address: string,
  draftId: string,
): boolean {
  return s3Key.startsWith(`outbound-staging/${address}/${draftId}/`);
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
