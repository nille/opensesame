// Port for the raw-MIME object writer (ADR-0017). Pure types in core; the
// S3-bound implementation lives in src/aws/s3-raw-store.ts.
//
// Inbound mail goes to S3 via the SES receipt action — ingest never writes
// raw bytes itself. Outbound mail has no equivalent SES-side path, so the
// operator-driven send path writes the canonical raw object before persisting
// the Messages row. Symmetric in shape to MessageStore: a port in core, an
// adapter in aws/.

export type RawObjectInput = {
  // S3 bucket name. Same bucket as inbound (ADR-0017) — the `outbound/`
  // prefix in the key is what distinguishes direction at the storage layer.
  bucket: string;
  // Full key under the bucket. The persist-outbound orchestrator builds it as
  // `outbound/{sesMessageId}` per ADR-0017; this port stays prefix-agnostic
  // so a future caller can pin a different layout without changing the port.
  key: string;
  raw: Uint8Array;
};

export interface RawMessageWriter {
  // Idempotent in semantics — re-running with the same key overwrites the
  // same S3 object byte-for-byte. The bucket has versioning ON (ADR-0012)
  // so a retry produces a new version, not a corrupted object.
  putRaw(input: RawObjectInput): Promise<void>;
}
