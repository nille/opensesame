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
import { TrashButton } from "./Trash.tsx";
import { ArchiveButton } from "./Archive.tsx";
import { MarkReadButton } from "./MarkRead.tsx";
import { LabelChips } from "./LabelChips.tsx";

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
  // Slice 8.12 (ADR-0030). Boolean toggle, same shape as pendingStars —
  // pending intent wins over server `trashed` for the icon and chip.
  pendingTrashes: Map<string, boolean>;
  onToggleTrash: (rootKey: string, next: boolean) => void;
  // Slice 8.16 (ADR-0034). Same shape as pendingTrashes; archive is an
  // independent attribute, so the pending map is its own.
  pendingArchives: Map<string, boolean>;
  onToggleArchive: (rootKey: string, next: boolean) => void;
  // Slice 8.13 (ADR-0031). Pending read intent map. The value stored is the
  // *target* read state (true = "marking read", false = "marking unread"),
  // so the unread dot/badge can flip optimistically before the RPC settles.
  pendingReads: Map<string, boolean>;
  onToggleRead: (rootKey: string, next: boolean) => void;
  // Slice 8.14 (ADR-0032). Bulk multi-select. Membership is checked per
  // row; the checkbox renders selected/disabled state from this set.
  // Subject-fallback rollups (rootKey not starting with "<") render the
  // checkbox disabled and are silently skipped on Shift+click range
  // expansion.
  selection: Set<string>;
  onToggleSelection: (rootKey: string, withShift: boolean) => void;
  // Slice 8.15 (ADR-0033). Master "select all in view" handler. Click
  // semantics live in App.tsx — this is just the UI surface. The
  // header row reads `selection` + `threads` to compute its tri-state
  // visual.
  onToggleSelectAll: () => void;
  // Selection mode: when at least one thread is bulk-selected, plain
  // clicks on a row toggle membership instead of opening the reader.
  // Esc / clear-selection exits the mode and restores click-to-read.
  selectionActive: boolean;
  // Slice 8.17 (ADR-0037). Pending-label deltas per thread. The list
  // overlays them on `thread.labels` to compute the chip set so
  // freshly-toggled labels appear / disappear before the next inbox
  // poll lands.
  pendingLabels: Map<string, { add: Set<string>; remove: Set<string> }>;
  // Lowercased canonical label → operator's chosen casing. The chip
  // falls back to the lowercased key when the catalog hasn't loaded yet.
  labelDisplayNames: Map<string, string>;
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
  pendingTrashes,
  onToggleTrash,
  pendingArchives,
  onToggleArchive,
  pendingReads,
  onToggleRead,
  selection,
  onToggleSelection,
  onToggleSelectAll,
  selectionActive,
  pendingLabels,
  labelDisplayNames,
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
      <SelectAllHeader
        threads={threads}
        selection={selection}
        onToggle={onToggleSelectAll}
      />
      {threads.map((thread, idx) => {
        const focused = idx === selectedIdx;
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
                (focused ? " inbox-row--selected" : "")
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
        // Trash: pending intent wins over server state, same posture as star.
        const pendingTrash = pendingTrashes.get(thread.rootKey);
        const trashFilled = pendingTrash ?? thread.trashed;
        // Archive: independent attribute, same pending pattern as trash.
        const pendingArchive = pendingArchives.get(thread.rootKey);
        const archiveFilled = pendingArchive ?? thread.archived;
        // Read: the map stores the *target* read state, so a pending entry
        // flips the unread bit immediately. When the entry is `true` (mark
        // read), the dot disappears; when `false` (mark unread), the dot
        // re-appears. Any thread without inbound rows can never be unread.
        const hasInbound = thread.rows.some((r) => r.direction === "in");
        const pendingRead = pendingReads.get(thread.rootKey);
        const unreadFilled =
          pendingRead !== undefined ? !pendingRead : thread.unread;
        // Slice 8.14. Bulk-select membership; subject-fallback rollups
        // are gated out (same as the annotation buttons).
        const checked = selection.has(thread.rootKey);
        // Slice 8.17 (ADR-0037). Overlay pending-label deltas on the
        // thread's server-aggregated labels so the chip strip flickers
        // in real time as the operator toggles. Identity is the
        // lowercased canonical key throughout.
        const labelDelta = pendingLabels.get(thread.rootKey);
        const effectiveLabels =
          labelDelta === undefined
            ? thread.labels
            : Array.from(
                (() => {
                  const s = new Set<string>(thread.labels);
                  for (const l of labelDelta.add) s.add(l);
                  for (const l of labelDelta.remove) s.delete(l);
                  return s;
                })(),
              ).sort((a, b) => a.localeCompare(b));

        return (
          <div
            key={thread.rootKey}
            data-idx={idx}
            className={
              "inbox-row" +
              (focused ? " inbox-row--selected" : "") +
              (checked ? " inbox-row--checked" : "")
            }
            onClick={(e) => {
              // Selection-mode: once at least one row is selected, plain
              // clicks toggle membership. Escape / clear-selection exits
              // the mode and restores click-to-read. Shift+click always
              // toggles + range-extends regardless of mode.
              if (e.shiftKey && threadable) {
                e.preventDefault();
                onToggleSelection(thread.rootKey, true);
                return;
              }
              if (selectionActive && threadable) {
                e.preventDefault();
                onToggleSelection(thread.rootKey, false);
                return;
              }
              onSelect(idx);
            }}
            role="button"
            tabIndex={-1}
            aria-pressed={checked}
          >
            {/* Left gutter: just the unread dot. Star moved to the
                right rail under the timestamp so its on/off state lives
                with the row's other temporal metadata (when it arrived,
                whether it's marked). The 2x2 action grid (snooze /
                trash / archive / mark-read) sits below the dot. */}
            <div className="inbox-row__gutter">
              {unreadFilled ? (
                <span className="inbox-row__dot" aria-hidden />
              ) : null}
              <div className="inbox-row__gutter-actions">
                <SnoozeButton
                  snoozedUntil={snoozedUntil}
                  pending={pendingSnooze !== undefined}
                  disabled={!threadable}
                  variant="gutter"
                  size={12}
                  stopPropagation
                  onPickPreset={(next) => onPickSnooze(thread.rootKey, next)}
                />
                <TrashButton
                  filled={trashFilled}
                  pending={pendingTrash !== undefined}
                  disabled={!threadable}
                  variant="gutter"
                  size={12}
                  stopPropagation
                  onToggle={(next) => onToggleTrash(thread.rootKey, next)}
                />
                <ArchiveButton
                  filled={archiveFilled}
                  pending={pendingArchive !== undefined}
                  disabled={!threadable}
                  variant="gutter"
                  size={12}
                  stopPropagation
                  onToggle={(next) => onToggleArchive(thread.rootKey, next)}
                />
                <MarkReadButton
                  unread={unreadFilled}
                  pending={pendingRead !== undefined}
                  disabled={!threadable || !hasInbound}
                  variant="gutter"
                  size={12}
                  stopPropagation
                  onToggle={(next) => onToggleRead(thread.rootKey, next)}
                />
              </div>
            </div>
            <div className="inbox-row__main">
              <div className="inbox-row__top">
                <span className="inbox-row__sender">{senderLine}</span>
                <span className="inbox-row__top-end">
                  <span className="inbox-row__time mono faint">
                    {formatRowTimestamp(thread.latestReceivedAt)}
                  </span>
                  <StarButton
                    filled={filled}
                    pending={pending !== undefined}
                    disabled={!threadable}
                    variant="gutter"
                    stopPropagation
                    onToggle={(next) => onToggleStar(thread.rootKey, next)}
                  />
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
                {trashFilled ? (
                  <span className="inbox-row__chip inbox-row__chip--trashed mono">
                    {" "}
                    trashed
                  </span>
                ) : null}
                {archiveFilled && !trashFilled ? (
                  <span className="inbox-row__chip inbox-row__chip--archived mono">
                    {" "}
                    archived
                  </span>
                ) : null}
                <LabelChips
                  labels={effectiveLabels}
                  displayNames={labelDisplayNames}
                  variant="row"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ADR-0033 (slice 8.15). Master select-all header. Tri-state visual
// drives off the count of threadable (server-stamped) rows in view vs.
// the count of selected rootKeys; subject-fallback rollups never
// participate, matching the per-row checkbox gate.
//
// React's controlled `checked` only models two states, so we flip the
// DOM `indeterminate` property imperatively via ref. This is the
// canonical pattern for tri-state checkboxes; keeping it in a tiny
// subcomponent isolates the imperative bit from the rest of the list.
interface SelectAllHeaderProps {
  threads: readonly Thread[];
  selection: Set<string>;
  onToggle: () => void;
}

function SelectAllHeader({
  threads,
  selection,
  onToggle,
}: SelectAllHeaderProps): JSX.Element | null {
  let total = 0;
  let picked = 0;
  for (const t of threads) {
    if (!t.rootKey.startsWith("<")) continue;
    total += 1;
    if (selection.has(t.rootKey)) picked += 1;
  }

  if (threads.length === 0) return null;

  // Count line. "N threads" when none picked, "M of N selected" otherwise.
  // Denominator is `total` (threadable rows), not threads.length —
  // the operator's question is "what would Shift+X select?".
  const label =
    picked === 0 ? `${total} threads` : `${picked} of ${total} selected`;

  const ariaLabel =
    picked > 0 ? "Deselect all threads in view" : "Select all threads in view";

  return (
    <button
      type="button"
      className="inbox-list__header"
      onClick={onToggle}
      disabled={total === 0}
      aria-label={ariaLabel}
      aria-pressed={picked > 0}
      title="Toggle select-all in view (Shift+X)"
    >
      <span className="inbox-list__header-count mono faint">{label}</span>
    </button>
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
