# Audit query: library function + CLI driver + GSI on `(principal, audit_id)`

ADR-0007 pinned `audit_query(agent_id?, address?, since?, until?, limit?) → {events[], next_cursor}` as part of the v1 MCP tool surface. ADR-0016 wrote the audit table without a GSI and explicitly deferred the read side: *"a future GSI on `(principal, audit_id)` is the obvious shape."* ADR-0019 added a third audit row variant (`send_blocked`) and noted: *"the audit_query MCP tool (future slice) will surface all three."* This ADR pins **slice 6**: the read-side query, the GSI shape, and how operators run it before the MCP server itself exists.

## Decision

### A new GSI on `(principal, audit_id)`

The audit table currently has only the `audit_id` PK — the only efficient lookup is "fetch one row by id." `audit_query` needs **range scans by time**, optionally filtered by `agent_id` and `address`. Without a GSI this requires a `Scan`, which is unbounded and blows past the cost budget once the table has more than a few hundred rows.

- **Index name**: `GSI1` (matches the `Messages` table convention).
- **PK**: `principal` (e.g. `"iam:operator"` in solo-direct; future Cognito subs / IAM role ARNs once Layer 1 of ADR-0008 lands).
- **SK**: `audit_id` (ULID — already lex-sortable by attempt time, which is what we'd want a `requested_at` SK to give us).
- **Projection**: `ALL` — we want every field (subject_hash, ses_message_id, error, blocked_recipients, …) returned without a follow-up GetItem per result. The audit table is small relative to Messages; projection cost is negligible.

In solo-direct every row carries `principal: "iam:operator"`, so the GSI's PK is effectively a constant and all data lands in one partition. That's intentional and **safe for v1 volume** (tens-to-hundreds of sends/day = far below DDB's per-partition 3000 RCU limit). When ADR-0008 Layer 1 introduces real principals, the GSI fans out naturally without a schema change. We therefore do *not* introduce an artificial bucketing scheme.

### Time-range queries use synthetic ULIDs over `audit_id`

`since` / `until` arrive as ISO-8601 timestamps. We convert each into a synthetic ULID — the lower bound has the timestamp's milliseconds with the random tail set to all-zero bytes, the upper bound with all-`0xFF` bytes — and run `Query` on `GSI1` with `KeyConditionExpression: principal = :p AND audit_id BETWEEN :lo AND :hi`. This is a server-side range scan with no FilterExpression on time, which is what we want for both correctness (boundary-exact, no off-by-one) and cost (DDB charges only on rows in range).

A small helper `ulidBoundsForTimeRange(since, until)` lives in `src/core/ids.ts` next to the existing `encodeUlid` so both sides of the contract — write (encodes a ULID at attempt time) and read (decodes a range from timestamps) — share a single source of truth on the encoding. When `since` is unset we use a 48-bit-zero floor; when `until` is unset we use a 48-bit-all-ones ceiling. Both bounds are inclusive (DDB `BETWEEN` is inclusive on both ends).

### `agent_id` and `address` are FilterExpressions, not key conditions

ADR-0007's contract treats `agent_id` and `address` as optional filters — most queries don't pin either. Putting them in the key would force separate GSIs (or composite SKs) and complicate the no-filter common case.

- **`agent_id` filter**: `FilterExpression: agent_id = :agent_id`. In solo-direct every row has `agent_id: null`, so passing `agent_id` in v1 returns nothing unless the caller asks for `null` explicitly — that's *correct* for the contract and aligns with what the future Grant-aware writer will produce.
- **`address` filter**: `from = :addr OR contains(#to, :addr) OR contains(#cc, :addr) OR contains(#bcc, :addr)`. `to`/`cc`/`bcc` are comma-joined strings on the row (per ADR-0016 §schema), so `contains()` is the correct DDB function. We deliberately accept the ambiguity that `contains("alice@example.com", "ali")` matches — callers pass full email addresses and the field is a delimited list, so substring matches don't realistically collide. This is cheaper than reshaping audit rows to a String Set, which would ripple through every audit write site.

FilterExpression runs *after* the key range scan, so it can over-read RCU relative to result count when filters are highly selective. We accept this for v1 — audit volume is tiny and the alternative (extra GSIs per filter) is operational debt for theoretical performance.

### Pagination: opaque cursor over `LastEvaluatedKey`

Per ADR-0007: *"opaque cursor + separate `since` for sync polling. List-style tools return `next_cursor` (opaque, server-defined, maps onto DynamoDB's `LastEvaluatedKey`)."*

The cursor is base64url(JSON({principal, audit_id, GSI1: {principal, audit_id}})) — exactly the shape DDB returns. We do not document the inner structure; callers treat it as an opaque blob and re-pass it as `cursor` to continue. Both `since`/`until` and `cursor` may be passed together; the cursor wins on its tie-breakers because it's a within-pagination resume point, not a re-bound of the range.

### Result shape: each row is normalized to one of three discriminated variants

The query returns rows in three shapes (`send_attempted`, `send_blocked` per ADR-0019, `send_succeeded`/`send_failed` per ADR-0016 §schema). The library returns them as a discriminated union keyed on `type` so callers don't have to invent the shape themselves:

```ts
export type AuditQueryResult = {
  events: AuditQueryEvent[];
  next_cursor?: string; // present iff more rows remain
};

export type AuditQueryEvent =
  | AuditQueryAttempted
  | AuditQueryBlocked
  | AuditQuerySucceeded
  | AuditQueryFailed;
```

The variants project the columns ADR-0016 + ADR-0019 wrote — no new fields. `send_attempted` rows where `recordOutcome` later succeeded *are not duplicated* with a separate `send_succeeded` row; instead, the same `audit_id` resolves to a single row whose `type` reflects the latest write (Update against the same key). This matches the on-table reality.

### Slice scope: library + CLI driver, no MCP wrapper

The MCP server itself is not yet implemented (ADR-0006 sketches it; the build out is later). Slice 6 ships the library function and a CLI direct caller (`src/bin/audit-query.ts`) so operators have an immediate read path. The MCP wrapper lands when the MCP-server scaffolding does — at that point this slice's library function becomes its handler verbatim.

The CLI prints results as line-delimited JSON (one event per line) so it composes with `jq` and avoids a giant single JSON document on busy queries.

### Default and maximum `limit`

- Default `limit`: 50 events per page.
- Maximum: 500. Above that the function clamps with no error.

The CLI exposes `--limit` (passes through) and `--all` (paginates internally and drains all pages, capped at 10 000 events as a safety belt).

## Slice plan

1. **Pure types + ULID range helper** — `src/core/audit-query.ts` with `AuditQuery`, `AuditQueryResult`, the four `AuditQueryEvent` variants, and the port `interface AuditQueryReader { query(input): Promise<AuditQueryResult> }`. Add `ulidBoundsForTimeRange(since?, until?)` to `src/core/ids.ts` with unit tests.
2. **Core query function** — pure narrowing/normalization: row from DDB → `AuditQueryEvent`. Unit-tested with table-driven cases for each variant.
3. **DDB adapter** — `src/aws/dynamodb-audit-query.ts` implementing `AuditQueryReader`. On-the-wire test asserting `IndexName: "GSI1"`, `KeyConditionExpression`, `FilterExpression` shape (with and without each filter), `ExclusiveStartKey` round-trip via cursor.
4. **CDK** — add the `GSI1` to the `AuditLog` table in `DataPlaneStack`, projection ALL. CDK assertion test pins the index name + keys.
5. **CLI driver** — `src/bin/audit-query.ts` reading `OPENSESAME_AUDIT_TABLE` from env, accepting `--agent-id`, `--address`, `--since`, `--until`, `--limit`, `--cursor`, `--all`. Prints LDJSON.
6. **Live verify** — query the real audit table after the prior live verify runs (the `send_attempted`/`send_succeeded` rows from slice 5's verify are still there). Assert: `--since` boundary works, `--address bounce@simulator.amazonses.com` returns the slice-5 verify rows, paginated.

## Out of scope

- **MCP server / tool wrapper.** Lands with the MCP scaffolding slice.
- **Cross-principal filtering.** Once Layer 1 of ADR-0008 produces real `principal` values, queries will need a way to authorize "see other principals." For now every solo-direct query is implicitly `principal = iam:operator`.
- **Free-text search** over subject hashes or error strings. ADR-0007's `search_email` is the analogue for inbound; an audit-search variant would be a future addition once we know what operators want.
- **Audit retention / TTL**. ADR-0016 deferred this; still deferred.
- **Audit export to S3 / Athena.** Future.

## Trade-offs accepted

- **GSI is single-PK in v1.** Solo-direct sends every row to one partition. Acceptable at v1 volume (≪ 3000 RCU/partition); migrates naturally when real principals arrive.
- **FilterExpression for `address`/`agent_id`.** Reads more RCU than the result count when filters are selective. We accept the cost for the small audit table to avoid extra-GSI operational complexity.
- **No MCP wrapper this slice.** CLI-only is fine for solo-direct; deferring the wrapper keeps slice 6 small and avoids stub code that has to be revisited when the MCP server actually lands.
- **`audit_id` BETWEEN over the synthesized ULID range.** Adds a small encoding helper but keeps the GSI clean and the time-range query exact at the boundary. The alternative (FilterExpression on `requested_at`) over-reads and admits boundary fuzz.
