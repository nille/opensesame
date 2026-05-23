import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { LabelCatalogEntry } from "../lib/bff-client.ts";

// Tri-state of "is this label currently on the target(s)":
//   on    — every selected thread carries it
//   mixed — some carry, some don't (bulk only)
//   off   — none carry it
export type LabelPresence = "on" | "mixed" | "off";

interface LabelPickerProps {
  // Catalog rows, in the order returned by list_labels (created_at desc).
  catalog: LabelCatalogEntry[];
  // Lowercased keys that are pending in-flight on the target(s). Used to
  // dim rows during the optimistic flicker so an operator who toggles
  // twice in a row sees the second click was registered.
  pendingKeys: Set<string>;
  // Compute the presence state for a given lowercased label key against
  // the current target. Bulk-mode picker passes a function that walks
  // every selected thread; single-thread picker checks one rootKey.
  presenceOf: (label: string) => LabelPresence;
  // Toggle dispatch. The caller owns the optimistic delta map and the
  // RPC fan-out; this component just emits intent ("add this to all" /
  // "remove this from all"). `target` is the *next* presence state.
  onToggle: (label: string, target: "on" | "off") => void;
  // Create a new label catalog entry, then immediately apply it to the
  // target(s). The caller surfaces 409 silently by treating the
  // conflicting label as if the operator had picked it from the list.
  onCreate: (label: string) => Promise<void>;
  // Dismiss the picker. Called on Esc, click-outside, or
  // Cmd/Ctrl+Enter (the "I'm done" exit). The caller is responsible for
  // restoring focus to whatever opened the picker.
  onClose: () => void;
}

const MAX_LABEL_LEN = 32;

// ADR-0037 (slice 8.17). Anchor-positioned picker — not a modal. Backdrop
// would imply "modal," which the strategic principles ban for surfaces that
// have a pane. The page stays interactive in the periphery; click outside
// dismisses via the caller's outside-click ref.
export function LabelPicker({
  catalog,
  pendingKeys,
  presenceOf,
  onToggle,
  onCreate,
  onClose,
}: LabelPickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmedQuery = query.trim();
  const queryLower = trimmedQuery.toLowerCase();

  // Filter catalog by case-insensitive substring match on display_name OR
  // canonical key. The list keeps the catalog's created_at ordering so the
  // operator's most recent labels surface first by default.
  const filtered = useMemo(() => {
    if (queryLower === "") return catalog;
    return catalog.filter(
      (e) =>
        e.label.toLowerCase().includes(queryLower) ||
        e.display_name.toLowerCase().includes(queryLower),
    );
  }, [catalog, queryLower]);

  // The "+ create" pseudo-row appears when the trimmed query is non-empty,
  // doesn't exact-match an existing entry, and parses as a valid label name.
  // Validation mirrors the BFF (1-32 chars, no commas, no controls); we
  // keep it client-side so the picker can hide the affordance instead of
  // letting the operator hit Enter and watch a 400 land.
  const canCreate =
    trimmedQuery !== "" &&
    isValidLabelName(trimmedQuery) &&
    !catalog.some((e) => e.label.toLowerCase() === queryLower);

  // Total navigable rows = filtered + (create row if shown). Cursor is
  // clamped to the active list size on every render so a query that
  // shortens the list doesn't park the cursor off the end.
  const totalRows = filtered.length + (canCreate ? 1 : 0);
  const safeCursor = totalRows === 0 ? 0 : Math.min(cursor, totalRows - 1);

  useEffect(() => {
    setCursor(0);
  }, [queryLower]);

  const commitCursor = useCallback(
    (closeAfter: boolean): void => {
      if (totalRows === 0) return;
      // Create row sits at the end of the list when present.
      if (canCreate && safeCursor === filtered.length) {
        void onCreate(trimmedQuery).then(() => {
          setQuery("");
          if (closeAfter) onClose();
        });
        return;
      }
      const row = filtered[safeCursor];
      if (row === undefined) return;
      const presence = presenceOf(row.label);
      // "on" → operator wants it off; "off" / "mixed" → operator wants
      // it on. The bulk picker resolves "mixed" toward add-to-all (see
      // ADR-0037 Implementation §4) so a half-applied label stays in
      // the operator's eyeline as a single "applied to all" click.
      const target: "on" | "off" = presence === "on" ? "off" : "on";
      onToggle(row.label, target);
      if (closeAfter) onClose();
    },
    [
      canCreate,
      filtered,
      onClose,
      onCreate,
      onToggle,
      presenceOf,
      safeCursor,
      totalRows,
      trimmedQuery,
    ],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => (totalRows === 0 ? 0 : (c + 1) % totalRows));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) =>
          totalRows === 0 ? 0 : (c - 1 + totalRows) % totalRows,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        commitCursor(e.metaKey || e.ctrlKey);
        return;
      }
    },
    [commitCursor, onClose, totalRows],
  );

  return (
    <div
      className="label-picker"
      role="dialog"
      aria-label="Label picker"
      // Stop bubbling so clicks inside the picker don't trigger the
      // outside-click dismiss the caller wires up on the parent.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="label-picker__head">
        <input
          ref={inputRef}
          type="text"
          className="label-picker__input mono"
          placeholder="search labels"
          value={query}
          maxLength={MAX_LABEL_LEN}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            setQuery(e.target.value)
          }
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search or create labels"
        />
      </div>
      <ul
        className="label-picker__list"
        role="listbox"
        aria-activedescendant={
          totalRows > 0 ? `label-picker-row-${safeCursor}` : undefined
        }
      >
        {filtered.length === 0 && !canCreate ? (
          <li className="label-picker__empty mono faint">
            {catalog.length === 0 ? "no labels yet" : "no matches"}
          </li>
        ) : null}
        {filtered.map((entry, idx) => {
          const presence = presenceOf(entry.label);
          const pending = pendingKeys.has(entry.label);
          const focused = idx === safeCursor;
          return (
            <li
              key={entry.label}
              id={`label-picker-row-${idx}`}
              role="option"
              aria-selected={focused}
              className={
                "label-picker__row" +
                (focused ? " label-picker__row--focused" : "") +
                (pending ? " label-picker__row--pending" : "")
              }
              onMouseEnter={() => setCursor(idx)}
              onClick={(e) => {
                const closeAfter = e.metaKey || e.ctrlKey;
                const target: "on" | "off" = presence === "on" ? "off" : "on";
                onToggle(entry.label, target);
                if (closeAfter) onClose();
              }}
            >
              <span
                className="label-picker__gutter mono"
                aria-hidden
                data-presence={presence}
              >
                {presence === "on" ? "✓" : presence === "mixed" ? "–" : ""}
              </span>
              <span className="label-picker__name">
                {entry.display_name}
              </span>
            </li>
          );
        })}
        {canCreate ? (
          <li
            id={`label-picker-row-${filtered.length}`}
            role="option"
            aria-selected={safeCursor === filtered.length}
            className={
              "label-picker__row label-picker__row--create" +
              (safeCursor === filtered.length
                ? " label-picker__row--focused"
                : "")
            }
            onMouseEnter={() => setCursor(filtered.length)}
            onClick={(e) => {
              const closeAfter = e.metaKey || e.ctrlKey;
              void onCreate(trimmedQuery).then(() => {
                setQuery("");
                if (closeAfter) onClose();
              });
            }}
          >
            <span className="label-picker__gutter mono" aria-hidden>
              +
            </span>
            <span className="label-picker__name">
              create &ldquo;{trimmedQuery}&rdquo;
            </span>
          </li>
        ) : null}
      </ul>
      <div className="label-picker__foot mono faint">
        enter toggle · ⌘↩ close · esc cancel
      </div>
    </div>
  );
}

// Mirror of the BFF's parseLabelName (src/bff/schemas.ts). Keeping this
// validator client-side hides the "+ create" affordance for inputs that
// would 400 on the wire — the operator never sees a server error for a
// problem the form already knew about.
function isValidLabelName(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_LABEL_LEN) return false;
  if (trimmed.includes(",")) return false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
