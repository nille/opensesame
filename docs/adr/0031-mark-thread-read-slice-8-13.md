# `mark_thread_read` RPC + per-thread `read_at` fan-out, slice 8.13

Slices 8.10 (ADR-0028, star), 8.11 (ADR-0029, snooze) and 8.12 (ADR-0030,
trash) shipped the per-row sparse-attribute fan-out shape. This slice
extends it to the **read/unread** annotation — the fourth operator
toggle on a thread. The per-row `read_at` attribute already exists from
slice 8.2 (the reader auto-stamps when the operator opens a row); what
this slice adds is:

- A **per-thread** RPC that bulk-stamps every inbound row in the thread
  in one call, so the operator can mark a whole conversation read (or
  unread) from the inbox without expanding it.
- An explicit **mark-unread** path that REMOVEs `read_at` — there has
  been no way to flip a row back to unread until now.

The interesting design pivots vs. the previous three slices:

- **vs. star / snooze / trash.** Wire shape mirrors star and trash (a
  boolean toggle), reusing the same `fanOutThreadAttribute` helper.
  The novel piece is a **direction filter** — the fan-out targets only
  rows where `direction == "in"`. Outbound rows are never "unread"
  (the operator sent them); stamping `read_at` on them muddies the
  audit signal even though it would be cosmetically harmless.
- **Wake-on-reply.** A fresh inbound reply lands without `read_at`,
  and the existing `Thread.unread` aggregation rule ("any inbound row
  with `read_at == null` → unread") flips the thread back to unread
  for free. No extra logic in this slice — same flavor of
  fall-out-for-free that snooze and trash already exploit.
- **No new GSI.** `ThreadIdGSI` (ADR-0027, slice 8.9) already exists
  and is what the resolve step uses. We extend its `ProjectionExpression`
  on the Query path *only at call time* — by adding `direction` to the
  projection list. The GSI's `Projection` config in CDK already
  `INCLUDE`s `direction` (slice 8.9), so no GSI rebuild.

## Decision

### Per-row `read_at` semantics unchanged

- `read_at` remains a sparse, per-row, ISO-8601 attribute. Attribute-
  absent → null → "unread". Same convention as `starred_at`,
  `snoozed_until`, `trashed_at`.
- The slice 8.2 per-row `markRead` (stamp on first reader open,
  first-write-wins via `attribute_not_exists(read_at)`) keeps its
  existing semantics. This slice adds a *separate* per-thread path
  alongside it — they coexist, both stamp the same attribute.
- The per-row `markRead` is first-write-wins (preserves the original
  open time as an audit signal). The per-thread `markThreadRead` is
  **last-write-wins** (UI toggle, mirrors star). When the operator
  marks an already-read thread as read again, the timestamp updates
  to "now" — same trade-off star already accepted, and for the same
  reason: this is a UI toggle, not a first-event timestamp.
- Skeleton rows (`parse_status: "failed"`) never carry a `thread_id`
  and so are never marked read by this RPC — the resolve step uses
  `ThreadIdGSI` and skeletons aren't on the index.

### The fan-out targets inbound rows only

The novel constraint vs. star / snooze / trash: not every row in the
thread is a fan-out target. Outbound rows (`direction == "out"`) are
the operator's own sends and are never "unread" in any UI sense — the
inbox dot ignores them already. Stamping `read_at` on them would be
cosmetically harmless but it muddies the audit posture: `read_at` on
an outbound row would imply the operator "read" their own send, which
is meaningless.

The implementation projects `direction` on the GSI Query and the
fan-out filters rows where `direction == "in"`. Rows with `direction`
absent (legacy, pre-slice-8.4) collapse to null and are skipped — same
posture as the slice 8.2 backfill.

### `MessageReader.markThreadRead(input, now)`

```ts
type MarkThreadReadInput = {
  thread_id: string;
  read: boolean;
};

type MarkThreadReadResult = {
  thread_id: string;
  read: boolean;
  read_at: string | null;
  updated_count: number;
};

markThreadRead(
  input: MarkThreadReadInput,
  now: Date,
): Promise<MarkThreadReadResult>;
```

- Step 1: Query `ThreadIdGSI` for `thread_id`, project
  `address, internal_id, direction`, limit `MAX_THREAD_LIMIT`. One
  RCU per row.
- Step 2: Filter the result to `direction == "in"` rows only.
- Step 3: For each surviving primary key, fan out parallel
  `UpdateCommand`s through the existing `fanOutThreadAttribute`
  helper (or a thin wrapper that pre-filters the rows).
  - Mark read: `SET read_at = :iso` with
    `ConditionExpression: attribute_exists(#addr)`. Last-write-wins —
    overwrites any existing timestamp.
  - Mark unread: `REMOVE read_at` with
    `ConditionExpression: attribute_exists(#addr)`. Already-unread
    rows are a benign no-op — REMOVE on a missing attribute succeeds.
- Step 4: Return `updated_count = number of successful inbound
  writes`. The result echoes `read_at` (the `now.toISOString()` value
  when marking read, `null` when marking unread) so the caller can
  render the affordance without re-reading.
- Empty thread (no rows on the GSI) → `updated_count: 0`,
  `read: <input>`, `read_at: null`. No 404.
- Outbound-only thread (every row is a send) → `updated_count: 0`,
  `read: <input>`. The dispatcher returns 200; the UI swallows as
  no-op.

### `/rpc/mark_thread_read` BFF tool

- New case in `dispatch`. Input schema:
  `{ thread_id: string; read: boolean }`.
- 400 `invalid_request` when:
  - `thread_id` missing/empty
  - `read` missing entirely
  - `read` not a boolean (string `"true"`, number `1`, null all
    rejected — keeps the wire shape unambiguous)
- 200 with the full `MarkThreadReadResult` body on success (including
  `updated_count: 0`).
- No 404, no 409.

### Web client: optimistic toggle, button, shortcut

- `Thread.unread` (in `src/web/src/lib/threading.ts`) is unchanged —
  the existing rule "any inbound row with `read_at == null` → unread"
  already handles wake-on-reply for free.
- Optimistic state lives in a new `pendingReads: Map<rootKey, boolean>`
  alongside `pendingStars`, `pendingSnoozes`, `pendingTrashes`. Reverts
  on RPC error (toast; same posture as the other three).
- `bff.markThreadRead(input)` lives in `bff-client.ts` shaped like
  `bff.starThread`.
- A small "envelope" / "envelope-open" icon-button sits in the
  inbox-row right gutter alongside Star/Snooze/Trash, and at the top
  of the reader. The icon flips: closed envelope = mark unread,
  open envelope = mark read. Clicking toggles the inverse of the
  current `Thread.unread` value.
- Keyboard: `Shift+U` toggles read/unread on the focused thread.
  Gmail's convention; plain `u` is reserved for a future archive
  shortcut.

### What this slice does *not* ship

- **No backfill.** The slice 8.2 backfill (`src/bin/backfill-read-at.ts`)
  already covers pre-existing rows. New behavior layers on top.
- **No new GSI.** No `UnreadGSI`. The "unread count" badge in the rail
  filters the inbox window client-side, like Starred / Snoozed /
  Trash.
- **No notification on wake-by-reply.** When a fresh inbound makes a
  read thread unread again, the inbox just shows the unread dot.
  Same posture as snooze and trash.
- **No bulk mark-read.** Per-thread toggle only. Multi-select is a
  follow-up across all four annotations.
- **No "mark all read" affordance.** No batch operation against the
  inbox window.
- **No per-row mark-unread RPC.** v1 only exposes the per-thread
  mark-unread path. A per-row variant is a follow-up if needed.
- **No per-operator state.** Same as 8.10 / 8.11 / 8.12.
- **No audit log entry.** Same as 8.10 / 8.11 / 8.12 — UI state, not a
  state-transition event.
- **No interaction with star/snooze/trash.** Marking a starred thread
  unread doesn't unstar it; marking a trashed thread read doesn't
  untrash it. Orthogonal annotations.

### Wire format & event compatibility

- No new fields on `read_inbox`, `get_message`, or
  `list_thread_messages` — `read_at` is already on the wire.
- `mark_thread_read` is a new tool name in the dispatcher route
  table; ADR-0021 commits this is a non-breaking addition.
- `ThreadIdGSI` is **not** modified. The Query path adds `direction`
  to the `ProjectionExpression`, but the GSI's CDK `Projection`
  already `INCLUDE`s it — so no GSI rebuild.

## Implementation

1. **Core types** — `src/core/store.ts` adds `MarkThreadReadInput` /
   `MarkThreadReadResult` and `MessageReader.markThreadRead`. No
   change to `InboxRowOk` / `ReadMessageOk` (they already carry
   `read_at`).
2. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns
   `markThreadRead`. Either:
   - Extend `fanOutThreadAttribute` with an optional row predicate
     `(row) => boolean` and a projection-extension hook, or
   - Inline a sibling `fanOutThreadAttributeFiltered` that adds
     `direction` to the projection and filters before fan-out.
   Pick whichever keeps the helper under the 800-line ceiling. The
   per-row `attribute_exists(#addr)` guard and the
   `ConditionalCheckFailedException` tolerance carry over unchanged.
3. **BFF schema** — `parseMarkThreadReadInput` in `src/bff/schemas.ts`.
   Required `thread_id: string`; required `read: boolean`.
4. **BFF dispatcher** — new `case "mark_thread_read"` in
   `src/bff/dispatcher.ts`. Same `MAX_THREAD_LIMIT = 200` cap.
5. **Web client** — `bff.markThreadRead` in
   `src/web/src/lib/bff-client.ts`. `pendingReads` map +
   `onToggleRead` handler in `src/web/src/components/App.tsx`.
   `Shift+U` keyboard binding alongside `s` / `z` / `#`.
   `MarkReadButton` in `src/web/src/components/MarkRead.tsx`,
   rendered in the inbox row gutter and the reader header.
6. **Tests**
   - `dynamodb-reader` test — read path: GSI Query with `direction`
     projection + N parallel UpdateCommands with the right
     ConditionExpression and UpdateExpression. Unread path: REMOVE
     shape. **Direction filter test:** outbound rows in the GSI
     result are skipped, only inbound rows generate UpdateCommands.
     Empty-thread path: no UpdateCommand fired, `updated_count: 0`.
     Outbound-only thread: `updated_count: 0`. Cap at 200 enforced.
   - `bff-dispatcher` test — route, 400s on missing/invalid input,
     success body shape, 500 on reader throw.
   - `bff-schemas` test — `parseMarkThreadReadInput` rejects
     non-boolean `read`, missing `thread_id`, etc.
   - `threading.test.ts` — already covers `unread` aggregation;
     re-verify the wake-on-reply path still works alongside the new
     pendingReads optimistic state.
   - Web component test for the mark-read button + `Shift+U`
     shortcut.

## Considered and rejected

- **Two RPCs (`mark_thread_read`, `mark_thread_unread`).** Cleaner
  verbs but doubles the wire surface and the dispatcher cases for
  the same effect. Star, trash, and snooze all chose the boolean
  form; this slice mirrors that consistency.
- **Stamp `read_at` on every row including outbound.** Simpler
  fan-out — the existing `fanOutThreadAttribute` helper takes no
  predicate. Rejected: stamps a meaningless timestamp on outbound
  rows ("operator read their own send"), muddying the audit signal
  for a cosmetic gain (the inbox dot already ignores outbound).
- **Sticky per-thread "marked read" flag overriding per-row
  `read_at`.** Would let the operator mark a thread read once and
  have it stay read even when fresh inbound arrives. New attribute,
  new aggregation rule, contradicts wake-on-reply muscle memory.
  Rejected — wake-on-reply is the standard.
- **Per-row mark-unread RPC.** Useful for "I expanded a row by
  accident, mark it unread again" without touching the rest of the
  thread. v1 ships per-thread only; per-row can layer in if the
  ergonomic gap shows up.
- **Make per-row `markRead` last-write-wins to match the per-thread
  path.** Tempting for symmetry. Rejected — slice 8.2 deliberately
  used `attribute_not_exists(read_at)` to preserve the original open
  time as an audit signal. The two paths serve different intents
  (auto-mark on open vs. explicit toggle) and can disagree on
  semantics without confusion.
- **Single `read_at` on a thread-root row.** Same critique as star /
  snooze / trash: forces a "find the root" step on every read,
  races under root drift. Plain fan-out wins.
- **TransactWriteItems for the fan-out.** Same answer as the other
  three: not worth the 2× WCU and 100-item cap; per-row idempotence
  is fine.
- **Reuse `r` for read.** Conflicts with potential future "reply"
  shortcut and isn't Gmail's convention. `Shift+U` is unambiguous.
- **Plain `u` for unread.** Some clients use it for "archive".
  Reserve `u` for a future archive shortcut; `Shift+U` is the
  Gmail-canonical mark-unread key.
- **Backfill `read_at` on every existing read thread.** No-op — the
  slice 8.2 backfill (`src/bin/backfill-read-at.ts`) already stamps
  `read_at = received_at` on legacy rows. New behavior layers on
  top with no migration.
