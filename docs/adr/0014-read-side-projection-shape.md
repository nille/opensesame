# Read-side projection shape: structured headers + raw blob, body assembled from chunks, html/attachments deferred

ADR-0007 fixes the v1 MCP tool surface; ADR-0010 fixes the on-the-wire `MailIngested` shape; ADR-0013 fixes the DynamoDB key model. This ADR pins the **`ReadMessage`** shape — what `get_message`, and any future caller that asks "give me one stored message", actually receives. Pinning this now keeps the read-side from drifting away from the write-side as the parser learns new tricks.

## Decision

### `ReadMessage` is a tagged union on `parse_status`

```ts
type ReadMessage = ReadMessageOk | ReadMessageFailed;

type ReadMessageOk = {
  parse_status: "ok";
  schema_v: "1";
  address: string;
  internal_id: string;
  received_at: string;
  raw_s3_uri: string;
  headers: StoredMessageHeaders;     // structured projection
  headers_blob: string;              // raw RFC 5322 bytes (CRLF preserved)
  body_text: string;                 // assembled from MessageBodyChunks
};

type ReadMessageFailed = {
  parse_status: "failed";
  schema_v: "1";
  address: string;
  internal_id: string;
  received_at: string;
  raw_s3_uri: string;
  parse_error: string;
};
```

Every reader branches on `parse_status` before touching content fields, mirroring the write-side contract from ADR-0012. The address/timestamp/raw_s3_uri identity tuple is identical across both branches so callers can route a skeleton row back through replay-ingest without re-asking the index for it.

### `headers` is a structured projection, `headers_blob` is the raw bytes

The read shape carries **both**:

- `headers` — a flat object with the named fields ADR-0010 commits to (`from`, `to`, `cc`, `subject`, `date`, `message_id`, `in_reply_to`, `references`, `auto_submitted`, `list_id`). Nullable where the inbound header was absent. RFC 2047 encoded-words are already decoded by the parser, so callers see human-readable strings.
- `headers_blob` — the raw header bytes with CRLF preserved. ADR-0004 commits to arbitrary `HEADER` search over this blob; the read path must therefore round-trip it untouched.

These are not redundant. The structured projection is what agents reason over; the blob is what the search path matches against and what an "export EML" path would round-trip. Splitting them lets the structured shape evolve (custom-headers map, threading hints) without touching the canonical bytes.

### `body_text` is the assembled-from-chunks string

`body_text` is reconstructed by `assembleBody()` (`src/core/reader.ts`) from the `MessageBodyChunks` rows that ADR-0013 commits to. The function is the byte-exact inverse of `chunkBody()`: it strips the codepoint-aligned overlap window between adjacent chunks before stitching, so the result equals `parsed.bodyText` from the original ingest run.

Defensive ordering: `assembleBody` refuses to silently reorder rows or paper over a missing first chunk. DynamoDB Query with `ScanIndexForward=true` over the zero-padded `chunk_seq` SK already returns the right order; if it doesn't, that's a contract violation upstream and we want loud failure, not a body that looks fine but is missing its first 300 KB.

### `body_html` and `attachments` are deferred to a later slice

**Not in `ReadMessage` v1.** The write-side (`src/aws/dynamodb.ts`) currently persists only `bodyText` as chunk rows — `bodyHtml` and `attachments[]` are extracted by the parser but never written. Surfacing them on the read side without a write-side change would be a lie.

The agreed write-side extension (next slice):

- **`body_html`** stored as additional chunk rows on `MessageBodyChunks` with a `kind` attribute distinguishing `text` from `html`, OR a parallel chunk SK prefix (`text/0000`, `html/0000`). Decision pinned in the html-chunking slice.
- **`attachments[]`** stored as a list attribute on the `Messages` row. Each entry carries `{filename, content_type, size_bytes, content_id}` (the `AttachmentSummary` shape the parser already emits). Binary content stays in the S3 raw MIME object — agents fetch it via a separate, lazy `get_attachment(message_id, attachment_index)` path so the hot read path never carries multi-MB payloads.

Both fields will land on `ReadMessageOk` as `body_html: string | null` and `attachments: AttachmentSummary[]`. Adding optional fields is non-breaking under the schema_v = "1" envelope per ADR-0011.

### The reader is a port, with a DDB adapter

`MessageReader` lives in `src/core/store.ts` alongside `MessageStore`, with two methods:

- `getByMessageId(messageId)` — GSI1 hop → primary-key fetch → chunks Query.
- `getByPrimaryKey(address, internalId)` — primary-key fetch → chunks Query.

Splitting them keeps the GSI1 hop out of the hot path: callers that already hold the (address, internal_id) pair (e.g. an inbox listing handing rows to `get_message`, the replay-ingest driver, or a Lambda that already processed the row in this invocation) pay one Query, not two.

## Considered and rejected

- **Fold `headers` and `headers_blob` into one field, recompute the blob on read.** Rejected — the blob must be byte-exact for ADR-0004's HEADER search, and recomputing from a structured projection silently drops headers we don't have a field for (Received chains, ARC-* signatures, X-* customs). Storage cost is a few KB per message; a small price for not lying about what the original bytes were.

- **Single `body` field that flips between text and html.** Rejected — agents need both for HTML-aware rendering paths. The write-side already extracts both; collapsing them on read forces a lossy choice the caller didn't ask for.

- **Eager attachment binaries on `get_message`.** Rejected — multi-MB inline payloads in tool results blow agents' context windows. ADR-0007 already commits to `attachments[]` being a metadata list, with `get_attachment` (not v1) for binaries. The ReadMessage shape mirrors that contract.

- **Return `null` for `headers_blob` on skeleton rows by including the field with a null value on `ReadMessageFailed`.** Rejected — keeping the failed branch narrow (no content fields at all, just the identity + the error) is the whole point of ADR-0012. Optional-everywhere would force every reader to defensively null-check fields that can never be present together, blurring the parse-state contract the union protects.

- **Make the chunk-assembly function tolerant of out-of-order rows.** Rejected — see "defensive ordering" above. The whole point of zero-padded `chunk_seq` is that ascending lex order *is* numeric order. Re-sorting hides bugs in the storage layer; refusing to assemble surfaces them.

## Trade-offs accepted

- **Two Queries per `get_message` by Message-ID** (GSI1 hop, then chunks). Both sub-100 ms; matches ADR-0004's hot-path budget. Direct primary-key callers pay one Query for chunks plus one Get for the row.
- **`body_text` is fully materialized in memory** during `assembleBody`. At the 25 MB SES inbound limit this is ~100 chunks of 300 KB; trivial for a Node process. If a future requirement adds multi-GB messages (forwarded archives, etc.) we'll revisit with a streaming variant. Not speculative work for v1.
- **Read-side and write-side projections are pinned together but evolve in lockstep.** The `body_html` / `attachments` extension lands on both sides in the same slice. Drift is the failure mode this ADR exists to prevent.
- **The reader port lives in `src/core/store.ts` next to `MessageStore`.** Symmetric with the write-side; one place to look for "how does this system talk to its own storage". A later refactor may split the file if it grows past the ~400-line guideline.
