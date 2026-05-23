// Sent-view projection (slice 8.18, ADR-0039).
//
// Inbox renders threads with the *senders* in the left column, sorted by
// the latest activity in any direction. Sent flips both: the left column
// is the *recipients of the latest outbound row* (your most recent send,
// not the latest reply you got back), and the list is sorted by that
// outbound row's `received_at`.
//
// Both helpers are pure projections over the existing Thread shape — no
// new RPC, no wire changes. The view filter `hasOutbound` is enforced
// upstream by App.tsx; these helpers defend in depth so a thread with no
// outbound row never crashes the row renderer.

import type { Thread } from "./threading.ts";
import type { InboxRowOk } from "./bff-client.ts";
import { senderDisplay } from "./format.js";

// Find the latest outbound row in a thread, or null if there are none.
// `t.rows` is already sorted newest-first by `groupIntoThreads`, so the
// first match is the latest.
function latestOutbound(t: Thread): InboxRowOk | null {
  for (const r of t.rows) {
    if (r.direction === "out") return r;
  }
  return null;
}

// Recipients (display names) of the latest outbound row in a thread.
// Returns `[]` when the thread has no outbound row (defense in depth —
// the Sent view filter excludes these upstream). Multi-recipient `to:`
// is split on the RFC 5322 list separator (comma); each address is run
// through `senderDisplay()` which handles `Display <addr>` and bare
// addresses identically to the inbox sender column.
//
// Deduped case-insensitively; original casing of the first occurrence
// wins so the column reads how the operator actually addressed it.
export function recipientsOfLatestOutbound(t: Thread): string[] {
  const out = latestOutbound(t);
  if (out === null) return [];
  if (out.to === null) return [];

  const parts = splitRecipients(out.to);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of parts) {
    const name = senderDisplay(part);
    if (name === "" || name === "(unknown)") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

// Sort threads by the latest outbound row's `received_at`, newest-first.
// Threads with no outbound row are excluded — the caller already filters
// on `hasOutbound`, but the predicate keeps `sortByLatestOutbound` total
// when used directly in tests.
//
// Stable on equal timestamps via `Array.prototype.sort` (ES2019+).
export function sortByLatestOutbound(threads: readonly Thread[]): Thread[] {
  const annotated: Array<{ t: Thread; outboundAt: string }> = [];
  for (const t of threads) {
    const out = latestOutbound(t);
    if (out === null) continue;
    annotated.push({ t, outboundAt: out.received_at });
  }
  annotated.sort((a, b) => b.outboundAt.localeCompare(a.outboundAt));
  return annotated.map((x) => x.t);
}

// Split a raw `to:` header on commas. RFC 5322 allows quoted display
// names containing commas, but the BFF persists the raw header verbatim
// and the operator-facing column doesn't need bullet-proof parsing —
// `senderDisplay()` already tolerates the noise. A future helper can
// upgrade this to a real address-list parser if multi-recipient sends
// with quoted commas show up in practice.
function splitRecipients(to: string): string[] {
  const out: string[] = [];
  for (const piece of to.split(",")) {
    const trimmed = piece.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}
