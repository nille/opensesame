# Server-side `thread_id` on the Messages row, slice 8.8

Slice 8.5 (ADR-0023) shipped client-side threading because we hadn't yet decided on the persistent shape. The web client groups inbox rows with a JWZ-lite mirror of `deriveThreadId` — References → In-Reply-To → self → subject+month fallback. It works for the inbox window read_inbox returns, but it has two ceilings:

1. **Window-bounded.** Anything older than the last 50 rows is invisible to the client, so a reply that lands now and answers a thread whose root scrolled off the page sits orphaned in its own bucket. The fallback subject+month key papers over some of this, not all.
2. **Recomputed every render.** The client redoes JWZ on every refetch; the cost is small at 50 rows but compounds when slices 8.9+ ask for "load older messages in this thread."

Slice 8.6's reader stack (ADR-0024) and slice 8.7's `J`/`K` nav (ADR-0025) both consume thread shape — the keyboard nav already broke the 50-row window assumption when an operator scrolled to the bottom of a long inbox, so this isn't speculative anymore.

The unblocker is one cheap thing: stamp `thread_id` on the row at write time. Same string the client computes today; same `deriveThreadId` already in core. Nothing else changes in this slice — no new GSI, no new RPC, no schema break.

## Decision

### Persist `thread_id` as a `Messages` row attribute, derived at write

- Inbound: `ingest.ts` already builds the `MailIngested` event whose `data.thread_id` is `deriveThreadId(parsed.headers)`. We pass that same string into the store call so the row carries it.
- Outbound (`persistOutbound`): same call, on the SES-rewritten parsed headers. The composer's `In-Reply-To` / `References` flow through `parseMime`, so an outbound reply lands with the inbound parent's `thread_id`.
- The attribute is sparse — null/undefined collapses to attribute-absent on the DDB row (same back-compat treatment as `direction`, `read_at`, `reply_to_raw`).

### Read side: project `thread_id` onto `InboxRowOk` and `ReadMessageOk`

- Add `thread_id: string | null` to `InboxRowOk` and `ReadMessageOk` in `src/core/store.ts`.
- The DDB reader maps `row["thread_id"]` (string) or returns `null` for rows written before this slice. No backfill required — the client falls back to JWZ on the missing case (see below), which keeps every row in some bucket.

### Client: prefer `thread_id` when present, fall back to JWZ

`groupIntoThreads` in `src/web/src/lib/threading.ts` becomes a two-stage rule:

1. If the row has a non-null `thread_id`, use it as `rootKey`.
2. Else compute the JWZ-style key the way today's code does (References → In-Reply-To → self → subject+month).

The fallback exists for one transitional reason: rows written before this slice land without `thread_id`, and we don't backfill in this slice (see below). Once every visible row carries `thread_id`, the fallback never fires — but we keep it in the code as a defense for the rare case of a corrupted/cleared attribute, same way we treat `direction` defaulting to `"in"` on attribute-absent.

### What this slice does *not* ship

- **No GSI on `thread_id`.** ADR-0013 explicitly punted on this and called it speculative until throughput shows otherwise. Adding a GSI now doubles the write cost on every message for a reader that doesn't exist yet (no "fetch all messages in thread X" RPC). When slice 8.9 wires up `list_thread_messages`, that's the slice that earns the GSI.
- **No backfill.** The Messages table is RETAIN'd; we don't have a migration framework yet. Old rows stay missing the attribute and the client's JWZ fallback handles them. This is consistent with the `direction` and `read_at` rollouts (ADR-0017, slice 8.2).
- **No `thread_id` on skeleton rows.** The parser never resolved enough to derive one (`deriveThreadId` returns `null`). Skeleton rows already each get their own bucket via `failed:{internal_id}` keys.
- **No subject-fallback at write time.** The server-side `deriveThreadId` returns `null` for messages with no Message-ID and no threading headers (a not-uncommon shape for some mailers). For those rows the client's JWZ subject-fallback still produces a stable key from the inbox window — the same way it does today. We could promote subject-fallback into core, but the trade-off is a server commit on a rule that operators may want to tweak per mailbox; keeping it client-side keeps the decision soft.

### Wire format & event compatibility

- The `MailIngested` event already carries `data.thread_id` (ADR-0010). No change there.
- The DDB attribute name is `thread_id` to match the event field; renaming would force a parallel attribute during transition we don't need.
- BFF responses (`read_inbox`, `get_message`) gain an additive `thread_id` field. ADR-0021 commits to wire-compatible additions; this slots in.

## Implementation

1. **Core types** — add `thread_id: string | null` to `InboxRowOk` and `ReadMessageOk` in `src/core/store.ts`. Keep `null` rather than `undefined` for back-compat parity with the other tail-add fields.
2. **`StoredMessage` carries it** — extend the type with `thread_id: string | null` (computed, not opaque to caller). Both write callers (`handleRawMail` for inbound and `persistOutbound`) call `deriveThreadId` against the parsed headers and pass the result through.
3. **DDB write adapter** (`src/aws/dynamodb.ts`) — write `thread_id` onto the metadata row only when non-null. Skeleton rows get nothing (same shape as before).
4. **DDB read adapter** (`src/aws/dynamodb-reader.ts`) — project `thread_id` from the row on both `projectInboxRow` and `projectOk`. Return `null` when missing.
5. **Client** (`src/web/src/lib/threading.ts`) — `rootKeyForRow` checks `row.thread_id` first. The function comment updates to reflect that the fallback is now a transitional + defense path, not the primary algorithm.
6. **Tests**
   - `dynamodb.test.ts` — assert `thread_id` is written when set, omitted when null.
   - `dynamodb-reader.test.ts` / `list-inbox.test.ts` / `get-message.test.ts` — assert the projection round-trips and that attribute-absent reads as null.
   - Web `threading.test.ts` — assert server `thread_id` wins over the JWZ fallback and that null rows still cluster via the existing JWZ rule.

## Considered and rejected

- **Add a GSI on `thread_id` now.** Pure write-side cost for no reader. The JWZ-or-stamped distinction the client uses is enough to satisfy slice 8.5–8.7 today; the GSI earns its keep when an "all messages in thread X" RPC lands.
- **Backfill old rows.** No migration harness exists yet, the Messages table is RETAIN, and the client's fallback covers the gap without any operator-visible artifact. Backfill becomes work when a caller assumes 100% coverage — none does in this slice.
- **Drop the JWZ fallback once `thread_id` ships.** Loses graceful degradation for rows where the parse landed but the headers were too sparse for `deriveThreadId` (no Message-ID, no References, no In-Reply-To). The server returns `null`; falling back to subject+month keeps these rows from each becoming their own bucket.
- **Promote subject-fallback into core's `deriveThreadId`.** Tempting: it would close the `null` gap for sparse rows. But the rule is mailbox-specific (a `subj:` key wedge across every operator's traffic creates spurious clusters; ADR-0023 keeps it client-only deliberately). We can revisit when search-result threading (later slice) exposes the artifact in a way the operator pushes back on.
- **Compute `thread_id` on read instead of write.** Cheap to write, free to read this way — but every read has to parse the threading headers it didn't already have decoded, and the GSI option (when we add it) wants the value present at write time anyway. Stamping at write is the path of least drift.
