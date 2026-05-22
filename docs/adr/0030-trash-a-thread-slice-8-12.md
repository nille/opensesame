# `trash_thread` RPC + sparse `trashed_at`, slice 8.12

Slices 8.10 (ADR-0028, star) and 8.11 (ADR-0029, snooze) shipped the per-row
sparse-attribute fan-out shape. This slice extends it to **trash** — the
third operator annotation in the inbox punch list. Trashing a thread hides
it from every view except a dedicated Trash sidebar; an inbound reply on a
trashed thread auto-resurfaces it in the inbox.

The interesting design pivots vs. the previous two slices:

- **vs. star.** Wire shape mirrors star (a boolean toggle, not a nullable
  ISO timestamp). The timestamp on the row is bookkeeping; the operator's
  intent is "trashed yes / trashed no".
- **vs. snooze.** Aggregation rule is the same flavor — every parsed row
  must carry `trashed_at` for the thread to read as trashed — but there
  is no expiry. The "wake on reply" behavior falls out of the same
  predicate (a fresh reply lands without `trashed_at`, which flips the
  thread back to untrashed). No background sweep, no scheduler.
- **Visibility.** Snooze still surfaces in Starred ("I starred it, I want
  to see it"). Trash hides everywhere except the Trash sidebar. This
  matches Gmail and Linear and is a stronger user signal than snooze.

## Decision

### `trashed_at` is a sparse, per-row attribute on `Messages`

- Type: ISO-8601 string. Attribute-absent on the row → "not trashed".
  Same convention as `read_at`, `thread_id`, `starred_at`, and
  `snoozed_until`.
- One annotation, one attribute: no per-operator state, no original
  trasher, no reason. v1 single-tenant.
- `trashed_at` semantics are bookkeeping only — the value records when
  the row was trashed, but the read path doesn't compare it to anything.
  Attribute exists → row reads as trashed. Attribute absent → row reads
  as live. (Contrast with `snoozed_until` which is a wake-time predicate.)
- Skeleton rows (`parse_status: "failed"`) never carry a `thread_id` and
  so are never trashed — `trash_thread` resolves rows via `ThreadIdGSI`
  and skeletons aren't on the index. Same precedent as 8.10 and 8.11.

### The annotation is per-thread, written across every row

When the operator trashes a thread, the BFF resolves *every row* in that
thread via `ThreadIdGSI` and stamps `trashed_at = <iso>` on each one.
Untrashing removes the attribute from every row. Same three reasons as
star and snooze (reads stay one-Query, race-free under root drift,
per-row idempotence pattern reused).

The wake-on-reply behavior falls out automatically: a new reply that
arrives after the trash is written *without* a `trashed_at` attribute
(the write path doesn't know about thread state). The client aggregation
rule "thread is trashed iff every row carries `trashed_at`" then flags
the conversation as live again — exactly the desired UX, mirrored from
snooze.

The fan-out cap is the same `MAX_THREAD_LIMIT = 200` already enforced
for `list_thread_messages`, `star_thread`, and `snooze_thread`. Threads
larger than 200 rows trash their first 200 ascending-by-`internal_id`
rows; this is enough to satisfy the aggregation rule on the visible
window.

### `MessageReader.trashThread(input, now)`

```ts
type TrashThreadInput = {
  thread_id: string;
  trashed: boolean;
};

type TrashThreadResult = {
  thread_id: string;
  trashed: boolean;
  trashed_at: string | null;
  updated_count: number;
};

trashThread(input: TrashThreadInput, now: Date): Promise<TrashThreadResult>;
```

- Step 1: Query `ThreadIdGSI` for `thread_id`, project only
  `address, internal_id`, limit `MAX_THREAD_LIMIT`. One RCU per row.
- Step 2: For each resolved primary key, fan out parallel
  `UpdateCommand`s.
  - Trash: `SET trashed_at = :iso` with
    `ConditionExpression: attribute_exists(#addr)`. Re-trashing an
    already-trashed row overwrites the timestamp — like star, this is
    a UI toggle, not a first-event timestamp.
  - Untrash: `REMOVE trashed_at` with
    `ConditionExpression: attribute_exists(#addr)`. Already-untrashed
    rows are a benign no-op — REMOVE on a missing attribute succeeds.
- Step 3: Return `updated_count = number of successful writes`. The
  result also echoes `trashed_at` (the `now.toISOString()` value when
  trashing, `null` when untrashing) so the caller can render the
  affordance without re-reading the row.
- Empty thread (no rows on the GSI) → `updated_count: 0`,
  `trashed: <input>`, `trashed_at: null`. No 404, same reasoning as
  `star_thread` and `snooze_thread`.
- The reader trusts its input — the BFF has already validated
  `thread_id` and the boolean shape.

### Wire row carries `trashed_at`

- `InboxRowOk` and `ReadMessageOk` gain a nullable
  `trashed_at: string | null` field. Attribute-absent on the DDB row
  → null.
- `projectInboxRow` and `projectOk` in `dynamodb-reader.ts` read the
  attribute via the existing `nullableString` helper.
- The web client mirrors the field on its `InboxRowOk` and
  `ReadMessageOk` types in `bff-client.ts`.

### `/rpc/trash_thread` BFF tool

- New case in `dispatch`. Input schema:
  `{ thread_id: string; trashed: boolean }`.
- 400 `invalid_request` when:
  - `thread_id` missing/empty
  - `trashed` missing entirely
  - `trashed` not a boolean (string `"true"`, number `1`, null all
    rejected — keeps the wire shape unambiguous)
- 200 with the full `TrashThreadResult` body on success (including
  `updated_count: 0`).
- No 404, no 409 — empty thread is a 200 no-op, same as `star_thread`
  and `snooze_thread`.

### Web client: aggregation, sidebar, affordance

- `Thread` (in `src/web/src/lib/threading.ts`) gains:
  - `trashed: boolean` — true iff every parsed row carries `trashed_at`.
    Empty `rows` (failed-only thread) → false. **Wake on reply** is
    encoded right here: a row without `trashed_at` (a fresh reply)
    flips this to false.
- View filters become trash-aware:
  - **Inbox** filters out threads where `trashed === true`.
  - **Sent** filters out threads where `trashed === true`.
  - **Starred** filters out threads where `trashed === true`. (Different
    from snooze, which keeps starred-snoozed threads visible. Trash is
    a stronger signal — "this conversation should be gone from my
    eyeline".)
  - **Snoozed** filters out threads where `trashed === true`.
  - **Trash** is the only view that shows them, sorted by most-recent
    activity descending — same ordering as Inbox.
- `RailView` widens to include `"trashed"`. The Trash sidebar entry
  shows the count of trashed threads in the current inbox window.
- `bff.trashThread(input)` lives in `bff-client.ts` shaped like
  `bff.starThread`.
- A small trashcan icon-button sits in the inbox-row right gutter
  alongside Star and Snooze, and at the top of the reader. Click
  toggles trash with optimistic update; revert on RPC error. From
  inside the Trash view the same button reads "untrash" (icon-only,
  filled state).
- Keyboard: `#` toggles trash on the focused thread (Gmail / Linear
  convention; same key for trash and untrash).

### What this slice does *not* ship

- **No backfill.** Legacy rows have no `trashed_at`; that's the
  untrashed default.
- **No TrashedAtGSI.** The Trash sidebar filters the inbox window
  client-side, like Starred and Snoozed. Out-of-window trashed threads
  are not surfaced — accepted v1 limitation.
- **No auto-purge sweep.** Trashed rows stay in DynamoDB indefinitely.
  No "trash older than 30 days is hard-deleted" job. ADR-0012 already
  forbids hard-delete; trash is a soft-delete only.
- **No notification on wake-by-reply.** When a trashed thread surfaces
  via a fresh reply, the inbox just shows it again. No badge, no
  separate "resurfaced" indicator. Same posture as snooze.
- **No bulk trash.** Per-thread toggle only. Multi-select trash is a
  follow-up.
- **No per-operator state.** Same as 8.10 and 8.11.
- **No audit log entry.** Same as 8.10 and 8.11 — UI state, not a
  state-transition event.
- **No separate Archive vs. Trash.** v1 has one annotation. Gmail-style
  Archive is a useful follow-up but doesn't need to gate this slice.
- **No "empty trash" affordance.** No batch-untrash, no batch-purge.
  Single-thread untrash via the same button is the only way out.

### Wire format & event compatibility

- `read_inbox`, `get_message`, and `list_thread_messages` shapes gain
  a tail `trashed_at` field. ADR-0021 commits to wire-additive
  evolution.
- `trash_thread` is a new tool name in the dispatcher route table;
  ADR-0021 commits this is a non-breaking addition.
- `ThreadIdGSI` is **not** modified — `trashed_at` is not added to its
  `INCLUDE` projection. The Query path that uses the GSI reads only
  the PK pair for the fan-out resolve step. ADR-0011 honored — no GSI
  rebuild.

## Implementation

1. **Core types** — `src/core/store.ts` adds `TrashThreadInput` /
   `TrashThreadResult` and `MessageReader.trashThread`. Tail-add
   `trashed_at: string | null` to `InboxRowOk` and `ReadMessageOk`.
2. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns `trashThread`.
   Reuses `ThreadIdGSI` for the resolve step and
   `attribute_exists(#addr)` for the per-row guard. Project
   `trashed_at` in `projectInboxRow` / `projectOk`.
3. **BFF schema** — `parseTrashThreadInput` in `src/bff/schemas.ts`.
   Required `thread_id: string`; required `trashed: boolean`.
4. **BFF dispatcher** — new `case "trash_thread"` in
   `src/bff/dispatcher.ts`. Same `MAX_THREAD_LIMIT = 200` cap.
5. **Web client** — `bff.trashThread` in
   `src/web/src/lib/bff-client.ts`. `Thread.trashed` derived in
   `src/web/src/lib/threading.ts`. `RailView` extension and Trash
   filter in `src/web/src/components/Rail.tsx` + `App.tsx`. Every
   non-Trash view becomes trash-aware. `TrashButton` in
   `src/web/src/components/Trash.tsx`. Trash icon-button rendered in
   `InboxList.tsx` + `Reader.tsx`. `trashed_at` added to the mirrored
   `InboxRowOk` / `ReadMessageOk` shapes.
6. **Tests**
   - `dynamodb-reader` test — trash path: GSI Query + N parallel
     UpdateCommands with the right ConditionExpression and
     UpdateExpression. Untrash path: REMOVE shape. Empty-thread path:
     no UpdateCommand fired, `updated_count: 0`. Cap at 200 enforced.
   - `bff-dispatcher` test — route, 400s on missing/invalid input,
     success body shape.
   - `bff-schemas` test — `parseTrashThreadInput` rejects
     non-boolean `trashed`, missing `thread_id`, etc.
   - `threading.test.ts` — `groupIntoThreads` derives `trashed` from
     constituent row `trashed_at` (every row). Wake-on-reply: a single
     unstamped row in an otherwise trashed thread → not trashed.
     Empty-rows thread → not trashed.
   - Web component test for the trash button, `#` shortcut, view
     filters (every non-Trash view hides trashed; Trash shows them).

## Considered and rejected

- **Hard-delete instead of soft-delete.** Permanently remove the row
  on trash. Rejected — breaks the audit posture in ADR-0012 (every
  inbound message persisted, raw MIME retained in S3) and forecloses
  the "operator trashed by mistake" recovery path. Soft-delete is the
  only sane v1 shape.
- **Strict trash (any-trashed-row → trashed thread, mirroring star).**
  Same critique as the equivalent strict-snooze proposal: forces the
  operator to manually untrash on every reply, fights muscle memory.
  Wake-on-reply is the standard, and it falls out of the every-row
  predicate for free.
- **Separate Archive and Trash states.** Two annotations, two
  attributes, two views. Useful long-term (Archive = "out of inbox,
  searchable"; Trash = "out of inbox, also out of Search"). Rejected
  for v1 — one soft-delete annotation is sufficient and the inbox
  punch list calls for one.
- **Trash hides only from Inbox, stays visible in Starred + Snoozed.**
  Mirrors snooze exactly. Rejected — trash is the operator saying
  "make this go away", and a starred-but-trashed thread visible in
  Starred sends mixed signals. Gmail and Linear both hide trashed
  items from every named view; match the muscle memory.
- **Single `trashed_at` on a thread-root row.** Same critique as star
  and snooze: forces a "find the root" step on every read, races under
  root drift. Plain fan-out wins.
- **Auto-purge sweep at 30 days.** Tempting for cost discipline.
  Rejected — adds a scheduler (cron + Lambda + DDB iterator) for an
  effect that's invisible at v1 sizes and contradicts ADR-0012's
  retention posture. Revisit when there's a measured S3/DDB bill
  pressure.
- **Boolean wire shape with no `trashed_at` echo in the response.**
  The boolean is enough; clients can re-derive `trashed_at` from a
  refetch. Rejected — echoing `trashed_at` lets the optimistic UI
  render the chip text without a refetch round-trip.
- **TransactWriteItems for the fan-out.** Same answer as star and
  snooze: not worth the 2× WCU and 100-item cap; per-row idempotence
  is fine.
- **Reuse `s` or `z` for trash (overload by modifier).** Confusing.
  Trash gets its own shortcut; `#` matches Gmail and Linear and is
  unmistakable.
