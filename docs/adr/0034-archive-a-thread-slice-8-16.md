# `archive_thread` RPC + sparse `archived_at`, slice 8.16

Slices 8.10–8.13 (ADR-0028…0031) shipped four sparse-attribute fan-out
annotations: star, snooze, trash, read. Slices 8.14 and 8.15 (ADR-0032,
ADR-0033) wrapped them in bulk multi-select and select-all. This slice
extends the same fan-out shape to **archive** — the Gmail-shaped "out of
inbox, not deleted" annotation that was deferred at the end of ADR-0030.

The interesting design pivots vs. trash:

- **Archive ≠ trash.** Archive is "this conversation is finished, get it
  out of my eyeline"; trash is "this conversation was a mistake".
  Archive lives alongside trash, not as an alternate reason on the same
  flag — see "Considered and rejected" for why we don't reuse
  `trashed_at`.
- **Wake on reply, like trash.** A fresh inbound row lands without an
  `archived_at` attribute, which trips the every-row predicate and
  flips the thread back to live. Same behavior the operator already
  knows from snooze and trash.
- **Bulk in scope from day one.** ADR-0030 deferred bulk trash; by the
  time we ship archive, ADR-0032 already proved the client-side
  Promise.allSettled fan-out shape. The selection plumbing is already
  generic — adding archive to it is a one-line keymap branch.

## Decision

### `archived_at` is a sparse, per-row attribute on `Messages`

- Type: ISO-8601 string. Attribute-absent on the row → "not archived".
  Same convention as `starred_at`, `snoozed_until`, `trashed_at`,
  `read_at`, `thread_id`.
- One annotation, one attribute. v1 single-tenant, no per-operator
  state, no archive reason, no original archiver.
- Bookkeeping-only timestamp — like `trashed_at`, the value records when
  the row was archived, but the read path doesn't compare it to
  anything. Attribute exists → row reads as archived.
- Skeleton rows (`parse_status: "failed"`) never carry a `thread_id`
  and so are never archived. Same precedent as 8.10–8.13.

### The annotation is per-thread, written across every row

Identical fan-out shape to trash. The reader resolves every row in the
thread via `ThreadIdGSI`, then issues one conditional `UpdateItem` per
row to `SET archived_at = :iso` (archive) or `REMOVE archived_at`
(unarchive). Wake-on-reply falls out of the every-row aggregation rule
for free — a fresh reply lands without `archived_at`, which flips the
thread back to live in the inbox.

The fan-out cap is the existing `MAX_THREAD_LIMIT = 200` shared with
the four other thread-level mutations.

### `MessageReader.archiveThread(input, now)`

```ts
type ArchiveThreadInput = {
  thread_id: string;
  archived: boolean;
};

type ArchiveThreadResult = {
  thread_id: string;
  archived: boolean;
  archived_at: string | null;
  updated_count: number;
};

archiveThread(input: ArchiveThreadInput, now: Date): Promise<ArchiveThreadResult>;
```

Implementation reuses the existing `fanOutThreadAttribute` helper —
identical to how trash and read are implemented. Wire shape mirrors
trash exactly (boolean toggle, ISO-or-null timestamp echo).

### Wire row carries `archived_at`

- `InboxRowOk` and `ReadMessageOk` gain a tail `archived_at: string | null`
  field (ADR-0021 — wire-additive evolution).
- `projectInboxRow` and `projectOk` in `dynamodb-reader.ts` read the
  attribute via the existing `nullableString` helper.
- The web client mirrors the field on its `InboxRowOk` and
  `ReadMessageOk` types in `bff-client.ts`.

### `/rpc/archive_thread` BFF tool

- New `case "archive_thread"` in `dispatch`. Input schema mirrors
  `parseTrashThreadInput`:
  - `thread_id: string` (required, non-empty)
  - `archived: boolean` (required, strict — strings/numbers/null all
    rejected)
- 400 `invalid_request` on schema failure; 200 with the full
  `ArchiveThreadResult` body on success (including `updated_count: 0`
  for empty threads). No 404, no 409.

### Web client: aggregation, sidebar, affordance, view filters

- `Thread` (in `src/web/src/lib/threading.ts`) gains:
  - `archived: boolean` — true iff every parsed row carries
    `archived_at`. Empty `rows` (failed-only thread) → false.
- View filters become archive-aware:
  - **Inbox** filters out archived (the whole point of archive).
  - **Sent** filters out archived.
  - **Starred** filters out archived. Distinct from snooze, where a
    starred-snoozed thread stays visible in Starred. Archive is closer
    to trash semantically — "out of all the day-to-day views" — so we
    treat it the same way.
  - **Snoozed** filters out archived (an archived-while-snoozed thread
    has been resolved by the operator; don't re-surface when it wakes).
  - **Trash** filters out archived.
  - **Archive** is the only view that shows them, sorted by most-recent
    activity descending.
- `RailView` widens to include `"archived"`. The Archive sidebar entry
  shows the count of archived threads in the current inbox window
  (same posture as Starred, Snoozed, Trash).
- `bff.archiveThread(input)` lives in `bff-client.ts` shaped like
  `bff.trashThread`.
- An `ArchiveButton` icon-button sits in the inbox-row right gutter
  alongside Star, Snooze, Trash, MarkRead, and at the top of the
  reader. Click toggles archive with optimistic update; revert on RPC
  error. From inside the Archive view the same button reads
  "unarchive".
- Keyboard:
  - `e` toggles archive on the focused thread (Gmail / Mutt
    convention).
  - `e` with a non-empty selection fans out across all selected
    threads (mirrors bulk star / trash / read in ADR-0032).
  - The cheat sheet (`?`) gains the `e` line.

### Bulk archive

The selection-aware branch in `App.tsx` reads the existing pattern from
8.14: when `selection.size > 0` and `e` is pressed, dispatch
`bff.archiveThread` for every selected `rootKey` via Promise.allSettled,
populating `pendingArchives` for each key while in flight. Errors fall
through to the same toast/revert path as bulk star/trash.

No new RPC for bulk — the dispatcher only sees N concurrent
`archive_thread` calls. Same reasoning as ADR-0032: thread fan-out is
already idempotent, batch endpoints would be a premature optimization.

### What this slice does *not* ship

- **No backfill.** Legacy rows have no `archived_at`; that's the
  unarchived default.
- **No ArchivedAtGSI.** The Archive sidebar filters the inbox window
  client-side, like Starred / Snoozed / Trash.
- **No auto-archive sweep.** No "messages older than 30 days are
  auto-archived" job. Operator action only.
- **No undo toast.** Same posture as star/snooze/trash — toggle is
  reversible by toggling again, no separate ephemeral undo affordance.
- **No "All Mail" view.** Gmail's "everything regardless of folder"
  view is useful, but search already covers the use case at v1.
- **No archive-on-send.** Gmail's "send and archive" is a follow-up.
- **No notification on wake-by-reply.** When an archived thread
  surfaces via a fresh reply, the inbox just shows it again. Same
  posture as snooze / trash.
- **No per-operator state.** Same as 8.10–8.13.
- **No audit log entry.** Same as 8.10–8.13 — UI state, not a
  state-transition event.

### Wire format & event compatibility

- `read_inbox`, `get_message`, and `list_thread_messages` shapes gain
  a tail `archived_at` field. ADR-0021 commits to wire-additive
  evolution.
- `archive_thread` is a new tool name in the dispatcher route table;
  ADR-0021 commits this is a non-breaking addition.
- `ThreadIdGSI` is **not** modified — `archived_at` is not added to
  its `INCLUDE` projection. ADR-0011 honored — no GSI rebuild.

## Implementation

1. **Core types** — `src/core/store.ts` adds `ArchiveThreadInput` /
   `ArchiveThreadResult` and `MessageReader.archiveThread`. Tail-add
   `archived_at: string | null` to `InboxRowOk` and `ReadMessageOk`.
2. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns
   `archiveThread` (3-line wrapper around `fanOutThreadAttribute`).
   Project `archived_at` in `projectInboxRow` / `projectOk`.
3. **BFF schema** — `parseArchiveThreadInput` in `src/bff/schemas.ts`,
   structurally identical to `parseTrashThreadInput`.
4. **BFF dispatcher** — new `case "archive_thread"` in
   `src/bff/dispatcher.ts`. Same `MAX_THREAD_LIMIT = 200` cap.
5. **Web client** —
   - `bff.archiveThread` in `src/web/src/lib/bff-client.ts`.
   - `Thread.archived` derived in `src/web/src/lib/threading.ts`.
   - `RailView` extension and Archive filter in
     `src/web/src/components/Rail.tsx` + `App.tsx`.
   - Every non-Archive view becomes archive-aware (Inbox, Sent,
     Starred, Snoozed, Trash all filter `!archived`).
   - `ArchiveButton` in `src/web/src/components/Archive.tsx`,
     shaped like `TrashButton`.
   - Archive icon-button rendered in `InboxList.tsx` + `Reader.tsx`.
   - `archived_at` added to the mirrored `InboxRowOk` /
     `ReadMessageOk` shapes.
   - Per-thread `e` keybind + bulk fan-out branch in `App.tsx`.
   - `pendingArchives: Map<string, boolean>` joins the existing
     pending-intent maps; same render-as-target shape.
6. **Tests**
   - `dynamodb-reader.test` — archive path: GSI Query + N parallel
     UpdateCommands. Unarchive path: REMOVE shape. Empty-thread path.
     Cap at 200 enforced.
   - `bff-dispatcher.test` — route, 400s on missing/invalid input,
     success body shape.
   - `bff-schemas.test` — `parseArchiveThreadInput` rejects
     non-boolean `archived`, missing `thread_id`.
   - `threading.test.ts` — `groupIntoThreads` derives `archived`
     from constituent row `archived_at`. Wake-on-reply: a single
     unstamped row in an otherwise-archived thread → not archived.
   - Web component test for the archive button and `e` shortcut.
   - Selection helper unchanged — bulk archive reuses `computeRange`
     and `threadableRootKeys` as-is.

## Considered and rejected

- **Reuse `trashed_at` with a `reason` field (or two-state enum:
  archived | trashed).** Smaller schema, but conflates two distinct
  operator intents. Trash is reversible "I made a mistake"; archive is
  reversible "I'm done with this". They have different views,
  different keybinds in every other client, and different long-term
  retention policies (trash auto-purges in some clients, archive
  doesn't). Two attributes is the right factoring; the fan-out helper
  makes the cost trivial.
- **Strict archive (any-archived-row → archived thread, mirroring
  star).** Same critique as the equivalent strict-trash proposal —
  forces the operator to manually unarchive on every reply, fights
  muscle memory. Wake-on-reply is the standard expectation.
- **Hide archived from inbox but keep them in Starred / Snoozed.**
  Mirrors snooze exactly. Rejected — the operator's intent with archive
  is "I don't want to think about this anymore"; surfacing in any
  primary view defeats the affordance. Match the trash treatment.
- **No bulk archive in this slice.** Doable, but the bulk plumbing is
  already generic from 8.14, and archive is the most-used bulk action
  in any Gmail-shaped client. Ship it together.
- **Use `y` (Mutt convention) for the keybind.** `e` is the more
  widely-known Gmail shortcut. `y` is free for a future "report spam"
  or similar.
- **TransactWriteItems for the fan-out.** Same answer as star, snooze,
  trash, read — not worth the 2× WCU and 100-item cap; per-row
  idempotence is fine.
- **Add `archived_at` to `ThreadIdGSI` projection.** Not needed — the
  fan-out resolve only reads PK pairs from the GSI. Read paths read
  the base table, where the attribute is always present. ADR-0011
  honored.
- **Boolean wire shape with no `archived_at` echo in the response.**
  The boolean is enough; clients can re-derive from a refetch.
  Rejected — echoing `archived_at` lets the optimistic UI render the
  chip text without a refetch round-trip. Same reasoning as trash.
