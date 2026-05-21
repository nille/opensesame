# Single-store DynamoDB with body chunking; raw MIME in S3; SQLite-trigram-in-S3 deferred as upgrade path

The ingest Lambda fans out a received message into two storage destinations:

1. **Raw MIME → S3** (canonical archive, write-once, never modified). The source of truth from which any derived data is rebuildable.
2. **DynamoDB** (multi-table: `Messages`, `Grants`, `Audit`) holds metadata, flags, threading IDs, a `headers_blob` for arbitrary-header search, and the message body — split into one or more **body chunks** of ~300 KB each, stored under the message's partition. Adjacent chunks overlap by 256 bytes so any search term up to 256 bytes is fully contained within at least one chunk; match dedup is by `message_id`.

Search semantics:

- **Inbox listing, keyed fetch, flag flips:** DynamoDB hot path, sub-100 ms.
- **Search:** DynamoDB `contains` filter over body chunks and `headers_blob`. Latency 3–10 s, scaling with total body bytes on the queried Address. Substring-only — no stemming, no ranking, no phrase or boolean operators beyond what FilterExpression composition provides.
- **Attachment binary content is not searchable in v1.** Attachments remain in the raw MIME archive in S3 and are served lazily via a separate fetch path. This matches the IMAP `BODY` search baseline (Dovecot, Cyrus, Gmail-IMAP all search textual body parts only).

This shape gives v1 IMAP-baseline `SEARCH` parity for the primitives clients actually use (`FROM`, `TO`, `SUBJECT`, `BODY`, `TEXT`, `HEADER`, `BEFORE`/`SINCE`, `LARGER`/`SMALLER`, flag predicates, boolean composition) without a body size cap. `MODSEQ` (CONDSTORE / RFC 7162) is intentionally deferred — it only matters if and when an IMAP wire-protocol front-end is ever in scope.

We considered and rejected several alternatives:

- **OpenSearch (Serverless or managed):** rejected on cost — Serverless has a ~$350–700/mo idle floor; the smallest managed cluster (~$28/mo) crosses our cost intent. Its unique advantage (linguistic Swedish FTS with decompounding) addresses a "nice-to-have, not necessary" requirement.
- **Aurora Serverless v2 + tsvector:** rejected — 5–15 s cold starts after 0-ACU pause hit exactly when agent activity is intermittent, which is the system's intended usage. The savings vanish under active-agent traffic.
- **RDS Postgres + pg_trgm:** functionally adequate (~$15/mo, sub-100 ms warm, good FTS) but doesn't beat the single-store DynamoDB option for our scale and adds a second engine.
- **Athena over Parquet:** previously considered as an FTS path; superseded — DynamoDB `contains` reaches the same functional ceiling without a second storage tier.
- **PGlite-in-S3:** `tsvector` solves a problem (stemming) we explicitly do not need, and the substring-in-token requirement is a poor fit for its strengths.
- **DynamoDB body chunking alternatives:** body in S3 with on-demand scan (rejected: fan-out makes broad searches slow and expensive), separate `BodyChunks` table (rejected: higher per-search cost than inline chunking), tokenize-and-store (rejected: half-builds Option B in a worse form).

**Documented upgrade path (v2):** if search use grows heavy or per-Address mailbox size makes the partition-scan-with-`contains` model too slow, add a per-Address SQLite-FTS5 index with the trigram tokenizer in S3, populated via DynamoDB Streams as a backfill and dual-write going forward. The MCP search tool's contract does not change. Per-Address single-writer is enforced via SQS FIFO with `MessageGroupId = address`. This is the same architectural pattern that mature IMAP servers (Dovecot's `fts-flatcurve`, Cyrus's Xapian backend) ship as opt-in plugins on top of an A-style baseline; we follow that lineage.

Trade-offs accepted: 3–10 s search latency in v1 (acceptable per IMAP-server norms — Dovecot's default no-FTS install behaves the same way); attachment binary content unsearchable until OCR/Textract is added at ingest as a future feature; ~0.085% storage overhead from chunk overlap; multi-table over single-table DynamoDB at this scale (single-table aggregation pattern earns its complexity only when optimizing cost-at-scale).
