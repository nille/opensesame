# Send-time suppression: derived `Suppressions` table + pre-send gate in `sendWithAudit`

ADR-0018 closed the loop on bounce/complaint *observation* — events land in `BounceLog`, the latest status projects onto the outbound `Messages` row, and operators can read both. ADR-0018 §"Out of scope" explicitly deferred suppression: "The send path doesn't yet check `delivery_status` before sending. Operators can read it back and decide manually in v1; automated suppression is a follow-up slice." This ADR pins **slice 5**: the send path refuses to dispatch to recipients we have already burned, and the bounce handler maintains the per-recipient suppression table.

## Decision

### A new `Suppressions` table — per-recipient, derived

`Messages.delivery_status` is keyed on the *outbound send* (one row per send, addressed to one or more recipients). Suppression has to be keyed on the *recipient* — "stop sending to alice@example.com," not "the send that bounced last Tuesday." The two views need different keys, so they need different tables.

- **Table**: `opensesame-suppressions`
- **PK**: `recipient` (lowercased, NFC-normalized email — see "Recipient normalization" below)
- **Attributes**:
  - `reason`: `bounced_permanent` | `complained`
  - `first_event_at`: ISO-8601 timestamp of the first event that suppressed this recipient
  - `last_event_at`: ISO-8601 timestamp of the most recent suppressing event
  - `last_ses_message_id`: pointer back to the most recent offending send
  - `last_event_id`: pointer into `BounceLog`
  - `source`: `bounce_handler` | `manual` — leaves room for future admin overrides without schema change
- **Lifecycle**: PITR + RETAIN, same as `BounceLog`. Suppression entries don't expire on their own; operators clear them manually. (TTL-based auto-clearing — "let bounces fade after 90 days" — is intentionally deferred. Most ESPs also do not auto-expire suppressions; operator-initiated rehabilitation is the safer default.)

The table is a *projection* of `BounceLog`, not a source of truth. If we ever lose it, the bounce handler can replay the log to rebuild it. We rely on this in the consequence "operators can repair drift by replay" below.

### Two events suppress; transient delays + delivery delays do not

The mapping mirrors what email operators expect:

| `delivery_status` from ADR-0018 | Suppresses?                       |
| ------------------------------- | --------------------------------- |
| `bounced_permanent`             | **yes** (`reason: bounced_permanent`) |
| `complained`                    | **yes** (`reason: complained`)        |
| `bounced_transient`             | no — retry is the right behavior     |
| `bounced_unknown`               | no — SES "Undetermined" is too noisy |
| `delayed`                       | no — the send completed             |

A future slice can revisit `bounced_transient` once we have data on retry-loop behavior; for v1 the principle is "only suppress on signals where re-sending is harmful."

### The bounce handler writes the Suppressions row inline, after BounceLog + Messages

The handler's order of operations gains one step:

1. `BounceLog.writeEvent(event)` — forensic record (unchanged).
2. `Messages.applyDeliveryStatus(...)` — projection on the outbound row (unchanged).
3. **`Suppressions.upsert(recipient, reason, event)`** — **new**: one PutItem per recipient on the event, but only when the event's category maps to a suppressing reason.

Idempotency: PutItem with a `ConditionExpression` of `attribute_not_exists(recipient) OR last_event_at <= :event_at` — late-arriving stale events do not overwrite a fresher suppression record. We accept that the *condition fails silently* for stale events (no row update, no error surfaced) because the handler already records every event in BounceLog.

The Suppressions write is *third* in order, after the two writes ADR-0018 already promises. If the Suppressions write fails after the Messages projection succeeds, the next event for the same recipient (or an operator-triggered replay) restores it. We do **not** roll back the BounceLog or Messages writes.

### A new core port `SuppressionList`, gated in `sendWithAudit`

Pure type:

```ts
export interface SuppressionList {
  // Returns the subset of `recipients` that are currently suppressed,
  // along with the reason. Empty array means "all clear, send away."
  // Implementations should batch (BatchGetItem) for multi-recipient sends.
  checkRecipients(recipients: readonly string[]): Promise<SuppressedRecipient[]>;
}

export type SuppressedRecipient = {
  recipient: string;
  reason: "bounced_permanent" | "complained";
  last_event_at: string;
};
```

`sendWithAudit` grows one optional dependency (`suppressionList`) and one optional input (`allowSuppressed: boolean`). The orchestrator's order becomes:

1. (NEW) If `suppressionList` is configured and `allowSuppressed !== true`, query it with the union of `to + cc + bcc`. If any recipient is suppressed:
   - Write a `send_blocked` audit row (`type: "send_blocked"`, `suppressed_recipients: [...]`, `block_reason: "suppression_list"`).
   - Throw `SuppressionBlockError` so the caller surfaces the failure.
2. `recordAttempt(...)` (unchanged).
3. `mailer.send(...)` (unchanged).
4. `recordOutcome(...)` (unchanged).

The audit-log shape gains a new variant:

```ts
export type AuditBlocked = {
  audit_id: string;
  schema_v: "1";
  type: "send_blocked";
  principal: string;
  agent_id: string | null;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject_hash: string;
  rfc_message_id: string;
  requested_at: string;
  blocked_recipients: string;          // joined "alice@x, bob@y"
  block_reason: "suppression_list";
};
```

`send_blocked` is a *terminal* audit type — no `recordOutcome` follows it. The operator's audit query gets one row per attempted-but-blocked send.

### `allowSuppressed: true` is the explicit operator override

A solo operator legitimately needs to retry to a recipient who has appeared on the suppression list — for example, the first complaint was a misclick, or the recipient mailbox was temporarily full and SES emitted `Permanent` instead of `Transient`. The override is per-call, opt-in, and audit-logged.

The CLI driver gains `--allow-suppressed`. When passed:
- The pre-flight check is skipped.
- The audit attempt row carries `allow_suppressed: true` (a new attribute on `send_attempted`).

We deliberately do **not** add a config-level "always allow" — every override must be a per-send decision. Future admin/MCP-tool surface (out of scope) can layer per-grant overrides on top.

### Recipient normalization: lowercase the domain, leave the local-part alone

Email addresses are *case-insensitive on the domain* and *case-sensitive on the local-part* per RFC 5321 §2.3.11 — though the latter is so consistently ignored in practice that lowering the entire string is the de-facto industry default for keying. We pick a deliberate middle path:

- Lower the domain (`Alice@Example.COM` → `Alice@example.com`).
- Leave the local-part as the sender wrote it, but match case-insensitively at lookup time using a derived attribute (`recipient_lc = recipient.toLowerCase()`).

In v1 we cut the second step: we **lower the entire string** and key on that. Reason: every mainstream MTA and ESP (Gmail, Outlook, AWS SES) treats local-parts as case-insensitive in practice, and SES itself canonicalizes addresses to lowercase before publishing them in event payloads. Keying on the lowered form aligns with the data we'll receive and avoids subtle "Alice and alice are different recipients" bugs.

The normalization function lives in `src/core/address.ts` next to existing parsing and is reused by both the bounce-handler write path and the send-time check. Tests pin the case-folding contract.

### CDK shape: extend `DataPlaneStack` + extend `BounceHandlerStack`

- **`DataPlaneStack`**: add `Suppressions` table. PITR + RETAIN. Exported via `Outputs` so `BounceHandlerStack` and the CLI driver can read the table name.
- **`BounceHandlerStack`**: grant the bounce-handler Lambda `dynamodb:PutItem + UpdateItem` on `Suppressions`; add `OPENSESAME_SUPPRESSIONS_TABLE` to its env.
- **`ComputePlaneStack`** (when the send path moves into a Lambda — future slice): same env var, `dynamodb:BatchGetItem` grant.
- **CLI driver (`src/bin/send-email.ts`)**: reads `OPENSESAME_SUPPRESSIONS_TABLE` from env. When unset, the suppression check is skipped (solo-direct without slice 5 deployed continues to work).

## Out of scope (deferred)

- **TTL / auto-expiry**. Suppression entries persist until manual removal.
- **`unsuppress` / list-management MCP tools**. ADR-0007's `audit_query` is the natural neighbor; both arrive in the read-side admin slice. For v1, operators clear entries with the AWS console or a one-shot script.
- **Per-grant override policy**. Future grant fields (`autonomy_mode`, `disclosure_mode`) may eventually layer with an `override_suppression` capability. Out of scope until grants exist beyond the placeholder `iam:operator` principal.
- **Bulk import from prior bounce log**. Replay tool to backfill `Suppressions` from `BounceLog` is trivially a script; not productized in this slice.
- **Suppression on `bounced_transient`**. As above — wait for retry-loop data.

## Consequences

- **One new DDB table to operate.** Same lifecycle policy as `BounceLog` and `Messages`; no new operational mode.
- **`sendWithAudit` gains one optional dependency.** Solo-direct without `OPENSESAME_SUPPRESSIONS_TABLE` set behaves exactly as today (no check, no audit-log shape change). Tests pin both shapes (with and without the dependency wired).
- **The bounce-handler Lambda gains one DDB write per suppressing event.** Volume is the same order as the existing `Messages` UpdateItem — tens per day. IAM grant is one additional `dynamodb:PutItem` statement.
- **A new audit row type, `send_blocked`.** Operators querying audit history will see blocked attempts alongside successes and failures. The `audit_query` MCP tool (future slice) will surface all three.
- **Operators can repair drift by replay.** If `Suppressions` is ever wiped (operator error, table recreate, etc.), a 50-line script that scans `BounceLog`, filters to suppressing categories, and PutItems into `Suppressions` rebuilds it.
- **Sandbox-exit narrative gains a "we close the loop" line.** "Permanent bounces and complaints are added to a per-recipient suppression list, which the send path consults before every dispatch."

## Slice plan

1. **Pure types + recipient normalization** (`src/core/address.ts` extension, `src/core/suppression.ts` new — types only).
2. **`SuppressionList` port + `sendWithAudit` integration** with unit tests covering: no port, port returns empty, port returns matches, override, multi-recipient partial-match (still blocks).
3. **DDB adapter `dynamodb-suppression.ts`** with `BatchGetItem` for reads + `PutItem` for writes. Test against in-memory mock.
4. **Bounce handler integration**: extend `handleDeliveryEvent` to call `Suppressions.upsert(...)` when category is suppressing.
5. **CDK**: `Suppressions` table on `DataPlane`, IAM + env on `BounceHandlerStack`. CDK assertion tests pin the table shape and grants.
6. **CLI driver wiring** in `src/bin/send-email.ts` + `--allow-suppressed` flag.
7. **Live verify**: send to `bounce@simulator.amazonses.com`, observe Suppressions row appears within ~6 s; second send with the same recipient blocks pre-flight; same send with `--allow-suppressed` proceeds and writes a `send_attempted { allow_suppressed: true }` audit row.

Each step is the unit of a separate commit; tests precede implementation per the project TDD rule.
