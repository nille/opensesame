// Format helpers for the inbox row + reader pane.
//
// Times are intentionally not localized — the operator reads raw timestamps
// alongside ULIDs and message-ids. Local time, hour:minute for today, day
// abbreviation + hour:minute for this week, ISO date for older. Mono-friendly.

export function formatRowTimestamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return pad2(d.getHours()) + ":" + pad2(d.getMinutes());

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 6);
  if (d >= sevenDaysAgo) {
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    return day + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate())
  );
}

export function formatPolledAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds())
  );
}

// Show the local-part + first n chars of the message-id.
export function shortMessageId(id: string | null, n = 16): string {
  if (id === null) return "—";
  const stripped = id.replace(/^</, "").replace(/>$/, "");
  if (stripped.length <= n) return stripped;
  return stripped.slice(0, n) + "…";
}

// Pull the display name from `From: "Display" <addr>` if present, else the
// raw address. Never fabricates a name.
export function senderDisplay(from: string | null): string {
  if (from === null || from.trim() === "") return "(unknown)";
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (m && m[1]) return m[1].trim();
  return from.trim();
}

export function senderAddress(from: string | null): string {
  if (from === null) return "";
  const m = from.match(/<([^>]+)>/);
  return m && m[1] ? m[1] : from.trim();
}

// Human-readable file size — operator-eye friendly (KB/MB/GB on base 1024).
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (n < 10 ? n.toFixed(1) : Math.round(n).toString()) + " " + units[i];
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}
