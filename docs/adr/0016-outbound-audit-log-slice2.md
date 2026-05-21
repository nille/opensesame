# Outbound audit log: pre-send attempt, post-send outcome, separate DDB table

ADR-0008 commits to defense-in-depth enforcement with a pre-send audit row written *before* the SES call and a post-send update on success. ADR-0015 pinned slice 1 (composer + SES adapter + CLI). This ADR pins **slice 2**: the audit-log port, the DDB-bound adapter, the table shape, and how slice 1's `send-email.ts` driver wires the two writes around the SES call.

## Decision

### Separate `AuditLog` DDB table, not Messages

`AuditLog` lives on its own DDB table (`opensesame-audit`) — not as overloaded items on `Messages`. Reasons:

- The `Messages` table is keyed by `(address, internal_id)` — meaningful for inbox queries but the wrong shape for audit queries (which want to scan by `principal`, `agent_id`, time range). Putting audit on `Messages` would force a second GSI just to query it.
- Audit retention is a different policy axis. ADR-0008 implies audit is forensic data; eventual rules (per-agent retention, legal-hold, export to S3 / Athena) shouldn't bleed into the operational mail table.
- Schema evolution is independent. The `Messages` schema is locked by ADR-0011's stability rules; audit can iterate freely without bumping `schema_v` on every message ever stored.

### Two writes per send: `recordAttempt` + `recordOutcome`

```ts
interface AuditLog {
  recordAttempt(attempt: AuditAttempt): Promise<void>;
  recordOutcome(outcome: AuditOutcome): Promise<void>;
}
```

`recordAttempt` is a `PutCommand` keyed on `audit_id` (a fresh ULID). `recordOutcome` is an `UpdateCommand` against the same `audit_id` that mutates only the outcome fields. The two-step shape mirrors ADR-0008 exactly: the row exists from the moment we *intend* to send; success or failure rewrites only the outcome columns.

### Schema (slice-2 minimum, solo-direct shape)

```
audit_id          (PK, ULID, lex-sortable by attempt time)
schema_v          "1"
type              "send_attempted" → "send_succeeded" | "send_failed"
principal         "iam:operator" in solo-direct (no Cognito sub yet)
agent_id          null in solo-direct
from              addr-spec from compose input
to                comma-joined recipient list
cc                comma-joined or absent
bcc               comma-joined or absent (kept here for forensic completeness; never on the wire — slice 1 ADR-0015)
subject_hash      hex(SHA-256(subject)) — body and subject text are not stored; this is enough to dedupe / correlate
rfc_message_id    composer's RFC `Message-ID` (the "attempted" id — see ADR-0015)
requested_at      ISO-8601 UTC, set at attempt time
ses_message_id    set by recordOutcome on success (the recipient-visible id)
succeeded_at      set by recordOutcome on success
failed_at         set by recordOutcome on failure
error             string, set by recordOutcome on failure
```

`grant_id`, `disclosure_mode`, `autonomy_mode` from ADR-0008 are intentionally **deferred** — solo-direct has no Grants (per ADR-0006), and synthesizing fake values would invite confusion. They land when slice-of-Grant-checking adds Layer 1 properly.

### Pre-send wiring in the CLI driver

```
1. compose
2. recordAttempt({...})        // if this throws, abort — ADR-0008 guarantee
3. ses.send(...)
   ├─ success → recordOutcome({audit_id, type: "send_succeeded", ses_message_id})
   └─ failure → recordOutcome({audit_id, type: "send_failed", error})  ; rethrow
```

If `recordOutcome` itself fails, slice 2 logs a warning to stderr and returns success when SES already accepted — the row sits at `send_attempted` and the operational reconciler (future) closes it. Losing the outcome write is degraded; losing the *attempt* write is unacceptable, hence the early throw on step 2.

## Considered and rejected

- **Single Put with a `pending → final` field updated in place via a conditional write.** Equivalent in steady state but harder to reason about: a future audit-query reader sees only one shape, and "what's the meaning of this row right now" is ambiguous. The `type` enum + `outcome_*` columns make state explicit.
- **EventBridge instead of DDB for audit.** Audit-query is a tool surface (ADR-0007 `audit_query`) that wants random access by id and range scans by time — DDB is the right shape. EventBridge is for fan-out (notify other systems), not authoritative storage.
- **Subject in cleartext for searchability.** Subjects can leak PII; storing a hash + the rfc_message_id (which links back to `Messages` for callers who already have read access to the message) is enough for v1 correlation without making audit a parallel mail archive.
- **Pre-send audit on the same table as Messages with a `kind=audit` discriminator.** Single-table design is fine when access patterns are aligned; here they aren't (see "Separate table" rationale above).

## Trade-offs accepted

- **No GSI in slice 2.** Without a GSI, `audit_query` (ADR-0007) cannot answer "all attempts for this principal in time range T" efficiently — it would require a Scan. That's deferred until the read-side audit slice; slice 2 only has to make the writes happen and be queryable by `audit_id` directly. The PK (a ULID) is already lex-sortable by attempt time, so a future GSI on `(principal, audit_id)` is the obvious shape.
- **No batching across the two writes.** The pre-send write must be durable before SES is called; we don't gain anything by batching. Two `await client.send(...)` calls per send is the cost.
- **`error` field is free-form.** No structured error code in slice 2 — SES's error string is what we have. Structured codes show up if/when the MCP server starts mapping its own error taxonomy through (ADR-0007's `{error: {code, message, retriable}}` shape).
- **Solo-direct fills `principal: "iam:operator"`.** This is a placeholder, not a sentinel — operators inspecting audit rows will see it; documentation in the audit-query tool surface should explain it. When Layer 1 lands, the resolver will produce a real Cognito sub or IAM role ARN.
