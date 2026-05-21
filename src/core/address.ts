export type ParsedAddress = {
  address: string;
  name: string | null;
};

// Minimal RFC 5322 address-list parser geared at the ADR-0010 event payload.
// The input is the value of a structured header (From / To / Cc / Reply-To)
// after parseMime has already applied RFC 2047 encoded-word decoding, so we
// receive plain UTF-8. We only need the shape, not full grammar coverage:
// quoted display names, angle-bracketed addresses, comma separation.
export function parseAddressList(raw: string | null): ParsedAddress[] {
  if (raw === null) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const out: ParsedAddress[] = [];
  for (const part of splitTopLevelCommas(trimmed)) {
    const entry = parseSingleAddress(part);
    if (entry !== null) out.push(entry);
  }
  return out;
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuotes = false;
  let inAngle = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"' && !inAngle) {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "<") inAngle = true;
      else if (ch === ">") inAngle = false;
    }
    if (ch === "," && !inQuotes && !inAngle) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function parseSingleAddress(raw: string): ParsedAddress | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const lt = trimmed.lastIndexOf("<");
  const gt = trimmed.lastIndexOf(">");
  if (lt !== -1 && gt > lt) {
    const inside = trimmed.slice(lt + 1, gt).trim();
    const namePart = trimmed.slice(0, lt).trim();
    const address = canonicalizeAddress(inside);
    if (address === null) return null;
    return { address, name: cleanDisplayName(namePart) };
  }

  const address = canonicalizeAddress(trimmed);
  if (address === null) return null;
  return { address, name: null };
}

function canonicalizeAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // We don't validate the local-part grammar exhaustively, but a v1 address
  // must at least look like local@domain so the event payload doesn't carry
  // garbage tokens (`<not-an-email>`, lone display names).
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return trimmed.toLowerCase();
}

function cleanDisplayName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith('"') &&
    trimmed.endsWith('"')
  ) {
    return trimmed.slice(1, -1).trim() || null;
  }
  return trimmed;
}
