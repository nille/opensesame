# Inbox threading: client-side JWZ rollup, no server changes, slice 8.5

Slice 8.4 (ADR-0022) made replies correctly threaded on the wire — `In-Reply-To` and `References` are now built from the parent in core. The webmail still renders the inbox as a flat list, so a sent reply and the parent it answered show up as two unrelated rows. Operators reading the inbox are doing the threading in their head.

Slice 8.5 ships **Gmail-style conversation rollup** on the inbox list. One row per thread, with the latest message as the lead and a count + sender list for the rest.

## Decision

### Threading runs in the webmail client. No new server attribute, no GSI.

`read_inbox` already returns the threading headers we need on each row — `message_id`, `in_reply_to`, `references` (ADR-0014, ADR-0021). The client groups rows in memory and renders one collapsible entry per thread.

This is deliberately a UI-only slice:

- **No `thread_id` on the projection.** A persisted `thread_id` + GSI is the right move when paging needs it (you can't roll up a thread whose head is on page 1 and tail on page 5 without server help). Slice 8.5 reads up to `limit=50` rows in one call and groups them in memory; that's the entire inbox view today. When a future slice paginates, it adds `thread_id` server-side and the client switches from "group what I see" to "use the server's thread_id".
- **No new RPC.** The data is already on the wire.
- **No write-side changes.** Tail-adding `thread_id` to `Messages` is a one-line schema change (ADR-0011 additive-attribute rule), but it's vacuous until the GSI exists. Defer.

The trade-off is honest: a thread whose messages span multiple `read_inbox` pages will look split until server-side `thread_id` lands. For the current single-page view this never happens.

### Algorithm: JWZ-lite, References-first, subject-fallback for orphans

The classic JWZ algorithm (Jamie Zawinski's `threading.txt`) builds an id-table over every Message-ID and resolves parent edges from `References` ++ `In-Reply-To`. We use the simplified form:

1. **Index by message-id.** Build `byId: Map<string, Row>` over rows where `message_id !== null`.
2. **Find each row's thread root.** Walk `references`'s first valid msg-id, else `in_reply_to`, else self. This is the same rule `deriveThreadId` already uses on the server (`src/core/threading.ts`) — the client mirrors it so future migration to a server-derived `thread_id` is a no-op.
3. **Subject-fallback for orphans.** A row whose root msg-id isn't in the visible set (the parent isn't on this page, or the row has no threading headers at all) gets a synthetic root: the **normalized subject** (lowercase, leading `Re:`/`Fwd:` runs stripped) joined to a coarse time bucket. Two `Re: Q2 invoice` rows from yesterday cluster; a `Re: Q2 invoice` from a different month does not. The bucket is a stability hedge — it prevents a frozen subject like "lunch?" from collapsing decade-old strangers into one thread.
4. **Single-message threads pass through.** A row with no replies, no parent in the set, and a unique normalized subject is its own thread of size 1 — rendered identically to a "real" group, just with no count.

JWZ's full pseudo-root container/promotion dance is **out of scope**. We only need to render one row per thread; we don't need to walk a tree in the UI. The id-table + root resolution is enough.

#### Subject normalization

```text
strip-prefix-runs(s) := s.replace(/^(?:\s*(re|fwd?|fw)\s*:\s*)+/i, "")
normalize(s)        := strip-prefix-runs(s).trim().toLowerCase()
bucket(receivedAt)  := receivedAt.slice(0, 7)   // YYYY-MM
```

`fwd:` and `fw:` join `re:` because forwards keep the conversation but the chain headers are usually broken. `aw:`, `sv:`, `回复:` and other locales are **not** stripped — same call as ADR-0022 (don't translate, don't double-stamp). A German `Aw: …` thread won't roll up perfectly, which is consistent with how its replies are wire-threaded.

The time bucket is per-month (`YYYY-MM`). Coarse enough that a normal back-and-forth doesn't cross it; fine enough that "lunch?" from January and "lunch?" from June stay apart. Cross-month conversations that depend on subject fallback split into two thread cards — preferable to a wrong rollup.

### Rendering: thread row replaces inbox row

The list maps over `Thread[]` instead of `InboxRow[]`. A `Thread` carries:

```ts
type Thread = {
  rootKey: string;          // msg-id or `subj:<bucket>:<norm>`
  rows: InboxRowOk[];       // sorted newest-first
  failedRows: InboxRowFailed[]; // skeleton rows that landed in this thread
  latestReceivedAt: string; // for top-level sort
  senders: string[];        // distinct, ordered: latest first, then unique earlier
  unread: boolean;          // any inbound row with read_at === null
  hasOutbound: boolean;     // any direction === "out"
  count: number;            // rows.length + failedRows.length
};
```

The thread row layout:

- **Gutter:** the existing unread/danger dot, computed across the thread.
- **Sender column:** up to three names from `senders`, latest first, comma-separated; "+N" suffix when truncated.
- **Subject:** the latest row's subject (with the canonical `Re:` already on the wire).
- **Meta line:** count chip when `count > 1` (e.g., `· 3`), the latest row's message-id excerpt, and the existing `sent` chip when the **latest** row is outbound.
- **Timestamp:** `latestReceivedAt`.

Selecting a thread opens the **latest** message in the reader. Slice 8.5 doesn't add an in-thread expander — the reader already shows the message you'd normally want, and stacked-message readers are a slice 8.6 question. j/k still moves through threads, not through messages within a thread.

### Search bypasses threading

Search results stay flat. A search hit means "this specific message matched"; rolling search results into threads hides the hit you came for. The inbox flips back to threading when the search clears.

### Sort: newest-first by latest message in the thread

Threads sort by `latestReceivedAt`. A new reply pulls its parent thread to the top, matching every email client. Single-message threads sort identically to `received_at` today, so unthreaded mailboxes look unchanged.

### Counts in the rail (`inboxCount` / `sentCount`)

The rail counts stay **message counts**, not thread counts. Triage volume is what the operator wants to know; thread count is incidental. This is the same call Gmail makes (the inbox tab badge counts conversations there, but the per-folder unread counters in advanced views count messages — we already lean toward the volume reading).

### Skeleton rows (parse_status === "failed")

A failed parse row has no headers, so it can't thread. It renders as its own thread of size 1, same as today. If a parse-failed row's `internal_id` later parses, it'll thread normally on the next `read_inbox`.

## Slice plan

1. **Lib: `src/web/src/lib/threading.ts`.** Pure function `groupIntoThreads(rows: InboxRow[]): Thread[]`. No I/O, no React. Mirrors the server's `deriveThreadId` rule for the id-based path; uses `normalize(subject) + bucket(received_at)` for the subject-fallback root.
2. **Tests: `test/web/threading.test.ts`.** Linear chain, branching tree, subject-fallback grouping, mixed in/out direction (sent reply rolls up under inbound parent), `Re:`/`Fwd:` normalization, missing-message-id rows, parse-failed rows, single-message threads, time-bucket boundary.
3. **Render: `src/web/src/components/InboxList.tsx`.** Replace flat `messages.map` with `groupIntoThreads(messages).map`. Selection model becomes `selectedThreadIdx`; the existing keyboard handlers in `App.tsx` keep working because `messages[selectedIdx]` becomes `threads[selectedIdx].rows[0]` (the latest). Reply, mark-read, get_message all key off the latest row's `message_id` — unchanged.
4. **Search behavior.** When `searchActive`, render flat (skip the grouping call). The existing `App.tsx` already branches on `searchActive`; the threading call sits inside the inbox/sent branches.
5. **Live verify.** The reply we just sent (slice 8.4) should now roll up under its parent in the inbox.

## Considered and rejected

- **Server-side `thread_id` + GSI now.** Right answer when paging arrives; pure overhead today (one inbox view, single page, no cross-page rollup problem to solve). Adding a GSI we don't need yet locks in a key shape we'd want to revisit once we see real chains. ADR-0011's tail-add rule means we can ship `thread_id` later without breaking older rows.
- **Pseudo-root containers (full JWZ).** The container/promotion dance buys you a tree to walk; we render a flat list of threads. Skip the dance, keep the id-table.
- **Roll up search results.** Hides the hit. A user searching for a specific phrase wants the message that contains it; rolling it up forces a second click.
- **Thread expander in the list (Gmail's "stack").** Extra interaction surface for a slice that mostly wants to stop showing replies-of-replies as duplicates. The reader is the expander. A slice-8.6 in-list expander is fine if triage flow demands it.
- **Strip localized prefixes (`Aw:`, `Sv:`, `回复:`).** Same footgun as ADR-0022. Localized threads either roll up via `References` (the common case) or split into per-locale subject buckets — preferable to "translate" them and accidentally collapse unrelated threads.
- **Bucket subjects by week or day.** Per-day breaks normal back-and-forth threads that span midnight. Per-week is closer but still hits Friday-night/Saturday-morning splits. Per-month rolls up almost everything legitimate; the rare cross-month subject-fallback case splits, which is the safe direction.
- **Thread-level mark-read.** Marks every message in the thread as read when any one is opened. Silent state mutation; defer until a UI affordance exists for it.

## Trade-offs accepted

- **Cross-page threads split.** A thread whose head and tail straddle the `limit=50` page boundary renders as two thread cards. Until paging arrives we never hit this; once paging arrives, server-side `thread_id` is the fix and this slice is forward-compatible (the client function takes `InboxRow[]`, swap `groupIntoThreads` for "group by `row.thread_id`" without touching the renderer).
- **Subject-fallback misroots.** A `Re: lunch?` reply whose parent isn't in the visible set falls back to `subj:<month>:lunch?`. Two unrelated `Re: lunch?` threads in the same month cluster wrongly. Fix is the same — server `thread_id` makes the fallback unnecessary.
- **Localized prefix accumulation.** A `Re: Aw: Hallo` thread roots correctly via References, but a parse-failed reply that lost its References would fall back to `subj:<month>:aw: hallo`. Negligible volume; same trade-off as ADR-0022.
- **Selection model is "first row of latest thread".** Reply / get_message / mark-read all act on the latest message in the selected thread. Replying to an older message in the thread requires the slice-8.6 in-thread expander. The compose key (`c`) is unaffected.
- **Search flips the rendering model.** The list is flat for search, threaded for inbox/sent. Two render paths in one component. Acceptable for the value; revisit if a third mode shows up.
