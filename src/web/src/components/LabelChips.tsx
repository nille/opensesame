import type { JSX } from "react";

interface LabelChipsProps {
  // Lowercased canonical label keys, already deduped + sorted by threading.
  labels: string[];
  // Catalog map from lowercased label → operator's chosen casing. The
  // chip falls back to the canonical key when the catalog hasn't loaded
  // yet so the row never renders blank during the first poll.
  displayNames: Map<string, string>;
  // Visible-cap variant. The inbox row gets first 2 + "+N"; the reader
  // header is generous enough to render the full set.
  variant: "row" | "header";
  // Click handler on a chip. The reader's chip click jumps to the label
  // view; the row's chip click is a no-op (chips are read-only summary).
  onClick?: (label: string) => void;
}

const ROW_VISIBLE = 2;
const TRUNCATE_AT = 12;

// ADR-0037 (slice 8.17). Read-only label summary rendered in two places:
// the inbox row's meta-strip and the reader header. Casing comes from the
// catalog (`display_name`); storage stays lowercased.
//
// The chip is deliberately neutral — labels are operator-defined content,
// not workflow state. Tinted state pills (snoozed / trashed / archived) keep
// their accent borders; this chip is the quiet ink-on-paper neighbor.
export function LabelChips({
  labels,
  displayNames,
  variant,
  onClick,
}: LabelChipsProps): JSX.Element | null {
  if (labels.length === 0) return null;

  const visible =
    variant === "row" ? labels.slice(0, ROW_VISIBLE) : labels;
  const overflow =
    variant === "row" ? Math.max(0, labels.length - ROW_VISIBLE) : 0;

  return (
    <span className="inbox-row__labels" role="list" aria-label="labels">
      {visible.map((l) => {
        const display = displayNames.get(l) ?? l;
        const truncated =
          display.length > TRUNCATE_AT
            ? display.slice(0, TRUNCATE_AT - 1) + "…"
            : display;
        const Tag = onClick ? "button" : "span";
        return (
          <Tag
            key={l}
            type={onClick ? "button" : undefined}
            className="inbox-row__label mono"
            title={display}
            role="listitem"
            onClick={
              onClick
                ? (e) => {
                    e.stopPropagation();
                    onClick(l);
                  }
                : undefined
            }
          >
            {truncated}
          </Tag>
        );
      })}
      {overflow > 0 ? (
        <span
          className="inbox-row__label inbox-row__label--more mono"
          title={labels
            .slice(ROW_VISIBLE)
            .map((l) => displayNames.get(l) ?? l)
            .join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
