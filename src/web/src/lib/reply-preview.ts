// Client-side preview helpers for reply mode (ADR-0022, slice 8.4).
//
// The server's reply_to_email RPC builds the authoritative recipient list,
// canonical Re: subject, and quoted body from the parent it loads. The
// composer shows a UI-side mirror so the operator knows what will be sent
// before they hit Send. These helpers are display-only: the wire request
// from the composer is just { message_id, body_text, reply_all }, never the
// derived strings.

const RE_PREFIX_RE = /^(?:\s*[Rr][Ee]\s*:\s*)+/;

export function canonicalReSubject(subject: string | null): string {
  const stripped = (subject ?? "").replace(RE_PREFIX_RE, "");
  return `Re: ${stripped}`;
}

// Reply target = Reply-To when present, else From. Mirrors the server's
// deriveRecipients.target — preserves the raw header form for display
// (display-name + angle-addr), since the operator reads this, not a parser.
export function previewReplyTarget(
  parentReplyTo: string | null,
  parentFrom: string | null,
): string {
  return parentReplyTo ?? parentFrom ?? "";
}

// Build the attribution line + quoted parent body the server will append.
// Mirrors src/core/reply-to-email.ts buildQuotedBody — the textarea stays
// operator-only, so this preview is what the operator reads to know what
// will be quoted. The server still does the authoritative build.
export function previewQuotedBody(args: {
  parentDate: string | null;
  parentFrom: string | null;
  parentReceivedAt: string;
  parentBodyText: string;
}): string {
  const date = args.parentDate ?? args.parentReceivedAt;
  const from = args.parentFrom ?? "(unknown sender)";
  const lines: string[] = [`On ${date}, ${from} wrote:`];
  if (args.parentBodyText.length > 0) {
    const trimmed = args.parentBodyText.endsWith("\n")
      ? args.parentBodyText.slice(0, -1)
      : args.parentBodyText;
    for (const line of trimmed.split("\n")) {
      lines.push(line.length === 0 ? ">" : `> ${line}`);
    }
  }
  return lines.join("\n");
}

// Naive comma-split for the reply_all Cc preview. Addresses with commas in
// display names will get mangled in the UI line — the server-side derivation
// uses real RFC 5322 parsing and remains authoritative. This is a preview.
export function previewReplyAllCc(
  parentTo: string | null,
  parentCc: string | null,
  selfAddress: string,
  target: string,
): string {
  const raws = [parentTo, parentCc].filter(
    (v): v is string => v !== null && v.length > 0,
  );
  if (raws.length === 0) return "";
  const parts = raws
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const selfKey = selfAddress.toLowerCase();
  const targetKey = target.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    if (key.includes(selfKey)) continue;
    if (target.length > 0 && key.includes(targetKey)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(", ");
}
