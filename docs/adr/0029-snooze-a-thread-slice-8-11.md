# `snooze_thread` RPC + sparse `snoozed_until`, slice 8.11

Slice 8.10 (ADR-0028) shipped per-thread starring with sparse `starred_at`
fan-out. This slice extends the same pattern to **snooze**: hide a thread
from the inbox until either a future timestamp passes *or* a new reply
arrives. Snooze is the second of the three operator annotations the inbox
punch list calls for; trash (8.12) reuses this shape too.

The interesting design pivot vs. star is the **wake rule**. Star is sticky
("any starred row → starred thread"). Snooze is the opposite kind of
predicate — "every row in the conversation is asleep, *and* none of them
are past the wake time". A new reply lands without a `snoozed_until`
attribute and the thread auto-wakes. This matches what every operator
expects from snooze (it's how Gmail behaves) and falls out of the
aggregation rule for free.

## Decision

### `snoozed_until` is a sparse, per-row attribute on `Messages`

- Type: ISO-8601 string. Attribute-absent on the row → "not snoozed".
  Same convention as `read_at`, `thread_id`, and `starred_at`.
- One annotation, one attribute: no per-operator state, no original-snooze
  timestamp, no reason. v1 single-tenant.
- `snoozed_until` semantics: the time at which the thread should re-appear
  in the inbox. Attribute exists + value in the future → asleep on this
  row. Attribute exists + value in the past → effectively woken (the
  client's aggregation rule treats expired snoozes as unstamped); a future
  background sweep removes the attribute, but rows with stale
  `snoozed_until` are correct without the sweep.
- Skeleton rows (`parse_status: "failed"`) never carry a `thread_id` and
  so are never snoozed — `snooze_thread` resolves rows via `ThreadIdGSI`
  and skeletons aren't on the index. Same precedent as 8.10.

### The annotation is per-thread, written across every row

When the operator snoozes a thread, the BFF resolves *every row* in that
thread via `ThreadIdGSI` and stamps `snoozed_until = <iso>` on each one.
Unsnoozing removes the attribute from every row. Same three reasons as
star (reads stay one-Query, race-free under root drift, per-row
idempotence pattern reused).

The wake-on-reply behavior falls out automatically: a new reply that
arrives after the snooze is written *without* a `snoozed_until`
attribute (the write path doesn't know about thread state). The client
aggregation rule "thread is snoozed iff every row carries an unexpired
`snoozed_until`" then flags the conversation as woken — exactly the
desired UX.

The fan-out cap is the same `MAX_THREAD_LIMIT = 200` already enforced
for `list_thread_messages` and `star_thread`. Threads larger than 200
rows snooze their first 200 ascending-by-`internal_id` rows; this is
enough to satisfy the aggregation rule on the visible window.

### `MessageReader.snoozeThread(input, now)`

```ts
type SnoozeThreadInput = {
  thread_id: string;
  // ISO-8601 wake time when snoozing; null when unsnoozing.
  snoozed_until: string | null;
};

type SnoozeThreadResult = {
  thread_id: string;
  snoozed_until: string | null;
  updated_count: number;
};

snoozeThread(input: SnoozeThreadInput, now: Date): Promise<SnoozeThreadResult>;
```

- Step 1: Query `ThreadIdGSI` for `thread_id`, project only
  `address, internal_id`, limit `MAX_THREAD_LIMIT`. One RCU per row.
- Step 2: For each resolved primary key, fan out parallel
  `UpdateCommand`s.
  - Snooze: `SET snoozed_until = :iso` with
    `ConditionExpression: attribute_exists(#addr)`. Re-snoozing
    overwrites — like star, this is a UI toggle, not a first-event
    timestamp.
  - Unsnooze: `REMOVE snoozed_until` with
    `ConditionExpression: attribute_exists(#addr)`. Already-unsnoozed
    rows are a benign no-op — REMOVE on a missing attribute succeeds.
- Step 3: Return `updated_count = number of successful writes`.
- Empty thread (no rows on the GSI) → `updated_count: 0`,
  `snoozed_until` echoes the requested state. No 404, same reasoning
  as `star_thread`.
- Past-time validation: the BFF rejects `snoozed_until` ≤ `now` with a
  400 (operator can't snooze into the past). The reader trusts its input
  — the BFF has already validated.

### Wire row carries `snoozed_until`

- `InboxRowOk` and `ReadMessageOk` gain a nullable
  `snoozed_until: string | null` field. Attribute-absent on the DDB row
  → null.
- `projectInboxRow` and `projectOk` in `dynamodb-reader.ts` read the
  attribute via the existing `nullableString` helper.
- The web client mirrors the field on its `InboxRowOk` and
  `ReadMessageOk` types in `bff-client.ts`.

### `/rpc/snooze_thread` BFF tool

- New case in `dispatch`. Input schema:
  `{ thread_id: string; snoozed_until: string | null }`.
- 400 `invalid_request` when:
  - `thread_id` missing/empty
  - `snoozed_until` missing entirely (unlike `starred`, the operator
    must explicitly pass `null` to unsnooze — keeps the wire shape
    self-documenting)
  - `snoozed_until` non-string and non-null
  - `snoozed_until` not parseable as ISO-8601
  - `snoozed_until` is a string and ≤ `now` (snoozing into the past)
- 200 with the full `SnoozeThreadResult` body on success (including
  `updated_count: 0`).
- No 404, no 409 — empty thread is a 200 no-op, same as `star_thread`.

### Web client: aggregation, sidebar, affordance

- `Thread` (in `src/web/src/lib/threading.ts`) gains:
  - `snoozed: boolean` — true iff every parsed row carries an unexpired
    `snoozed_until`. Empty `rows` (failed-only thread) → false. **Wake
    on reply** is encoded right here: a row without `snoozed_until` (a
    fresh reply) flips this to false.
  - `snoozedUntil: string | null` — the *minimum* unexpired
    `snoozed_until` across the rows. Null when not snoozed. Used to
    render "snoozed until 9am" affordances.
- The `unread` and inbox view filter become snooze-aware:
  - Inbox view filters out threads where `snoozed === true`. Snoozed
    threads still surface via the **Snoozed** sidebar entry.
  - The Starred view continues to show snoozed threads (intentional —
    "I starred it, I want to see it; snooze just means it's not in my
    triage queue right now").
- `RailView` widens to include `"snoozed"`. The Snoozed sidebar
  filters `threads.filter(t => t.snoozed)`. Sorted by `snoozedUntil`
  ascending so the soonest-waking thread is at the top.
- `bff.snoozeThread(input)` lives in `bff-client.ts` shaped like
  `bff.starThread`.
- A small clock-face icon-button sits in the inbox-row right gutter
  alongside (right of) the star, and at the top of the reader. Click
  opens a preset popover: "1 hour", "this evening", "tomorrow 9am",
  "next week", and "unsnooze" when already snoozed. Optimistic update;
  revert on RPC error.
- Keyboard: `z` opens the picker on the focused thread. `Z`
  (shift+z) unsnoozes immediately. Mnemonic: zzz = sleep.

### Time-zone semantics for the presets

The presets are computed client-side relative to the operator's local
time zone. "Tomorrow 9am" means 09:00 in the browser's local zone the
following calendar day; "this evening" means 18:00 local same day, or
18:00 next day if it's already past 18:00. The wire payload is always
UTC ISO-8601 — the BFF and reader never interpret a wall-clock time.

### What this slice does *not* ship

- **No backfill.** Legacy rows have no `snoozed_until`; that's the
  unsnoozed default.
- **No SnoozedUntilGSI.** The Snoozed sidebar filters the inbox
  window client-side, like Starred. Out-of-window snoozed threads are
  not surfaced — accepted v1 limitation.
- **No wake-time background sweep.** Expired snoozes stay on the row
  with an in-the-past `snoozed_until` value. The aggregation rule
  (`unexpired` predicate) handles them on the read side; rewriting
  the row to drop the attribute is mostly cosmetic and adds a
  scheduler we don't need yet.
- **No notification on wake.** When a snoozed thread surfaces (via
  reply or expiry), the inbox just shows it again. No badge, no
  separate "woken" indicator. The operator's `j/k` cycle through it
  naturally.
- **No bulk snooze.** Per-thread toggle only. Multi-select snooze is
  a follow-up.
- **No per-operator state.** Same as 8.10.
- **No audit log entry.** Same as 8.10 — UI state, not state-transition
  event.

### Wire format & event compatibility

- `read_inbox`, `get_message`, and `list_thread_messages` shapes gain
  a tail `snoozed_until` field. ADR-0021 commits to wire-additive
  evolution.
- `snooze_thread` is a new tool name in the dispatcher route table;
  ADR-0021 commits this is a non-breaking addition.
- `ThreadIdGSI` is **not** modified — `snoozed_until` is not added
  to its `INCLUDE` projection. The Query path that uses the GSI
  reads only the PK pair for the fan-out resolve step. ADR-0011
  honored — no GSI rebuild.

## Implementation

1. **Core types** — `src/core/store.ts` adds `SnoozeThreadInput` /
   `SnoozeThreadResult` and `MessageReader.snoozeThread`. Tail-add
   `snoozed_until: string | null` to `InboxRowOk` and `ReadMessageOk`.
2. **DDB adapter** — `src/aws/dynamodb-reader.ts` learns
   `snoozeThread`. Reuses `ThreadIdGSI` for the resolve step and
   `attribute_exists(#addr)` for the per-row guard. Project
   `snoozed_until` in `projectInboxRow` / `projectOk`.
3. **BFF schema** — `parseSnoozeThreadInput` in `src/bff/schemas.ts`.
   Required `thread_id: string`; required `snoozed_until: string | null`
   with the past-time guard described above.
4. **BFF dispatcher** — new `case "snooze_thread"` in
   `src/bff/dispatcher.ts`. Same `MAX_THREAD_LIMIT = 200` cap.
5. **Web client** — `bff.snoozeThread` in
   `src/web/src/lib/bff-client.ts`. `Thread.snoozed` and
   `Thread.snoozedUntil` derived in
   `src/web/src/lib/threading.ts`. `RailView` extension and Snoozed
   filter in `src/web/src/components/Rail.tsx` + `App.tsx`. Inbox
   view becomes snooze-aware. SnoozePicker preset popover in
   `src/web/src/components/SnoozePicker.tsx`. Snooze icon-button in
   `InboxList.tsx` + `Reader.tsx`. `snoozed_until` added to the
   mirrored `InboxRowOk` / `ReadMessageOk` shapes.
6. **Tests**
   - `dynamodb-reader` test — snooze path: GSI Query + N parallel
     UpdateCommands with the right ConditionExpression and
     UpdateExpression. Unsnooze path: REMOVE shape. Empty-thread
     path: no UpdateCommand fired, `updated_count: 0`. Cap at 200
     enforced.
   - `bff-dispatcher` test — route, 400s on missing/invalid input
     including past-time guard, success body shape.
   - `threading.test.ts` — `groupIntoThreads` derives `snoozed` from
     constituent row `snoozed_until` (every row + unexpired).
     Wake-on-reply: a single unstamped row in an otherwise snoozed
     thread → not snoozed. Expired `snoozed_until` → not snoozed.
   - Web component test for the snooze picker, the `z` shortcut, and
     the inbox/Snoozed view filter.

## Considered and rejected

- **Strict snooze (any-snoozed-row → snoozed thread).** Mirrors star
  exactly. Rejected because it forces operators to manually unsnooze
  when a reply arrives — an extra step at exactly the moment the
  thread is most relevant. Wake-on-reply is what every modern mail
  client does; we should match the muscle memory.
- **Single `snoozed_until` on a thread-root row.** Same critique as
  star: forces a "find the root" step on every read, races under
  root drift. Plain fan-out wins.
- **Server-stored wall-clock presets.** "Tomorrow 9am" computed
  on the server. Tempting (the server is the timezone authority for
  scheduled jobs in some shops). Rejected — the operator is the
  observer, and "tomorrow" is the operator's tomorrow. Compute
  client-side, send UTC.
- **Background sweep that REMOVEs expired `snoozed_until`.** Cleaner
  long-term shape — expired rows land back in their natural unsnoozed
  state. Costs us a scheduler (cron + Lambda + DDB iterator) for a
  feature whose only observable effect is cosmetic at v1 sizes. The
  read-side `unexpired` predicate handles correctness. Revisit when
  there's a measured WCU or read-amplification cost.
- **Notification on wake.** Slack-style "this thread is back" indicator.
  Rejected as scope creep; the inbox surfacing IS the notification
  for an operator-grade reader.
- **Reuse `starred_at` keyboard `s` for snooze (overload by modifier).**
  Confusing. `s` stays on star; `z` is its own shortcut. Single-letter
  shortcuts are cheap and the cheat sheet stays readable.
- **Snooze-into-the-past as a no-op.** If `snoozed_until` is in the
  past, just don't write it (the thread is already woken). Rejected as
  surprising — the operator typed a wake time, and a silent no-op
  hides the typo. 400 is friendlier.
- **TransactWriteItems for the fan-out.** Same answer as star: not
  worth the 2× WCU and 100-item cap; per-row idempotence is fine.
- **Snooze hides starred threads from Starred view.** Rejected — see
  above. Starred is "things I'm tracking"; snooze is "not my problem
  *right now*". Operators have already opted into seeing starred
  threads explicitly.
