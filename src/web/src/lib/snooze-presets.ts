// Snooze preset computations (ADR-0029, slice 8.11).
//
// Presets are wall-clock relative to the operator's local timezone — the
// observer is the operator, and "tomorrow" means the operator's tomorrow.
// We never send a wall-clock time over the wire; the wire payload is
// always UTC ISO-8601 derived from the chosen Date.

export interface SnoozePreset {
  // Stable identifier for keyboard / test selection.
  id: "later_today" | "this_evening" | "tomorrow" | "next_week";
  // Operator-facing label shown in the picker row.
  label: string;
  // Right-aligned wall-clock hint, e.g. "Wed 09:00".
  hint: string;
  // Resolved wake time in local TZ.
  at: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const TOMORROW_HOUR = 9;
const NEXT_WEEK_HOUR = 9;

export function computeSnoozePresets(now: Date = new Date()): SnoozePreset[] {
  const presets: SnoozePreset[] = [];

  // "Later today" = +1h, only when at least an hour of today is left
  // before midnight. Otherwise hide it — the operator's "later today"
  // expectation is broken by 23:30 + 1h landing in tomorrow.
  const laterToday = new Date(now.getTime() + HOUR_MS);
  if (laterToday.getDate() === now.getDate()) {
    presets.push({
      id: "later_today",
      label: "Later today",
      hint: formatHint(laterToday, now),
      at: laterToday,
    });
  }

  // "This evening" = today 18:00 local, but only when we're not already
  // past it. Past 18:00, fold into the tomorrow preset instead.
  if (now.getHours() < EVENING_HOUR) {
    const evening = atLocal(now, 0, EVENING_HOUR, 0);
    presets.push({
      id: "this_evening",
      label: "This evening",
      hint: formatHint(evening, now),
      at: evening,
    });
  }

  const tomorrow = atLocal(now, 1, TOMORROW_HOUR, 0);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    hint: formatHint(tomorrow, now),
    at: tomorrow,
  });

  // "Next week" = next Monday 09:00 local (operator-week starts Monday).
  // If today is Sunday, "next week" still means tomorrow's Monday — that
  // matches "the next Monday I'll see".
  const daysUntilMonday = ((1 - now.getDay() + 7) % 7) || 7;
  const nextWeek = atLocal(now, daysUntilMonday, NEXT_WEEK_HOUR, 0);
  presets.push({
    id: "next_week",
    label: "Next week",
    hint: formatHint(nextWeek, now),
    at: nextWeek,
  });

  return presets;
}

// Construct a local-time Date `dayOffset` days from `now`, at hour:minute.
// Seconds and ms are zeroed so the wake-time stays clean in URLs / logs.
function atLocal(
  now: Date,
  dayOffset: number,
  hour: number,
  minute: number,
): Date {
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    hour,
    minute,
    0,
    0,
  );
  return d;
}

// Hint format: today → "18:00"; tomorrow / this week → "Wed 09:00";
// later → "2026-06-01 09:00". Mirrors formatRowTimestamp's tiering so the
// picker reads the same as the rest of the inbox.
function formatHint(at: Date, now: Date): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const hm = pad2(at.getHours()) + ":" + pad2(at.getMinutes());
  if (sameDay) return hm;

  const sevenDaysAhead = new Date(now);
  sevenDaysAhead.setDate(now.getDate() + 6);
  if (at <= sevenDaysAhead) {
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getDay()];
    return day + " " + hm;
  }

  return (
    at.getFullYear() +
    "-" +
    pad2(at.getMonth() + 1) +
    "-" +
    pad2(at.getDate()) +
    " " +
    hm
  );
}

// "snoozed until <hint>" text, matching the picker hints. Used in the inbox
// row meta strip and in the reader header. Returns the empty string when
// the iso doesn't parse — the affordance falls back to "snoozed".
export function formatSnoozedUntil(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return formatHint(at, now);
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
