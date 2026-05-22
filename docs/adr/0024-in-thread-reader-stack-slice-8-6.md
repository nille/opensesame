# In-thread reader stack: slice 8.6, expand-on-click parent and earlier replies

Slice 8.5 (ADR-0023) rolled the inbox up into one row per thread. Selection opens the **latest** message in the reader — by design, that's the operator's triage front. The trade-off the slice took: reading anything older in the thread now requires unthreading the conversation in your head and finding the parent row, which the threading itself just hid.

Slice 8.6 reattaches the rest of the conversation to the reader pane as an expandable stack.

## Decision

### One reader pane, stacked messages, latest auto-expanded

Selecting a thread opens the reader on the **whole thread**, not a single message. The pane renders:

- Subject at the top (the latest row's subject, with the canonical `Re:` already on the wire).
- A vertical stack of message cards, newest-first.
- The latest card is **expanded by default** — same headers + body + attachments the slice-8 reader showed for a single message.
- Older cards render as **one-line strips**: sender · snippet · timestamp. Clicking a strip expands it in place.

A thread of size 1 looks identical to the pre-8.6 reader — no strips, just the one expanded card.

The expansion model is purely visual: the data is already a `Thread` (slice 8.5), and each row's `body_text` / `headers` / `attachments` come from `bff.getMessage(message_id)` on demand. TanStack Query dedupes the latest's hit (it's already in cache from when the operator was navigating with `j`/`k`); parents fetch in parallel the moment they're expanded.

### Each expanded message owns its own mark-read

Slice 8.5 (and earlier) marked the **lead row** read when its reader opened. With a stack, that semantic doesn't generalize — opening the latest doesn't tell us anything about whether the operator has seen the parent.

Slice 8.6: each `MessageView` (the expanded card) fires `bff.markRead({ address, internal_id })` against **its own row** when it mounts and its row is inbound + unread. The latest auto-expands → marks itself read. Clicking an older strip mounts a `MessageView` for that row → marks **that** row read. Cards that stay collapsed stay unread.

This matches how the inbox dot is computed (`thread.unread = any inbound row with read_at === null`): the dot disappears once the operator has actually expanded all inbound rows. Consistent with what the dot is telling you.

The alternative — Gmail's "mark whole conversation read on first open" — is silent state mutation across rows the operator never saw. We're conservative until a UI affordance exists for it (slice-9 territory).

### Reply target: latest by default, per-card override

`r` continues to reply to the **latest** row in the thread. That's the common case (you're catching up on a conversation; you want to reply to where it currently sits) and matches the slice-8.4 selection model.

Each expanded card carries its own `Reply` button that replies to **that specific message**. An operator who scrolled down to read the parent and wants to fork a reply off it has the affordance right there.

Both paths feed the same `replyToCurrent` / `setPane({ mode: "composer", replyParentId })` flow that slice 8.4 already wired — only the `replyParentId` differs. The composer doesn't care where the parent came from.

### Stack ordering and selection

Cards render **newest-first**, matching `Thread.rows[0]` being the lead. This is the opposite of how an email thread reads chronologically (oldest → newest), but it puts the latest message — what the operator actually wants to act on — at the top of the pane without scrolling. Same call Gmail makes for its inbox conversation view (vs. its expanded thread view, which is chronological); we have one render path, and triage wins.

`j`/`k` continues to move between **threads**, not between messages within a thread. Adding intra-thread navigation is a slice-8.7 question — for now click-to-expand is the only intra-thread input, which is fine for a stack rarely deeper than 3-5 messages.

### State and remount

Each `Reader` instance carries an `expanded: Set<string>` of `message_id`s. The latest's id is in the set on mount. Older strips toggle the id in/out on click.

Switching threads must reset the expansion set — otherwise the operator sees parents from the previous thread expanded into the next one's stack. Implementation: `key={thread.rootKey}` on the rendered `Reader` so React remounts it on thread change. The set is a fresh `useState` initializer each mount; no useEffect plumbing.

This drops the slice-8 `messageId` prop from the reader: the thread is the input, the latest's id is derivable. `pane.messageId` in `App` is no longer the source of truth for what's rendered — `selectedRow` (and thus `threads[selectedIdx]`) is. The pane state simplifies to `{ mode: "reader" } | { mode: "composer", ... }`.

### Skeleton rows in the stack

Slice 8.5 already routes parse-failed rows into their own one-row threads (they can't share a chain). They land in the reader as a single failed card — same UX as slice 8. No stack involvement.

If a future slice persists `thread_id` server-side, a parse-failed row in the middle of an otherwise-parsed thread would suddenly appear inside the stack. Render that as an expanded "parse failed · {parse_error}" card with the `raw_s3_uri` faint underneath, same shape as the single-row failure. Slice 8.6 doesn't actually hit this case (skeleton rows still thread alone), but the shape is forward-compatible.

## Slice plan

1. **`MessageView` component (new).** Extracts the "render one expanded message" logic from the current `Reader.tsx` — fetches via `bff.getMessage`, renders header dl + body article + attachments, fires its own mark-read effect against the supplied row. Takes `row: InboxRowOk`, `onReply: () => void`, `showSubject: boolean`.
2. **`MessageStrip` component (new).** One-line collapsed view of an `InboxRowOk`: sender · snippet · timestamp on the right · expand affordance. Calls `onExpand(row.message_id)`.
3. **Rewrite `Reader.tsx`.** Now takes `thread: Thread | null` (null → empty pane). Owns `expanded: Set<string>`. Renders subject h1, then maps `thread.rows` to either `MessageView` (in `expanded`) or `MessageStrip` (not in `expanded`). Failed lead → render `MessageView`'s parse-failed branch, no stack.
4. **Update `App.tsx`.** Pass `thread={threads[selectedIdx] ?? null}` and `key={thread?.rootKey}` to `Reader`. Drop the `pane.messageId` field; pane simplifies to `{ mode: "reader" }`. `replyToCurrent` keeps targeting `selectedRow.message_id` (the latest).
5. **Live verify.** The `Re: test 2 · 3` thread should expand the latest, show two strips for the parent and the middle reply, and clicking either strip should expand it inline with full headers + body. Each newly-expanded inbound row should disappear from the inbox unread dot count after expansion.

## Considered and rejected

- **Full chronological view (oldest-first).** Matches the way email "reads" but pushes the part the operator wants to act on below the fold. Gmail's conversation view in the inbox is newest-first for the same reason; the chronological view lives behind a "show all" toggle. We don't have two views — we have the inbox stack — so optimize for triage.
- **Auto-expand the entire thread.** Easy to implement; bad on long threads (mailing-list digests, long back-and-forth). Operator scrolls past content they didn't ask to see, and we fire N `get_message` requests for messages they may not read. Strips + click-to-expand keeps the cost local to interest.
- **Mark whole thread read on first open.** Silent across rows; the inbox unread dot is computed per-row, so a "mark whole thread" would have to mutate every inbound row's `read_at`. Defer until there's an explicit affordance ("Mark thread read" button) and a story for what undo looks like.
- **Intra-thread keyboard navigation (`J`/`K` to step between cards).** Worthwhile when threads run long. Slice 8.6 leaves it out — click-to-expand is enough for the typical 2-5 message thread, and adding a second navigation register on top of `j`/`k` (threads) is the kind of decision that benefits from seeing real usage first.
- **Per-card `r` shortcut.** Same — adds a register. The latest is the right reply target 90% of the time; the per-card Reply button covers the rest.
- **Inline thread expansion in the inbox list (Gmail's "stack" hover).** Considered and rejected in ADR-0023 already; same reasoning here. The reader is the expander.
- **Single shared `useQuery` for all expanded messages, multiplexed by id.** No upside — TanStack Query already keys by `[message_id]` and dedupes, so each `MessageView`'s own `useQuery(["message", id])` is the same cache hit. Sharing would couple unrelated cards to one suspending query.

## Trade-offs accepted

- **Reader subject is the latest's subject, not the conversation's "true" subject.** A thread that drifts subjects (`Re: Q2 invoice` → `Re: Re: Q2 invoice corrections`) shows the latest. That's also what the inbox row already showed. The cards' own header dls disambiguate when the operator cares.
- **Strips show snippet, not subject.** A thread that drifts subjects loses the visual cue of the older subject from the strip. Inbox rows already collapsed the chain into one subject; this is consistent. If we add a second-line subject diff treatment later, it goes on the strip without changing the data shape.
- **Reply-from-card uses each card's `message_id`, no UI cue that the parent differs.** Operators replying off the latest (the common case) and operators replying off an older card both go through the same Composer; the composer's "parent" affordance shows whose message you're replying to, which is the cue. No additional indicator on the card itself in this slice.
- **Fetches fan out per expand.** N expansions = N `get_message` calls. The endpoint is fast and TanStack caches; on a 5-message thread this is negligible. If a future slice persists thread bodies in the projection, the stack just becomes a render of pre-fetched data.
