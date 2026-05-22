import { useEffect, useRef, type JSX } from "react";
import type { Thread } from "../lib/threading.ts";
import {
  formatRowTimestamp,
  senderDisplay,
  shortMessageId,
} from "../lib/format.ts";
import { formatSnoozedUntil } from "../lib/snooze-presets.ts";
import { StarButton } from "./Star.tsx";
import { SnoozeButton } from "./Snooze.tsx";

interface InboxListProps {
  threads: Thread[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  loading: boolean;
  offline: boolean;
  searchActive?: boolean;
  // Slice 8.10 (ADR-0028). Optimistic-pending intent map keyed by rootKey.
  // When a row's rootKey is in the map, the value (true|false) is the
  // operator's intended next state and renders as if the toggle has
  // already succeeded; the row's true `starred` returns to authority once
  // the next inbox poll lands and the entry is dropped from the map.
  pendingStars: Map<string, boolean>;
  onToggleStar: (rootKey: string, next: boolean) => void;
  // Slice 8.11 (ADR-0029). Same shape as pendingStars, but the value is
  // either an ISO wake-time (snoozing) or null (unsnoozing). Drives the
  // optimistic snooze indicator + meta-strip footer.
  pendingSnoozes: Map<string, string | null>;
  onPickSnooze: (rootKey: string, snoozedUntil: string | null) => void;
}

// Triage-fast inbox: one row per conversation (slice 8.5, ADR-0023). The
// lead is the latest message; senders + count chip surface the rest. j/k
// moves through threads, not individual messages.

export function InboxList({
  threads,
  selectedIdx,
  onSelect,
  loading,
  offline,
  searchActive = false,
  pendingStars,
  onToggleStar,
  pendingSnoozes,
  onPickSnooze,
}: InboxListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-idx="${selectedIdx}"]`,
    );
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (loading && threads.length === 0) {
    return (
      <div className="inbox-list">
        <div className="inbox-list__skeletons">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="inbox-row inbox-row--skel" />
          ))}
        </div>
      </div>
    );
  }

  if (threads.length === 0) {
    const empty = offline
      ? "0 messages · BFF unreachable"
      : searchActive
        ? "0 results · try a different query"
        : "0 messages · waiting for new mail";
    return (
      <div className="inbox-list">
        <div className="inbox-list__empty mono faint">{empty}</div>
      </div>
    );
  }

  return (
    <div className="inbox-list" ref={listRef}>
      {threads.map((thread, idx) => {
        const selected = idx === selectedIdx;
        const lead = thread.rows[0];
        if (lead === undefined) {
          // Skeleton-only thread — failed parse row standing alone.
          const failed = thread.failedRows[0]!;
          return (
            <div
              key={thread.rootKey}
              data-idx={idx}
              className={
                "inbox-row inbox-row--failed" +
                (selected ? " inbox-row--selected" : "")
              }
              onClick={() => onSelect(idx)}
              role="button"
              tabIndex={-1}
            >
              <div className="inbox-row__gutter">
                <span className="inbox-row__dot inbox-row__dot--danger" />
              </div>
              <div className="inbox-row__main">
                <div className="inbox-row__top">
                  <span className="inbox-row__sender">{failed.address}</span>
                  <span className="inbox-row__time mono faint">
                    {formatRowTimestamp(failed.received_at)}
                  </span>
                </div>
                <div className="inbox-row__subject">(parse failed)</div>
                <div className="inbox-row__meta mono faint">
                  {failed.internal_id.slice(0, 14)}
                </div>
              </div>
            </div>
          );
        }

        const subject = lead.subject ?? "(no subject)";
        const senderLine = renderSenders(thread.senders);
        const messageIdExcerpt = shortMessageId(lead.message_id, 14);
        const showSentChip = lead.direction === "out";
        // Star + snooze can only be toggled on threads with a server-stamped
        // thread_id (rootKey starts with "<" — same gate as ThreadReader
        // expansion). Subject-fallback rollups have no stable handle to
        // address an UpdateItem fan-out against.
        const threadable = thread.rootKey.startsWith("<");
        const pending = pendingStars.get(thread.rootKey);
        const filled = pending ?? thread.starred;
        // Snooze: pending intent wins over server state for both the icon and
        // the meta-strip footer. A pending null (unsnooze) reads as not
        // snoozed, an ISO wake-time reads as snoozed-until-that-ISO.
        const pendingSnooze = pendingSnoozes.get(thread.rootKey);
        const snoozedUntil =
          pendingSnooze !== undefined ? pendingSnooze : thread.snoozedUntil;

        return (
          <div
            key={thread.rootKey}
            data-idx={idx}
            className={
              "inbox-row" + (selected ? " inbox-row--selected" : "")
            }
            onClick={() => onSelect(idx)}
            role="button"
            tabIndex={-1}
          >
            <div
              className={
                "inbox-row__gutter" +
                (filled ? " inbox-row__gutter--starred" : "") +
                (thread.unread && !filled ? " inbox-row__gutter--unread" : "")
              }
            >
              {/* Filled star always renders. Unstarred star renders too —
                  CSS hides it unless the row is hovered or the thread is
                  unread (so the dot can swap to a star on hover). */}
              {thread.unread && !filled ? (
                <span className="inbox-row__dot" aria-hidden />
              ) : null}
              <StarButton
                filled={filled}
                pending={pending !== undefined}
                disabled={!threadable}
                variant="gutter"
                stopPropagation
                onToggle={(next) => onToggleStar(thread.rootKey, next)}
              />
              <SnoozeButton
                snoozedUntil={snoozedUntil}
                pending={pendingSnooze !== undefined}
                disabled={!threadable}
                variant="gutter"
                stopPropagation
                onPickPreset={(next) => onPickSnooze(thread.rootKey, next)}
              />
            </div>
            <div className="inbox-row__main">
              <div className="inbox-row__top">
                <span className="inbox-row__sender">{senderLine}</span>
                <span className="inbox-row__time mono faint">
                  {formatRowTimestamp(thread.latestReceivedAt)}
                </span>
              </div>
              <div className="inbox-row__subject">{subject}</div>
              <div className="inbox-row__meta mono faint">
                {messageIdExcerpt}
                {thread.count > 1 ? (
                  <span className="inbox-row__chip mono"> {thread.count}</span>
                ) : null}
                {showSentChip ? (
                  <span className="inbox-row__chip mono"> sent</span>
                ) : null}
                {snoozedUntil !== null ? (
                  <span className="inbox-row__chip inbox-row__chip--snoozed mono">
                    {" "}
                    snoozed · {formatSnoozedUntil(snoozedUntil)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Up to three names from senders, latest first, with `+N` when truncated.
// Falls back to the lead's raw sender display when the thread has no
// extractable names (e.g. a single message from a malformed `From:`).
function renderSenders(senders: string[]): string {
  if (senders.length === 0) return senderDisplay(null);
  if (senders.length <= 3) return senders.join(", ");
  const head = senders.slice(0, 3).join(", ");
  return `${head}, +${senders.length - 3}`;
}
