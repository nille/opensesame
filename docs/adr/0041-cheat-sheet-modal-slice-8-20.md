# Cheat-sheet modal, slice 8.20

The `?` keybind has shipped a cheat sheet since slice 8.5 (ADR-0023):
press `?` anywhere outside an input and a `window.alert()` opens with
the full keybinding + search-operator reference. It's functional and
keeps growing — eight new bindings have landed since (`s`, `z`, `Z`,
`#`, `e`, `Shift+U`, `l`, `x`, `Shift+x`, `c`, `⌘↵`, `⇧⌘↵`,
`/`, `t`, `?`, `esc`). The native dialog scales fine, but it has
three defects that get worse the more text we cram into it:

1. **No theme.** The browser's native chrome doesn't read `prefers-
   color-scheme` and ignores the app's day/night CSS variables
   entirely. In night mode, a stark white modal with bright black
   text is jarring after the muted webmail surface.
2. **No mono.** The cheat sheet is keyboard glyphs and mono pills
   in the rest of the app — `j`, `Shift+U`, `⌘↵`. The native
   dialog renders them in the OS UI font, breaking the visual
   register. Operators have to mentally map.
3. **No layout.** Native dialogs render `text` as a single
   left-aligned column. The list of keybinds wants a two-column
   grid (key on the left, action on the right) — the existing
   alert() body is a string with two-space pad columns that
   line-break differently per OS.

This slice is the smallest possible polish: replace `alert()` with
a styled modal that uses the existing app variables, mono glyph
column, and proper two-column layout. The content stays exactly
what it is today.

## Decision

### A modal overlay component, gated on the existing `?`-handler

`App.tsx` keeps the keydown handler (no other component needs to
know what `?` does). Instead of `alert(...)`, it sets a piece of
state — `helpVisible: boolean` — and renders `<HelpOverlay />`
when true. The overlay handles its own dismiss (Esc, click on
backdrop, click on the close affordance), reports back via a
`onClose` prop.

### Component shape: simple, no portal, no focus trap library

`HelpOverlay.tsx` is a presentational component. Roughly:

```tsx
function HelpOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  // Esc-to-close: handled by App.tsx's existing keydown handler
  // (it already swallows Esc to clear search/composer/selection).
  // We add one more branch: "if helpVisible, set false, return".
  // Click-on-backdrop: the backdrop calls onClose; the inner card
  // stops propagation so clicks inside don't dismiss.
  return (
    <div className="help-overlay" onClick={onClose} role="dialog" aria-label="Keyboard cheat sheet">
      <div className="help-overlay__card" onClick={(e) => e.stopPropagation()}>
        <h2 className="help-overlay__title mono">keyboard reference</h2>
        <dl className="help-overlay__list">
          <dt><kbd>j</kbd> / <kbd>k</kbd></dt>
          <dd>move selection between threads</dd>
          {/* … the same content as today's alert() body, rendered
              with proper kbd elements and dt/dd pairs */}
        </dl>
      </div>
    </div>
  );
}
```

- `<dl>` + `<dt>` / `<dd>` for the two-column grid: keys on the
  left, action on the right. CSS lays them out via
  `display: grid; grid-template-columns: max-content 1fr` so the
  key column auto-fits the longest binding (`Shift+U`) and the
  action column fills.
- `<kbd>` for individual key glyphs: mono, with the same chip
  treatment the inbox row's `· sent` chip uses (faint border,
  small radius). Multiple keys in a binding get joined with a `/`
  rendered as plain text between `<kbd>` elements.
- `role="dialog"` + `aria-label` so screen readers announce the
  modal's purpose. No `aria-modal="true"` because we're not
  trapping focus (see "What we're not doing").
- Search-operators section uses the same `<dl>` shape, with the
  operator on the left (`from:`) and a tiny inline example on
  the right (`from:bob`).

### CSS lives in `app.css`, no new dependency

Three rules:

```css
.help-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-overlay-backdrop, oklch(20% 0 0 / 0.4));
  display: grid;
  place-items: center;
  z-index: 100;
}
.help-overlay__card {
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 1.5rem 2rem;
  max-width: 60ch;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 20px 50px oklch(0% 0 0 / 0.3);
}
.help-overlay__list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.5rem 1.5rem;
  font-family: var(--font-mono);
  font-size: 0.875rem;
}
```

Reuses existing tokens. Adds one new optional token
(`--color-overlay-backdrop`) with a fallback so the slice doesn't
need to touch the design tokens file. Day-mode and night-mode get
the right contrast for free because the card uses `--color-surface`
and `--color-text`.

### Dismiss: Esc, backdrop click, no close button

- **Esc**: handled in `App.tsx`'s existing keydown handler. The
  Esc branch already does compound work (close composer, clear
  search, clear selection); we add `if (helpVisible) {
  setHelpVisible(false); return; }` at the *top* of the Esc
  branch — help dismiss takes precedence so an operator who hits
  `?` then `Esc` doesn't accidentally clear their selection.
- **Backdrop click**: the outer `<div>` has `onClick={onClose}`;
  the inner card's `onClick` stops propagation. Click anywhere
  outside the card, the modal closes.
- **No close button**: the keyboard hint at the bottom of the card
  (`Esc to close`) is the affordance. Adding a close button would
  duplicate the affordance and require positioning logic. Esc +
  click-out is the convention we want operators to internalize for
  every overlay we build (label picker is already this shape).

### What stays unchanged

- **The `?` keybind handler in `App.tsx`**: still owns the gate.
  The change is `alert(text)` → `setHelpVisible(true)`.
- **The cheat-sheet content**: identical. Same lines, same
  search-operators block, same ADR reference. The slice ships no
  new keybindings.
- **No focus trap**: see below.
- **No portal**: the overlay renders as the last child of the
  app root. Z-index handles the stacking. Adding a portal would
  pull in `createPortal` and a separate mount point; the
  z-index/inset combo is the same outcome with one CSS rule.

### Where it lives

- `src/web/src/components/HelpOverlay.tsx` — new component, ~60
  lines including the cheat-sheet content as JSX.
- `src/web/src/components/App.tsx` — add `helpVisible` state, swap
  `alert(...)` for `setHelpVisible(true)`, render
  `<HelpOverlay onClose={() => setHelpVisible(false)} />` at the
  app root when visible. Handle help-dismiss at the top of the
  Esc branch.
- `src/web/src/components/app.css` — three new rules for the
  overlay, backdrop, and grid.

### Failure modes (explicit)

| Case | Outcome |
|---|---|
| Operator hits `?` while composing | The composer's keydown handler already stops propagation for typing — `?` typed in the body never reaches the App handler. Behavior unchanged from today |
| Operator hits `?` while a label picker or any other overlay is open | The other overlay's keydown handler swallows `?`. If it doesn't, both overlays render — Esc dismisses the help first (top of Esc branch), then the second Esc dismisses the other |
| Modal renders behind another fixed-position element | Z-index: 100 covers the existing rail and threads list. The label picker is the only other overlay; it can co-exist (different mount points) |
| Operator narrows the window so the card overflows 60ch | `max-width: 60ch` keeps the card legible; `max-height: 80vh` + `overflow-y: auto` lets the content scroll if needed (≪ 80vh today, but defensive against future content growth) |
| Reduced-motion user | No animations on open/close; the overlay just appears. Adheres to global "compositor-friendly motion or none" posture |

### What we're not doing

- **No focus trap.** Trapping Tab inside the modal is the standard
  WAI-ARIA dialog pattern, but it's a 50-line dependency (own ref,
  tab-key listener, sentinel elements, save/restore initial focus).
  v1 ships without it. The cheat sheet has no actionable elements
  inside the card — Tab does nothing useful even if it leaves the
  modal. If we add a "show advanced" toggle later, the focus
  trap question reopens.
- **No animation.** Open is instant. The native `alert()` is
  instant; the styled modal should feel at least as fast.
- **No persistent visibility setting.** Some apps remember
  "show help on launch". Open Sesame's operator hits `?` once a
  week tops; persisting state is overkill.
- **No version stamp / "what's new".** The cheat sheet is
  reference material, not release notes. If we add release notes,
  they live in their own slice with their own affordance.
- **No printable view.** A `Cmd+P` while the modal is open prints
  the underlying app. Acceptable — the cheat sheet is a 30-line
  table, not a manual.

## Implementation

1. **`src/web/src/components/HelpOverlay.tsx`** — new component.
   Props: `{ onClose: () => void }`. Body: a `<dl>` rendering the
   exact lines today's alert() carries, but as proper `<dt>` /
   `<dd>` pairs with `<kbd>` for keys. Click-on-backdrop calls
   `onClose`; click-on-card stops propagation.
2. **`src/web/src/components/App.tsx`** — add `const [helpVisible,
   setHelpVisible] = useState(false)`. Replace the `alert(...)`
   block with `setHelpVisible(true)`. At the top of the existing
   Esc handler branch, add `if (helpVisible) { e.preventDefault();
   setHelpVisible(false); return; }`. Render `{helpVisible ?
   <HelpOverlay onClose={() => setHelpVisible(false)} /> : null}`
   at the app root (just below the existing reader pane).
3. **`src/web/src/components/app.css`** — add `.help-overlay`,
   `.help-overlay__card`, `.help-overlay__list`,
   `.help-overlay__list dt`, `.help-overlay__list dd`,
   `.help-overlay kbd`. Use existing color/font tokens.
4. **Tests**
   - `test/web/help-overlay.test.tsx` — render the overlay,
     assert it shows the keybindings and search operators sections;
     click the backdrop, assert `onClose` is called; click inside
     the card, assert `onClose` is not called.
   - `test/web/app-help-keybind.test.tsx` (new, or extend the
     existing keyboard test) — render App, press `?`, assert the
     overlay appears; press Esc, assert it closes; assert the
     handler doesn't fire when an input is focused.
   - No core/lib changes → no core test additions.

## Considered and rejected

- **A separate `/help` route or rail entry.** Rejected: the cheat
  sheet is a reference, not a page. Operators want it in front of
  them while reading a thread, not as a navigation destination.
- **Inline help that highlights bindings as the operator types.**
  ("Press j to scroll down" toast). Rejected: too noisy. The
  cheat sheet is opt-in; toasts are opt-out.
- **A static markdown page rendered as the modal body.** Lets the
  cheat sheet be edited without touching JSX. Rejected: the
  cheat sheet is short, lives next to the keybind handler, and
  using JSX lets us mark up `<kbd>` properly. A markdown layer
  would need a renderer for `<kbd>` patterns and re-introduce the
  layout problem we're solving.
- **Persisting open-state in localStorage** so the cheat sheet
  reopens on next visit. Rejected: `?` is one keystroke. State
  persistence is overkill for a reference modal.
- **Splitting the search-operators block to its own modal.** A
  dedicated `??` or `Cmd+/` for search reference. Rejected: one
  modal, one keystroke. The search section is already
  visually-separated by a heading inside the same card.
- **Including a focus trap library** (`focus-trap-react`,
  `react-focus-lock`). Rejected: adds a dependency for a modal
  with no actionable elements. The slice is small on purpose.
- **Animating the open/close.** A 200ms fade-in could feel
  polished but adds a state machine and a `useEffect` for cleanup.
  Rejected: the native alert is instant; the styled modal should
  match. Future polish if it bothers anyone.
