# `*_thread_label` RPCs + multi-valued `labels`, slice 8.17

Slices 8.10–8.13 (ADR-0028…0031) shipped four sparse-attribute fan-out
annotations — star, snooze, trash, read — and slice 8.16 (ADR-0034) added
archive on the same shape. Slices 8.14 / 8.15 (ADR-0032, ADR-0033) put
all of them under bulk multi-select and select-all. This slice extends
the same per-row fan-out pattern to **operator-defined labels**: Gmail's
"tags", a many-to-many membership where a thread can carry N labels and
a label can apply to N threads.

The interesting design pivots vs. archive:

- **Many-to-many, not boolean.** A row carries a *set* of label names,
  not a sparse timestamp. The fan-out helper extends to set add / set
  remove instead of plain SET / REMOVE.
- **Catalog separate from membership.** The list of available labels
  has to live somewhere the rail can render before any thread is
  labelled. We make it explicit so rename and delete are O(1) on the
  catalog side and O(rows) on the membership side, with the operator
  in control of the cost.
- **Wake-on-reply doesn't apply.** A fresh inbound row in a labelled
  thread arrives without the label. With star's OR aggregation the
  thread stays labelled — exactly what the operator wants. We pick
  the OR-shaped derivation, the same one that gives star its "any row
  starred → starred thread" rule. Different from archive / trash /
  snooze, where the every-row predicate is the whole point.
- **Bulk in scope from day one.** ADR-0032 already proved the
  selection plumbing; bulk-apply-label is the most-used label action
  in any Gmail-shaped client.

## Decision

### `labels` is a sparse, multi-valued per-row attribute on `Messages`

- Type: DynamoDB **String Set** (`SS`). Attribute-absent on the row →
  "no labels". A thread is "labelled X" when *any* row in the thread
  carries `"X"` in its set — same OR-aggregation rule as `starred_at`
  in ADR-0028.
- One attribute, N values. The operator's label name is the value;
  no per-operator state, no priority, no ordering. v1 single-tenant
  follows the same posture ADR-0028 / ADR-0034 set.
- Skeleton rows (`parse_status: "failed"`) never carry a `thread_id`
  and so never receive labels — `add_thread_label` resolves rows via
  `ThreadIdGSI` and skeletons aren't on the index. Same precedent as
  every fan-out slice 8.10 onward.
- Empty-set semantics: when the last value is removed from a row's
  set, the row's `labels` attribute is **removed entirely** (DynamoDB
  cannot store an empty SS). The aggregation rule treats absent and
  empty identically, so this is an internal storage detail.

### The annotation is per-thread, written across every row

Identical fan-out shape to star. The reader resolves every row in the
thread via `ThreadIdGSI` (the index from slice 8.9 / ADR-0027), then
issues one conditional `UpdateItem` per row:

- **Add label**: `ADD labels :val` where `:val` is a one-element
  `SS{label}`. Idempotent at the value level — `ADD` on a set treats
  the value as a member-add, no duplicates.
- **Remove label**: `DELETE labels :val`. When the resulting set is
  empty, a follow-up `REMOVE labels` is **not** issued — DDB's
  `DELETE` on the last member already drops the attribute. Verified
  against the SDK contract; tested in the dynamodb-reader test.

The condition guard stays `attribute_exists(#addr)` — same phantom-row
protection the star fan-out uses. The fan-out cap stays
`MAX_THREAD_LIMIT = 200`.

Wake-on-reply is **not** a feature here. A fresh inbound row arrives
without `labels`; the thread's existing label set is preserved by the
OR aggregation across the in-window rows that *do* carry the label.
This is the right behavior — the operator's intent in labelling a
thread is "this is one of those", and a reply doesn't undo that
classification. Re-applying the label on the new row is a deliberate
follow-up the operator can make if they want every row stamped.

### Catalog: explicit `Label` items on the `Messages` table

A separate item kind colocated with messages on the same partition
shape:

```
PK: address       (S, the mailbox address — same partition as Messages)
SK: LABEL#<name>  (S, e.g. "LABEL#waiting")
created_at: ISO-8601
schema_v: "1"
```

Why explicit catalog instead of "any string ever added becomes a
label":

- **Rename without rewriting every row.** An implicit catalog forces
  rename to be `O(rows-carrying-label)` writes. With explicit
  catalog v1 keeps rename a one-item write at the catalog and a
  *deferred* bulk fan-out at the membership — see the rename
  decision below.
- **Empty-state UI.** The rail needs to render the labels section
  before the operator labels their first thread. An implicit catalog
  has no first state.
- **Sort order, future color.** Catalog rows are the place to add
  per-label `color`, `order`, `description` later (deferred — see
  "What this slice does *not* ship"). Implicit catalogs leak label
  metadata into every row that carries the label.
- **Rail count.** Counts are computed client-side from the in-window
  thread set (see below); the catalog gives the rail something to
  render zero-counts against, which is the bulk-action menu's
  expected behaviour.

The catalog lives on the `Messages` table to avoid a second table. It
shares the partition (`address`) with the message rows, which is fine
— the SK prefix `LABEL#` is disjoint from `internal_id` (a ULID) and
from any future `SK` tier we might add. Reads use a Query with
`begins_with(SK, "LABEL#")`.

ADR-0011 honored: no new GSI, no new table.

### Catalog operations: create, list, rename, delete

- **Create** (`create_label`): one `PutItem` with
  `ConditionExpression: attribute_not_exists(SK)`. 409 `already_exists`
  on conflict — distinct from the empty-thread no-op shape used by
  the fan-out RPCs because catalog identity matters here.
- **List** (`list_labels`): one Query with `begins_with(SK, "LABEL#")`,
  paged. v1 mailboxes are operator-scale, so a single page covers
  every realistic catalog (cap 100 — see visual budget below).
- **Rename** (`rename_label`): a *catalog-only* operation in v1.
  `PutItem` the new `LABEL#<new>` row, `DeleteItem` the old
  `LABEL#<old>` row, then fan out across every row carrying
  `<old>` in its `labels` set: `DELETE labels :old, ADD labels :new`
  in a single `UpdateItem` per row. Bounded by `MAX_THREAD_LIMIT`?
  No — rename has no thread_id to resolve through, so it scans by
  the labelled-row set instead. With v1 mailbox sizes the worst case
  is "every row in the mailbox carries the label," which the
  dispatcher caps at `MAX_RENAME_FANOUT = 1000` rows per call. The
  result body echoes `updated_row_count` and an
  `incomplete: boolean` flag the operator can re-call against. No
  GSI for "rows-with-label-X" — we Query the address partition with
  `FilterExpression: contains(labels, :old)` and accept the
  filter-after-scan cost; mailboxes at this size make this a
  one-page Query in practice.
- **Delete** (`delete_label`): `DeleteItem` on the catalog row +
  bulk strip (same `MAX_RENAME_FANOUT` cap, same scan-and-filter
  resolve). Tombstoning the catalog and leaving rows alone was
  rejected — see "Considered and rejected" — because it surfaces
  ghost labels in the rail and on inbox chips with no way to clean
  them up.

The dispatcher routes the catalog RPCs the same way every other
slice does; no new infrastructure.

### `MessageReader` extensions

```ts
type AddThreadLabelInput    = { thread_id: string; label: string };
type RemoveThreadLabelInput = { thread_id: string; label: string };

type ThreadLabelResult = {
  thread_id: string;
  label: string;
  labels: string[];          // post-state for the operator's lead row
  updated_count: number;
};

type CreateLabelInput = { address: string; label: string };
type DeleteLabelInput = { address: string; label: string };
type RenameLabelInput = { address: string; from: string; to: string };
type ListLabelsInput  = { address: string };

type LabelCatalogEntry = { label: string; created_at: string };
type ListLabelsResult  = { labels: LabelCatalogEntry[] };

type RenameLabelResult = {
  from: string;
  to: string;
  updated_row_count: number;
  incomplete: boolean;       // true when MAX_RENAME_FANOUT was hit
};

type DeleteLabelResult = {
  label: string;
  updated_row_count: number;
  incomplete: boolean;
};

addThreadLabel(input: AddThreadLabelInput, now: Date): Promise<ThreadLabelResult>;
removeThreadLabel(input: RemoveThreadLabelInput, now: Date): Promise<ThreadLabelResult>;
listLabels(input: ListLabelsInput): Promise<ListLabelsResult>;
createLabel(input: CreateLabelInput, now: Date): Promise<LabelCatalogEntry>;
renameLabel(input: RenameLabelInput, now: Date): Promise<RenameLabelResult>;
deleteLabel(input: DeleteLabelInput): Promise<DeleteLabelResult>;
```

`addThreadLabel` / `removeThreadLabel` reuse a tweaked
`fanOutThreadAttribute` — the helper grows a `setOp: "add" | "delete"`
discriminator alongside the existing `value: string | null` shape.
Existing callers (star, snooze, trash, archive, mark_thread_read)
pass `setOp: undefined` and stay on the `SET`/`REMOVE` path. The
helper's `attribute_exists(#addr)` guard, `MAX_THREAD_LIMIT` cap,
and ConditionalCheckFailed tolerance are preserved verbatim.

`labels: string[]` (the sorted Array projection of the SS) is
returned in `ThreadLabelResult` so the optimistic UI can render the
post-state without a refetch — same posture as `archived_at` echoes
in ADR-0034.

### Wire row carries `labels: string[]`

- `InboxRowOk` and `ReadMessageOk` gain a tail
  `labels: string[]` field. Attribute-absent on the DDB row → `[]`.
  ADR-0021 — wire-additive evolution; never `null`, never absent,
  always a (possibly empty) array so client filters and chips don't
  branch on the field's presence.
- `projectInboxRow` and `projectOk` in `dynamodb-reader.ts` read
  the SS via a new `stringSetToArray` helper alongside
  `nullableString`.
- The web client mirrors the field on its `InboxRowOk` and
  `ReadMessageOk` types in `bff-client.ts`. Stable sort
  (lexicographic, case-insensitive) on read so the same set of
  labels renders identically across browsers and rounds of
  refetching.

### `/rpc/*_thread_label` and `/rpc/*_label` BFF tools

Six new `case` arms in `dispatch`:

- `add_thread_label` — `{ thread_id, label }`. 400 on missing /
  empty `thread_id` or `label`. 200 with `ThreadLabelResult` (empty
  thread → `updated_count: 0`, no 404 — same posture as star).
- `remove_thread_label` — symmetric.
- `list_labels` — `{ address }`. 200 with `ListLabelsResult`.
- `create_label` — `{ address, label }`. 200 with the catalog entry,
  409 `already_exists` on conflict.
- `delete_label` — `{ address, label }`. 200 with `DeleteLabelResult`.
  Missing catalog entry → 200 no-op (`updated_row_count: 0`); the
  catalog write is idempotent, the bulk strip already runs against
  whatever rows happen to carry the value.
- `rename_label` — `{ address, from, to }`. 400 when `from === to`,
  400 on missing/empty inputs, 409 when `to` already exists in the
  catalog, 200 with `RenameLabelResult` otherwise.

Label-name validation lives in the schema layer:

- 1–32 chars (UI-meaningful, same width budget as the rail entry)
- Trim leading / trailing whitespace; reject empty after trim
- Disallow ASCII control chars and `,` (the latter so a
  later "labels:foo,bar" search syntax stays unambiguous)
- Case is **preserved** but not significant for catalog identity —
  the catalog row's SK is `LABEL#<lowercased>`, the original casing
  is stored in a `display_name` attribute. The fan-out value uses
  the lowercased form on the wire and on the row. Operators see
  their casing back in the rail; collisions on case are rejected
  at create / rename time.

### Web client: aggregation, rail, chips, affordance, view filters

- `Thread` (in `src/web/src/lib/threading.ts`) gains:
  - `labels: string[]` — union of every parsed row's `labels` array,
    deduped and sorted (lexicographic, case-insensitive). Computed
    in `groupIntoThreads` via the same upsert pass that derives
    `starred` / `unread`. OR aggregation matches star.
- View filters become label-aware:
  - `RailView` widens to a discriminated union:
    `"inbox" | "sent" | "starred" | "snoozed" | "trashed" | "archived" | { kind: "label"; label: string }`.
    The label view filters
    `threads.filter(t => t.labels.includes(label) && !t.archived && !t.trashed)`.
  - **Inbox**, **Sent**, **Starred**, **Snoozed** unchanged; a
    labelled thread in the Inbox shows its label chips on the row
    but doesn't drop out of any existing view. Labels are
    orthogonal classifications, not folders — same posture Gmail
    settled on after the IMAP-folder mistake.
  - **Trash** and **Archive** still hide labelled threads from
    every other view (existing rules win); inside a label view a
    trashed-while-labelled thread is hidden, same posture as the
    archive view in ADR-0034.
- Rail:
  - A new `Labels` section under the existing inbox / starred /
    snoozed / sent / trash / archive entries. Each label renders
    as a `rail__navitem` with the label name and an in-window
    count (zero renders as `—`, same posture as starredCount).
  - **Visual budget: 20.** The rail collapses to "20 most-recent +
    `more (N)`" past the cap, where "most-recent" is sorted by
    most-recent-thread-touch on a labelled thread (computed
    client-side from the in-window threads). The overflow control
    expands inline; no separate page. Past 50 labels we truncate
    further to "alphabetical first 50 + the active label if not in
    that set"; this is a v1 ceiling not an architectural one.
  - System views (Inbox / Sent / etc.) are **not** rendered as
    labels and don't appear in `list_labels`. They stay as
    orthogonal `RailView` literals — see "Considered and rejected"
    for why.
- Inbox row chips:
  - The existing meta-strip (count / sent / snoozed / trashed /
    archived chips) gains label chips. Show **first 2** labels by
    name, then `+N` for the rest. 2 + overflow keeps the strip
    width predictable; 3 starts to crowd reply-to and snooze chips
    on narrow widths. The chip-cluster width is bounded — chips
    truncate the name at 12 chars with `…` rather than wrapping.
- Reader:
  - The reader header gains a "labels" affordance — a chip list
    plus an "add label" plus button. Picker is a vertical list of
    catalog entries (toggle-style; checked rows are currently
    applied). Create-from-picker is in scope: typing a name not in
    the catalog shows "+ create '<name>'" as the last row, which
    fires `create_label` then `add_thread_label` in sequence.
- `bff.addThreadLabel` / `bff.removeThreadLabel` /
  `bff.listLabels` / `bff.createLabel` / `bff.deleteLabel` /
  `bff.renameLabel` in `bff-client.ts`, shaped after
  `bff.archiveThread` / `bff.markRead`.
- Pending-intent map:
  `pendingLabels: Map<string, { add: Set<string>; remove: Set<string> }>`,
  keyed on `rootKey`. Each entry tracks the optimistic deltas
  in flight for that thread. Render derives the visible label set
  as `(server_labels ∪ pending.add) \ pending.remove`. On RPC
  resolve, the matching delta is removed from the entry; on RPC
  reject, the delta is removed and a toast surfaces the failure.
  The shape is intentionally a delta map (not a full optimistic
  snapshot like `pendingTrashes`) because labels are
  multi-valued — two concurrent add-different-labels calls have
  to coexist.
- Keyboard:
  - `l` opens the label picker on the focused thread (Gmail
    convention); selection-aware (a non-empty selection opens the
    picker scoped to apply / remove across every selected
    `rootKey`).
  - The picker is a typeahead — typing filters the catalog,
    `Enter` toggles the focused entry, `Cmd/Ctrl+Enter` toggles
    and closes. `Esc` closes without applying pending toggles.
  - The cheat sheet (`?`) gains the `l` line.

### Bulk apply / remove

The selection-aware branch in `App.tsx` reuses 8.14's pattern: when
`selection.size > 0` and `l` opens the picker, each pick fans out
across the selected `rootKey`s via Promise.allSettled, populating
`pendingLabels` deltas per key while in flight. Errors flow through
the same toast/revert path as bulk star / archive.

No new RPC for bulk — the dispatcher only sees N concurrent
`add_thread_label` (or `remove_thread_label`) calls. Same reasoning
as ADR-0032: thread fan-out is already idempotent at the row level
(set add/delete is idempotent at the value level), batch endpoints
would be a premature optimization.

### What this slice does *not* ship

- **No backfill.** Legacy rows have no `labels`; that's the
  unlabelled default. Nothing to migrate.
- **No `LabelGSI`.** ADR-0011 honored — the rail's per-label count
  is computed client-side from the in-window threads, same posture
  as Starred / Snoozed / Trash / Archive. Labelled threads outside
  the inbox window aren't surfaced in their label view at v1; the
  search affordance covers the gap. Re-evaluate if real usage shows
  the in-window-only filter is too lossy.
- **No per-label color.** v1 monochrome — labels render as text
  chips in the rail's existing typography and as text chips in
  the inbox row meta-strip. Color is the obvious follow-up; the
  catalog shape already carries a place for it (`color: string |
  null` would be a tail-add). Deferred.
- **No nested labels / hierarchies.** Gmail allows `Work/Acme`;
  v1 keeps a flat namespace. Rejected for the same reason
  ADR-0030 rejected per-message reason fields — the storage
  doesn't need it yet, and operator-scale catalogs are flat in
  practice.
- **No auto-labelling rules.** "Apply label X when from:foo"
  is a search-then-bulk workflow at v1, not a rule engine.
- **No sharing labels across addresses.** Catalog is partitioned
  by `address`; multi-mailbox is its own slice.
- **No "all mail" view.** Same posture as ADR-0034.
- **No per-operator state.** Single-tenant; one label catalog per
  mailbox, one set of labels per thread globally. Same as
  8.10–8.16.
- **No audit log entry.** Same as 8.10–8.16 — UI state, not a
  state-transition event.

### Wire format & event compatibility

- `read_inbox`, `get_message`, and `list_thread_messages` shapes
  gain a tail `labels: string[]` field. ADR-0021 commits to
  wire-additive evolution; existing callers ignoring the field
  are unaffected.
- `add_thread_label`, `remove_thread_label`, `list_labels`,
  `create_label`, `delete_label`, `rename_label` are six new tool
  names in the dispatcher route table; ADR-0021 commits this is
  a non-breaking addition.
- `ThreadIdGSI` is **not** modified — `labels` is not added to
  its `INCLUDE` projection. The fan-out resolves only PK pairs
  from the GSI. Read paths read the base table where the
  attribute is always present. ADR-0011 honored.

## Implementation

1. **Core types** — `src/core/store.ts` adds `AddThreadLabelInput`
   / `RemoveThreadLabelInput` / `ThreadLabelResult` /
   `LabelCatalogEntry` / `ListLabelsInput` / `ListLabelsResult` /
   `CreateLabelInput` / `DeleteLabelInput` / `DeleteLabelResult` /
   `RenameLabelInput` / `RenameLabelResult`, plus six methods on
   `MessageReader`. Tail-add `labels: string[]` to `InboxRowOk`
   and `ReadMessageOk`.
2. **DDB adapter** — `src/aws/dynamodb-reader.ts`:
   - `fanOutThreadAttribute` grows a `setOp` discriminator; the
     existing five callers pass `undefined` and stay on the
     SET/REMOVE path. Add tests for the new branch.
   - `addThreadLabel` / `removeThreadLabel` thin wrappers.
   - `listLabels` / `createLabel` / `deleteLabel` / `renameLabel`
     against the new `LABEL#` SK prefix.
   - `projectInboxRow` / `projectOk` project `labels` via a new
     `stringSetToArray` helper next to `nullableString`.
3. **BFF schema** — `parseAddThreadLabelInput`,
   `parseRemoveThreadLabelInput`, `parseListLabelsInput`,
   `parseCreateLabelInput`, `parseDeleteLabelInput`,
   `parseRenameLabelInput` in `src/bff/schemas.ts`. Label-name
   validator (1–32 chars, no commas, no controls) shared across the
   three label-bearing parsers.
4. **BFF dispatcher** — six new `case` arms in
   `src/bff/dispatcher.ts`. `MAX_THREAD_LIMIT = 200` for the
   add/remove fan-out. New `MAX_RENAME_FANOUT = 1000` for
   rename / delete row strips, surfaced in the result's
   `incomplete` flag.
5. **Web client** —
   - `bff.addThreadLabel`, `bff.removeThreadLabel`,
     `bff.listLabels`, `bff.createLabel`, `bff.deleteLabel`,
     `bff.renameLabel` in `src/web/src/lib/bff-client.ts`.
   - `Thread.labels` derived in `src/web/src/lib/threading.ts`
     (OR aggregation in `upsert`).
   - `RailView` widens to the discriminated union in
     `src/web/src/components/Rail.tsx`. Labels section rendered
     under the existing nav. Counts derived in
     `src/web/src/components/App.tsx` from the in-window
     `threads` array.
   - `LabelChips` in `src/web/src/components/LabelChips.tsx` —
     2-then-`+N` strip used in `InboxList.tsx` and `Reader.tsx`.
   - `LabelPicker` in `src/web/src/components/LabelPicker.tsx`
     — typeahead, toggle, create-on-miss; mounted from the reader
     header and from the bulk-action bar.
   - `pendingLabels` map joins the existing pending-intent maps
     in `App.tsx`; render computes the visible label set from
     `(server ∪ pending.add) \ pending.remove`.
   - Per-thread `l` keybind + bulk fan-out branch in `App.tsx`,
     mirroring the `e` branch from 8.16.
   - `labels` mirrored on `InboxRowOk` / `ReadMessageOk` shapes.
6. **Tests**
   - `dynamodb-reader.test`: add-label path (`ADD labels :val` SS
     of size 1, condition-guard, ConditionalCheckFailed tolerance),
     remove-label path (`DELETE labels :val`, last-member-drops-attr
     verified), empty-thread path (zero updates, no error),
     `MAX_THREAD_LIMIT = 200` enforced. Catalog: create-then-create
     hits the conditional and 409s; rename writes new + deletes
     old + fans out across labelled rows; delete fans out and drops
     the catalog row. `MAX_RENAME_FANOUT = 1000` enforced with
     `incomplete: true` on overflow.
   - `bff-dispatcher.test`: routes for all six tools, 400s on
     missing/invalid input, success body shapes, 409 on duplicate
     create / rename collision.
   - `bff-schemas.test`: label-name validator rejects empty,
     overlength, comma, control chars; preserves casing on input
     while normalizing for catalog identity.
   - `threading.test.ts`: `groupIntoThreads` derives `labels`
     from constituent rows (OR aggregation); a fresh inbound row
     with no labels in an otherwise-labelled thread → still
     labelled (anti-archive: deliberate behavior).
   - Web component tests for `LabelChips` (2-then-`+N` truncation)
     and `LabelPicker` (typeahead, create-on-miss, toggle-on-Enter).
   - Selection helper unchanged — bulk label reuses `computeRange`
     and `threadableRootKeys` as-is.

## Considered and rejected

- **Storage option (b): separate label-membership items
  (`PK = ADDR#<addr>, SK = LABEL#<label>#<thread_id>`).** Cheapest
  rail count (one Query per label, server-side count). Rejected:
  it breaks the parallelism with star / snooze / trash / archive,
  introduces a new item kind on the message table that the inbox
  read path has to skip in every Query, and forces a second write
  on every row of every labelled thread for every label. The
  client-side rail count is tractable at v1 mailbox sizes; revisit
  if a hard ceiling on labels-per-mailbox forces a server-side
  count.
- **Storage option (c): one item per (row, label) pair
  (`SK = MSG#<msgid>#LABEL#<label>`).** Worst of both worlds — the
  per-row attribute reads stop working for labels (they live on
  separate items now), so the inbox Query has to either fetch
  every label item alongside every message item or do a second
  Query per message. Rejected.
- **Implicit catalog (any label-string ever added becomes a
  label).** Smaller surface — five RPCs instead of six. Rejected
  for the four reasons listed in the catalog section: rename cost,
  empty-state UI, sort/color metadata home, rail-count surfaces.
- **Single `label_thread` RPC with `apply: boolean`.** Mirrors the
  star/trash/archive boolean shape. Rejected — labels are
  fundamentally a different operation (add to set / remove from
  set), and the boolean shape forces a third "label" parameter
  anyway, at which point separate `add_thread_label` /
  `remove_thread_label` RPCs read more clearly in the
  dispatcher and the BFF audit logs.
- **Tombstone catalog entries on delete; leave row labels alone.**
  Smaller delete cost (one catalog write, no row strips). Rejected:
  the rail then needs a "show deleted labels" toggle to render the
  ghost chips, and inbox rows show chips for labels the operator
  thinks they removed. Cleanup-on-delete is the model the operator
  expects.
- **Lossless rename (catalog-only, leave rows on the old value).**
  Forces the rail rename to be a redirect entry. Rejected for the
  same reason as tombstone-on-delete — the operator expects rename
  to mean rename, not redirect.
- **Make system views (Inbox, Sent, Starred, etc.) labels too.**
  Gmail does this internally. Rejected: Inbox / Sent /
  Starred / Snoozed / Trash / Archive are already discriminated
  `RailView` literals with their own filter rules and their own
  derived `Thread` flags. Folding them into a label catalog
  collapses the type and forces every `RailView` consumer to know
  about both storage models. They stay orthogonal.
- **Per-label color in v1.** Worth it for a real visual hierarchy,
  but the picker UI, the palette, the contrast story (day theme
  *and* night theme) are a slice each. Defer.
- **Nested labels (Gmail's `Work/Acme`).** Catalog SK could carry
  the path. Rejected — flat catalog is what fits a 20-entry visual
  budget and an operator-scale mailbox; hierarchy is over-spec for
  v1.
- **Bulk-add via a single `add_label_to_threads` RPC with
  `thread_ids: string[]`.** Same answer as ADR-0032: per-thread
  RPCs fan out cleanly under Promise.allSettled and the network
  RTT is dwarfed by the row-level fan-out cost. No batch endpoint.
- **Add `labels` to `ThreadIdGSI` projection.** The fan-out
  resolve only reads `address, internal_id` from the GSI; the
  inbox base-table read already projects `labels`. Adding to the
  projection rebuilds the GSI (ADR-0011) for no read-path benefit.
- **Wake-on-reply (any unlabelled row → unlabelled thread).**
  Mirrors trash/archive/snooze aggregation. Rejected — labels are
  classifications the operator chose deliberately; a fresh reply
  doesn't reclassify the conversation. Star's OR is the right
  shape.
- **TransactWriteItems for the rename / delete fan-out.** Same
  answer as star / trash / archive — not worth the 2× WCU and
  100-item cap; per-row idempotence (set add/delete) is fine and
  the result echoes the `incomplete` flag for resume.
