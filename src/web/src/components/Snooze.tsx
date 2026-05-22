import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from "react";
import {
  computeSnoozePresets,
  formatSnoozedUntil,
  type SnoozePreset,
} from "../lib/snooze-presets.ts";

// Snooze affordance for slice 8.11 (ADR-0029). Mirrors StarButton's gutter /
// header variants so the inbox row and reader header read as siblings, then
// adds a preset popover the operator picks from. We deliberately don't ship
// a free-form datetime — the picker is preset-only and the wire payload is
// always a UTC ISO derived from a Date in the operator's local TZ.
//
// The icon is a clock face — circle + two hands. Same 1.5px stroke as the
// star so they share an optical weight in the gutter column. The toggle
// itself isn't animated; the popover fades in via app.css.

interface SnoozeButtonProps {
  // Authoritative wake-time for the surrounding thread. null when the thread
  // is not snoozed; an ISO-8601 string when it is. Drives the icon's filled
  // state and the "snoozed until <hint>" footer in the popover.
  snoozedUntil: string | null;
  // Optimistic intent (string or null) currently in flight. Surfaces a faint
  // mono cue without animating the icon.
  pending: boolean;
  // Subject-fallback rollups (rootKey doesn't start with "<") have no stable
  // server thread_id to fan out against. Renders the affordance disabled.
  disabled: boolean;
  ariaLabel?: string;
  size?: number;
  // Caller commits a preset's wake-time (ISO) or null to unsnooze. The picker
  // closes automatically before this fires.
  onPickPreset: (snoozedUntil: string | null) => void;
  // Inbox-row gutter sits inside a clickable row, so we stop propagation;
  // reader-header doesn't.
  stopPropagation?: boolean;
  variant: "gutter" | "header";
  // Controlled mode (used by the reader-header variant so App's `z` keyboard
  // shortcut can open the picker). When undefined, the button manages its
  // own open state.
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SnoozeButton({
  snoozedUntil,
  pending,
  disabled,
  ariaLabel,
  size = 14,
  onPickPreset,
  stopPropagation = false,
  variant,
  controlledOpen,
  onOpenChange,
}: SnoozeButtonProps): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean): void => {
    if (isControlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };

  const wrapRef = useRef<HTMLSpanElement>(null);

  // Click-outside + Escape close the popover. We listen at document level
  // so a click on the surrounding inbox row (which would otherwise just
  // select the row) also dismisses the picker.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: globalThis.MouseEvent): void => {
      const wrap = wrapRef.current;
      if (wrap === null) return;
      if (e.target instanceof Node && wrap.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
    // setOpen is stable per render in the controlled branch; isControlled is constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filled = snoozedUntil !== null;

  const handleClick = (e: MouseEvent<HTMLButtonElement>): void => {
    if (stopPropagation) e.stopPropagation();
    if (disabled) return;
    setOpen(!open);
  };

  const handlePick = (next: string | null): void => {
    setOpen(false);
    onPickPreset(next);
  };

  const label =
    ariaLabel ??
    (disabled
      ? "Cannot snooze — thread has no server thread id yet"
      : filled
        ? "Snoozed — change or wake"
        : "Snooze thread");

  const cls =
    "snooze snooze--" +
    variant +
    (filled ? " snooze--on" : "") +
    (pending ? " snooze--pending" : "") +
    (disabled ? " snooze--disabled" : "") +
    (open ? " snooze--open" : "");

  const tip = disabled ? label : filled ? "Snoozed (z)" : "Snooze (z)";
  const isGutter = variant === "gutter";

  return (
    <span ref={wrapRef} className="snooze-wrap">
      <button
        type="button"
        className={cls}
        onClick={handleClick}
        aria-pressed={filled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={isGutter ? undefined : tip}
        data-tooltip={isGutter && !open ? tip : undefined}
        disabled={disabled}
      >
        <ClockIcon filled={filled} size={size} />
      </button>
      {open && !disabled ? (
        <SnoozePicker
          snoozedUntil={snoozedUntil}
          variant={variant}
          onPick={handlePick}
          stopPropagation={stopPropagation}
        />
      ) : null}
    </span>
  );
}

interface SnoozePickerProps {
  snoozedUntil: string | null;
  variant: "gutter" | "header";
  onPick: (snoozedUntil: string | null) => void;
  stopPropagation: boolean;
}

// Preset list. Right-aligned hints mirror formatRowTimestamp's tiering so the
// picker reads the same as the rest of the inbox.
function SnoozePicker({
  snoozedUntil,
  variant,
  onPick,
  stopPropagation,
}: SnoozePickerProps): JSX.Element {
  const presets: SnoozePreset[] = computeSnoozePresets();
  const stop = (e: MouseEvent): void => {
    if (stopPropagation) e.stopPropagation();
  };
  return (
    <div
      className={"snooze-picker snooze-picker--" + variant}
      role="menu"
      onClick={stop}
    >
      <div className="snooze-picker__head mono faint">snooze until</div>
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          className="snooze-picker__item"
          onClick={() => onPick(p.at.toISOString())}
          role="menuitem"
        >
          <span className="snooze-picker__label">{p.label}</span>
          <span className="snooze-picker__hint mono faint">{p.hint}</span>
        </button>
      ))}
      {snoozedUntil !== null ? (
        <>
          <div className="snooze-picker__rule" aria-hidden />
          <button
            type="button"
            className="snooze-picker__item snooze-picker__item--unsnooze"
            onClick={() => onPick(null)}
            role="menuitem"
          >
            <span className="snooze-picker__label">Unsnooze</span>
            <span className="snooze-picker__hint mono faint">
              {formatSnoozedUntil(snoozedUntil)}
            </span>
          </button>
        </>
      ) : null}
    </div>
  );
}

// 16-viewbox clock face. Outline ring + two hands. Stroke matches Star.
// Filled state colours via `currentColor` and the `.snooze--on` rule —
// no separate filled glyph (the hands stay visible at any state).
function ClockIcon({
  filled: _filled,
  size,
}: {
  filled: boolean;
  size: number;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5 V8 L10.6 9.6" />
    </svg>
  );
}
