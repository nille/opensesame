# Outbound attachments, slice 8.19

The send story has been one-attachment-shaped-hole-shy of complete since
slice 1: `send_email` produces RFC 5322 bytes via
`composeRawMime` (ADR-0007), persists the outbound copy via the same
`attachmentWriter` the inbound path uses (ADR-0017), and surfaces the
result in the reader with the existing `Attachments` component
(slice 8.5). What's missing is the bit in the middle: the composer's
`renderBody` only emits `text/plain` (or `multipart/alternative` when
HTML is present) — no `multipart/mixed`, no part for a file payload,
no upload affordance in `Composer.tsx`.

The receive side is fully wired. `read_inbox` already returns
`attachments[]` per row; the reader already renders a chip list with
lazy-loaded download links via `get_attachment` (slice 8.5). Search
already filters by `has:attachment` (ADR-0036). What's missing is
the *send* side.

This slice closes that gap. It is intentionally narrow: webmail
upload only, inline base64 on the wire, capped at 10MB per file and
25MB total — the same envelope SES accepts on `SendRawEmail`. No
S3 pre-staging, no presigned uploads, no resumable uploads. Future
slices can lift those caps when the use case warrants it.

## Decision

### Wire shape: `attachments[]` on `SendEmailInput`, base64 inline

Extend the existing `send_email` RPC's input schema with one optional
field:

```ts
attachments?: Array<{
  filename: string;
  content_type: string;     // MIME type, e.g. "application/pdf"
  content_base64: string;   // base64-encoded bytes
}>;
```

- `filename` is what the recipient sees in their MUA. Encoded with
  RFC 2047 only when it contains non-ASCII bytes (same posture as
  the subject header today).
- `content_type` is the part's `Content-Type` header value. The BFF
  trusts it — if the operator/agent picks the wrong one, that's a
  caller bug, not a server-side classification problem. The composer
  defends against header injection (no CR/LF in any field).
- `content_base64` is the part body, base64-encoded by the *caller*.
  The composer re-emits it with `Content-Transfer-Encoding: base64`
  and 76-column line folding (RFC 2045 §6.8). Re-encoding in place
  is cheap and avoids a separate `Buffer` round-trip on the BFF
  side.

The *whole field is optional*. A `send_email` call with no
`attachments[]` is wire-identical to today's call — no
`multipart/mixed` wrapper is emitted. Existing callers (drafts
restore, reply, send-and-archive) keep working without changes.

### Caps: 10MB per file, 25MB total, ≤ 20 files

These mirror the AWS SES SendRawEmail limit (40MB raw, ~30MB after
base64 inflation) with margin for the headers and body. Enforced at
two boundaries:

- **Composer.tsx** (client): rejects `File` objects whose `size`
  exceeds the per-file cap *before* reading them, and rejects the
  Add when adding would push the running total over 25MB. This is
  the operator-friendly path — instant feedback, no upload time
  wasted.
- **BFF dispatcher** (server): returns 400 with `field:
  "attachments"` when the inflated total exceeds the cap. Defense
  in depth — an MCP agent might bypass the client check.

Counted against the cap is the *base64-decoded* size, since base64
inflation (~33%) is overhead the recipient never sees. The
composer's wire output, including base64 padding, is what SES
rejects, so the BFF check uses the raw decoded total + a 33%
margin.

`> 20 files` is rejected in the same place. Twenty is a soft limit —
beyond that, an operator wants either a Zip or a shared link.
Enforcing the limit on the wire keeps the composer's chip strip
readable.

### Composer.tsx UX: drop zone + file picker, chip strip, size readout

The composer surface gains:

- An **Attach** button next to the existing **Send** action. Opens
  the OS file picker with `multiple` enabled. No filter — the
  composer trusts the operator's content-type pick, but the picker
  uses the OS's MIME map for the `accept` hint (so common types
  show with friendly names).
- A **drop zone**: the entire compose card accepts `dragover` /
  `drop`. Dropped files run the same validation path as picker
  files — over-cap files are rejected with an inline error chip,
  not silently dropped.
- A **chip strip** below the body editor showing each accepted
  attachment as `filename · NN KB ✕`. Clicking the `✕` removes the
  entry. The strip is sorted by add-order; no thumbnails (v1).
- A **size readout** at the right edge of the strip:
  `12.4 / 25 MB · 3 / 20 files`. Mono, faint when under 80%, switches
  to warning color past 80%, error past 100%. The composer's
  Send button disables when over cap so there's no confusion about
  why a send fails.
- **Compose-state survives reload** through the existing draft
  autosave — but attachments do **not**. Attachments are bytes, not
  text, and the draft store is a JSON record per ADR-0035. v1 keeps
  attachments in-memory only; closing the composer drops them.
  The chip strip carries a faint `· not saved with draft` line so
  the operator knows.

### MIME assembly: `multipart/mixed` wraps `multipart/alternative`

`composeRawMime` gains a third branch. The decision tree becomes:

| body shape | wire shape |
|---|---|
| text only, no attachments | `text/plain` (today) |
| text + html, no attachments | `multipart/alternative` (today) |
| text only, attachments | `multipart/mixed` containing one `text/plain` part + N attachment parts |
| text + html, attachments | `multipart/mixed` containing one `multipart/alternative` (with text + html) + N attachment parts |

Both new branches use a fresh boundary string per outer wrapper,
generated from the same `randomBytes()` source the existing
boundary uses. Each attachment part carries:

```
Content-Type: <content_type>; name="<filename>"
Content-Disposition: attachment; filename="<filename>"
Content-Transfer-Encoding: base64

<76-col-folded base64>
```

Both `Content-Type` and `Content-Disposition` carry the filename —
the former is RFC 2047-encoded if non-ASCII, the latter uses RFC
5987 (`filename*=UTF-8''…`) for non-ASCII. Both are defensive: most
MUAs read one, some read the other, all of them tolerate both.

CR/LF and NUL bytes are rejected from `filename` and `content_type`
at the composer boundary. This is the only sanitization the
composer does — the rest is the caller's responsibility.

### Persist path: unchanged

The persist path is already attachment-aware (ADR-0017). Once
`composeRawMime` emits a multipart/mixed message, the existing
`makeS3AttachmentWriter` path through `persistOutbound` will store
each attachment under `s3://opensesame-raw-mime-…/attachments/…`
with the same key shape inbound attachments use. The reader loads
them via `get_attachment` exactly as it does today.

This is the slice's main payoff: by the time the composer can emit
a multipart/mixed message, the rest of the system already knows
what to do with it. No new RPC. No DDB schema change. No new S3
prefix.

### What stays unchanged

- **`reply_to_email` and `send_and_archive`**: same code path.
  Both already wrap `send_email`'s input shape and pick up the new
  field for free. Reply attachments work in v1.
- **Draft schema (ADR-0035)**: drafts hold text + recipients. v1
  does not persist attachments to drafts. The compose-card wipes
  attachments on close-and-reopen-from-draft. The chip strip's
  `· not saved with draft` line tells the operator. Future slice
  may add `draft_attachments` if the use case warrants the
  S3-staging cost.
- **`get_attachment` and reader rendering**: untouched. The slice
  produces wire bytes the existing inbound code path already
  understands.
- **MCP tool surface**: `send_email`'s schema gains the optional
  field, advertised through the same `tool_definitions` channel.
  Clients that don't pass `attachments[]` see no change.

### Where it lives

- `src/web/src/components/Composer.tsx` — file picker, drag-drop
  handler, chip strip, size readout, base64 conversion (via
  `FileReader.readAsArrayBuffer` + a small base64 encoder helper).
  The composer state grows one field: `attachments: Attachment[]`.
- `src/web/src/lib/bff-client.ts` — `SendEmailInput.attachments?`
  added. Type-only change.
- `src/core/composer.ts` — `ComposeInput.attachments?` added.
  `renderBody` reshapes into the multipart/mixed branch when
  attachments are present. New helpers: `renderAttachmentPart`,
  `foldBase64`, `encodeFilename`. Plus per-attachment caller-data
  validation (CRLF rejection).
- `src/bin/webmail-bff.ts` — translate `SendEmailInput.attachments`
  into `ComposeInput.attachments`. Enforce the 25MB / 20-file cap
  with a 400 response.

### Failure modes (explicit)

| Case | Outcome |
|---|---|
| One file is 11MB | Client: rejected at picker time with chip-strip error. Server: 400 if it slips through |
| 24MB file + 2MB file (over total) | Client: second file rejected, first stays. Server: 400 if both get through |
| 21st file added | Client: rejected with chip-strip error |
| Filename contains a literal CRLF | Composer rejects the whole send with a 422-like client error. Header injection is the worst case here, so we fail closed |
| `content_type` is empty or malformed | Composer falls back to `application/octet-stream` (RFC 2046 §4.5.1). The recipient's MUA picks based on the filename extension |
| Operator drops a 0-byte file | Accepted. The recipient gets a 0-byte attachment, which is what the operator asked for |
| Operator restores draft after attachment add | Attachments gone (per "not saved with draft" line). Body + recipients restore as today |

### What we're not changing

- **No S3 pre-staging.** Inline base64 keeps the slice client-only
  on the upload side and matches the SES envelope. If we ever need
  to lift the 25MB cap, the followup is a `stage_attachment` RPC
  that returns a presigned PUT and an opaque key, plus a
  `attachment_keys[]` field on `send_email`. That's a different
  ADR.
- **No client-side virus scanning.** SES accepts what we send;
  the recipient's MUA scans on their side. Adding scanning would
  require a Lambda hook the inbound side doesn't have either.
- **No image inline / cid: references.** A future slice could add
  `Content-Disposition: inline` and `Content-ID:` for HTML body
  references. v1 is `attachment` disposition only.
- **No drafts persistence for attachments.** As above.
- **No keybind for attach.** `c` opens compose, the **Attach**
  button is two clicks away; the file picker is the affordance.
  Adding a keybind would imply a focus model the composer doesn't
  yet have. Future slice.

## Implementation

1. **`src/core/composer.ts`** — extend `ComposeInput` with optional
   `attachments?: Array<{ filename, contentType, contentBytes:
   Uint8Array }>`. Add `renderBody`'s third branch (multipart/mixed
   wrapping the existing alternative or text branch). Add
   `renderAttachmentPart(att, boundary)` and `foldBase64(bytes,
   columnWidth = 76)` helpers. Validate filename / contentType for
   CRLF/NUL; throw on violation.
2. **`src/web/src/lib/bff-client.ts`** — extend `SendEmailInput`
   with optional `attachments?: Array<{ filename, content_type,
   content_base64 }>`. Type-only change.
3. **`src/bin/webmail-bff.ts`** — translate the wire shape
   (`content_base64` → `Uint8Array`) into `ComposeInput.attachments`.
   Reject inputs that exceed 10MB per file, 25MB total decoded, or
   20 files with a 400 carrying `field: "attachments"`.
4. **`src/web/src/components/Composer.tsx`** — add `Attach` button,
   drag-drop handler, chip strip, size readout. New state: an
   `attachments` array of `{ id, filename, contentType,
   contentBase64, decodedSize }`. `Send` and the two reply paths
   pass `attachments` through to the RPC. Disable Send when over
   cap. Show `· not saved with draft` on the strip.
5. **Tests**
   - `test/composer.test.ts` — extend with cases for: text-only +
     1 attachment (asserts multipart/mixed envelope, one
     text/plain part, one attachment part, base64 line-folded at
     76 cols, both Content-Type and Content-Disposition carry the
     filename); text + html + 1 attachment (multipart/mixed wraps
     multipart/alternative wraps text+html, then attachment);
     filename with non-ASCII (RFC 2047 / RFC 5987); CRLF in
     filename → throws; empty content_type → falls back to
     application/octet-stream.
   - `test/web/composer.test.tsx` — extend with: file picker accepts
     valid file (chip appears with size + mime); over-cap file
     rejected (error chip, not added to state); total cap reached
     (next add rejected); drag-drop adds files (same path as
     picker); remove-x clears one chip; Send disabled when over
     cap; Send invokes with `attachments[]` populated.
   - `test/bff/dispatcher.test.ts` (or wherever send_email's input
     schema lives) — extend with: cap-enforcement returns 400 with
     `field: "attachments"`; valid call passes `attachments[]`
     through.

## Considered and rejected

- **S3 pre-staging via `stage_attachment` RPC.** Two-RPC dance
  (presigned PUT, then `send_email` with opaque keys). Rejected for
  v1: the 25MB cap covers >99% of real attachments and matches what
  SES accepts on `SendRawEmail`. The two-RPC dance pays its cost
  (server-side staging UX, garbage collection of orphaned uploads)
  for files that don't fit, which v1 doesn't promise to handle.
  Path stays open for v2.
- **Server-side virus scanning.** Inbound also doesn't scan. If we
  add it later, it lives on the inbound persist path (so we
  classify what we deliver to the operator), and only mirrors on
  outbound if we want to refuse known-bad sends. Out of scope.
- **Image inline (`cid:` references).** Useful for HTML bodies
  with embedded images. Rejected for v1: the composer doesn't
  expose an image-insert affordance in the body editor; without
  that, the only way to use `cid:` is to hand-author HTML, which
  the composer doesn't surface. Future slice.
- **Persist attachments to drafts.** Drafts (ADR-0035) are JSON
  records keyed by address. Attachments would either inflate the
  record (>400KB DDB cap is real) or stage to S3 (the same
  pre-staging slice we deferred). Rejected: drafts stay text-only
  for v1, with a visible `· not saved with draft` cue on the chip
  strip so the operator isn't surprised.
- **Drag-from-Finder direct (no chip strip).** Drop a file on the
  composer, it sends. Rejected: no review step, no remove
  affordance, no size readout. Composers everywhere have chips for
  a reason.
- **Auto-zip when over cap.** Pleasant in theory; in practice
  bumps the slice into a Web Worker dependency for compression
  speed and changes the wire bytes the recipient sees in subtle
  ways (zip-of-one is unusual). Rejected: better to surface the
  cap and let the operator decide.
- **Per-attachment progress bar.** Inline base64 means the
  upload-and-send happen in a single RPC; there's no upload step
  to show progress for. The composer just shows a "sending…"
  state on the Send button until SES returns.
- **Allow operator to override `content_type`.** A free-text MIME
  field on each chip. Rejected: the operator chose the file by its
  type already, the picker used the OS MIME map, and the override
  is a footgun. If it ever matters, add it later.
