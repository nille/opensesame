// Client-side conversation rollup for the inbox list (slice 8.5, ADR-0023).
//
// As of slice 8.8 (ADR-0026), the server stamps `thread_id` on the row at
// write time using the same `deriveThreadId` rule. We prefer the server value
// when present and fall back to JWZ-style resolution otherwise. The fallback
// covers two transitional/defense cases:
//   - rows written before slice 8.8 (no backfill)
//   - parses too sparse for deriveThreadId (no Message-ID, no In-Reply-To,
//     no References) — the subject+month bucket keeps these from each
//     becoming their own one-message thread.

import type {
  InboxRow,
  InboxRowFailed,
  InboxRowOk,
  ListThreadMessagesResult,
  RpcResult,
} from "./bff-client.ts";

export interface Thread {
  // Stable key — either the root msg-id (`<root@example.com>`) or a
  // synthetic `subj:<YYYY-MM>:<normalized>` when the chain root isn't in
  // the visible set.
  rootKey: string;
  // Parsed rows in this thread, sorted newest-first.
  rows: InboxRowOk[];
  // Skeleton rows that landed in this thread. These never participate in
  // chain resolution — they're each their own one-row thread.
  failedRows: InboxRowFailed[];
  // Latest received_at across rows + failedRows. Drives top-level sort.
  latestReceivedAt: string;
  // Distinct sender display names, newest-first, deduped case-insensitively.
  senders: string[];
  // Any inbound row with read_at === null. Outbound rows never count as
  // "unread" — they were never an inbox item to read.
  unread: boolean;
  // True when any row is direction === "out". Drives the `sent` chip and
  // selection-mode unread elision in the renderer.
  hasOutbound: boolean;
  // ADR-0028 (slice 8.10): true when any row carries a starred_at timestamp.
  // Star is per-thread state but the storage is per-row; aggregating with OR
  // means a stale window where one row hasn't been re-fetched yet still
  // reads as starred — matches operator intent.
  starred: boolean;
  // ADR-0029 (slice 8.11): true when every parsed row carries an unexpired
  // `snoozed_until`. Aggregating with AND (vs star's OR) is what gives us
  // wake-on-reply for free — a fresh inbound row arrives without
  // `snoozed_until` and the thread auto-wakes. Failed/skeleton rows don't
  // affect the predicate (they can't be snoozed); a thread that's ONLY
  // skeletons reads as not snoozed.
  snoozed: boolean;
  // The earliest unexpired `snoozed_until` across the rows. Null when not
  // snoozed. Drives the "snoozed until 9am" affordance and the Snoozed
  // sidebar's ascending sort.
  snoozedUntil: string | null;
  // ADR-0030 (slice 8.12): true iff every parsed row carries a
  // `trashed_at` timestamp. Same every-row aggregation as snooze (without
  // the expiry check) — a fresh inbound reply lands without `trashed_at`
  // and the thread auto-resurfaces in the inbox. A skeleton-only thread
  // is never trashed (rows.length === 0 → false).
  trashed: boolean;
  // ADR-0034 (slice 8.16): true iff every parsed row carries an
  // `archived_at` timestamp. Same every-row aggregation as trash;
  // wake-on-reply behavior is identical. Independent from `trashed` —
  // a thread can be archived without being trashed and vice versa.
  archived: boolean;
  // rows.length + failedRows.length. >1 means render the count chip.
  count: number;
}

const MSG_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;
// `re:` / `fwd:` / `fw:` only — localized prefixes (`aw:`, `sv:`, `回复:`)
// stay intact, same call as the server's reply subject canonicalization.
const PREFIX_RUN_RE = /^(?:\s*(?:re|fwd?|fw)\s*:\s*)+/i;

// `now` is injected so callers can pin the wake-time predicate to a fixed
// instant (tests; deterministic re-renders during one React tick). Default
// to the actual clock so the live UI sees expired snoozes wake on the
// next inbox poll.
export function groupIntoThreads(
  rows: InboxRow[],
  now: Date = new Date(),
): Thread[] {
  const okRows: InboxRowOk[] = [];
  const failedRows: InboxRowFailed[] = [];
  for (const r of rows) {
    if (r.parse_status === "ok") okRows.push(r);
    else failedRows.push(r);
  }

  const buckets = new Map<string, Thread>();

  for (const row of okRows) {
    const key = rootKeyForRow(row);
    upsert(buckets, key, row);
  }

  for (const row of failedRows) {
    // Skeleton rows never thread — synthesize a unique key per row.
    const key = `failed:${row.internal_id}`;
    const t: Thread = {
      rootKey: key,
      rows: [],
      failedRows: [row],
      latestReceivedAt: row.received_at,
      senders: [row.address],
      unread: false,
      hasOutbound: false,
      starred: false,
      snoozed: false,
      snoozedUntil: null,
      trashed: false,
      archived: false,
      count: 1,
    };
    buckets.set(key, t);
  }

  const threads = Array.from(buckets.values());
  // Snooze and trash aggregation need the full row set per thread, so
  // compute them as a final pass once upsert has finished collecting rows
  // (vs star/unread which are short-circuit OR and can be computed during
  // upsert).
  const nowMs = now.getTime();
  for (const t of threads) {
    annotateSnooze(t, nowMs);
    annotateTrash(t);
    annotateArchive(t);
  }
  // Sort newest-first by the thread's most-recent message.
  threads.sort((a, b) => b.latestReceivedAt.localeCompare(a.latestReceivedAt));
  return threads;
}

// snoozed iff every parsed row carries an unexpired snoozed_until. A thread
// of skeletons-only is not snoozable (no rows on the GSI). snoozedUntil is
// the earliest unexpired wake time across the rows — that's the moment the
// thread will reappear, which is what "snoozed until X" should display.
function annotateSnooze(t: Thread, nowMs: number): void {
  if (t.rows.length === 0) {
    t.snoozed = false;
    t.snoozedUntil = null;
    return;
  }
  let earliest: string | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const r of t.rows) {
    const su = r.snoozed_until;
    if (su === null) {
      // Wake-on-reply: a single unstamped row wakes the conversation.
      t.snoozed = false;
      t.snoozedUntil = null;
      return;
    }
    const ms = Date.parse(su);
    if (!Number.isFinite(ms) || ms <= nowMs) {
      // Expired (or unparseable) snooze on this row → also a wake. We treat
      // an unparseable timestamp as the safer "awake" state so a corrupt
      // row can't permanently pin a thread out of the inbox.
      t.snoozed = false;
      t.snoozedUntil = null;
      return;
    }
    if (ms < earliestMs) {
      earliestMs = ms;
      earliest = su;
    }
  }
  t.snoozed = true;
  t.snoozedUntil = earliest;
}

// trashed iff every parsed row carries `trashed_at`. A thread of skeletons
// only is not trashed (rows.length === 0 → false). Wake-on-reply: a single
// unstamped row resurfaces the conversation, same shape as snooze without
// the expiry check.
function annotateTrash(t: Thread): void {
  if (t.rows.length === 0) {
    t.trashed = false;
    return;
  }
  for (const r of t.rows) {
    if (r.trashed_at === null) {
      t.trashed = false;
      return;
    }
  }
  t.trashed = true;
}

// archived iff every parsed row carries `archived_at`. Same every-row
// predicate as trash; identical wake-on-reply behavior. Independent from
// trash — both attributes can coexist on a row, though the operator
// rarely sets both.
function annotateArchive(t: Thread): void {
  if (t.rows.length === 0) {
    t.archived = false;
    return;
  }
  for (const r of t.rows) {
    if (r.archived_at === null) {
      t.archived = false;
      return;
    }
  }
  t.archived = true;
}

function upsert(
  buckets: Map<string, Thread>,
  key: string,
  row: InboxRowOk,
): void {
  let t = buckets.get(key);
  if (t === undefined) {
    t = {
      rootKey: key,
      rows: [],
      failedRows: [],
      latestReceivedAt: row.received_at,
      senders: [],
      unread: false,
      hasOutbound: false,
      starred: false,
      snoozed: false,
      snoozedUntil: null,
      trashed: false,
      archived: false,
      count: 0,
    };
    buckets.set(key, t);
  }
  t.rows.push(row);
  t.count = t.rows.length + t.failedRows.length;
  // Sort newest-first inside the thread so rows[0] is always the lead.
  t.rows.sort((a, b) => b.received_at.localeCompare(a.received_at));
  t.latestReceivedAt = t.rows[0]!.received_at;
  t.hasOutbound = t.hasOutbound || row.direction === "out";
  if (row.starred_at !== null) t.starred = true;
  if (row.direction === "in" && row.read_at === null) t.unread = true;
  // Recompute senders newest-first to match the freshly-sorted rows order.
  t.senders = collectSenders(t.rows);
}

// Resolve a row's thread root. Server-stamped `thread_id` wins (ADR-0026);
// otherwise mirror src/core/threading.ts deriveThreadId on the wire headers
// and fall back to subject + month bucket when nothing chains.
function rootKeyForRow(row: InboxRowOk): string {
  if (row.thread_id !== null && row.thread_id !== "") return row.thread_id;

  const refRoot = firstMsgId(row.references);
  if (refRoot !== null) return refRoot;

  const irt = firstMsgId(row.in_reply_to);
  if (irt !== null) return irt;

  if (row.message_id !== null) return row.message_id;

  return subjectFallbackKey(row.subject, row.received_at);
}

function firstMsgId(raw: string | null): string | null {
  if (raw === null) return null;
  // Reset stateful regex.
  MSG_ID_RE.lastIndex = 0;
  const match = MSG_ID_RE.exec(raw);
  return match === null ? null : match[0];
}

function subjectFallbackKey(
  subject: string | null,
  receivedAt: string,
): string {
  const normalized = normalizeSubject(subject);
  const bucket = receivedAt.slice(0, 7); // YYYY-MM
  return `subj:${bucket}:${normalized}`;
}

function normalizeSubject(subject: string | null): string {
  if (subject === null) return "";
  return subject.replace(PREFIX_RUN_RE, "").trim().toLowerCase();
}

function collectSenders(rows: InboxRowOk[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const name = senderName(r.from);
    if (name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Union the in-window rows with any extra rows list_thread_messages surfaced
// (ADR-0027 / slice 8.9). Dedupe by internal_id — same key the inbox already
// uses for PK identity. Sort newest-first so the lead matches the existing
// reader-stack ordering. In-window rows win on collision: they may carry a
// fresher `read_at` from a more recent inbox poll than the GSI page.
export function mergeThreadRows(
  inWindow: InboxRowOk[],
  fetched: RpcResult<ListThreadMessagesResult> | undefined,
): InboxRowOk[] {
  if (fetched === undefined || fetched.kind !== "ok") return inWindow;
  const byId = new Map<string, InboxRowOk>();
  for (const r of fetched.value.messages) {
    if (r.parse_status !== "ok") continue;
    byId.set(r.internal_id, r);
  }
  for (const r of inWindow) byId.set(r.internal_id, r);
  return Array.from(byId.values()).sort((a, b) =>
    b.received_at.localeCompare(a.received_at),
  );
}

function senderName(from: string | null): string {
  if (from === null) return "";
  const trimmed = from.trim();
  if (trimmed === "") return "";
  const m = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (m && m[1]) return m[1].trim();
  return trimmed;
}
