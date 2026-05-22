# Intra-thread keyboard nav: capital J/K walk the reader stack, slice 8.7

Slice 8.6 (ADR-0024) gave the operator a thread stack where the latest auto-expands and earlier messages live behind one-line strips. Click-to-expand was deliberately the only way to open a strip — keyboard nav was deferred until real usage showed whether mouse-only was enough.

It isn't. Triaging a 4-message thread is reaching for the mouse to expand parent context, then back to the keyboard for `j`/`k` to move to the next thread. Each strip click is a context switch.

## Decision

### Capital `J` / `K` walk the in-thread stack. Lowercase stays inter-thread.

`j` and `k` keep their slice-8 meaning: move selection between threads in the inbox list. `J` (shift+j) and `K` (shift+k) operate inside the currently-open thread:

- **`J`** expands the topmost currently-collapsed strip. Reads as "open the next message I haven't looked at yet" because the stack is newest-first — the strip nearest the lead is the most-recent reply you haven't expanded.
- **`K`** collapses the bottommost currently-expanded card *that isn't the lead*. The lead is pinned open by the slice-8.6 contract (selecting a thread opens its latest); collapsing the lead would leave the pane visually empty.

If the operator hits `J` with every row already expanded, nothing happens. Same for `K` when only the lead is open. No bell, no flash — these are idempotent at the boundaries, like every other key in the app.

### No "active card" concept

A more elaborate variant would track an "active card" cursor inside the stack, so `J`/`K` step the cursor up/down, and a separate key (`o`/`enter`) toggles expansion. We're not building that:

- The thread stack is rarely deeper than 5 messages. A second cursor concept doesn't pay for itself at that depth.
- Per-card Reply (slice 8.6) already provides per-card action without a cursor — the `Reply` button on each expanded card is the affordance.
- The lowercase `j`/`k` cursor is the inbox list. Adding a second cursor inside the reader pane introduces "which cursor does Tab move?" and "where is focus visually?" questions that we don't need yet.

`J`/`K` as pure expand/collapse keeps the model flat: expansion is the only intra-thread state, and these keys mutate it.

### `R` (capital) is *not* in scope

A natural neighbor question: does `R` reply to the bottommost expanded card the way `K` collapses it? We're not adding it. Lowercase `r` already replies to the lead, which covers the common case; per-card Reply buttons cover the rest. A capital-R binding would introduce a hidden state (which card is "current?") that `J`/`K` deliberately avoided.

If real usage shows operators repeatedly expanding a parent and then mousing back to its Reply button, revisit. For now: one less binding, one less question.

### Implementation: hook lives in `Reader.tsx`, not `App.tsx`

The expansion state is owned by `ThreadReader` (slice 8.6). The keyboard subscription that mutates that state belongs there — pulling the state up to `App` to satisfy `App.tsx`'s existing `useKeyboard` would couple the App shell to a stack-internal detail.

Trade-off: we now have two `useKeyboard` subscriptions registered on `window`. `useKeyboard` already skips INPUT / TEXTAREA / contenteditable, so the composer (which it would be wrong to walk through with `J`/`K`) is silent by default — but the hook in `ThreadReader` still needs to skip when `App`'s `pane.mode === "composer"`. We pass an `enabled` flag through.

The two handlers don't conflict: `App`'s handler matches `j`/`k`/`r`/`c`/`/`/`?`/`t`, and `ThreadReader`'s handler matches `J`/`K` (which `App`'s handler never sees because the keys differ). No `event.stopPropagation` needed.

### Lead-pinning rule

`K` walks `expanded` and removes the last entry whose row index in `thread.rows` isn't 0. Equivalent: from the bottom of the stack upward, find the first card that's currently open and isn't the lead, collapse it. Repeated `K` collapses the second-to-bottom, then the third, until only the lead is open. After that, `K` is a no-op.

Symmetric: `J` finds the first row in `thread.rows` whose key isn't in `expanded` and adds it. Newest-first iteration means the first strip after the lead opens first, then the next strip, then the parent. After every row is expanded, `J` is a no-op.

### `key=` remount carries through

`App` already passes `key={thread?.rootKey}` to `Reader`. Switching threads remounts `ThreadReader`, which re-runs the `useState` initializer that seeds `expanded` with the lead's id. The `J`/`K` history dies with the unmount, which is what an operator wants — switching threads should give a fresh stack, not carry expansion intent across.

## Slice plan

1. **`useKeyboard` subscription in `ThreadReader`** (slice 8.6's inner component). Watches `J` and `K`, mutates `expanded`. Disabled when the parent reports composer mode (pass an `enabled` prop down from `Reader` → `ThreadReader`).
2. **`Reader` accepts and threads through `enabled`.** `App` already knows `pane.mode !== "composer"` for its own keyboard hook; pass the same boolean to `Reader`.
3. **Cheat sheet update in `App.tsx`** so `?` mentions `J/K  expand/collapse next/last in thread`.
4. **Live verify.** `Re: test 2 · 3` thread: `J` expands middle strip, `J` again expands parent, `K` collapses parent, `K` collapses middle, `K` is a no-op.

## Considered and rejected

- **Lowercase `j`/`k` switch register based on whether a thread is open.** Subtle behavior change, no visual cue. Capital is a shift-key cost; the explicitness is worth it.
- **`o`/`Enter` to toggle a "current" card.** Requires the active-card concept above; not buying enough at our thread depths.
- **Spacebar to expand the next.** Conflicts with the natural "scroll the pane" expectation on a long thread. Capital `J` is a clear "expand more" without the scroll ambiguity.
- **Auto-expand all on `J` once, collapse all on `K`.** Loses the per-step navigation that's the whole point. Operators who want everything open can keep pressing `J`; one-shot full expansion isn't worth the extra binding.
- **Move expand state up to `App`.** Couples app shell to reader internals, complicates the `key={rootKey}` remount story (we'd need an effect that resets `expanded` when the thread changes instead of relying on remount). Worse for no benefit.
