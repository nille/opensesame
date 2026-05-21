# Messages table layout: PK=address, two-table split for body chunks, single GSI on `message_id`

ADR-0004 commits to a multi-table DynamoDB layout (`Messages`, `Grants`, `Audit`) with body chunking but leaves the per-table key model unspecified. ADR-0007 fixes the read patterns; ADR-0010 fixes the on-the-wire `MailIngested` shape; ADR-0012 fixes the failure-recovery model. This ADR pins the `Messages` table primary key, the body-chunk co-location strategy, and the GSI shape that satisfies the v1 tool surface.

## Decision

### Two tables

- **`Messages`** — one row per inbound message. Carries metadata, flags, threading IDs, the `headers_blob`, and (when `parse_status: "ok"`) the structured header fields ADR-0010 mirrors. Skeleton rows (per ADR-0012) live here with `parse_status: "failed"`.
- **`MessageBodyChunks`** — one row per body chunk produced by `chunkBody()` (per ADR-0004).

### Keys

```
Messages
  PK  = address          (e.g. "alice@acme.com")
  SK  = internal_id      (lexicographically time-sortable, deterministic per S3 key)

  GSI1
    PK = message_id      (RFC 5322 Message-ID, raw with brackets)
    SK = received_at     (ISO-8601 UTC; pins ordering when message_id repeats — see below)

MessageBodyChunks
  PK  = internal_id
  SK  = chunk_seq        (zero-padded integer, e.g. "0001")
```

Every row carries `schema_v: "1"` per ADR-0011.

### Why these keys

- **Inbox listing** (`read_inbox(address)`, ADR-0007) is the dominant read pattern. PK=address makes it a single `Query` with `ScanIndexForward=false` — sub-100ms, no GSI hop. The opaque `cursor` of ADR-0007 maps to `LastEvaluatedKey`.
- **Body co-location.** Putting chunks under their own PK=internal_id means `get_message` body assembly is one `Query` ordered by chunk_seq. Inbox listing never sees chunk rows — no sparse-GSI-or-FilterExpression workaround for the rest of the system's life.
- **`get_message(message_id)`** uses GSI1: one `Query` to resolve `message_id → internal_id + address`, then the `Messages` row by primary key plus the body chunks `Query`. Sub-100ms each; well inside ADR-0004's hot-path budget.
- **`mark_read` / `mark_flagged` / `delete_message`** take `message_id` per ADR-0007. Same GSI1 lookup → `UpdateItem` on the resolved primary key. Soft delete is a `deleted: true` attribute on the `Messages` row; the row stays so the audit trail and the ADR-0010 event lineage remain consistent.
- **`list_threads`** is reader-side grouping by `thread_id` over the inbox `Query`. No GSI on `thread_id` in v1 — speculative until search/throughput shows otherwise.

### `internal_id` requirements (scheme deferred)

`internal_id` is a string with two contracts:

1. **Lexicographically sortable** so `ScanIndexForward=false` returns messages newest-first.
2. **Deterministic per canonical S3 object key** so re-running the ingest Lambda on the same SQS message rewrites the same DDB items (ADR-0012's idempotency).

A ULID seeded with `received_at` as the timestamp component and a SHA-256 of the S3 key as the random component satisfies both. The exact scheme is decided in the ingest-Lambda slice and pinned there. v1 test fixtures are ULID-shaped (`01HF7E…`) for readability; the scheme commitment is not in this ADR.

### Skeleton rows

Live in `Messages` with `parse_status: "failed"`, `parse_error: "<reason>"`, `raw_s3_uri`, and the address/timestamp fields. No `headers_blob`, no entry in `MessageBodyChunks`. Readers branch on `parse_status` before touching content fields, per ADR-0012.

### Headers blob

`headers_blob` (ADR-0010) lives on the `Messages` row. Sized in low-tens of KB per message — comfortably below DynamoDB's 400 KB item limit when combined with the rest of the metadata. If a future header-heavy edge case threatens the limit, the blob moves to its own table; not speculative work for v1.

## Considered and rejected

- **Single table with SK convention `<ulid>#meta` / `<ulid>#chunk-NNNN`.** One table, but inbox `Query` returns mixed item types — every inbox read needs a sparse GSI on `is_message` or a per-Query `FilterExpression` to skip chunks. Operational tax that compounds with every reader. Two tables is cheaper end-to-end.
- **Embed body chunks as a List attribute on the `Messages` row.** The 400 KB item limit is exactly the constraint chunking exists to remove (ADR-0004). Half-builds the rejected option.
- **PK = `internal_id` on `Messages`, GSI for inbox by address.** Inverts the access-pattern frequency: every inbox read pays a GSI hop while `get_message` (less frequent) gets a direct lookup. Chosen direction was wrong.
- **GSI on `thread_id` for `list_threads`.** Speculative; v1 grouping is reader-side over the inbox `Query` and the dataset sizes ADR-0004 contemplates make that fine. Adds a write-amplification cost for every message.
- **GSI on `received_at` for cross-address admin views.** Not in the v1 tool surface. The `Audit` table covers cross-address operator queries.
- **`internal_id` = raw SES Message-ID.** Not lexicographically time-sortable; provides no ordering guarantee against duplicate Message-IDs in practice (mailing-list relays, retransmits).

## Trade-offs accepted

- **Two-table writes per message** for the happy path. `TransactWriteItems` handles atomicity within DynamoDB's 100-item / 4 MB transaction limits. A ~30 MB body produces ~100 chunks at the 300 KB default — at that scale we exceed the transaction limit. The composer writes the `Messages` row and chunks in two phases: chunks first, then the metadata row last. A reader that finds a `Messages` row can trust the chunks exist; an interrupted write leaves orphaned chunks the reconciliation job sweeps. This trades transactional simplicity for headroom up to the 25-MB SES inbound limit.
- **`get_message` is two `Query`s** when called by RFC `message_id` (GSI1 then chunks). Both sub-100ms; matches ADR-0004's latency budget. Direct primary-key lookups (after `internal_id` is in hand from any inbox view) are one `Query`.
- **GSI1 cost.** Doubles the write cost for messages with a populated `Message-ID` header. Acceptable; the lookup pattern is core to ADR-0007.
- **`internal_id` scheme is unspecified here.** Deliberate; the ingest-Lambda slice commits to one. The `Messages` table can be created and populated by tests in the meantime as long as the scheme satisfies the two contracts above.
