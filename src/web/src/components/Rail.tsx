import { useState, type ChangeEvent, type JSX, type KeyboardEvent, type Ref } from "react";
import type { Theme } from "../hooks/useTheme.ts";
import { formatPolledAt } from "../lib/format.ts";

export type RailView =
  | "inbox"
  | "sent"
  | "starred"
  | "snoozed"
  | "trashed"
  | "archived"
  | "drafts"
  // ADR-0037 (slice 8.17). Operator-defined label view. The label is
  // the canonical lowercased catalog key; the rail renders the
  // catalog's display_name.
  | { kind: "label"; label: string };

// ADR-0037 (slice 8.17). One row per catalog entry rendered in the
// rail's labels section. Display name is the operator's chosen casing;
// `label` stays lowercased for identity comparisons.
export interface RailLabel {
  label: string;
  display_name: string;
  count: number;
}

// Visible-cap for the rail labels section. Above this count the
// remainder collapses behind a "more (N)" toggle. The cap matches the
// design budget (~20 visible) and keeps the rail from drowning the
// fixed-view rows below.
const LABELS_VISIBLE_CAP = 20;

interface RailProps {
  mailbox: string;
  theme: Theme;
  onToggleTheme: () => void;
  lastPolledAt: string | null;
  offline: boolean;
  onCompose: () => void;
  view: RailView;
  onChangeView: (view: RailView) => void;
  inboxCount: number;
  sentCount: number;
  // ADR-0028 (slice 8.10): count of threads with any starred row in the
  // currently-loaded inbox window. Hidden when zero — the entry is a
  // recall affordance, not a feature advert.
  starredCount: number;
  // ADR-0029 (slice 8.11): count of threads currently snoozed (every row
  // unexpired). Hidden when zero — same reasoning as starredCount.
  snoozedCount: number;
  // ADR-0030 (slice 8.12): count of trashed threads in the inbox window.
  // Hidden when zero — same reasoning as starredCount/snoozedCount.
  trashedCount: number;
  // ADR-0034 (slice 8.16): count of archived threads in the inbox window.
  // Hidden when zero — same reasoning as starredCount/snoozedCount/trashedCount.
  archivedCount: number;
  // ADR-0035 (slice 8.17): count of saved drafts. Drafts are auto-saved on
  // a 1500ms debounce in the composer; the count flickers as the operator
  // types. Hidden when zero — same reasoning as the other annotation counts.
  draftsCount: number;
  // ADR-0037 (slice 8.17). Catalog entries with their thread counts,
  // sorted by the caller (Rail just renders). Empty list elides the
  // section entirely; the picker (l) is the way to add the first one.
  labels: RailLabel[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef?: Ref<HTMLInputElement>;
  searching: boolean;
  searchHitCount: number | null;
  // ADR-0036 (slice 8.17): server-side parser error surfaced inline.
  // Non-null when the BFF returned 400 invalid_request for the search
  // query — we keep the input visible (the operator is still typing) but
  // replace the hit-count line with the parser message so they can fix
  // the token instead of staring at "no results yet".
  searchError: string | null;
  onSearchKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

// The rail isn't a sidebar with a logo. It's a path bar plus the views
// the operator switches between, plus compose + theme. Drafts land in
// slice 8.1 (the BFF doesn't expose them yet).

export function Rail({
  mailbox,
  theme,
  onToggleTheme,
  lastPolledAt,
  offline,
  onCompose,
  view,
  onChangeView,
  inboxCount,
  sentCount,
  starredCount,
  snoozedCount,
  trashedCount,
  archivedCount,
  draftsCount,
  labels,
  searchQuery,
  onSearchChange,
  searchInputRef,
  searching,
  searchHitCount,
  searchError,
  onSearchKeyDown,
}: RailProps): JSX.Element {
  const searchActive = searchQuery.length > 0;
  const isLabelView = typeof view === "object";
  const labelDisplayName = isLabelView
    ? labels.find((l) => l.label === view.label)?.display_name ?? view.label
    : null;
  const title = searchActive
    ? "~/search"
    : isLabelView
      ? `~/${labelDisplayName}`
      : view === "inbox"
        ? "~/inbox"
        : view === "starred"
          ? "~/starred"
          : view === "snoozed"
            ? "~/snoozed"
            : view === "trashed"
              ? "~/trash"
              : view === "archived"
                ? "~/archive"
                : view === "drafts"
                  ? "~/drafts"
                  : "~/sent";
  const [labelsExpanded, setLabelsExpanded] = useState(false);
  const visibleLabels = labelsExpanded
    ? labels
    : labels.slice(0, LABELS_VISIBLE_CAP);
  const hiddenLabelCount = Math.max(0, labels.length - LABELS_VISIBLE_CAP);
  return (
    <aside className="rail">
      <div className="rail__head">
        <div className="rail__title mono">
          {title}
          {offline ? <span className="rail__offline mono"> · offline</span> : null}
        </div>
        <div className="rail__mailbox mono faint">{mailbox}</div>
      </div>

      <div
        className={
          "rail__search" + (searching ? " rail__search--searching" : "")
        }
      >
        <span className="rail__search-prompt mono" aria-hidden>
          /
        </span>
        <input
          ref={searchInputRef}
          type="search"
          className="rail__search-input mono"
          placeholder="search · from: subject: is:unread …"
          value={searchQuery}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onSearchChange(e.target.value)
          }
          onKeyDown={onSearchKeyDown}
          aria-label="Search messages"
          aria-busy={searching}
          spellCheck={false}
          autoComplete="off"
        />
        {searchActive ? (
          <button
            type="button"
            className="rail__search-clear mono faint"
            onClick={() => onSearchChange("")}
            aria-label="Clear search"
            title="Clear (esc)"
          >
            ×
          </button>
        ) : null}
        {searching ? (
          <span className="rail__search-progress" aria-hidden />
        ) : null}
      </div>
      {searchActive ? (
        <div
          className={
            "rail__search-status mono" +
            (searchError !== null
              ? " rail__search-status--error"
              : " faint" + (searching ? " rail__search-status--pulse" : ""))
          }
          role={searchError !== null ? "alert" : "status"}
          aria-live="polite"
        >
          {searchError !== null
            ? searchError
            : searching
              ? "searching…"
              : searchHitCount === null
                ? "no results yet"
                : `${searchHitCount} ${searchHitCount === 1 ? "hit" : "hits"}`}
        </div>
      ) : null}

      <nav className="rail__nav" aria-hidden={searchActive}>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "inbox" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("inbox")}
        >
          <span>inbox</span>
          <span className="mono faint">{inboxCount}</span>
        </button>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "starred" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("starred")}
        >
          <span>starred</span>
          <span className="mono faint">
            {starredCount === 0 ? "—" : starredCount}
          </span>
        </button>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "snoozed" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("snoozed")}
        >
          <span>snoozed</span>
          <span className="mono faint">
            {snoozedCount === 0 ? "—" : snoozedCount}
          </span>
        </button>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "sent" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("sent")}
        >
          <span>sent</span>
          <span className="mono faint">{sentCount}</span>
        </button>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "trashed" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("trashed")}
        >
          <span>trash</span>
          <span className="mono faint">
            {trashedCount === 0 ? "—" : trashedCount}
          </span>
        </button>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "archived" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("archived")}
        >
          <span>archive</span>
          <span className="mono faint">
            {archivedCount === 0 ? "—" : archivedCount}
          </span>
        </button>
        <button
          type="button"
          className={
            "rail__navitem" +
            (view === "drafts" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("drafts")}
        >
          <span>drafts</span>
          <span className="mono faint">
            {draftsCount === 0 ? "—" : draftsCount}
          </span>
        </button>

        {labels.length > 0 ? (
          <>
            <div
              className="rail__section-head mono faint"
              aria-hidden
            >
              labels
            </div>
            {visibleLabels.map((l) => {
              const active = isLabelView && view.label === l.label;
              return (
                <button
                  key={l.label}
                  type="button"
                  className={
                    "rail__navitem" +
                    (active ? " rail__navitem--active" : "")
                  }
                  onClick={() =>
                    onChangeView({ kind: "label", label: l.label })
                  }
                  title={l.display_name}
                >
                  <span className="rail__navitem-label">
                    {l.display_name}
                  </span>
                  <span className="mono faint">
                    {l.count === 0 ? "—" : l.count}
                  </span>
                </button>
              );
            })}
            {hiddenLabelCount > 0 ? (
              <button
                type="button"
                className="rail__navitem rail__navitem--more mono faint"
                onClick={() => setLabelsExpanded((v) => !v)}
                aria-expanded={labelsExpanded}
              >
                <span>
                  {labelsExpanded ? "fewer" : `more (${hiddenLabelCount})`}
                </span>
                <span aria-hidden>{labelsExpanded ? "↑" : "↓"}</span>
              </button>
            ) : null}
          </>
        ) : null}
      </nav>

      <div className="rail__spacer" />

      <button className="rail__compose" onClick={onCompose}>
        <span>Compose</span>
        <span className="mono faint">c</span>
      </button>

      <div className="rail__foot">
        <button
          className="rail__themetoggle"
          onClick={onToggleTheme}
          aria-label={theme === "day" ? "Switch to night" : "Switch to day"}
          title={theme === "day" ? "Switch to night (t)" : "Switch to day (t)"}
        >
          {theme === "day" ? <MoonIcon /> : <SunIcon />}
        </button>
        <div className="rail__polled mono faint">
          {lastPolledAt
            ? `polled ${formatPolledAt(lastPolledAt)}`
            : "polling…"}
        </div>
      </div>
    </aside>
  );
}

// Line icons drawn at 16px so they sit on the same baseline as the
// 12px mono text in the foot. 1.5px stroke balances against Inter at
// these sizes — thinner reads as broken on hi-dpi.
function SunIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="3" />
      <line x1="8" y1="1.5" x2="8" y2="3" />
      <line x1="8" y1="13" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="3" y2="8" />
      <line x1="13" y1="8" x2="14.5" y2="8" />
      <line x1="3.4" y1="3.4" x2="4.5" y2="4.5" />
      <line x1="11.5" y1="11.5" x2="12.6" y2="12.6" />
      <line x1="3.4" y1="12.6" x2="4.5" y2="11.5" />
      <line x1="11.5" y1="4.5" x2="12.6" y2="3.4" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
  );
}
