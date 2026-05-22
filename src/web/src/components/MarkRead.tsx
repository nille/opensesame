import type { JSX, MouseEvent } from "react";

// Mark-read affordance for slice 8.13 (ADR-0031). Mirrors TrashButton: two
// visual states sharing one 16-viewbox path. The icon flips between a
// closed envelope (unread — has unopened mail) and an open envelope (read).
//
// `unread` is the *current* thread state, not a desired toggle direction.
// onToggle receives the next read state (true → mark read, false → mark
// unread), matching App.tsx's bff.markThreadRead({ read }) contract.

interface MarkReadButtonProps {
  // True when the thread has any inbound row without a read_at. The button
  // renders the closed envelope when unread, the open envelope when read.
  unread: boolean;
  // True while the optimistic intent is in flight to the BFF; the icon
  // renders the target state but with reduced contrast so the operator can
  // see the toggle hasn't fully landed yet.
  pending: boolean;
  // True when the thread has no server-stamped thread_id yet, OR when the
  // thread has no inbound rows at all (an outbound-only thread can't be
  // "unread"). The reader-header variant still renders disabled so the
  // affordance set stays consistent across surfaces.
  disabled: boolean;
  ariaLabel?: string;
  size?: number;
  // The next read state — true means "mark read", false means "mark unread".
  onToggle: (next: boolean) => void;
  stopPropagation?: boolean;
  variant: "gutter" | "header";
}

export function MarkReadButton({
  unread,
  pending,
  disabled,
  ariaLabel,
  size = 14,
  onToggle,
  stopPropagation = false,
  variant,
}: MarkReadButtonProps): JSX.Element {
  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (stopPropagation) e.stopPropagation();
    if (disabled) return;
    // Click toggles the inverse of the current unread state. Currently
    // unread → next read = true. Currently read → next read = false.
    onToggle(unread);
  };
  const label =
    ariaLabel ??
    (disabled
      ? "Cannot mark read — thread has no inbound rows or no server thread id"
      : unread
        ? "Mark thread read"
        : "Mark thread unread");
  const cls =
    "markread markread--" +
    variant +
    (unread ? " markread--unread" : " markread--read") +
    (pending ? " markread--pending" : "") +
    (disabled ? " markread--disabled" : "");
  return (
    <button
      type="button"
      className={cls}
      onClick={handleClick}
      aria-pressed={!unread}
      aria-label={label}
      title={
        disabled
          ? label
          : unread
            ? "Mark read (Shift+U)"
            : "Mark unread (Shift+U)"
      }
      disabled={disabled}
    >
      <EnvelopeIcon unread={unread} size={size} />
    </button>
  );
}

function EnvelopeIcon({
  unread,
  size,
}: {
  unread: boolean;
  size: number;
}): JSX.Element {
  // Envelope in a 16-viewbox, sized to match Star/Snooze/Trash.
  // Unread → closed envelope (rectangle with V-flap), filled to draw the eye.
  // Read   → open envelope (rectangle + opened triangle flap), outline-only.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={unread ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      {unread ? (
        <>
          <rect x="2" y="4" width="12" height="9" rx="1" />
          <path
            d="M2.5 4.5 L8 9 L13.5 4.5"
            stroke="var(--paper)"
            strokeWidth="1.25"
            fill="none"
          />
        </>
      ) : (
        <>
          <rect x="2" y="4" width="12" height="9" rx="1" />
          <path d="M2.5 4.5 L8 9 L13.5 4.5" />
        </>
      )}
    </svg>
  );
}
