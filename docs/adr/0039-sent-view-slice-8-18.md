# Sent view, slice 8.18

The webmail rail has carried a `sent` entry since slice 8.5 (ADR-0023),
and `sentThreads` has been wired into App.tsx since the same slice as a
`hasOutbound && !trashed && !archived` filter over the threaded inbox.
What was never finished is the *view* itself — the list still ran the
inbox's threading model, with three quiet wrongnesses that the operator
notices the moment they actually open Sent:

1. **The sender column shows the wrong person.** `collectSenders`
   (threading.ts) walks every row's `From:`, so a thread you replied to
   reads `[operator, recipient]` — your own name takes the slot. In a
   Sent view the question is "who did I send this to", not "who's in the
   conversation".
2. **The sort is wrong.** Threads in Sent are ordered by latest *any*
   activity. If the recipient replies after you, the row jumps to the
   top by *their* timestamp, not by when you sent. Sent should anchor
   on the latest *outbound* row.
3. **The empty-state copy is wrong.** Sent inherits the inbox's
   "0 messages · waiting for new mail", which doesn't describe what an
   empty Sent view means.

This slice is small on purpose. It introduces no new RPC, no wire
change, no new server state. It is a view-layer recombination of data
the inbox already returns — `read_inbox` already includes outbound rows
(ADR-0017's `persistOutbound` pattern), the threading rollup already
flags `hasOutbound`, and `to`/`cc` are already on the wire row.

## Decision

### Sent view is the existing `sentThreads` filter, with a Sent-specific sender + sort

The filter stays:

```ts
allThreads.filter((t) => t.hasOutbound && !isTrashedNow(t) && !isArchivedNow(t))
```

What changes is the **derived projection** for the inbox row's left-hand
column and the **sort** that orders the list.

### Sender column shows recipient(s) of the latest outbound row

The "from" column on an inbox row carries the question "who is this
about". In Inbox that's the sender of the latest message; in Sent it's
the recipient of the latest **outbound** message. The thread can carry
inbound rows too — replies to your message — but those don't change who
you sent the original to.

The renderer pulls the latest outbound row, parses its `to:` (CC ignored
for the column; it's accessible in the reader), normalizes each
address to a display name, and renders up to three with `+N` overflow —
the same shape the Inbox sender column uses for multiple senders.
Display name extraction reuses the existing `senderDisplay()` helper.

### List sort is by latest outbound `received_at`

Inbox sorts by `latestReceivedAt` (any direction). Sent sorts by the
latest outbound row's `received_at`. The thread's lead row stays
newest-first across all directions (so the reader still opens the most
recent message first, which is usually the inbound reply); only the
list ordering changes.

Threads with no outbound row are filtered out by the existing
`hasOutbound` predicate, so the sort is well-defined for every row in
view.

### Empty-state copy

```text
0 sent · compose with c
```

Mirrors the Inbox / search empty-state register (mono, faint,
information-first per `PRODUCT.md`). The copy works whether the operator
has never sent anything or has trashed everything they ever sent.

### What stays unchanged

- **The `sent` chip on inbox rows.** The chip ("· sent") that marks the
  latest row as outbound stays exactly as it is in Inbox. Inside Sent
  it is redundant on every row, but suppressing it would mean two
  divergent row renderers for one variable; the inbox row is busy
  enough that one extra mono pill on every row is a smaller cost than
  the divergence.
- **Threading rollup.** Same `groupIntoThreads` call. Sent is a view
  filter, not a different rollup model — a thread of one outbound and
  three inbound replies is still one row in Sent (with the recipient
  column drawn from the outbound row, even though it's not the lead).
- **Annotations.** Star, snooze, trash, archive, read, labels — every
  annotation works in Sent the same as in Inbox. Snoozed and labelled
  sent threads stay visible (matching the Inbox / Starred posture for
  snooze; matching label-views for labels).
- **Search.** `searchActive` continues to bypass the per-view
  projection — the search results list stays flat and inbox-shaped.
  Sent's special projection only applies to the non-search Sent view.
- **Keybinds.** No new ones. The rail click is the only entrypoint.
  `j` / `k` / `enter` / `r` / annotation toggles all continue to work
  unchanged inside the view.

### Where it lives

- A small `src/web/src/lib/sent-view.ts` with two pure functions:
  - `recipientsOfLatestOutbound(thread): string[]` — display names of
    the latest outbound row's `to:` addresses, deduped
    case-insensitively.
  - `sortByLatestOutbound(threads): Thread[]` — newest-first by latest
    outbound `received_at`. Threads with no outbound row are filtered
    out (defense in depth; the caller already filters by
    `hasOutbound`).
- `App.tsx` calls `sortByLatestOutbound(sentThreads)` in the view
  branch and passes a new `viewKind` prop down to `InboxList`.
- `InboxList.tsx` switches the row's left-hand text on `viewKind`:
  - `viewKind === "sent"` → `recipientsOfLatestOutbound(thread)` →
    "to: <names>" rendered with the same truncation rule the sender
    column uses.
  - otherwise → existing senders rendering.
- The empty-state copy switch lives in the same `viewKind` branch.

### Failure modes (explicit)

| Case | Outcome |
|---|---|
| Outbound row has empty `to:` (data corruption) | Render `(no recipient)` in the same place `(unknown)` lands for missing `From:` — the row is still selectable so the operator can open it and inspect |
| Thread carries only inbound rows somehow (filter bypassed in tests) | `recipientsOfLatestOutbound` returns `[]` → `(no recipient)`. `sortByLatestOutbound` excludes the thread |
| Multiple outbound rows with different recipients | Use the *latest* outbound row's `to:` — the operator's most recent intent. Earlier recipients are visible inside the reader |
| Address parses with no display name (`<addr@host>` only) | Fall back to the raw address local-part, same as `senderDisplay()` |

### What we're not changing

- **No `to:` column header.** The Inbox row's column is "sender"; in
  Sent the same column reads as recipient because the rendered names
  are recipients. No header needed (the row layout has no headers
  anywhere in the app).
- **No "you" prefix.** Sent rows do not lead with "you →" or any
  similar marker. The view title (`~/sent`) and the sort are the
  affordances; the row itself stays a row.
- **No sent-specific gutter actions.** All five gutter buttons stay.
  The operator can star, snooze, trash, archive, and mark-read a sent
  thread the same as an inbox thread.
- **No counter changes.** `sentMessageCount` continues to count every
  outbound row in the loaded window (per ADR-0023's "rail counts are
  message volume, not thread count" rule).

## Implementation

1. **`src/web/src/lib/sent-view.ts`** — new module with the two pure
   helpers above. `recipientsOfLatestOutbound` finds the latest
   outbound row by direction filter + max `received_at`, splits its
   `to:` on commas (RFC 5322 list separator — full address parsing is
   out of scope; the BFF already returns the comma-separated raw
   header), runs each through `senderDisplay()`, dedupes
   case-insensitively, and returns up to N names with the count of
   the rest. `sortByLatestOutbound` is a stable sort by the same
   timestamp, descending.
2. **`src/web/src/components/App.tsx`** — derive
   `sortedSentThreads = sortByLatestOutbound(sentThreads)`; pass it
   through `threads` when `view === "sent"`. Pass a new `viewKind`
   prop (`"inbox" | "sent" | "starred" | …`) to `InboxList`. Cheap
   addition — the existing `view` value already encodes the answer,
   we just thread it down.
3. **`src/web/src/components/InboxList.tsx`** — accept `viewKind`. In
   the row renderer, when `viewKind === "sent"`, replace
   `renderSenders(thread.senders)` with
   `renderRecipients(recipientsOfLatestOutbound(thread))`. Same
   truncation shape (up to three, then `+N`). Empty-state copy
   branches on `viewKind === "sent"` for `0 sent · compose with c`.
4. **Tests**
   - `test/web/sent-view.test.ts` — `recipientsOfLatestOutbound` for:
     a single outbound row, two outbound rows with different
     recipients (latest wins), an outbound row with multi-recipient
     `to:`, an outbound row with bare address (no display name), an
     outbound row with empty `to:`, a thread with no outbound row
     (returns `[]`).
   - Same file — `sortByLatestOutbound` for: two threads where the
     inbound replies arrive in opposite chronological order from the
     outbound rows (verifies sort is by outbound, not by latest), a
     thread with no outbound row (excluded), stable order on equal
     timestamps.
   - No new BFF tests — the dispatcher is untouched.

## Considered and rejected

- **Server-side `list_sent` RPC** — a dedicated endpoint that returns
  outbound rows directly. Rejected: `read_inbox` already returns the
  full set, and the slice's whole point is "view-layer recombination
  of data we already have". Adding an RPC for a filter that the
  client can compute in O(rows) is the camel's nose for every other
  view (Starred, Snoozed, Trash, Archive, label views — all of which
  also reuse `read_inbox`).
- **Sender column reads "you → recipient"** — leading every Sent row
  with "you" was considered as a way to signal direction. Rejected:
  the view title (`~/sent`) and the sort already signal direction.
  The "you" prefix is template-y, eats horizontal space the row uses
  for actual recipient names, and adds visual noise that the
  PRODUCT.md tone rules explicitly avoid ("information-first copy").
- **Suppress the `· sent` chip in Sent view** — the chip is redundant
  on every row inside Sent. Rejected: the chip is a single mono pill
  in the meta line; suppressing it would create a Sent-specific row
  variant for negligible visual savings, and the chip helps disambiguate
  rows when the same conversation has both inbound and outbound rows
  (the chip marks which one the lead is — useful even inside Sent).
- **`g s` keybind to switch to Sent** — Gmail uses `g i` / `g s` /
  `g d` to navigate between views. Rejected for v1: the rail is one
  click away and the app has no other `g`-prefixed nav. Adding one
  shortcut creates the expectation of a full set; if we ship that
  later, we ship them all together with their own ADR.
- **Sort by `sent_at` (a future field) instead of outbound
  `received_at`** — `received_at` for an outbound row is whatever
  `persistOutbound` stamped at SES-send time, which is "when we sent
  it" by construction. Adding a parallel `sent_at` column would
  duplicate the same value under a different name. If the source of
  truth ever diverges (e.g. queued sends), revisit then.
- **Hide snoozed sent threads in the Sent view** — Inbox hides
  snoozed; should Sent? Rejected: snooze on a sent thread is the
  operator saying "remind me about this if they don't reply". The
  Sent view is where they look for "what did I send"; hiding the
  snoozed ones means a thread vanishes the moment they snooze it,
  which contradicts the operator's intent. Snoozed sent threads stay
  visible in Sent — same posture as Starred.
- **A sent-specific empty state with a recipient-picker affordance**
  — opening compose is what `c` does; the empty-state copy already
  references `c`. A second affordance would duplicate the keybind
  hint without adding capability.
