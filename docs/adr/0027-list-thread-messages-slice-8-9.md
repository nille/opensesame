# `list_thread_messages` RPC + `ThreadIdGSI`, slice 8.9

Slice 8.8 (ADR-0026) stamped `thread_id` on the `Messages` row at write time and got the web client to prefer it over its JWZ fallback. That closed the recompute-on-render and orphan-row gaps for *the inbox window*, but it didn't change the underlying ceiling: the client only knows about the rows `read_inbox` returns. A reply that lands now and answers a thread whose root scrolled off the page is still resolvable to the right `thread_id`, but the rest of the chain isn't — because the rows it would cluster with aren't on the wire.

The reader stack (slice 8.6 / ADR-0024) and the J/K nav (slice 8.7 / ADR-0025) both already assume the operator can scroll *within* a thread. Today that scroll is bounded by whatever ended up in the latest 50-row inbox page. Slice 8.9 is the first slice that actually breaks the window: when the operator opens a thread, the client should be able to ask the BFF for "every message in this conversation" and get a chronologically-ordered page back.

That's what earns the GSI ADR-0013 punted on. We add it now because we have a reader.

## Decision

### Add `ThreadIdGSI` on the `Messages` table

- Construct ID `ThreadIdGSI` (load-bearing per ADR-0011).
- PK: `thread_id` (STRING).
- SK: `internal_id` (STRING) — the same ULID that already orders the base table by time. Newest-last on `ScanIndexForward=true`; the RPC sorts ascending so the reader stack reads in conversational order.
- Projection: `INCLUDE` with the inbox-row attribute set, plus what `get_message` needs that isn't in the inbox row (`headers_blob` is *not* projected — readers that want the body fall back to the base table via the (address, internal_id) PK on the row).
  - Projected: `address`, `parse_status`, `schema_v`, `received_at`, `message_id`, `from_raw`, `to_raw`, `cc_raw`, `reply_to_raw`, `subject`, `date_raw`, `in_reply_to`, `references_raw`, `auto_submitted`, `list_id`, `snippet`, `direction`, `read_at`, `parse_error`, `raw_s3_uri`.
  - Not projected: `headers_blob`, `custom_headers`, `attachments`. `list_thread_messages` returns the inbox-row shape, not the full `ReadMessage` — keeps GSI item size small and matches what the reader stack actually renders.

Skeleton rows project too (they carry `thread_id === null`, so they never appear on the index — exactly the same sparse-GSI behavior as `GSI1` for skeletons today).

### `MessageReader.listThreadMessages(threadId, opts)`

```ts
listThreadMessages(input: {
  thread_id: string;
  limit: number;
  cursor?: string | null;
}): Promise<{ messages: InboxRow[]; next_cursor: string | null }>;
```

- Single Query against `ThreadIdGSI`, `KeyConditionExpression: thread_id = :tid`, `ScanIndexForward: true` (oldest-first).
- Same opaque-base64 `LastEvaluatedKey` cursor shape as `listInbox` / `searchEmail`.
- Returns the same `InboxRow` discriminated union (`InboxRowOk | InboxRowFailed`). Skeleton rows can't appear here in practice (they have no `thread_id`), but the type stays unified so the wire shape mirrors `read_inbox`.

### `/rpc/list_thread_messages` BFF tool

- New case in `dispatch`. Input schema: `{ thread_id: string; limit?: number; cursor?: string }`.
- 400 `invalid_request` when `thread_id` missing or not a string. No `address`-scoping in the input — the GSI partition is the thread, and a thread is owned by exactly one mailbox (every row in a thread shares an `address` because outbound replies clone the inbound parent's `address`). We *do not* leak across mailboxes because the indexing rule already guarantees colocation.
- `DEFAULT_THREAD_LIMIT = 50`, same shape as `DEFAULT_INBOX_LIMIT`. Cap at 200 to bound the page; threading conversations rarely exceed that.

### Web client wiring

- `src/web/src/lib/bff-client.ts` gets a `bff.listThreadMessages` method shaped like `bff.readInbox`.
- The reader stack expansion (slice 8.6) currently slices the inbox-window rows by `rootKey`. With slice 8.9 the expansion fires `listThreadMessages(thread_id)` whenever the thread's `rootKey` is a real `thread_id` (i.e. starts with `<` — server-stamped) and merges the result with the in-window rows. Legacy rows (`thread_id === null`, `rootKey` is the JWZ fallback) keep the in-window subset only — they can't be queried by `thread_id` because they don't have one.
- Merge rule: union by `internal_id`, sort newest-first for display (matches the existing reader stack ordering). This handles the case where a row is both in the inbox window *and* on the GSI page.

### What this slice does *not* ship

- **No backfill.** Same call as ADR-0026: legacy rows missing `thread_id` keep using the client's JWZ fallback inside the inbox window. They simply can't be queried via the GSI — by definition, they have no key.
- **No "load older threads" surface.** The thread expansion is paged via `next_cursor`, but the inbox itself still pages via `read_inbox`. Cross-thread "load older mail in this conversation" is a single RPC; cross-inbox "load older threads" is the existing slice.
- **No write-side rate-limiting.** PAY_PER_REQUEST DDB; the GSI write cost is the same as a base-table write. We measure post-deploy and add throttling only if real traffic shows hot partitions on a single thread (e.g. a list with thousands of replies on one root).
- **No new event or audit entry.** The RPC is a read; the existing audit hooks for read tools still apply.

### Wire format & event compatibility

- `read_inbox` and `get_message` shapes are unchanged.
- `list_thread_messages` is additive (ADR-0021 commits to wire-compatible additions). Adding the new tool name to the dispatcher route table is a non-breaking change.
- The new GSI is `ThreadIdGSI`; the existing `GSI1` (message_id+received_at) is untouched. Renaming GSIs is forbidden by ADR-0011 — pinning a new construct ID keeps the rule honest.

## Implementation

1. **CDK** — `src/cdk/data-plane-stack.ts` adds the second GSI on the `Messages` table. Update `test/cdk-data-plane.test.ts` to assert it's present with the right keys + projection set.
2. **Reader port** — `MessageReader.listThreadMessages` method + a `ListThreadMessagesInput` / `Result` pair in `src/core/store.ts`.
3. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns `listThreadMessages`. Re-uses `projectInboxRow` so the inbox-row shape stays canonical. Cursor encode/decode is shared.
4. **BFF** — schema in `src/bff/schemas.ts` + dispatcher case in `src/bff/dispatcher.ts`. The BFF `MessageReader` dependency type widens to include the new method.
5. **Web client** — `bff.listThreadMessages` in `src/web/src/lib/bff-client.ts`. Reader-stack expansion in `Reader.tsx` (slice 8.6) calls it on thread open and merges the result with the in-window rows.
6. **Tests**
   - `cdk-data-plane.test.ts` — `ThreadIdGSI` exists with the right keys + projection.
   - `dynamodb-reader` test — Query against `ThreadIdGSI`, ascending order, cursor opacity.
   - `bff-dispatcher.test.ts` — tool routes, 400 on missing/invalid `thread_id`, success path returns the wire shape.
   - Web — reader stack pulls older messages on open when `thread_id` is set, falls back to the in-window subset when it isn't.

## Considered and rejected

- **Skip the GSI; query by base-table partition + filter.** The base table is keyed on `address`, not `thread_id`. We'd have to read a whole address partition and FilterExpression to `thread_id`. That's a full mailbox scan per thread open — ruled out the moment any mailbox crosses ~1k messages.
- **`ProjectionType.ALL` on the GSI.** Cleaner reader code, no base-table fallback for `get_message`. Trades that for ~2× the storage and write cost since `headers_blob` and `body_text` chunks are the long pole. We don't do that for `GSI1` either, and the reader stack only wants the inbox-row shape — `INCLUDE` with the projection list above is a closer match to the access pattern.
- **Make `list_thread_messages` an `address`-scoped tool that uses the base table.** Costs a `BEGINS_WITH` on the SK or a FilterExpression — same scan-the-mailbox problem. The whole point of the GSI is that a thread is its own partition.
- **Mirror the inbox-window subset into the response and skip the GSI when the thread has 1 visible row.** Saves a Query for short threads. We don't do this because (a) it adds branching the reader stack doesn't need and (b) one Query against the GSI for a thread of size 1 is the same cost as a `GetItem` — the page-size minimum, not the scan size.
- **Use `thread_id` as the new GSI's PK and `received_at` as the SK.** Tempting because it matches `GSI1`'s `(message_id, received_at)` shape. But `internal_id` is the ULID that already encodes received-at-millisecond order *and* breaks ties on the per-message uniqueness. Using `received_at` would lose the per-message tiebreak and could collapse two rows landing in the same millisecond.
- **Drop the JWZ fallback now.** Same call as ADR-0026: keep it for legacy rows that genuinely have no `thread_id`. The fallback path doesn't exercise the GSI; it can't.
