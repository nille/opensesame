import type { JSX, MouseEvent } from "react";

// Star affordance for slice 8.10 (ADR-0028). Two visual states sharing one
// 16-viewbox path so the row gutter and reader header read identically.
//
// The component is a button; the parent owns the on/off state and the RPC
// call. We deliberately don't animate the toggle — the project's motion
// budget is reserved for state changes that need a felt narrative (theme
// switch, reader open). A star toggle is the kind of action operators do
// many times a minute; choreography there would be noise.

interface StarButtonProps {
  filled: boolean;
  // Pending optimistic toggle target — when set, the icon renders as if the
  // toggle has succeeded but the rail's polled-line surfaces a faint cue.
  // null means "no pending request."
  pending: boolean;
  // True when the thread has no server-stamped thread_id yet (legacy /
  // subject-fallback rollups). In that case the affordance renders disabled
  // — star is a server-side property, and there's nothing yet to mark.
  disabled: boolean;
  // Optional explicit label override; defaults to "Star"/"Unstar".
  ariaLabel?: string;
  size?: number;
  onToggle: (next: boolean) => void;
  // Caller's affordance variant. The gutter star sits inside a clickable
  // inbox row, so we stop propagation; the reader-header variant doesn't.
  stopPropagation?: boolean;
  // Visual variant — `gutter` is the inbox-row icon; `header` is the reader.
  variant: "gutter" | "header";
}

export function StarButton({
  filled,
  pending,
  disabled,
  ariaLabel,
  size = 14,
  onToggle,
  stopPropagation = false,
  variant,
}: StarButtonProps): JSX.Element {
  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (stopPropagation) e.stopPropagation();
    if (disabled) return;
    onToggle(!filled);
  };
  const label =
    ariaLabel ??
    (disabled
      ? "Cannot star — thread has no server thread id yet"
      : filled
        ? "Unstar thread"
        : "Star thread");
  const cls =
    "star star--" +
    variant +
    (filled ? " star--on" : "") +
    (pending ? " star--pending" : "") +
    (disabled ? " star--disabled" : "");
  const tip = disabled ? label : filled ? "Unstar (s)" : "Star (s)";
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
      <StarIcon filled={filled} size={size} />
    </button>
  );
}

function StarIcon({
  filled,
  size,
}: {
  filled: boolean;
  size: number;
}): JSX.Element {
  // Five-point star centered in a 16-viewbox, matching Sun/Moon icons.
  // 1.5px stroke; fill flips on `filled`.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 1.7 10.06 5.85 14.6 6.5 11.3 9.7 12.1 14.2 8 12.1 3.9 14.2 4.7 9.7 1.4 6.5 5.94 5.85 Z" />
    </svg>
  );
}
