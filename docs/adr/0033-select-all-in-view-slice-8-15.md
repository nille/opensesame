# Select-all in view, slice 8.15

Slice 8.14 (ADR-0032) shipped per-row checkboxes, Shift+click range
select, and the bulk action bar. Selection still has to be assembled
one row at a time. This slice adds the **whole-view** primitive: one
gesture that toggles every threadable thread in the current `Thread[]`,
giving the operator "select all → bulk apply" as a single triage motion.

The interesting design pivots vs. slice 8.14:

- **No new selection state.** The same `Set<rootKey>` carries it. The
  master toggle is a derived view onto that set, not a parallel flag.
- **No "select all matching N total"** banner / two-step. We have the
  full visible list client-side after server pagination — there's
  nothing beyond `threads` to opt into. The Gmail-style upsell would
  be confusing in a tool with no virtual scroll.
- **Tri-state checkbox.** Header checkbox renders unchecked / checked /
  indeterminate based on the count relative to the threadable subset of
  the view. Click semantics: any non-empty selection collapses to
  empty; an empty selection expands to "every threadable row in view".

## Decision

### Selection scope

- The "all" set is `threads.filter(t => t.rootKey.startsWith("<"))` —
  every server-threaded row in the current view. Subject-fallback
  rollups stay gated out, same as the per-row checkbox in slice 8.14.
- "Current view" is whatever the renderer is showing: inbox, starred,
  snoozed, sent, trash, drafts, or a search-filtered subset of inbox.
  No new view filtering happens here; we read what `App.tsx` already
  passes to `<InboxList>`.
- View switches still clear the selection (slice 8.14 carry-over).
  Select-all is per-view; flipping the rail empties the set.

### Header row

- New `<div className="inbox-list__header">` rendered above the row
  list whenever `threads.length > 0`. Skeleton/empty/loading states
  do **not** show the header (nothing to select).
- Contents: a single tri-state `<input type="checkbox">` plus a
  `mono faint` label that mirrors the bulk bar's count line:
  `0 of 18` when nothing is selected, `4 of 18 selected` when partial,
  `18 of 18 selected` when full. The "of N" denominator is the
  threadable-row count, not `threads.length` — so a view containing 12
  threadable rows + 6 subject-fallback rollups reads `0 of 12`. This
  matches what the toggle will actually do.
- The header is `aria-hidden="false"` and the checkbox carries
  `aria-label="Select all threads in view"` /
  `aria-label="Deselect all threads in view"` based on state. The
  indeterminate state uses the same label as "Select all" (clicking
  toggles to none).

### Tri-state semantics

Let `total = threadable rows in view`, `picked = total ∩ selection`:

| `total` | `picked`             | Checkbox visual |
| ------- | -------------------- | --------------- |
| 0       | n/a                  | Hidden (no header at all when threads.length === 0; if threads.length > 0 but every row is a rollup, render disabled) |
| > 0     | 0                    | Unchecked       |
| > 0     | 0 < picked < total   | **Indeterminate** |
| > 0     | total                | Checked         |

Click handler:

- If `picked === 0` → select every threadable rootKey in view, set
  anchor to the first one (so a subsequent Shift+click extends from
  the top).
- Otherwise (`picked > 0`, partial or full) → clear selection, clear
  anchor.

This matches the operator's mental model: a single click always lands
in a known terminal state.

### Keyboard shortcut

- New keybind: `Shift+x` toggles select-all using the same handler.
  Bound at the `App.tsx` keydown level alongside `x` and `Esc`. No
  modifiers other than Shift; no `Ctrl+A` (would clash with browser
  text-select).
- `x` (slice 8.14) still toggles only the focused row. The two
  keybinds are independent.
- Cheat sheet line added: `Shift+x  select / deselect all in view`.

### Out-of-view selection

If the operator selects all (say 18), then switches to a view with 4
threads, the selection clears (carry-over from 8.14). Coming back to
the inbox is a fresh `0 of 18` — we don't restore. Same rationale as
8.14: anchor only makes sense relative to the current list ordering.

### What this slice does *not* ship

- **No "select all matching" banner.** No two-step "selected 18, want
  all 200?" because there is no "all 200" — the inbox view is already
  the full client-side set after server-side filters.
- **No range select via the header checkbox.** Header is binary
  (clear ↔ all). For partial selections use the per-row checkbox or
  Shift+click.
- **No persisted "select all" mode that auto-includes new rows.**
  Polling brings new threads; they arrive **unselected**, even if the
  operator had previously checked the header. Auto-inclusion would
  silently expand the next bulk-apply to rows the operator never saw.
- **No keybind override.** `Shift+x` does not act on the focused row
  if no rows are visible; it's a no-op.
- **No new RPCs, no schema change, no audit events.** Selection is
  client-only state, same as 8.14.

### Wire format & event compatibility

Bulk apply still routes through the four per-thread RPCs from slices
8.10–8.13. Selecting all in a 18-row view and clicking "Star all
selected" still issues 18 concurrent `star_thread` requests — same
posture as 8.14, just easier to reach.

## Implementation

### `InboxList.tsx`

- New `headerProps` (or just inline destructuring): the header row
  needs `selection`, `threads`, `onToggleSelectAll`, where
  `onToggleSelectAll(picked, total)` is the App-level handler.
- A small `useEffect` flips the checkbox's `.indeterminate` DOM
  property on the ref each render — React's controlled `checked` only
  covers two states, so we set the third imperatively (standard
  pattern; matches what every tri-state component does).
- Header renders only when `threads.length > 0` and we're past the
  loading skeleton.

### `App.tsx`

- New `toggleSelectAll()` callback memoized like `clearSelection`.
  Reads `threads.filter(...startsWith("<"))`, computes `picked`, and
  either fills the set or empties it. Sets / clears anchor accordingly.
- Pass `selection` + `onToggleSelectAll` into `<InboxList>`.
- Keydown handler picks up `Shift+x` (`event.shiftKey && event.key === "X"`
  — JS sends uppercase X for Shift+x). Same gating as `x`: ignore when
  the composer is open or the search box has focus.
- Cheat sheet string updated.

### Tests

- `selection.test.ts` extension: a new `computeAllInView(threads)`
  helper (or direct test of the App handler — extract minimally if
  trivial). Cases:
  - No threadable rows → returns `[]`.
  - Mixed rollups + threadable → returns only threadable.
  - All rollups → returns `[]`.
- Header tri-state visual: covered by manual verify; we don't unit-
  test the imperative `indeterminate` ref.

### Manual verify

- Open inbox view. Header reads `0 of 18`; click checkbox → bar reads
  `18 threads selected`, all rows checked, header reads `18 of 18 selected`.
- Click a single per-row checkbox to deselect → header flips to
  indeterminate visual + reads `17 of 18 selected`.
- Click header checkbox again → all clear, bar dismissed, anchor
  cleared.
- `Shift+x` from focused row builds full selection; second `Shift+x`
  empties it.
- Switch to starred view → header reads `0 of N` for that view; the
  inbox-side selection is gone (carry-over from 8.14).
- Bulk-star all 18 → Promise.allSettled fans out, sidebar updates to
  `starred 18` after the next poll.

## Considered and rejected

- **Banner "select all matching"** — already covered above. We don't
  paginate inbox; there is no "more matches" beyond what's visible.
- **`Ctrl+A` / `Cmd+A`** as the keybind — clashes with the browser's
  default text-select; muscle memory will fight us. Shift+x is the
  natural extension of `x`.
- **Auto-include polled-in rows when "all" is the current state** —
  silently growing a selection set is a footgun for bulk operations.
  The operator should re-toggle if new mail arrives mid-triage.
- **Header checkbox affects only the visible viewport** — needs
  intersection-observer wiring and feels surprising when the row count
  is small enough to fit on screen anyway. Whole-view is simpler and
  matches the count line.
- **Per-view "remember selection"** — sidebar-switch carry-over from
  8.14 is the right baseline. Persisted-per-view selection adds state
  to clear when polling shifts the row order.
