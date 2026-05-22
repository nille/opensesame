import type { JSX } from "react";
import { StarButton } from "./Star.tsx";
import { TrashButton } from "./Trash.tsx";
import { ArchiveButton } from "./Archive.tsx";
import { MarkReadButton } from "./MarkRead.tsx";
import { SnoozeButton } from "./Snooze.tsx";

// ADR-0032 (slice 8.14). Bulk action bar — renders above the inbox list
// when the operator has at least one thread selected. Reuses the four
// existing icon buttons (StarButton / SnoozeButton / TrashButton /
// MarkReadButton) in their `header` variant so the visual language
// matches the reader header set; the bar is conceptually "the reader
// header for a virtual selection of threads".
//
// Each button's `onClick` fans out across the selection in App.tsx via
// the bulkApply helper, which calls the existing per-thread handlers.
// Disambiguation between Star All / Unstar All (and Trash / Mark Read
// pairs) lives in App.tsx — the bar is a dumb pass-through that only
// flips the visible verb based on the predicates it's given.

interface BulkActionBarProps {
  count: number;
  // Predicate: every selected thread is currently starred. The Star
  // button shows a filled star + "Unstar All" affordance when true.
  allStarred: boolean;
  // Predicate: every selected thread is currently trashed.
  allTrashed: boolean;
  // Predicate: every selected thread is currently archived.
  allArchived: boolean;
  // Predicate: every selected thread has zero unread inbound rows.
  allRead: boolean;
  // Disable the mark-read affordance entirely when no selected thread
  // has inbound rows — outbound-only selections can't toggle read state.
  anyHasInbound: boolean;
  // SnoozeButton is controlled here so the bar can close its picker
  // declaratively (Esc / clear-selection both close the bar without
  // leaving an orphaned popover).
  snoozePickerOpen: boolean;
  onSnoozePickerOpenChange: (open: boolean) => void;
  onClear: () => void;
  onStarAll: () => void;
  onTrashAll: () => void;
  onArchiveAll: () => void;
  onMarkReadAll: () => void;
  onPickSnooze: (snoozedUntil: string | null) => void;
}

export function BulkActionBar({
  count,
  allStarred,
  allTrashed,
  allArchived,
  allRead,
  anyHasInbound,
  snoozePickerOpen,
  onSnoozePickerOpenChange,
  onClear,
  onStarAll,
  onTrashAll,
  onArchiveAll,
  onMarkReadAll,
  onPickSnooze,
}: BulkActionBarProps): JSX.Element {
  const noun = count === 1 ? "thread" : "threads";
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-bar__count mono">
        {count} {noun} selected
      </div>
      <div className="bulk-bar__actions">
        <StarButton
          filled={allStarred}
          pending={false}
          disabled={false}
          variant="header"
          ariaLabel={allStarred ? "Unstar all selected" : "Star all selected"}
          onToggle={onStarAll}
        />
        <SnoozeButton
          // Bar's snooze affordance is always "pick a wake-time and
          // apply to every selected thread" — the bar doesn't track
          // "all snoozed" state because per-thread mixed snooze times
          // would render as a single chip on the bar that nobody can
          // interpret. Always-null snoozedUntil means the button reads
          // as "Snooze" not "Snoozed", which matches operator intent.
          snoozedUntil={null}
          pending={false}
          disabled={false}
          variant="header"
          ariaLabel="Snooze all selected"
          onPickPreset={onPickSnooze}
          controlledOpen={snoozePickerOpen}
          onOpenChange={onSnoozePickerOpenChange}
        />
        <TrashButton
          filled={allTrashed}
          pending={false}
          disabled={false}
          variant="header"
          ariaLabel={
            allTrashed ? "Untrash all selected" : "Trash all selected"
          }
          onToggle={onTrashAll}
        />
        <ArchiveButton
          filled={allArchived}
          pending={false}
          disabled={false}
          variant="header"
          ariaLabel={
            allArchived ? "Unarchive all selected" : "Archive all selected"
          }
          onToggle={onArchiveAll}
        />
        <MarkReadButton
          unread={!allRead}
          pending={false}
          disabled={!anyHasInbound}
          variant="header"
          ariaLabel={
            !anyHasInbound
              ? "Mark read disabled — no inbound rows in selection"
              : allRead
                ? "Mark all selected unread"
                : "Mark all selected read"
          }
          onToggle={onMarkReadAll}
        />
      </div>
      <button
        type="button"
        className="bulk-bar__clear mono faint"
        onClick={onClear}
        aria-label="Clear selection"
        title="Clear selection (Esc)"
      >
        clear · esc
      </button>
    </div>
  );
}
