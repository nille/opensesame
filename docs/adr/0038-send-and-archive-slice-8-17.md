# `send + archive`: client-side compound send-then-archive, slice 8.17

ADR-0022 shipped `reply_to_email` as the dedicated, server-resolved reply
tool. ADR-0034 shipped `archive_thread` as the sparse `archived_at`
fan-out. This slice composes the two into Gmail's most-used compound
action: **Send + archive** — send the reply, then immediately archive
the parent thread so it disappears from the inbox in one gesture.

The slice is small on purpose. It introduces no new RPC, no wire change,
no new server state. It is a UI-level recombination of two primitives
that already exist, justified by the fact that "reply, then immediately
archive" is the single most-frequent compound the operator performs in
any Gmail-shaped client. Earning a dedicated affordance for this exact
sequence is the whole point.

The interesting design pivots:

- **No `send_and_archive` RPC.** The server stays orthogonal — two
  generic primitives compose better than one welded compound. See
  "Considered and rejected".
- **Reuse the existing pending-archive map.** `pendingArchives` from
  ADR-0034 already handles optimistic flips; the new flow stamps the
  same map preemptively and lets the existing rollback path cover
  archive-after-send-success failure.
- **Reply-mode only.** Send-and-archive only makes sense against a
  parent thread. New compose with no parent has no thread to archive
  and no affordance is rendered.

## Decision

### Client-side compound: two RPCs, one button

The webmail wires the compound in `Composer.send()`. On click of the
secondary **Send + archive** button (or its keybind):

1. Resolve `parent.thread_id` from the in-memory parent context (the
   composer already holds the parent for the reply preview).
2. Optimistically stamp `pendingArchives.set(rootKey, true)` — the
   inbox row vanishes from Inbox / Starred / Snoozed / Sent the moment
   the operator commits, exactly as if they'd hit `e` (ADR-0034).
3. Fire `bff.replyToEmail(...)` (the existing reply path, ADR-0022).
4. On `kind: "ok"` → fire `bff.archiveThread({ thread_id, archived: true })`.
5. On send error → roll back the pending archive immediately;
   the row reappears in the inbox; the composer surfaces the existing
   send-error UI (suppression / 422 / 500). No archive RPC fires.
6. On send-OK + archive error → leave the thread visible in the inbox
   (the pending entry is dropped on rollback). Send already succeeded;
   the operator can press `e` to retry archive manually. Acceptable
   degradation — see "Failure modes".

The compound is two round-trips. The "send succeeded but archive
failed" window is benign: the reply landed, the audit row is intact,
the thread just hasn't been hidden yet. Operator presses `e` and moves
on.

### UI affordance: split-button in the composer footer

The composer footer in reply mode renders **two adjacent buttons**:

- **Send** — primary, existing behavior (ADR-0022 reply path only).
- **Send + archive** — primary-tone, narrower, sits to the right of
  Send. Clicking commits both actions per the sequence above.

Why two visible buttons over a split-button-with-dropdown:

- The composer is small. A dropdown adds a second click and hides the
  archive intent behind a chevron.
- Operators who want one or the other should pick at glance, not
  discover via a popover.
- Both buttons fit on one line at the composer's max width — measured.

Visual treatment: the secondary button shares the primary button's
weight but renders the archive icon (the same one from
`ArchiveButton`) on its left. No separate "armed-toggle" pill, no
pre-arm UI. The state lives only in which button got clicked.

### Keybind: `Shift+⌘↵` in compose-as-reply mode

`⌘↵` already commits send (ADR-0022). `Shift+⌘↵` commits **send +
archive**. The shift modifier reads as "and one more thing" —
consistent with the way Shift extends most other shortcuts in the app
(Shift+J / Shift+K for intra-thread nav, Shift+U for read/unread,
Shift+X for select-all). Cheat-sheet line:

```text
⌘↵          send reply
⇧⌘↵         send reply and archive thread
```

Reader-level keybind (`R` to open compose pre-armed for archive) was
considered and rejected — see below. The archive intent is a
send-time decision, not a compose-time one.

### Reply-mode gate

Both the secondary button and the `Shift+⌘↵` keybind are gated on
`replyMode === true && parent !== null`. In new compose with no
parent thread, the affordance is absent (no second button rendered, no
archive on `Shift+⌘↵`). The composer's existing "compose · new" vs
"compose · reply" title disambiguates the two modes, and the button
row mirrors that distinction.

Forward mode (against an existing thread) does not exist in v1; if it
ships in a later slice, it inherits the affordance — the gate is
"parent thread is known", not "the action is literally a reply".

### Optimistic UI: stamp pending-archive before send returns

The composer closes optimistically on send-OK already (ADR-0022). For
send-and-archive:

- The `pendingArchives` stamp lands **before** the send RPC fires, so
  the inbox row vanishes the instant the operator commits — same
  perceived latency as a bare `e` press.
- On send-OK: the archive RPC runs; on its OK, `pendingArchives` clears
  on the next poll; on its error, the entry is dropped (rollback) and
  the thread reappears.
- On send-error: the entry is dropped immediately, **before** the
  composer renders the error toast. The thread snaps back into the
  inbox; the operator sees the send-error in the open composer; they
  fix and retry.

This is the same posture ADR-0034 specifies for bare archive — no new
optimistic machinery, just an earlier stamp inside the send path.

### Failure modes (explicit)

| Sequence | Outcome | UI |
|---|---|---|
| Send-OK, archive-OK | Reply sent, thread archived | Composer closes, row gone from Inbox |
| Send-OK, archive-fails | Reply sent, thread visible | Composer closes, pendingArchive rolls back, row reappears in Inbox; operator presses `e` to retry archive |
| Send-fails | Nothing sent, archive never fires | Composer stays open with existing error UI; pendingArchive rolls back instantly |
| Send timeout (undefined) | Same envelope as bare send timeout (ADR-0022); archive never fires from the client | Composer keeps the draft; operator decides whether to retry |

Send-OK + archive-fails is the only new failure mode, and it
degrades to "the operator does the second action manually" — which is
exactly the v1 archive flow ADR-0034 already ships. No new UI, no new
toast, no new audit shape.

### No bulk variant

Send-and-archive is intrinsically a single-thread action — the
operator is replying to one parent. Bulk reply isn't a coherent
gesture (recipients, subjects, bodies all differ). No bulk
send-and-archive, and no bulk-mode entrypoint. Bulk archive
(ADR-0032) and bulk reply remain orthogonal.

### Wake-on-reply consistency

The thread has just received an outbound reply. The archive fan-out
hides it immediately. If the recipient replies back, the new inbound
row lands without an `archived_at` attribute, and ADR-0034's
every-row aggregation rule flips the thread back to live in the
inbox. This is the operator's exact intent: "I'm done with this
unless they reply." No new rule — wake-on-reply already covers it.

### Reply-targeting and fan-out ordering

`reply_to_email` returns a `Message-ID` for the new outbound row
(ADR-0022). The new row is part of the parent's thread by
construction (its `In-Reply-To` and `References` chain back to the
parent). `archive_thread` resolves rows via `ThreadIdGSI` keyed by
`thread_id` — the new outbound row's persistence is **not** required
to land before archive fires:

- Archive fans out across whatever rows are indexed at the moment
  the GSI Query runs. If the new outbound row is already indexed
  (the common case — `persistOutbound` finishes before the client
  sees the send response), it gets `archived_at`. If it isn't yet,
  it lands without — which trips wake-on-reply on the operator's
  own outbound row, which is wrong.

Two paths considered:

- (a) Archive only the inbound rows — explicitly skip outbound. The
  fan-out helper would need a direction filter, which it doesn't
  currently have.
- (b) Trust the persist path. `sendWithAudit` (ADR-0017) writes the
  outbound row synchronously on the send-OK return. By the time the
  client receives 200 from `reply_to_email` and fires
  `archive_thread`, the outbound row is in DDB and the GSI Query
  surfaces it.

**Decision: (b).** The race window is tight enough in practice
(persist completes before the BFF returns), and adding a
direction-aware fan-out is an unrelated change. If the race ever
bites, the symptom is benign — wake-on-reply surfaces a
just-archived thread, which the operator can re-archive with `e`. We
ship (b) and only revisit if telemetry shows the race firing.

### Per-thread / per-account defaults: out of scope

- No "always send-and-archive for this thread" toggle.
- No "always archive on reply" account-level default.
- No persisted operator preference. The button picks the action,
  and the action is always single-shot.

These are reasonable follow-ups if telemetry shows operators picking
send+archive more than 80% of the time, but v1 keeps the choice
in-the-moment.

### Wire format & event compatibility

- **No new RPC.** The dispatcher route table is unchanged. ADR-0021
  honored — zero wire surface added.
- **No new fields** on `read_inbox`, `get_message`, `list_thread_messages`,
  `reply_to_email`, or `archive_thread` payloads.
- **No new event shapes.** The audit row for the reply is identical
  to ADR-0022's; the archive fan-out is identical to ADR-0034's.
- The compound is observable only on the client — the server sees
  two ordinary calls back-to-back.

This is the headline property of the slice: **send-and-archive is
free at the protocol layer.**

## Implementation

1. **Composer button + handler** — `src/web/src/components/Composer.tsx`.
   Add a second `<button class="btn btn--primary">` to the footer, gated
   on `replyMode`. Lift the existing `send()` into `sendInternal({ archive: boolean })`;
   the new button calls `sendInternal({ archive: true })`. On reply-OK, fire
   `props.onSentAndArchive(parent.thread_id)` instead of `props.onSent()`.
2. **App-level orchestration** — `src/web/src/components/App.tsx`. New
   `onSentAndArchive(threadId: string)` callback: closes the composer
   (existing `onSent` flow), then invokes `toggleArchive(rootKey, true)`
   directly. The composer never sees `pendingArchives` — App owns the map
   and the existing handler covers both the optimistic stamp and the
   rollback. The thread_id passed back from the composer maps 1:1 to
   `Thread.rootKey` for any server-stamped thread (the only kind that
   reaches reply mode in the first place — failed-parse rows and
   subject-fallback rollups can't be replied to).
3. **Pre-stamp ordering** — Stamp `pendingArchives.set(rootKey, true)`
   *before* the reply RPC fires, not after. New `archiveOnReplySuccess`
   path in the App composer-mode handler: stamp → reply RPC → on OK
   fire `bff.archiveThread` (which clears the entry on its own success);
   on reply error, drop the entry. One small refactor to `toggleArchive`
   to support "stamp now, fire later" — extract `stampPendingArchive`
   and `runArchiveRpc` as small internal helpers, leaving `toggleArchive`
   as their composition for the bare-archive path.
4. **Keybind** — `Composer.tsx`'s existing `onKey` listener gains a
   `(e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter"` branch
   that calls `sendInternal({ archive: true })`. The existing `⌘↵`
   branch stays as-is. Both branches gated on `replyMode`.
5. **Visual treatment** — `composer.css` gets a `.composer__send-archive`
   modifier on the secondary button (primary tone, archive icon to the
   left of the label, narrower padding). The footer's flex row already
   accommodates two buttons; no layout change.
6. **Cheat sheet** — `App.tsx` cheat-sheet alert gains a
   `⇧⌘↵   send reply and archive thread (in composer)` line under the
   existing `⌘↵   send` entry. The footer hint in `Composer.tsx` reply
   mode also extends: `⌘↵ to send · ⇧⌘↵ send + archive · a toggles reply-all · esc to cancel`.
7. **Tests**
   - Composer component test: in reply mode, both buttons render; in
     new-compose mode, only Send renders.
   - Composer component test: `Shift+⌘↵` calls the send-and-archive
     path; `⌘↵` calls plain send.
   - App-level test: send-and-archive path stamps `pendingArchives`
     before the reply RPC, fires archive on send-OK, drops the entry
     on reply error.
   - App-level test: send-OK + archive-error leaves the row visible
     after rollback; the composer-closed UI is unchanged.
   - No new BFF tests — the dispatcher is untouched.

## Considered and rejected

- **`send_and_archive` RPC.** A single server-side compound that does
  both atomically (or sequenced with shared error handling). Eliminates
  the send-OK + archive-fail window server-side. Rejected for two
  reasons: (1) the partial-failure mode is benign and recoverable —
  operator hits `e` once and the thread is archived — and (2)
  introducing a compound RPC is the camel's nose for every other
  operator-shaped compound (send-and-snooze, send-and-trash, send-and-
  star). The client-side composition keeps the RPC surface small and
  orthogonal; ADR-0021's wire-additivity commitment specifically tries
  to avoid welding two primitives into a third one. If the failure
  window ever bites in production, we can add the RPC then; for v1 the
  cost is one extra "press `e` to retry" interaction in a rare error
  path.
- **Single "Reply and archive" button in the reader header.** Opens
  compose pre-armed with archive-on-send. Rejected — the archive is a
  send-time decision; arming it at compose-open hides the choice from
  the moment of commit and breaks the muscle memory the second
  composer button establishes. The reader's existing `R`-to-reply
  shortcut stays single-purpose.
- **Split-button with dropdown.** Send | ▾ → "Send and archive".
  Rejected — adds a click + a popover for a high-frequency action.
  Two adjacent buttons cost the same horizontal space and surface the
  intent at a glance.
- **Pre-arm toggle pill in the composer.** "[ archive on send ]"
  checkbox above the body. Rejected — wastes vertical real estate on a
  small composer; the operator has to pre-arm the toggle, type, and
  then commit, which is more work than picking the right button at
  send time.
- **Reader-level keybind `R` (capital) to open compose with archive
  armed.** Rejected — same reason as the single-button-in-header
  variant; archive belongs at the send moment, not the open moment.
  `R` stays free for a future reply-all shortcut if we ever want one
  (currently `a` flips reply-all inside the composer per ADR-0022).
- **Direction-aware fan-out (skip the just-sent outbound row).**
  Rejected on grounds of complexity vs. the rare race window. The
  archive helper stays generic; if the race becomes operationally
  visible, revisit then.
- **Per-thread "always archive on reply" sticky toggle.** Rejected —
  no per-thread state in v1, and the gesture is a send-moment choice.
  Account-level default is also rejected for the same reason.
- **Bulk send-and-archive.** Rejected — bulk reply isn't a coherent
  v1 gesture; without it, bulk send-and-archive doesn't compose. Bulk
  bare archive (ADR-0032) already covers the "I'm done with these N
  threads" intent.
- **Audit-row field marking the reply as send-and-archive.** Rejected
  — the archive is a UI-state annotation, and ADR-0034 explicitly
  declined to log archive as a state-transition event. The send audit
  row is unchanged; the compound is invisible to the audit log, which
  is the right invariant.
- **Send-and-snooze, send-and-trash as siblings of this slice.**
  Mentioned for completeness. Send-and-snooze is plausible (reply,
  then snooze the thread until the recipient replies — Gmail offers
  this) and could ship as a follow-up if compound becomes a pattern.
  Send-and-trash is implausible (replying to a thread you're trashing
  is a contradictory intent). Neither belongs in 8.17.
