# `save_draft` / `list_drafts` / `delete_draft` RPCs + parallel draft data plane, slice 8.17

Slices 8.10–8.16 (ADR-0028…0034) shipped five sparse-attribute fan-out
annotations on the `Messages` table — star, snooze, trash, read, archive.
This slice does something different. The Drafts entry in the rail has
been a `drafts —` placeholder since slice 7 (see `Rail.tsx` line 226 –
`title="Slice 8.1"` is a stale label, drafts moved to 8.17 once the
annotation series consumed the slice budget). Promoting it to a real,
persisted feature means committing to a few things the annotation slices
sidestepped:

- **Drafts are not inbound mail.** A draft has never traversed SES, has
  no RFC 5322 Message-ID, no `received_at`, no raw S3 object. Trying to
  squeeze it into the `Messages` partition by adding a sixth sparse
  attribute would make every reader code path branch on "is this a
  draft" forever. Drafts are a **parallel data plane** — same table,
  different SK prefix.
- **Mutation cadence is not annotation cadence.** Star fires once per
  click; a draft fires every ~1.5s while the operator types. Per-row
  fan-out is the wrong shape; one item, idempotent upsert, is the right
  shape.
- **No fan-out, no thread aggregation.** A draft is a leaf. It may
  reference a thread (`in_reply_to`), but it is not part of one.

## Decision

### Drafts live in the `Messages` table under a `DRAFT#<ulid>` SK prefix

- Partition key: `address` (the operator's mailbox the draft will send
  from). Same partition as that mailbox's messages, so a single Query
  per mailbox covers both `read_inbox` and `list_drafts` regions of the
  partition with the SK condition picking which.
- Sort key: `DRAFT#<ulid>` where `<ulid>` is a freshly-minted ULID via
  the existing `makeUlidFactory` (`src/core/ids.ts`). The ULID is the
  draft's stable identity for the life of the row — `save_draft` is
  upsert-by-id, not append-then-tombstone.
- Today the `Messages` table's SK is `internal_id` (also a ULID) with no
  prefix. Adopting `DRAFT#` for drafts establishes the prefix
  convention; existing message rows continue with the bare-ULID SK
  (their structural absence of a prefix is the "this is a message"
  marker on read). Reader queries against the address partition that
  want only inbox rows already filter on `parse_status` and other row
  attributes; a `begins_with(SK, "DRAFT#")` predicate is a clean
  positive disambiguation.
- Schema marker: `kind: "draft"` attribute on the row — explicit, so
  `projectInboxRow` in `dynamodb-reader.ts` can fast-skip drafts if a
  caller's Query accidentally surfaces one. ADR-0011 schema_v stays
  pinned to "1"; the `kind` attribute is the new tail-add.

### Draft row shape

```ts
type StoredDraft = {
  schema_v: "1";
  kind: "draft";
  address: string;        // PK — operator's mailbox
  draft_id: string;       // ULID; SK = "DRAFT#" + draft_id
  body_text: string;      // plain-text only at v1
  to: string | null;      // free-form, not parsed; preserves what the
  cc: string | null;      // operator typed (commas, semicolons, etc.)
  subject: string | null;
  in_reply_to: string | null;  // RFC 5322 Message-ID of parent, when reply
  references: string | null;   // space-joined list, copied from parent
  created_at: string;     // ISO-8601, set on first write, never changed
  updated_at: string;     // ISO-8601, last successful save_draft
};
```

- All recipient fields are nullable strings, not `string[]`. The
  composer's current shape (see `Composer.tsx` lines 67–70 — `useState<string>("")`
  for `to`, `cc`, `subject`, `bodyText`) treats them as raw input the
  operator hasn't necessarily comma-split yet. Re-opening a draft must
  give back the exact bytes the operator left, including a trailing
  comma mid-completion. The `,` / `;` / whitespace split lives only in
  `parseAddrList` at send time.
- No `body_html`. v1 composer is plain-text only (Composer.tsx's
  `<textarea>` at line 311). When rich text lands, `body_html` is a
  tail-add on the draft row, the same way it tail-adds on
  `SendEmailInput`.
- No `from`. The mailbox is the partition; `from` at send time is the
  partition value.
- No attachments. CONTEXT.md pins attachment binary content to the raw
  MIME archive, written by SES on receipt — drafts have no SES touch
  and so no attachment posture today. Attachment support is a deferred
  follow-up.

### Auto-save cadence: debounced typing, plus save-on-blur

- The composer fires `save_draft` 1500ms after the last keystroke in
  any field (To, Cc, Subject, body). 1.5s is the same idle threshold
  the search input already uses (`useDebounced` in `App.tsx` line 58
  uses 220ms for search; drafts get a longer window because the cost of
  a stale draft is much lower than the cost of a stale search query
  flicker). The debounce is **per-composer-mount**, not per-field — any
  field's edit resets the timer.
- A blur on the composer (clicking outside, switching the rail view,
  Esc to cancel a non-empty draft) flushes a pending debounced save
  immediately. Esc on an *empty* composer does not save — empty drafts
  are not persisted.
- No explicit "Save draft" button. The annotation series has trained
  operators that state changes happen instantly and silently; a save
  button would be the only affordance in the product that asks for
  confirmation, and the discoverability cost of "did my draft save?"
  is solved by a single mono-faint footer line ("saved · 2s ago").
- The composer's `useEffect` keyboard handler (Composer.tsx lines
  122–139) gains no new bindings. `⌘S` is reserved for an opt-in
  "force save now" if the debounce window proves too long, but is not
  in this slice.

### Send semantics: delete on success, no tombstone

- A successful `send_email` / `reply_to_email` from a draft-backed
  composer fires `delete_draft` with the draft's ULID. The draft row
  vanishes; the outbound copy (ADR-0017) is the durable record of what
  was sent. Two reasons: (a) the outbound row already lives in the
  same partition with full envelope data, so a tombstoned draft would
  be a redundant second copy; (b) drafts are not user-facing history,
  the Sent view is.
- An in-flight debounced save that lands *after* `send_email` returns
  is the only race worth a guard. The composer holds the draft's
  `draft_id` and a `lastUpdatedAt` from the most recent `save_draft`
  echo; on send-success it cancels any pending debounce timer before
  firing `delete_draft`. A save that already left the wire and races
  the delete is fine — `delete_draft` is unconditional, and a phantom
  re-save by a stale tab is handled by the concurrency rule below.
- A `send_email` failure (suppression, network, 500) leaves the draft
  intact. The composer continues to auto-save; the operator can fix
  the recipient list and resend.

### Reply context: drafts of replies are first-class draft rows, not annotations on the parent

- A reply-mode draft carries `in_reply_to` and `references` copied from
  the parent at composer-open. `subject` is the canonical-Re subject
  the composer already derives via `canonicalReSubject` (Composer.tsx
  line 100). The parent thread is **not** modified — no draft
  annotation on the inbound row, no row-fan-out.
- The Drafts rail view shows each draft as its own row, sorted
  newest-first by `updated_at`. Replies do not group under their
  parent thread in this view. Rationale: the operator's mental model
  in the Drafts view is "what am I in the middle of writing?", not
  "what conversations have outstanding work?". A reply-draft row's
  subject prefix (`Re: …`) plus the To: line is enough disambiguation;
  the in-thread render of the parent is a different question (and the
  parent thread's reader can grow a "draft reply pending" chip in a
  follow-up slice without touching this one's storage shape).
- A draft started fresh (no parent) lands with `in_reply_to: null`
  and `references: null`. Same row shape, just empty pointers.

### RPC family

Four new tools on the dispatcher route table. All four follow the
ADR-0021 wire-additive evolution rule.

```
save_draft   — upsert a draft by id; mints id if absent
list_drafts  — Query the address partition's DRAFT# region
get_draft    — point-Get a single draft by (address, draft_id)
delete_draft — DeleteItem; idempotent (missing draft → 200 with deleted: false)
```

`save_draft` input:

```ts
type SaveDraftInput = {
  address: string;
  draft_id: string | null;          // null on first save → server mints ULID
  body_text: string;
  to?: string | null;
  cc?: string | null;
  subject?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
};

type SaveDraftResult = {
  draft_id: string;                  // canonical post-mint
  created_at: string;
  updated_at: string;
};
```

The result echoes both timestamps so the composer's footer
("saved · 2s ago") and the optimistic-pending machinery upstream can
render without a refetch — same posture as `archive_thread` echoing
`archived_at`.

`list_drafts` input is `{ address: string; limit?: number; cursor?: string }`,
result is `{ drafts: StoredDraft[]; next_cursor: string | null }`. ULID-
sorted descending so most-recently-updated drafts surface at the top —
the ULID's monotonic time prefix is enough sort key, no separate
`updated_at` index needed. (A draft saved 30 seconds ago, then again
just now, will resort by re-stamping `updated_at` but its ULID stays
fixed; lexicographic SK ordering is by `created_at`. For the v1 Drafts
view this is the right ordering — operators don't expect a draft to
jump to the top mid-typing every keystroke. If the discrepancy proves
annoying we revisit with a `Sort: by updated_at` toggle, not a GSI.)

`get_draft` input `{ address: string; draft_id: string }` → returns the
full row or 404. `delete_draft` input identical → 200 `{ deleted: true | false }`.

`save_draft` is **upsert-by-id with conditional-write semantics**:

- First save (`draft_id: null`): server mints a ULID, writes with
  `attribute_not_exists(SK)` to prevent a (vanishingly unlikely) ULID
  collision; on collision, mint again and retry once before failing
  500.
- Subsequent saves (`draft_id` present): conditional `UpdateItem` with
  `attribute_exists(address) AND #kind = :draft` so a stale primary
  key cannot create a phantom draft and a draft that was deleted from
  another tab cannot be silently revived. ConditionalCheckFailed maps
  to 404 `draft_not_found`; the composer responds by minting a new
  draft on the next save (the operator's text is preserved client-side
  through the entire transition).

Error cases per RPC:

- `save_draft`: 400 invalid_request (missing address / body_text not a
  string / draft_id present-but-empty); 404 draft_not_found on a stale
  id; 500 internal_error.
- `list_drafts`: 400 invalid_request (missing address); 500
  internal_error. Empty result is a 200 with `drafts: []`, matching
  `read_inbox` posture.
- `get_draft`: 400 invalid_request; 404 draft_not_found; 500.
- `delete_draft`: 400 invalid_request; 200 `{ deleted: false }` on
  already-missing (idempotent — same posture as `mark_read` returning
  `already_read` rather than 404 in the no-op case).

### Wire format & event compatibility

- `read_inbox`, `get_message`, `list_thread_messages`, `search_email`
  are unchanged. Drafts are a parallel data plane; existing tools'
  shapes do not move.
- The four new RPC names land non-breaking on the dispatcher route
  table. ADR-0021 commits this as additive.
- `ThreadIdGSI` is **not** modified. A draft reply's `in_reply_to` is
  not indexed — drafts never need to be resolved by thread (the rail
  view is keyed by mailbox, not thread, and `get_draft` is point-PK).
  ADR-0011 honored — no GSI rebuild.
- No new events. `MailIngested` (ADR-0010) fires on inbound mail
  arrival; drafts have no equivalent — they are private to the
  authoring operator until sent.

### Web client: rail count, view, composer wiring, optimistic state

- `RailView` widens to include `"drafts"`. The Drafts entry replaces
  the disabled placeholder at lines 226–231 of `Rail.tsx`. Count
  surfaces as `draftsCount === 0 ? "—" : draftsCount`, matching the
  starred / snoozed / trashed / archived em-dash convention.
- `bff.saveDraft / listDrafts / getDraft / deleteDraft` in
  `bff-client.ts`, shaped like the existing `bff.archiveThread` etc.
  Result discriminated unions follow the existing `RpcResult<T>` shape
  — no new variants needed, `draft_not_found` rides the existing
  `not_found` kind.
- A `useQuery({ queryKey: ["drafts", MAILBOX], refetchInterval: POLL_MS })`
  in `App.tsx`, parallel to `inboxQuery`. The Drafts view renders the
  query's `drafts` array directly; clicking a row mounts the composer
  in resume mode (a new `PaneState` variant, see below).
- `PaneState` (App.tsx lines 37–46) gains a third variant:
  `{ mode: "composer"; seed: ComposerSeed | null; replyParentId: string | null; resumeDraftId: string | null }`.
  Resume mode hydrates the composer's local state from the draft row
  (one `bff.getDraft` call on mount) and routes saves to the same
  `draft_id`. Send-from-resume fires `delete_draft(draft_id)` after
  send-success.
- `ComposerSeed` (Composer.tsx lines 16–23) gains nothing — resume
  isn't seeding, it's loading. The composer learns a sibling
  `ComposerResumeDraft` shape:

  ```ts
  interface ComposerResumeDraft {
    draft_id: string;
    body_text: string;
    to: string | null;
    cc: string | null;
    subject: string | null;
    in_reply_to: string | null;
    references: string | null;
  }
  ```

- **Optimistic-pending state** mirrors the annotation slices.
  `pendingDrafts: Map<string, DraftBody | null>` keyed by `draft_id`
  in App.tsx alongside `pendingStars` / `pendingSnoozes` / etc. The
  value is the draft body the operator just typed (for in-flight
  saves) or `null` for in-flight deletes. The Drafts view applies
  pending intents on top of the server-authoritative
  `useQuery(["drafts", ...])` result, same pattern as
  `pendingArchives` (App.tsx lines 92–94).
- A single `<DraftRow>` component renders one row in the Drafts view:
  subject, recipient line, snippet of `body_text`, an `updated_at`
  relative timestamp, and a trailing trash icon-button. Clicking the
  row resumes; clicking the trash button fires `delete_draft` with
  optimistic removal. No starring, no snoozing, no archiving of
  drafts — the row is a transient artifact, not a conversation.

### Bulk delete drafts

In scope. The selection plumbing from ADR-0032 is generic over rootKeys
that start with `<` (server-stamped Message-IDs). Drafts use ULID-
shaped `draft_id`s as their selection key — they don't collide with
Message-IDs (different alphabet, no angle brackets), so the selection
gate `rootKey.startsWith("<")` becomes a per-view `selectionGate`
predicate. In Drafts, the gate is `draft_id.length === 26`; in every
other view it stays the existing `<…>` check. The bulk-action-bar
loses its star/snooze/trash/archive/mark-read buttons in the Drafts
view and shows only "Delete N drafts". `bulkApply` fans out
`bff.deleteDraft` exactly the way it already fans out
`bff.archiveThread`. No new dispatcher endpoint — N concurrent
`delete_draft` calls, same reasoning as ADR-0032.

### Concurrency: last-write-wins on `updated_at`, no client-side conflict detection

- Two devices editing the same draft last-write-wins by wall-clock
  `updated_at`. The composer does not surface conflicts — the cost of
  building an `If-Match`-style header for an artifact the operator
  hasn't sent is higher than the cost of one device silently winning
  on a race that requires the operator to leave the same draft open
  in two tabs. v1 is single-tenant (one operator, one mailbox in this
  webmail surface); the race window is "did I switch tabs and resume
  typing".
- Server clock is the canonical clock. `save_draft` stamps
  `updated_at = now` on every write. The composer's "saved · 2s ago"
  footer line is computed from the server's echoed `updated_at`, not
  the client's local clock — same posture as `read_at` echo through
  `mark_read`.
- Two-tab edit is a known papercut and the right answer for a v1
  shape. If it bites in practice, an `if-not-modified-since` guard
  tail-adds onto `save_draft` without breaking the wire (ADR-0021).

### Rail count: separate `bff.listDrafts` poll, mirrors inbox cadence

- The existing `inboxQuery` in App.tsx polls every 30s
  (`POLL_MS = 30_000`). The new `draftsQuery` uses the same cadence —
  one extra Query per address per 30s, and the partition is identical
  so RCU cost is bounded. Splitting the queries (rather than mixing
  drafts into `read_inbox`) keeps the inbox response shape pinned and
  lets the Drafts view's polling pause when the rail isn't showing
  the count (the rail always shows the count, so no pause logic in v1
  — just a clean future option).
- The count includes the draft the operator is currently editing in
  the same tab. The local optimistic-pending map keys are the same
  `draft_id`s the server returns, so a draft that's been saved at
  least once shows up in both lists; a brand-new unsaved draft (the
  composer mounted, no debounce window has elapsed) is not counted —
  which matches operator intuition ("until I've saved it, it's not a
  draft yet"). The first debounced save lands within 1.5s of typing.

### What this slice does *not* ship

- **No rich-text formatting.** Plain text only. `body_html` is a
  reserved tail-add on the draft row.
- **No attachments.** CONTEXT.md pins attachment bytes to the raw
  MIME archive, populated by SES on receipt; outbound attachments
  ride through the persist-outbound path that writes into the same
  bucket. Wiring attachment uploads into the draft surface is a
  separate slice — it changes the storage shape (per-draft S3
  prefix), not just the row.
- **No scheduled send.** A draft becomes a sent message via the
  existing `send_email` / `reply_to_email` paths. "Send at 9am
  tomorrow" is a future feature and lives orthogonal to the draft
  row (a scheduled-send queue, separate ADR).
- **No draft sharing.** v1 is single-operator; cross-operator draft
  sharing would need Grant-level scoping (CONTEXT.md "Grant"), which
  drafts at this slice deliberately don't model.
- **No draft templates.** A "starter" library is a different
  product surface — likely an MCP tool, not a webmail row type.
- **No drafts in search.** `search_email` (ADR-0007) scopes to the
  message-shaped row layout. Drafts have no message_id, no
  thread_id, and no headers_blob — including them would require
  branching the search index. Re-opening a draft from the rail's
  Drafts view is the search affordance at v1.
- **No backfill.** There are no pre-slice drafts to migrate.
- **No undo for delete_draft.** Same posture as the trash slice —
  re-creating the draft from the composer's still-open buffer is
  the undo path. A trashed draft is gone; if the operator hits the
  delete affordance with an empty composer state, they've lost the
  text. The mitigation is a 1.5s debounce window — the most recent
  text the operator typed is on the wire before they can click
  delete.
- **No audit log entry.** Drafts are pre-send; the audit log
  (ADR-0016) starts at send time.
- **No `Auto-Submitted` header on the draft.** Drafts never become
  RFC 5322 wire bytes until send.

## Implementation

1. **Core types** — `src/core/store.ts` adds `StoredDraft`,
   `SaveDraftInput`, `SaveDraftResult`, `ListDraftsInput`,
   `ListDraftsResult`, `GetDraftInput`, `DeleteDraftInput`,
   `DeleteDraftResult`. `MessageReader` grows `saveDraft`,
   `listDrafts`, `getDraft`, `deleteDraft`. `MessageStore` is
   unchanged — drafts are reader-side; the persist-outbound /
   ingest writers don't touch them.
2. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns four new
   functions. `saveDraft` mints the ULID via the injected
   `makeUlidFactory` (new dep on `DynamoMessageReaderDeps`), writes
   with `attribute_not_exists(SK)` on first save and conditional
   `UpdateItem` on subsequent saves. `listDrafts` Querys the
   address partition with `KeyConditionExpression: "address = :addr AND begins_with(internal_id, :pfx)"`,
   `:pfx = "DRAFT#"`, descending. `getDraft` is a point-Get.
   `deleteDraft` is a `DeleteCommand` with no condition.
3. **BFF schema** — `parseSaveDraftInput`, `parseListDraftsInput`,
   `parseGetDraftInput`, `parseDeleteDraftInput` in
   `src/bff/schemas.ts`. Hand-rolled, matching the existing
   parsers' shape (no Zod; in-tree-primitives memory).
4. **BFF dispatcher** — four new `case` arms in
   `src/bff/dispatcher.ts`. `handleSaveDraft` / `handleListDrafts`
   / `handleGetDraft` / `handleDeleteDraft`. 200 / 400 / 404 / 500
   only — no 409, no 422.
5. **Web client** —
   - `bff.saveDraft / listDrafts / getDraft / deleteDraft` in
     `src/web/src/lib/bff-client.ts`.
   - New `pendingDrafts: Map<string, DraftBody | null>` in
     `App.tsx` alongside the five existing pending-intent maps.
   - `useQuery(["drafts", MAILBOX])` in `App.tsx`.
   - `RailView` extension and `draftsCount` prop in
     `src/web/src/components/Rail.tsx`. Replace the disabled
     placeholder (lines 226–231) with an active `<button>`.
   - `Composer.tsx` learns a `resumeDraft: ComposerResumeDraft | null`
     prop and a `draft_id` ref; debounced save effect on every state
     change touching `to / cc / subject / bodyText`. Send-success
     fires `delete_draft` when `draft_id` is non-null.
   - `PaneState` adds the `resumeDraftId` discriminator; the
     composer-mount effect resolves the resume draft via
     `bff.getDraft` (cached in TanStack Query under
     `["draft", draft_id]`).
   - New `src/web/src/components/DraftsList.tsx` — the rail-bound
     view, structurally lighter than `InboxList.tsx` (no
     star/snooze/trash/archive gutter buttons, no in-thread
     expansion).
   - Bulk-action-bar gains a Drafts-mode that shows only "Delete
     N drafts"; `App.tsx`'s `bulkApply` fans out `bff.deleteDraft`.
6. **Tests**
   - `dynamodb-reader.test`: save (first / upsert), list (newest-first,
     pagination), get (404 on missing), delete (idempotent on missing).
     Conditional-write rollback path on stale draft_id.
   - `bff-dispatcher.test`: route, 400 on missing fields, 404 on stale
     id, 200 success body shape on each tool.
   - `bff-schemas.test`: each parser's missing/wrong-type rejections.
   - `Composer.test` (web): debounced save fires once after 1.5s of
     idle typing, save-on-blur flushes pending, send-success fires
     `delete_draft`, send-failure leaves draft intact.
   - `App.test` (web): Drafts rail count reflects `listDrafts`
     poll; resume-from-rail mounts composer with hydrated state;
     bulk-delete-drafts fans out and clears selection.

## Considered and rejected

- **Sixth sparse attribute on `Messages` (e.g. `draft_at`).**
  Mechanically possible but semantically wrong — a draft has no
  `internal_id`-as-message-id, no `received_at`, no `parse_status`,
  no headers_blob. Trying to backfill these as nulls leaks "is this
  really a message?" branching into every read path. The annotation
  pattern from 8.10–8.16 is the right shape for sparse state on real
  rows; drafts are not real rows.
- **Separate `Drafts` table.** Cleaner schema-wise, but adds another
  CDK resource, another set of IAM policies, another partition the
  reader has to think about. The `DRAFT#` SK prefix on `Messages`
  costs nothing — the existing partition is already keyed by
  `address`, which is exactly the partition every draft Query
  wants. A separate table would also break the natural co-location
  of "everything for this mailbox" in one DDB partition for backup
  / restore / audit purposes.
- **Append-then-tombstone (every save is a new row).** Gives a free
  history-of-edits view, but every `list_drafts` Query has to
  collapse-by-`draft_id` client-side and the table grows
  unboundedly during a single composing session. Upsert-by-id is
  the boring shape and matches the operator's mental model.
- **Save on every keystroke (no debounce).** A 60-WPM typist fires
  ~5 keystrokes per second. Even at trivial WCU per write, the
  cost is wasteful and the UI's "saved just now" indicator becomes
  noise. 1500ms is the same idle-window length the autosave
  literature has settled on.
- **Save on blur only, no debounce.** Debounce-on-typing catches
  the operator who Cmd-Tab'd to look something up and didn't blur
  the composer. Both triggers fire; the debounce loses the race
  on blur because a flush is unconditional.
- **Tombstone drafts on send (`sent_at` attribute, soft-delete).**
  Adds a code path nothing else needs — the outbound copy already
  serves as the durable post-send record (ADR-0017). Hard delete
  is one DeleteItem per send, and the ULID is never reused.
- **Group reply-drafts under their parent thread in the Drafts view.**
  Gmail does this and it's nice when it works — but the Drafts
  view is small at v1 (~tens of rows) and the disambiguation cost
  of "Re: Q3 retro · alice@…" is already low. Grouping requires
  resolving each draft's `in_reply_to` against the inbox window
  client-side and degrades to a flat list whenever the parent has
  fallen out of the window. Not worth the complexity at v1.
- **Index drafts on `ThreadIdGSI`.** Drafts have no `thread_id`
  (they pre-date the thread membership decision). Synthesizing one
  for the in_reply_to case would mean indexing reply-drafts but
  not fresh-compose drafts; that asymmetry leaks into every
  thread-aware code path. ADR-0011 honored — no GSI rebuild for a
  use case that point-Get and a single Query already cover.
- **Use `if-not-modified-since: <updated_at>` on save_draft.**
  Conflict-detect across two open tabs is real but rare at v1;
  building it now means every save round-trips a timestamp and
  the composer needs a "your changes were overwritten" UI. Tail-add
  if it bites; ship without.
- **Use the rail's existing `<input>` plumbing for composing.**
  The rail's search input is single-line and global; the composer
  is a multi-field pane that takes over the reader region. They
  have nothing structural in common; reusing one for the other
  would couple unrelated UI.
- **No bulk-delete-drafts.** Doable, but the bulk plumbing from
  ADR-0032 is already generic and Drafts is the only view where
  "select N rows and apply one action" maps to a single canonical
  verb (delete). Ship it together.
