# `star_thread` RPC + sparse `starred_at`, slice 8.10

The webmail-experience punch list (handoff 2026-05-22) opens with three
operator annotations the inbox doesn't have yet — star, soft-delete, snooze.
Star is the simplest and ships first. The reader stack and inbox row
aggregation (slices 8.5 / 8.6) already rolls per-message rows into threads
on the client; this slice gives the operator a way to flag a thread for
later and a way to filter the inbox down to the flagged set.

This ADR pins the data shape, the write semantics, and the read path.
Star is **per-thread, row-stamped** — every row in the conversation carries
the annotation, and the aggregation rule "any starred row → starred
thread" lives on the client. There is no Star GSI in v1; the Starred
sidebar entry filters the existing inbox window. The slices that follow
(8.11 trash, 8.12 snooze) reuse this shape.

## Decision

### `starred_at` is a sparse, per-row attribute on `Messages`

- Type: ISO-8601 string. Attribute-absent on the row → "not starred".
  Same convention as `read_at` (ADR-0014, slice 8.2) and `thread_id`
  (ADR-0026, slice 8.8).
- One annotation, one attribute: no per-operator state, no count, no
  reason — v1 is single-tenant and a star is a boolean. Future
  multi-operator work can add `starred_by` without invalidating this
  shape (the absent → unstarred default still holds).
- Skeleton rows (`parse_status: "failed"`) never carry a `thread_id`
  and so are never starred — `star_thread` resolves rows via
  `ThreadIdGSI` and skeletons aren't on the index. Matches the
  precedent set in ADR-0027 for `list_thread_messages`.

### The annotation is per-thread, written across every row

When the operator stars a thread, the BFF resolves *every row* in that
thread via `ThreadIdGSI` (the index introduced in slice 8.9 / ADR-0027)
and stamps `starred_at = now` on each one. Unstarring removes the
attribute from every row. Three reasons to fan the write out instead of
stamping one root row:

1. **Reads stay one-Query.** The inbox listing already projects every
   row's attributes; the aggregation rule sees `starred_at` on whichever
   row of the thread happens to be in the visible window. No second
   lookup, no "find the root row" step at render.
2. **Race-free under thread root drift.** If the chain root scrolls off
   the page or a new "earlier" message arrives later, no special case is
   needed — the annotation lives on every row that exists at the moment
   of the click.
3. **Matches the per-row idempotence pattern.** Each row update guards
   on `attribute_exists(#addr)` exactly like `mark_read`'s
   `stampReadAt`. Conditional update phantom-row protection is reused
   verbatim.

The trade is write-amplification: a thread of 8 rows costs 8 UpdateItem
writes per star/unstar. Threads in this product are operator-scale, not
mailing-list-scale, so this stays bounded. The dispatcher caps the
star fan-out at the same `MAX_THREAD_LIMIT = 200` already enforced for
`list_thread_messages`. Threads larger than 200 rows star their first
200 ascending-by-`internal_id` rows; this is enough for the
aggregation rule to fire and the limit is documented in the response
(`updated_count`).

Replies that arrive *after* the star are written without `starred_at`
(write path doesn't know about thread state). The aggregation rule
"any starred row → starred thread" still flags the conversation.
Re-starring picks up the new arrivals.

### `MessageReader.starThread(input, now)`

```ts
type StarThreadInput = {
  thread_id: string;
  starred: boolean; // true = star, false = unstar
};

type StarThreadResult = {
  thread_id: string;
  starred: boolean;
  starred_at: string | null; // ISO-8601 when starring, null when unstarring
  updated_count: number;     // rows actually touched
};

starThread(input: StarThreadInput, now: Date): Promise<StarThreadResult>;
```

- Step 1: Query `ThreadIdGSI` for `thread_id`, project only
  `address, internal_id`, limit `MAX_THREAD_LIMIT`. One RCU per row.
- Step 2: For each resolved primary key, fan out parallel
  `UpdateCommand`s.
  - Star: `SET starred_at = :now` with
    `ConditionExpression: attribute_exists(#addr)`. Idempotent in
    state (re-starring an already-starred thread overwrites the
    timestamp; we don't preserve "first-star-wins" because star is a
    UI toggle, not an event).
  - Unstar: `REMOVE starred_at` with
    `ConditionExpression: attribute_exists(#addr)`. Already-unstarred
    rows are a benign no-op — REMOVE on a missing attribute succeeds.
- Step 3: Return `updated_count = number of successful writes`.
  `starred_at` is `now.toISOString()` for star, `null` for unstar.
- Empty thread (no rows on the GSI) → `updated_count: 0`,
  `starred_at` echoes the requested state. No 404 — the operator may
  be acting on a stale inbox-window thread rollup, and a no-op
  response is friendlier than a hard error.

### Wire row carries `starred_at`

- `InboxRowOk` and `ReadMessageOk` gain a nullable `starred_at: string | null`
  field. Attribute-absent on the DDB row → null.
- `projectInboxRow` and `projectOk` in `dynamodb-reader.ts` read the
  attribute via the same `nullableString` helper used for `read_at`
  and `thread_id`.
- The web client mirrors the field on its `InboxRowOk` and
  `ReadMessageOk` types in `bff-client.ts`.

### `/rpc/star_thread` BFF tool

- New case in `dispatch`. Input schema:
  `{ thread_id: string; starred: boolean }`.
- 400 `invalid_request` when `thread_id` missing/empty or `starred`
  missing/non-boolean.
- 200 with the full `StarThreadResult` body on success (including
  `updated_count: 0`).
- No 404, no 409 — the empty-thread case is a 200 no-op as described
  above.

### Web client: aggregation, sidebar, affordance

- `Thread` (in `src/web/src/lib/threading.ts`) gains a derived
  `starred: boolean` flag. `groupIntoThreads` sets it during the
  `upsert` pass: any `row.starred_at !== null` flips the bucket's
  `starred` flag to true. Mirrors how `unread` and `hasOutbound` are
  derived today.
- `RailView` widens to include `"starred"`. The Starred sidebar entry
  filters `threads.filter(t => t.starred)` over the inbox-window
  threads. Threads whose only starred rows are outside the inbox
  window are not visible — accepted v1 limitation, see "Considered
  and rejected" below.
- `bff.starThread(input)` lives in `bff-client.ts` shaped like
  `bff.markRead`.
- A star icon-button (filled = starred, outline = unstarred) sits in
  the inbox-row right gutter and at the top of the reader. Click
  toggles. Optimistic update on the client; revert on RPC error.
- Keyboard: `s` toggles star on the focused thread. Mirrors the
  existing single-letter shortcuts (`c` compose, `t` theme).

### What this slice does *not* ship

- **No backfill.** Legacy rows have no `starred_at`; that's the
  unstarred default. There's nothing to migrate.
- **No StarredAtGSI.** The Starred sidebar filters the inbox window
  client-side. Adding a sparse GSI on `starred_at` would let us
  surface starred threads from outside the window, but the cost of a
  new GSI for a feature that mostly answers "what did I just flag
  right now" doesn't pay back at v1 mailbox sizes. Re-evaluate when
  the feature has real usage.
- **No per-operator state.** Single-tenant; one star per thread
  globally. Multi-tenancy is its own architecture slice.
- **No "starred count" anywhere.** The sidebar entry just toggles a
  filter view; no badge.
- **No audit log entry.** `mark_read` doesn't audit either — these
  are UI-state writes, not state-transition events. The existing
  read-tool audit hooks don't apply because star isn't a tool that
  reads protected content.

### Wire format & event compatibility

- `read_inbox` and `get_message` shapes gain a *tail* `starred_at`
  field. ADR-0021 commits to wire-additive evolution; existing
  callers that ignore the field are unaffected.
- `star_thread` is a new tool name in the dispatcher route table;
  ADR-0021 commits this is a non-breaking addition.
- `ThreadIdGSI` is **not** modified — `starred_at` is not added to its
  `INCLUDE` projection. The Query path that uses the GSI
  (`list_thread_messages`) isn't asked about star state; the inbox
  window's base-table read is. ADR-0011 (GSIs are forever) stays
  honored — no rebuild.

## Implementation

1. **Core types** — `src/core/store.ts` adds `StarThreadInput` /
   `StarThreadResult` and `MessageReader.starThread`. Tail-add
   `starred_at: string | null` to `InboxRowOk` and `ReadMessageOk`.
2. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns
   `starThread`. Reuses `ThreadIdGSI` for the resolve step and
   `attribute_exists(#addr)` for the per-row guard. Project
   `starred_at` in `projectInboxRow` / `projectOk`.
3. **BFF schema** — `parseStarThreadInput` in `src/bff/schemas.ts`.
   Required `thread_id: string` and `starred: boolean`.
4. **BFF dispatcher** — new `case "star_thread"` in
   `src/bff/dispatcher.ts`. Same `MAX_THREAD_LIMIT = 200` cap shared
   with `list_thread_messages`.
5. **Web client** — `bff.starThread` in
   `src/web/src/lib/bff-client.ts`. `Thread.starred` derived in
   `src/web/src/lib/threading.ts`. `RailView` extension and Starred
   filter in `src/web/src/components/Rail.tsx` + `App.tsx`. Star
   icon-button in `InboxList.tsx` + `Reader.tsx`. `starred_at`
   added to the mirrored `InboxRowOk` / `ReadMessageOk` shapes.
6. **Tests**
   - `dynamodb-reader` test — star path: GSI Query + N parallel
     UpdateCommands with the right ConditionExpression and
     UpdateExpression. Unstar path: REMOVE shape. Empty-thread path:
     no UpdateCommand fired, `updated_count: 0`. Cap at 200 enforced.
   - `bff-dispatcher` test — route, 400s on missing/invalid input,
     success body shape. The new reader stub method lands in every
     dispatcher-test setup the way `listThreadMessages` did in slice
     8.9.
   - `threading.test.ts` — `groupIntoThreads` derives `starred` from
     constituent row `starred_at`; mixed star + unstar rows in the
     same thread → starred.
   - Web component test for the icon-button toggle and the Starred
     view filter.

## Considered and rejected

- **Stamp only the thread root row.** Cleaner conceptually — one row,
  one annotation. Forces every read to find the root, which the inbox
  window doesn't necessarily contain (the root may have scrolled off).
  Race-prone too: a new "earlier" reply changes the root, and the old
  root's `starred_at` is now on a non-root row. Stamping every row
  removes the question.
- **Separate `ThreadAnnotations` table keyed on `thread_id`.** The
  cleanest long-term shape — one row per thread carries star, trash,
  snooze, label, etc. Out of scope for this slice; revisit when 8.11
  + 8.12 ship and the trade-off has data behind it. Doing it now would
  double the read surface for the inbox listing (per-thread annotation
  Query for every visible thread).
- **Sparse `StarredAtGSI` (PK=address, SK=starred_at).** Lets the
  Starred sidebar paginate out-of-window starred threads. Cost: a new
  GSI, a new RPC, a new dispatcher case. Hand-off doc explicitly
  says "no GSI, client-side filter for the starred sidebar entry";
  honor it. Revisit if the in-window-only filter is too lossy.
- **Idempotent first-star-wins semantics.** `mark_read` preserves the
  first-open timestamp; star could too. Star isn't an event — it's a
  toggle the operator flips deliberately. Preserving the first-star
  timestamp would mean an unstar/star cycle still reports the
  *original* `starred_at`, which surprises the reader. Plain `SET`
  with each star, plain `REMOVE` with each unstar.
- **TransactWriteItems for the fan-out.** All-or-nothing semantics
  for the per-row writes. Costs 2× WCU per item and caps at 100
  items per transaction. The fan-out is already idempotent under
  per-row failure (a partial write leaves the thread in a
  partially-starred state, which the aggregation rule still
  flags as starred). Plain `Promise.all` of `UpdateCommand` is
  simpler and matches `mark_read`.
- **Skip the GSI; star using the inbox-window rows the client
  already has.** Tempting — the client knows the rows. Costs us the
  invariant that "starring a thread stars every row," because rows
  outside the window aren't included. Aggregation would still
  surface "starred" via in-window rows, but a later listInbox call
  that brings the out-of-window row into view would render that row
  as unstarred-within-a-starred-thread, surprising the operator on
  any per-row star indicator we add later. The GSI Query is one
  call; pay it.
- **Audit-log every star.** Star isn't a permission-relevant event.
  The audit table records send / persist / suppression / mark-read
  hooks today; star follows mark-read's no-audit pattern.
