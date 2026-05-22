import type { ChangeEvent, JSX, KeyboardEvent, Ref } from "react";
import type { Theme } from "../hooks/useTheme.ts";
import { formatPolledAt } from "../lib/format.ts";

export type RailView = "inbox" | "sent";

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
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef?: Ref<HTMLInputElement>;
  searching: boolean;
  searchHitCount: number | null;
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
  searchQuery,
  onSearchChange,
  searchInputRef,
  searching,
  searchHitCount,
  onSearchKeyDown,
}: RailProps): JSX.Element {
  const searchActive = searchQuery.length > 0;
  const title = searchActive
    ? "~/search"
    : view === "inbox"
      ? "~/inbox"
      : "~/sent";
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
          placeholder="search"
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
            "rail__search-status mono faint" +
            (searching ? " rail__search-status--pulse" : "")
          }
          role="status"
          aria-live="polite"
        >
          {searching
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
            (view === "sent" ? " rail__navitem--active" : "")
          }
          onClick={() => onChangeView("sent")}
        >
          <span>sent</span>
          <span className="mono faint">{sentCount}</span>
        </button>
        <div
          className="rail__navitem rail__navitem--disabled"
          title="Slice 8.1"
        >
          <span>drafts</span>
          <span className="mono faint">—</span>
        </div>
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
