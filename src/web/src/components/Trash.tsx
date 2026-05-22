import type { JSX, MouseEvent } from "react";

// Trash affordance for slice 8.12 (ADR-0030). Mirrors StarButton: two
// visual states sharing one 16-viewbox path so the row gutter and reader
// header read identically.
//
// Same posture as star — no animated toggle; trashing is a frequent,
// repeatable action. The parent owns the on/off state and the RPC call;
// the button is purely presentational.

interface TrashButtonProps {
  filled: boolean;
  // Pending optimistic toggle target — when set, the icon renders as if the
  // toggle has succeeded but the rail's polled line surfaces a faint cue.
  pending: boolean;
  // True when the thread has no server-stamped thread_id yet (legacy /
  // subject-fallback rollups). In that case the affordance renders disabled
  // — trash is a server-side property, and there's nothing yet to mark.
  disabled: boolean;
  // Optional explicit label override; defaults to "Trash"/"Untrash".
  ariaLabel?: string;
  size?: number;
  onToggle: (next: boolean) => void;
  // Caller's affordance variant. The gutter trash sits inside a clickable
  // inbox row, so we stop propagation; the reader-header variant doesn't.
  stopPropagation?: boolean;
  // Visual variant — `gutter` is the inbox-row icon; `header` is the reader.
  variant: "gutter" | "header";
}

export function TrashButton({
  filled,
  pending,
  disabled,
  ariaLabel,
  size = 14,
  onToggle,
  stopPropagation = false,
  variant,
}: TrashButtonProps): JSX.Element {
  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (stopPropagation) e.stopPropagation();
    if (disabled) return;
    onToggle(!filled);
  };
  const label =
    ariaLabel ??
    (disabled
      ? "Cannot trash — thread has no server thread id yet"
      : filled
        ? "Untrash thread"
        : "Trash thread");
  const cls =
    "trash trash--" +
    variant +
    (filled ? " trash--on" : "") +
    (pending ? " trash--pending" : "") +
    (disabled ? " trash--disabled" : "");
  const tip = disabled ? label : filled ? "Untrash (#)" : "Trash (#)";
  const isGutter = variant === "gutter";
  return (
    <button
      type="button"
      className={cls}
      onClick={handleClick}
      aria-pressed={filled}
      aria-label={label}
      title={isGutter ? undefined : tip}
      data-tooltip={isGutter ? tip : undefined}
      disabled={disabled}
    >
      <TrashIcon filled={filled} size={size} />
    </button>
  );
}

function TrashIcon({
  filled,
  size,
}: {
  filled: boolean;
  size: number;
}): JSX.Element {
  // Trashcan in a 16-viewbox, sized to match Star/Snooze. Lid + body +
  // two vertical hash lines. 1.5px stroke; fill flips on `filled`.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3 4 H13" />
      <path d="M6.5 4 V2.5 H9.5 V4" />
      <path d="M4.2 4 L5 13.5 H11 L11.8 4 Z" />
      {!filled ? (
        <>
          <path d="M7 6.5 V11.5" />
          <path d="M9 6.5 V11.5" />
        </>
      ) : null}
    </svg>
  );
}
