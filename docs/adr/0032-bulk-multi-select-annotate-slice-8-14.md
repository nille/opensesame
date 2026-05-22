# Bulk multi-select annotate, slice 8.14

Slices 8.10–8.13 (ADR-0028 star, ADR-0029 snooze, ADR-0030 trash, ADR-0031
read) shipped the four per-thread annotation toggles. Each is keyed by
`thread_id` and runs through its own RPC + optimistic-pending intent map
on the client. This slice adds **bulk multi-select** so the operator can
star, snooze, trash, or mark-read N threads in one gesture from the
inbox without opening any of them.

The interesting design pivots vs. the previous four slices:

- **No new RPCs.** Bulk apply is N parallel calls to the existing
  `star_thread` / `snooze_thread` / `trash_thread` / `mark_thread_read`
  endpoints. Each call carries its own optimistic intent; a per-row
  failure rolls back only that thread, the rest of the selection is
  unaffected. Localhost personal tool — N short HTTP roundtrips do not
  pay for the doubled wire surface a `bulk_*_threads` family would
  cost.
- **Selection lives entirely on the client.** Server has no concept of
  "selected" — selection is keyboard/mouse state in `App.tsx`. Cleared
  on view switch, on Esc, and on selection-emptying actions (apply
  succeeds → optionally clear; apply fails → keep selected so the
  operator can retry).
- **Re-uses every existing component.** `StarButton` / `SnoozeButton` /
  `TrashButton` / `MarkReadButton` already render a clickable affordance;
  the new bulk action bar embeds them with a `variant="bulk"` and a
  multi-thread `onApply` handler. No new icon work, no new ARIA.

## Decision

### Selection model

- A `Set<rootKey>` keyed by `Thread.rootKey` (the same handle used by
  `pendingStars` / `pendingSnoozes` / `pendingTrashes` / `pendingReads`).
  Server-stamped thread ids start with `<…>`; subject-fallback rollups
  do not, and they are gated out of every annotation flow already.
  Bulk select keeps that gate: subject-fallback rows are not selectable.
- An `anchorRootKey: string | null` records the most recent **plain**
  selection click (without Shift), used as the start of a Shift+click
  range. Range expansion picks the inclusive index window between
  anchor and target in the **current `threads` view order**, which
  matches what the operator sees on screen. Switching views or running a
  search resets the anchor (and the selection — see below).
- The selection is cleared on:
  - Pressing `Esc`.
  - Switching views via the rail (`switchView`).
  - Entering or leaving a search (because the source list changes
    shape — same posture `selectedIdx` already takes via `useEffect`).
  - The `pane.mode` flipping to `composer` (composer owns the keyboard).
- The selection is **not** cleared on bulk apply success. Operator
  intent: "I picked these five, now star them, then trash them." A
  follow-up apply on the same selection is the common ergonomic. A
  toggle-to-untoggle bulk apply (e.g. star a set that's already mixed)
  uses the bulk-action-bar's "Star all" / "Unstar all" disambiguation
  rather than guessing intent from the selection's mixed state.

### Keyboard

- `x` toggles the focused thread's membership in the selection set
  (Gmail's convention). `j` / `k` still move focus; `x` is non-blocking
  on focus, so the operator can `j x j x j x` through the inbox to
  build a multi-select without re-binding their muscle memory.
- `Shift+x` (capital `X`) is reserved for a future "select all visible"
  follow-up; v1 ships only the per-row toggle.
- `Esc` clears the selection when non-empty. When the selection is
  empty, `Esc` keeps its current behavior (close the composer / clear
  search). The order of precedence: composer → selection → search.
- Bulk-action-bar keyboard (`s`/`z`/`#`/`Shift+U`) keeps the existing
  per-thread keybindings — applied to the **focused** thread, not the
  selection. The bar's buttons are the only way to bulk-apply via
  keyboard in v1; we deliberately avoid overloading `s` with
  "bulk-star when selection is non-empty" because the silent
  scope-shift is a footgun. A future v1.1 may add `Shift+S` for
  bulk-star if the per-button click ergonomics turn out to be a real
  papercut.

### Mouse

- A small checkbox in the inbox-row gutter, leading the existing
  star/snooze/trash/mark-read group. Click toggles selection without
  changing focus (the row's `onClick` body remains "select-as-current");
  Shift+click on a checkbox extends the inclusive range from the
  anchor to the target in current view order.
- Shift+click on the row body is **not** a range select — that gesture
  is reserved for future text selection in inline previews. Range
  select requires the checkbox affordance specifically. This avoids
  accidental range-selects when the operator wanted to focus a row.
- Subject-fallback rollups render the checkbox disabled (same gate as
  the per-thread annotation buttons): the rollup has no stable handle
  to bulk-apply against.

### Bulk action bar

- Renders directly above the inbox list (between the Rail and
  `InboxList`) when `selection.size > 0`. Slides down from the top of
  the inbox column — content flows below it without resizing the rail.
- Displays:
  - Count chip: `N selected` (mono).
  - "Clear" button (mirrors Esc).
  - Star / Unstar All — distinct from the per-row toggle. The bar
    chooses one action: if any thread in the selection is unstarred,
    the bar shows "Star All"; if every thread is starred, it shows
    "Unstar All". Mixed selections default to "Star All" (the
    add-to-set bias).
  - Snooze … (opens the existing `SnoozePicker` in a header-anchored
    popover, applies the picked wake-time to every thread).
  - Trash / Untrash All — same disambiguation as star.
  - Mark Read / Mark Unread All — same disambiguation. Outbound-only
    selections (no thread has any inbound rows) render this disabled.
- Buttons fire the existing `onToggleStar` / `onPickSnooze` /
  `onToggleTrash` / `onToggleRead` for **each selected `rootKey` in
  parallel**. Each call carries its own optimistic intent map entry;
  per-thread errors roll back only that thread.

### Optimistic intent under bulk apply

- Bulk apply is `Array.from(selection).map(applyOne)` where `applyOne`
  is the same single-thread handler. This means the existing pending
  maps (`pendingStars`, `pendingSnoozes`, `pendingTrashes`,
  `pendingReads`) carry one entry per selected thread for the duration
  of the in-flight RPC. The inbox renders the pending state for each
  row independently — failures show as per-row revert with no global
  toast, matching the established posture.
- The fan-out is fired with `Promise.allSettled` so a 500 on one
  thread doesn't cancel the others; each handler already owns its own
  rollback, and the parent doesn't need to know whether any individual
  call settled.
- The selection set itself is not optimistic — it tracks operator
  intent only, and is cleared by explicit gestures (Esc / view switch
  / search / composer open). Apply success keeps the selection so a
  follow-up bulk action (`#` star → trash → unread) lands on the same
  set without re-selecting.

### What this slice does *not* ship

- **No bulk RPCs.** No `bulk_star_threads`, no `bulk_*` family on the
  BFF. v1 is client-side fan-out over the existing per-thread
  endpoints. If batch latency becomes user-visible (it won't on
  localhost), a future slice can introduce them without breaking the
  client.
- **No "select all".** No `Shift+x` keybind, no checkbox in the inbox
  header. Operator selects rows individually or via Shift+click range.
  v1.1 territory.
- **No bulk delete-message.** Trash is per-thread; per-row delete is
  out of scope (and ADR-0007 `delete_message` is unimplemented).
- **No bulk reply / forward / archive.** Multi-reply is a meaningful
  composition gesture, not a bulk annotation; archive is a separate
  affordance reserved for a future slice (`a` keybind held).
- **No persisted selection across reloads.** Selection lives in
  React state only. Refresh clears it.
- **No selection sidebar / chip strip.** The bulk action bar shows the
  count; per-row gutter checkboxes show membership. No floating
  picker, no "selected items" panel.
- **No keyboard shortcut for the bar's buttons during selection.** As
  noted above, `s`/`z`/`#`/`Shift+U` apply to the focused thread, not
  the selection. The bar's mouse buttons are the bulk path.
- **No new audit log entries.** Same posture as the four annotation
  slices — UI state, not state-transition events.

### Wire format & event compatibility

- No new BFF tools, no schema changes. The four existing per-thread
  RPCs receive N concurrent requests; each one is sized identically to
  the single-thread case.
- `MAX_THREAD_LIMIT = 200` is per-thread already. Bulk apply doesn't
  change individual thread sizes.
- No CDK changes, no DynamoDB changes.

## Implementation

1. **`App.tsx`** — three new state slots:
   - `selection: Set<string>` (Thread.rootKey).
   - `anchorRootKey: string | null` (last plain-click anchor for
     Shift+click range).
   - Derived `selectionMode = selection.size > 0`.

   Helpers:
   - `toggleSelection(rootKey, range = false)` — plain toggle when
     `range === false`; range-extend when `true` (uses the current
     `threads` array's index of `rootKey` and `anchorRootKey`).
   - `clearSelection()` — empties both `selection` and
     `anchorRootKey`.
   - `bulkApply<T>(fn: (rootKey: string) => Promise<T>)` — fan out
     via `Promise.allSettled` over `Array.from(selection)`. Used by
     the bar's button handlers.

   Wired into existing flows:
   - `switchView` and search state-change effect call
     `clearSelection()`.
   - `Esc` global key handler (still composer-first) clears the
     selection when non-empty.
   - New `x` key in the global keyboard handler toggles the focused
     thread's selection membership.

2. **`InboxList.tsx`** — checkbox in `inbox-row__gutter`, leading the
   four existing buttons. New props:
   - `selection: Set<string>`
   - `onToggleSelection(rootKey, withShift)` — handler delegates to
     `App.tsx`'s `toggleSelection`.

   The checkbox `onClick` calls `e.stopPropagation()` so it doesn't
   also fire the row-body `onClick` (which would re-focus the row).
   The checkbox's `onKeyDown` is left to native (Space toggles by
   default).

3. **`BulkActionBar.tsx`** — new component, renders only when
   `selection.size > 0`. Reuses the four existing icon buttons in a
   new `variant="bulk"` (or a thin label-bearing wrapper) so the
   visual language matches the gutter set. Handles disambiguation
   (Star All vs. Unstar All) by inspecting the selected threads'
   current optimistic state via the same `pendingX` maps.

4. **`MarkRead.tsx` / `Star.tsx` / `Snooze.tsx` / `Trash.tsx`** — add
   the `"bulk"` variant alongside `"gutter"` / `"header"` if the
   visual treatment differs from `"header"`. If `"header"` already
   has the right size + label slot, the bar can render the existing
   variant directly with a wrapper.

5. **CSS** — `bulk-action-bar` styling in `app.css`. Slim height
   (~40px), monospace count chip, sticky to the top of the inbox
   column.

6. **Tests** (new, alongside `test/web/`):
   - `selection.test.ts` — pure helpers: `computeRange(threads,
     anchorRootKey, targetRootKey)` returns the correct rootKey set
     for plain, anchor-only, target-only, anchor+target, and
     anchor-after-target cases.
   - `inbox-list.test.tsx` (or extension of the existing render
     test) — Shift+click on a checkbox calls `onToggleSelection` with
     `withShift: true`; plain click with `withShift: false`.
   - `app-bulk.test.tsx` — `x` adds the focused thread to selection;
     a second `x` removes it. `Esc` clears a non-empty selection
     without closing the composer (composer is closed). Switching
     views clears the selection. A successful bulk star calls
     `bff.starThread` once per selected rootKey.

7. **Manual verify**
   - `j` / `k` / `x` builds a 3-row selection; bulk star applies, bar
     hides on Esc, bar reappears on next `x`.
   - Shift+click extends a range from the anchor; clicking outside
     the checkbox (row body) does not extend.
   - Bulk snooze opens the picker once, applies the picked wake-time
     to every selected thread, each row gets its own optimistic
     chip.
   - A simulated BFF 500 on one of the N parallel calls rolls back
     that one thread's optimistic state without affecting the others.

## Considered and rejected

- **Bulk RPCs (`bulk_star_threads`, `bulk_snooze_threads`, …).**
  Smaller wire roundtrips; cleaner audit shape. Rejected: doubles the
  RPC surface, the dispatcher cases, the schema validators, the
  reader functions, and the test footprint. Localhost-personal-tool
  latency budget is ~50ms per RPC over loopback; N parallel calls for
  realistic N (≤20) finish well under the inbox poll interval.
- **Single bulk RPC `annotate_threads(thread_ids[], op)`.** Smallest
  surface growth, but the value-shape union (`boolean | iso | null`)
  bleeds the four operations into one wire schema and forces a
  switch-on-`op` in the reader that's already split across four
  helpers. Rejected — the four helpers stay clean and we don't pay
  the union cost on the wire.
- **Selection persisted to localStorage.** Useful when reloading
  across deploys. Rejected for v1: an operator returning to a
  "selected for trash" set after a reload is more likely to
  accidentally bulk-trash than to deliberately resume the gesture.
  When/if this becomes a real ergonomic, the persistence should be
  scoped to a session id and surface a confirm.
- **Bulk-apply with selection-clear.** Mirrors Gmail. Rejected — the
  operator's pattern in this product is "bulk-star then bulk-trash",
  which is a single chain of selection-preserving applies. Esc is
  cheap when they want to clear.
- **Status-aware single bulk button per action ("Star → Unstar →
  Star…" cycling on the bar).** Cute, but produces a
  three-state button when the selection is mixed. Rejected:
  operator can't tell which state the next click will land them in.
  Star All vs. Unstar All disambiguation is louder, but the operator
  always knows what's about to happen.
- **`x` toggles the *visible* range of threads (Outlook-ish "select
  range from focus to next click").** Awkward to chain. Rejected —
  per-row toggle composes; range select is the Shift+click affordance.
- **Selection survives view switch.** Rejected — switching views
  reorders / hides rows; carrying a selection across the switch
  produces invisible state ("why is the bar showing 3 selected when I
  only see 1?").
- **Apply on Enter when bar is focused.** Rejected — the bar isn't
  focusable as a whole; each button is. Operator clicks the action
  they want explicitly.
