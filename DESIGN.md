# Open Sesame — design system (slice 8)

This document describes the visual system for the webmail surface. The single source of truth for runtime values is `src/web/src/styles/tokens.css`; this document explains *why*.

## Color strategy

**Restrained.** Tinted neutrals + one accent ≤ 8% of any visible surface. Two intentional themes:

| Theme | Surface     | Accent role          |
|-------|-------------|----------------------|
| Day   | warm paper  | ink-blue (`oklch(48% 0.13 250)`) |
| Night | cool ink    | amber (`oklch(72% 0.14 68)`)     |

Accent **hue shifts** with the theme on purpose. This is not a filter inversion. Day is reading-by-daylight (cool accent on warm paper); night is reading-by-lamp (warm accent on cool ink).

All colors are OKLCH. Neutrals carry chroma 0.003–0.012 toward the theme hue — never `#000`/`#fff`.

## Typography

Two families, one register each.

| Role | Family | Notes |
|---|---|---|
| Sans (content) | system stack with Inter as the cross-platform fallback | sender display names, subjects, body, button labels |
| Mono (metadata) | JetBrains Mono → IBM Plex Mono → SF Mono → ui-monospace | addresses, message-ids, ULIDs, timestamps, status chips, paths, error codes, the rail title |

**Fixed rem scale** (no clamp — product UI). Ratio 1.2.

| Token | px | Used for |
|---|---|---|
| `--t-mono-xs` | 11 | status chips, message-id excerpts |
| `--t-mono-sm` | 12 | timestamps, addresses |
| `--t-sm`      | 13 | row metadata, secondary copy |
| `--t-base`    | 14 | inbox row content, form fields |
| `--t-lg`      | 17 | reader body |
| `--t-xl`      | 22 | reader subject (h1 of the open message) |

Body line length is capped at ~68ch in the reader. Tables and dense lists may run denser.

## Layout

Three-region split, single screen:

- **Rail** (left, ~200px wide) — identity (`test@nille.net` in mono), `~/inbox` title, last-polled timestamp, theme toggle.
- **Inbox column** (~52ch wide, fixed) — newest-first list of inbox rows. Triage-fast density (~36–44px row).
- **Reader/composer pane** (fills) — message body or compose form; one-of-two states, never both.

No top bar. No breadcrumb. No logo. The rail title is the title.

**Rhythm:** 4px baseline. Section gaps are deliberate doubles (`--r-2`, `--r-4`, `--r-6`, `--r-8`). Padding *varies* — rows are tight, reader is generous — so the eye knows where it is. Same padding everywhere is monotony; we earn the difference.

## Components

Every interactive component carries the full state vocabulary:

- default · hover · focus-visible · active · disabled · selected · loading · error

Button vocabulary:
- **Primary** — accent fill, paper text. Used for `Send` and one place per pane.
- **Quiet** — no fill, accent text on hover. Default for nav and toolbar actions.
- **Destructive** — kept rare; same shape as quiet, with a single semantic color shift on hover.

Inbox row anatomy:
- 8px gutter (unread dot lives here)
- sender display in sans
- timestamp in mono, right-aligned, narrow column
- subject in sans on its own line; ellipsis at 1 line
- message-id excerpt in mono `--t-mono-xs` `--ink-faint`, optional, only on selected/hover

Reader anatomy:
- subject as h1 (`--t-xl`, weight 600)
- a small mono block — `from`, `to`, `date`, `message_id` — under the subject, `--ink-muted`
- body in `--t-lg`, `--ink`, `--font-sans`, max-width 68ch

## Motion

- Theme switch: 120ms cross-fade on `--paper` and `--ink`. Accent **snaps** to its new hue. Two rooms.
- Row selection: instant. Hover affordance: 1px top rule, 120ms ease-out-quart.
- Reader open: subject's vertical position settles in 200ms. Body fades in at 120ms. Nothing else animates.
- All durations 120–200ms. Easing: ease-out-quart (`cubic-bezier(0.22, 1, 0.36, 1)`). No bounce. No elastic.
- `prefers-reduced-motion: reduce` removes the 200ms reader settle and the row-rule fade; theme switch becomes instant.

## What's intentionally absent

- Avatars and gravatars (not part of the data we have; would invent affordance)
- Folder tree beyond `~/inbox` until the BFF exposes more (slice 8.1+)
- Card grids
- Decorative gradients
- Toasts for ordinary state changes

## Bans (project-specific, on top of the shared bans)

- No avatar circles. Sender identity is the email address; display names if RFC 5322 supplies them.
- No "Mark as read" affordance. Opening a message marks it read; nothing else needs an action.
- No emojis in UI copy.
- No HTML body rendering with arbitrary CSS — slice 8 ships text-only body display. Sandboxed HTML lands when we trust the parser more.

## Stack

- Vite + React 18 + TypeScript
- TanStack Query for `read_inbox`/`get_message` (stale-while-revalidate fits the polling model)
- Hand-rolled CSS using the tokens. No CSS framework.
- Live-reload Vite alongside `pnpm tsx --watch src/bin/webmail-bff.ts`.

Code lives under `src/web/`. Build artifacts go to `src/web/dist/` and are git-ignored.
