import type { JSX, MouseEvent } from "react";

// Archive affordance for slice 8.16 (ADR-0034). Mirrors TrashButton
// one-for-one — same gutter / header variants, same pending / disabled
// handling. The semantic distinction lives in the icon (tray + downward
// arrow vs trashcan with lid) and in the on-state color (muted ink vs
// danger red): archive is "filed", not "removed", so it must read as
// quieter than trash, never louder.

interface ArchiveButtonProps {
  filled: boolean;
  pending: boolean;
  disabled: boolean;
  ariaLabel?: string;
  size?: number;
  onToggle: (next: boolean) => void;
  stopPropagation?: boolean;
  variant: "gutter" | "header";
}

export function ArchiveButton({
  filled,
  pending,
  disabled,
  ariaLabel,
  size = 14,
  onToggle,
  stopPropagation = false,
  variant,
}: ArchiveButtonProps): JSX.Element {
  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (stopPropagation) e.stopPropagation();
    if (disabled) return;
    onToggle(!filled);
  };
  const label =
    ariaLabel ??
    (disabled
      ? "Cannot archive — thread has no server thread id yet"
      : filled
        ? "Unarchive thread"
        : "Archive thread");
  const cls =
    "archive archive--" +
    variant +
    (filled ? " archive--on" : "") +
    (pending ? " archive--pending" : "") +
    (disabled ? " archive--disabled" : "");
  const tip = disabled ? label : filled ? "Unarchive (e)" : "Archive (e)";
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
      <ArchiveIcon filled={filled} size={size} />
    </button>
  );
}

function ArchiveIcon({
  filled,
  size,
}: {
  filled: boolean;
  size: number;
}): JSX.Element {
  // Tray + downward arrow in a 16-viewbox. Top half: down-arrow with
  // chevron, signaling "into storage". Bottom half: open tray, filled
  // when archived. The open-top tray is intentionally distinct from the
  // trashcan's closed lid — at 14px gutter size that's the affordance
  // the eye reaches for first.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 2.5 V7.5" />
      <path d="M5.5 5.5 L8 8 L10.5 5.5" />
      <path
        d="M3 9 H13 V13.5 H3 Z"
        fill={filled ? "currentColor" : "none"}
      />
    </svg>
  );
}
