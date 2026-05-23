# Draft attachments persist across reloads, slice 8.22

ADR-0040 (slice 8.19) shipped outbound attachments with one explicit
gap: the chip strip carries a `· not saved with draft` label because
attachment **bytes** live in `Composer.tsx` state only. Close the
composer or reload the tab and they're gone — the operator re-attaches
from disk.

ADR-0042 (slice 8.21) intentionally stayed out of attachments.
With rich-text round-trip working (commit `6432663`), the last
"lose work on reload" rough edge in compose is here.

This slice closes that gap. Attachment **bytes** survive autosave by
staging to S3 the moment the operator picks the file; the draft row
stores per-attachment **refs** (S3 key, filename, content type, size,
sha256). Reopening a draft hydrates the chip strip from refs;
`get_attachment` (existing, slice 8.5) is the byte path on send. No
other change to the send pipeline.

## Decision

### A new RPC: `stage_attachment`

Wire shape:

```ts
// Input
{
  address: string;       // mailbox the draft will send from
  draft_id: string;      // attachments are scoped to a draft
  filename: string;
  content_type: string;
  content_base64: string;
}

// Output
{
  s3_key: string;        // outbound-staging/<address>/<draft_id>/<idx>
  filename: string;      // echoed back; the wire is the canonical name
  content_type: string;  // echoed back
  size: number;          // decoded byte size, used by composer's readout
  sha256: string;        // hex; used as a stable client-side id
}
```

The BFF receives base64 bytes inline (matching ADR-0040's inbound
shape on `send_email`), decodes once, validates the size cap (10MB
per file, 25MB total across the draft, ≤ 20 files — same envelope
as ADR-0040), and writes the bytes to S3 under
`outbound-staging/<address>/<draft_id>/<idx>` in the existing
**raw-mime bucket** (`OPENSESAME_RAW_MIME_BUCKET`). The bucket
already has versioning + BPA (ADR-0012). Staging objects are
written with `Content-Disposition: attachment` and the original
filename so a presigned GET round-trips intact.

`<idx>` is the next zero-indexed integer for the draft. The reader
reads existing attachment refs off the row to compute it; concurrent
stage calls from the same draft are linearized by the operator
(humans don't drag-drop two files in the same millisecond). A
collision falls through to PutObject's last-write-wins on identical
key, so the cost is one wasted S3 byte stream — not a correctness
hazard.

### Draft row schema extension

`StoredDraft` gains:

```ts
attachments: Array<{
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  s3_key: string;
}>;
```

Tail-add. Pre-existing draft rows have no `attachments` attribute;
`projectDraftRow` collapses absent → `[]`. Empty `[]` is the
default; `null` is not a valid value (no semantic difference between
"never had attachments" and "had then removed them all"). The
DynamoDB write stores the array as a List of Maps — readable in the
console for debugging.

400KB DynamoDB item cap is not a concern: each ref is ~150 bytes,
20 caps the draft at ~3KB of attachment metadata.

### `save_draft` accepts attachments[]

`SaveDraftInput` gains:

```ts
attachments?: Array<{
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  s3_key: string;
}>;
```

Same absent-vs-set trichotomy as `body_html` (ADR-0042):

| wire | semantic |
|---|---|
| key absent | leave stored attachments alone |
| `[]` | clear all attachments |
| `[ref, ...]` | replace with this exact list |

"Replace with" is the simple-and-correct shape. The composer always
knows the full chip strip; sending the diff would require the BFF to
diff which adds nothing. Removing an attachment is "send the new
list without it"; the orphaned S3 object is cleaned up lazily (see
below).

The schema does **not** trust client-supplied refs blindly. The
dispatcher validates each ref's `s3_key` is shaped
`outbound-staging/<address>/<draft_id>/<N>` for the same address +
draft_id the call carries. A caller can't smuggle a ref to another
mailbox's staging area.

### `get_draft` and `list_drafts` return refs

The reader projects the row's `attachments` list onto the wire
unchanged. The composer uses the refs to render the chip strip
(filename, size). To send, it pre-fetches bytes via
`get_attachment` (slice 8.5, presigned URLs) — the existing path
the inbox reader uses for inbound chips works against
`outbound-staging/` keys without modification.

### `delete_draft` cleans up staged blobs

Today `deleteDraft` is one DDB delete. It gains an S3 cleanup step:
read the row's refs first, batch-delete the matching S3 objects,
then delete the DDB row. Order matters — if the DDB delete were
first, a crash would orphan the bytes. The current order leaves
**partial cleanup** as the failure mode (S3 deleted, DDB deleted,
or S3-deleted-row-survives) rather than orphan-bytes-only.
Idempotent: re-deleting an already-deleted draft is a no-op for
both legs.

### Composer flow

| event | composer action |
|---|---|
| operator drops file | call `stage_attachment` with base64; on success, push ref onto `attachments` state, render chip |
| stage fails (over cap, network) | inline error chip, no state change |
| autosave fires | `save_draft` includes the full current `attachments[]` list of refs |
| operator removes a chip | drop from local state; on next autosave, the saved list shrinks |
| operator reopens draft | `get_draft` returns refs; chip strip hydrates; chip ✕ removes from local + next save |
| operator sends | for each ref, fetch bytes via `get_attachment` (presigned GET → fetch → re-base64); call `send_email` with the existing ADR-0040 `attachments[]` shape; on success, the BFF writes the outbound copy attachments via the regular `attachmentWriter` and the staging S3 objects become eligible for cleanup |
| operator deletes draft | `delete_draft` removes DDB row + S3 objects |

The send path is **wire-identical to today**. The composer hydrates
ref bytes back into the same `content_base64` shape `send_email`
already accepts. Future slices (probably slice 9.x) can short-circuit
this with a `send_from_draft` RPC that lets the BFF read the staging
keys directly, but v1 keeps the send dispatcher untouched.

### Lifetime of orphaned staged blobs

The happy path: `delete_draft` cleans up, `send_email` from a
restored draft is followed by `delete_draft` (the composer's
existing post-send behavior), staging objects are gone within
seconds of the send.

The unhappy paths:

- **Composer crashes between stage and autosave** — orphan with no
  DDB ref. No way to enumerate orphans without scanning S3.
- **Send succeeds, delete_draft fails** — orphan with a stale DDB
  ref. `list_drafts` still surfaces the ref; the operator can retry
  delete.
- **Operator never sends, never deletes** — draft sits indefinitely;
  staging bytes sit indefinitely.

For v1 we accept all three. A dedicated S3 lifecycle rule on
`outbound-staging/` deletes objects untouched for 30 days; a draft
older than 30 days that still references those keys produces a
clean failure on send (S3 returns 404) which the composer surfaces
as "attachment expired, please re-attach". That lifecycle rule is a
CDK change in this slice (`src/cdk/data-plane-stack.ts`).

### CDK + IAM

The BFF Lambda's IAM role already has `s3:PutObject`,
`s3:GetObject`, `s3:DeleteObject` on `OPENSESAME_RAW_MIME_BUCKET`
(slice 8.5 / ADR-0017). The new prefix is under the same bucket;
no new grant.

The new lifecycle rule deletes objects under
`outbound-staging/` after 30 days. Configured on the existing
bucket; doesn't affect `attachments/`.

## Why this shape

We considered three alternatives:

1. **Inline base64 in the draft row.** Simplest wire shape, but
   DynamoDB enforces a 400KB item cap. Three real attachments (10MB
   each, base64-inflated) blow that ceiling instantly. Could chunk
   like `BodyChunks` (ADR-0004) but that's a multi-row transactional
   write per save — large jump in implementation complexity for the
   composer's autosave-every-1500ms cadence. Rejected.

2. **Hand bytes to the composer's `get_attachment` flow on read,
   no staging RPC at all.** The composer would `save_draft` with
   `attachments[]: [{filename, content_type, content_base64}]`,
   and the BFF would write to S3 inside `save_draft`. Rejected
   because it shoves an opaque-byte upload into a hot path
   (autosave fires on every keystroke pause) — most autosaves don't
   add a new attachment, and re-uploading the same 10MB on every
   keystroke is a non-starter. Splitting the verb (`stage_attachment`
   for adds, `save_draft` for everything else with refs) keeps the
   hot path cheap.

3. **S3 multipart upload with presigned URLs.** Browser uploads
   directly to S3, bypassing the BFF for bytes. More AWS plumbing
   (CORS on the bucket, IAM scoping the presigned PUT to the right
   prefix) but no BFF byte cost. Worth doing later if upload size
   limits grow past 25MB; for v1 the BFF byte cost is acceptable
   and the implementation is half the size.

## Files

| Layer | File | Change |
|---|---|---|
| Core types | `src/core/store.ts` | Tail-add `attachments` to `StoredDraft`; add `StageAttachmentInput` / `Result`; extend `SaveDraftInput` |
| Reader | `src/aws/dynamodb-reader.ts` | `saveDraft` writes `attachments`; `projectDraftRow` reads them; `deleteDraft` cleans up S3; new `stageAttachment` method |
| Reader (S3) | `src/aws/s3-attachment-store.ts` | Add `stageAttachment` (writes under `outbound-staging/`) and `cleanupStagedAttachments` (batch deletes a list of keys) |
| Schemas | `src/bff/schemas.ts` | New `parseStageAttachmentInput`; extend `parseSaveDraftInput` to accept `attachments[]`; validate refs scope |
| Dispatcher | `src/bff/dispatcher.ts` | New `handleStageAttachment` case; plumb `attachments` through `handleSaveDraft` |
| BFF entry | `src/bin/webmail-bff.ts` | Wire `stageAttachment` deps (S3 client + bucket name) into the reader |
| Composer | `src/web/src/components/Composer.tsx` | On add → call `stage_attachment`; on autosave → include refs; on reopen → hydrate chips; on send → fetch via `get_attachment` and re-base64 |
| BFF client | `src/web/src/lib/bff-client.ts` | Add `stageAttachment(input)` method |
| CDK | `src/cdk/data-plane-stack.ts` | Lifecycle rule on `outbound-staging/` (30 days) |
| Tests | `test/drafts.test.ts`, `test/bff-schemas.test.ts`, `test/bff-dispatcher.test.ts` | Round-trip with N attachments; absent / empty / replace cases |

## Failure modes

| case | outcome |
|---|---|
| operator picks a 12MB file | client rejects pre-stage (existing ADR-0040 cap); no S3 byte cost |
| over-cap caller bypasses client | BFF returns 400 with `field: "content_base64"` from `parseStageAttachmentInput` |
| stage_attachment fails mid-write | client receives 5xx; chip is not added; bytes either landed in S3 or didn't (S3 PutObject is atomic per key); no DDB orphan |
| save_draft from a restored draft removes a ref | S3 object orphaned; lifecycle rule sweeps within 30 days |
| send from restored draft, S3 GET fails | composer surfaces "attachment unavailable"; send is blocked until operator re-attaches |
| delete_draft S3 batch-delete partially fails | DDB row already deleted, some staged blobs remain; lifecycle rule sweeps; idempotent re-delete is a safe no-op (DDB Get returns null) |
| pre-existing draft (slice 8.17, no `attachments` attr) | reader projects to `[]`; composer renders empty chip strip |
| operator opens two composers on the same draft | both write same `attachments[]` list (last-write-wins, same as `body_text`); orphaned bytes lifecycle-swept |

## What we're not doing

- **No attachment dedup across drafts.** Same PDF in two drafts =
  two staging objects. Per-draft cleanup, no cross-draft reference
  counting.
- **No streaming uploads.** Base64 inline on `stage_attachment`
  matches `send_email`; the existing 25MB total cap keeps the
  request size manageable.
- **No `send_from_draft` RPC.** Composer hydrates bytes via
  `get_attachment` and calls existing `send_email` with the bytes
  re-encoded. The optimization is real but defers the slice.
- **No background "still uploading" UX.** Stage is synchronous from
  the composer's perspective. The chip appears when the BFF
  responds; loading state is the existing `aria-busy` chip pattern.
- **No CSP/CORS changes.** The composer talks to the BFF only;
  the BFF talks to S3 server-side. No browser-direct S3 uploads
  in this slice.
- **No shared drafts.** A staged blob's ACL is the bucket's BPA;
  only the BFF Lambda's IAM role reads or writes. No presigned URLs
  for staging objects (they're internal).

## Verification

1. Compose with one PDF attached. Wait for autosave. Console:
   `stage_attachment` 200 → `save_draft` 200 with `attachments[1]`.
2. Close composer, reopen draft. Chip strip hydrates with the PDF.
3. Send. Recipient's mail client shows the PDF intact.
4. Compose with two attachments. Delete one. Save. Reopen. Only
   the kept one is present.
5. Compose with one attachment. Delete the draft. Verify the
   staged S3 object is gone (`aws s3 ls
   s3://OPENSESAME_RAW_MIME_BUCKET/outbound-staging/<address>/<draft_id>/`
   returns nothing).
6. Pre-existing draft (created before this slice): reopen.
   Composer renders zero chips, no errors. Add an attachment;
   round-trip works.
