# Outbound copy persistence: same Messages table, `direction` field, S3 under `outbound/{ses_message_id}`

ADR-0007 lists `send_email` and the future read-side primitives (`get_message`, `read_inbox`). ADR-0015 pinned the composer + SES adapter (slice 1). ADR-0016 pinned the audit log (slice 2). This ADR pins **slice 3**: where outbound copies live so the operator can read back what they sent, and how the row threads with inbound mail.

## Decision

### Same `Messages` table; new `direction: "in" | "out"` field

Outbound copies land on the existing `Messages` table with `address = fromAddress` and a new `direction` attribute. Reasons:

- **Read-side parity for free.** `read_inbox(address)` already does a primary-key Query against `Messages`. Self-loopback (`from = to`) flows naturally — one address scan returns both the inbound message and the outbound copy under the same `address`. No second table to merge.
- **`get_message(message_id)` works for outbound replies.** GSI1 on `message_id` already exists; an inbound reply quoting our outbound `Message-ID` lands on the same lookup path. Threading round-trips end-to-end.
- **Schema stability rule (ADR-0011) tolerates additive attributes.** A new `direction` field is a sparse attribute on the row; existing rows missing it default to `"in"` on read. No destructive migration; no schema_v bump.

`direction = "out"` is added on the write side. On the read side, attribute-absent collapses to `"in"` (back-compat for every row written before this slice).

### Raw bytes to S3 under `outbound/{ses_message_id}`

Inbound's canonical S3 layout uses SES's default key (`mail.messageId` from the receipt event). For outbound we generate the key ourselves: `outbound/{sesMessageId}`. The `outbound/` prefix:

- Distinguishes operator-sent copies from received mail in the same bucket — easier to scope IAM, lifecycle, and reconciliation queries.
- The SES API id is unique, opaque, and globally distinct from the inbound `mail.messageId` namespace, so collisions across direction are impossible.

The same lifecycle policy (90-day Glacier Deep Archive transition, ADR-0012) applies; outbound copy doesn't need a different retention story in v1.

### `internal_id` is deterministic on the outbound s3Key

`internal_id = makeInternalId({ s3Key: "outbound/{sesMessageId}", receivedAt: sentAt })`. Same factory as inbound (ADR-0013). Idempotent on retry: if persistence is re-driven for the same SES message id, the same Messages row is rewritten in place rather than duplicated. ULID time component is `sentAt`, so newest-first inbox ordering still works for outbound copies.

### `received_at` repurposed as "ingested_at"; `message_id` stores the SES-rewritten form

Two field-meaning notes pinned here:

- **`received_at`**: for outbound rows, this is `sentAt` from the SES adapter — the moment the operator's send was accepted. The field name stays `received_at` for ADR-0011 stability; semantic is "when this row entered the store." Documented; not renamed.
- **`message_id`**: per ADR-0015, must be the SES-rewritten RFC `Message-ID` (so an inbound reply quoting it lands on GSI1). The composer's attempted ID is informational and lives in the audit log (`rfc_message_id`), not on the Messages row. The rewritten form is `<{sesMessageId}@{region}.amazonses.com>`, where `sesMessageId` is the value SES `SendEmail` returns in `MessageId`.

The recipient-index suffix (e.g. `-000000`) is part of the `MessageId` value SES already returns — it is not appended on top. Multi-recipient sends get distinct rewritten IDs per recipient (`…-000000`, `…-000001`, …); we store the first-recipient form (the value SES returns to the caller) as the canonical row id. Threading via GSI1 may miss for replies from non-first recipients — known limitation, acceptable for the v1 send paths (mostly self-loopback during smoke and single-recipient sends in early operator flows).

### Persistence is orchestrated *outside* `sendWithAudit`

`sendWithAudit` keeps its narrow ADR-0008 invariant (attempt → SES → outcome) untouched. The CLI driver wires a new `persistOutbound` step *after* `sendWithAudit` returns success:

```
compose → sendWithAudit → persistOutbound (best-effort)
```

If `persistOutbound` fails, SES has already accepted and the audit row is closed; the driver logs a warning and returns success. Losing the persist write is degraded (operator can't read back the sent copy) but not catastrophic — the raw bytes still went to SES, and the audit row records that the send happened.

### S3 raw writer is a port

A new `RawMessageWriter` port lives in core (`src/core/raw-store.ts`) so `persistOutbound` is unit-testable without a real S3. The S3-bound implementation (`src/aws/s3-raw-store.ts`) wraps `PutObjectCommand`. Symmetric with the ingest path's `MessageStore` port.

## Considered and rejected

- **Separate `OutboundMessages` table.** Mirrors ADR-0016's argument for `AuditLog` separation, but the access patterns *do* align here — `read_inbox` and `get_message` want both directions in one place. A second table would force every read tool to UNION across two queries.
- **Store the composer's attempted Message-ID as the row's `message_id`.** Threading would silently break: inbound replies quote the SES-rewritten ID, GSI1 wouldn't match, `get_message` would 404 on every quoted-id lookup.
- **Embed `persistOutbound` inside `sendWithAudit`.** Conflates two invariants (audit durability vs. storage convenience). Keeping them separate means a future operator who wants audit-only sends (no persist — e.g. for test-mode or "fire and forget" notification flows) can compose the orchestration differently without rewriting `sendWithAudit`.
- **Store raw under `messages/outbound/{sesMessageId}` (nested under inbound prefix).** Inbound objects use SES's default flat layout; nesting outbound under it would force IAM and lifecycle rules to know two patterns. Top-level `outbound/` keeps prefix-scoping trivial.
- **Skip the parser; build the Messages item directly from `ComposeInput`.** The composer has the structured fields, but the parser is what produces the on-the-wire `headers_blob` and the (possibly RFC-2047-decoded) display values that the read-side projection commits to. Re-parsing is one extra call but gives byte-for-byte parity with what the recipient sees, including SES's downstream re-encoding being a non-issue (we parse the bytes we sent, not what SES delivered).

## Trade-offs accepted

- **First-recipient SES rewritten ID only.** Multi-recipient sends would need either per-recipient rows or a list-attribute of all rewritten IDs to make GSI1 lookups work for every reply. v1 doesn't have multi-recipient threading concerns — most early sends are self-loopback or single-recipient. Documented limitation; revisit when first multi-recipient bug surfaces.
- **Persist failure is silent in non-CLI flows.** The CLI driver writes to stderr; future MCP-server invocations must surface the warning through their own logging seam. Not a code change, just a contract: callers of `persistOutbound` are responsible for their own warning channel.
- **`direction = "in"` default on read covers all pre-slice-3 rows.** This is fine forever as long as inbound never starts emitting `direction = "out"` (it can't — direction is set explicitly by the writer). If a future schema bump renames the field, the migration ADR has to handle the back-compat default.
- **No new IAM in slice 3.** The CLI runs under the operator's admin profile and already has S3:PutObject + DDB:Write on these resources. When the send path moves to a Lambda, `compute-plane-stack.ts` will need `s3:PutObject` on the `outbound/*` prefix and DDB write grants on `Messages` + `MessageBodyChunks` — same shape as the ingest function's grants, scoped to a different prefix.
