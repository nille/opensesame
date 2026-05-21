import { randomFillSync } from "node:crypto";
import { encodeUlid } from "./ids.js";

// RFC 5322 raw-MIME composer for outbound mail (ADR-0007 `send_email`).
//
// Output is a UTF-8 byte stream ready to hand to SES `SendRawEmail`. The
// returned `messageId` and `fromAddress` are inputs to the audit trail and
// the SES envelope (`Source` parameter); `envelopeTo` is the SES `Destinations`
// list — Bcc recipients are envelope-only and never appear on the wire.
//
// v1 scope:
//   - text/plain body (required), text/html body (optional, wrapped in
//     multipart/alternative when both are present).
//   - quoted-printable transfer encoding so 7-bit-clean wire bytes hold any
//     UTF-8 payload without further escaping.
//   - In-Reply-To / References for threaded replies.
//   - Attachments deferred to a follow-up slice (composer + parser already
//     have the type seam, but the writer doesn't persist them yet).

export type ComposeInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
};

export type ComposeDeps = {
  now: () => Date;
  // Caller-supplied entropy for the Message-ID ULID. Defaults to
  // node:crypto via the ids.ts factory.
  randomBytes?: () => Uint8Array;
};

export type ComposeResult = {
  raw: Uint8Array;
  messageId: string;
  fromAddress: string;
  envelopeTo: string[];
};

const CRLF = "\r\n";
const ULID_RANDOM_BYTES = 10;

export function composeRawMime(
  input: ComposeInput,
  deps: ComposeDeps,
): ComposeResult {
  if (input.to.length === 0) {
    throw new Error("composeRawMime: to[] must contain at least one recipient");
  }

  const fromMailbox = parseMailbox(input.from);
  if (fromMailbox === null) {
    throw new Error(`composeRawMime: invalid from address: ${input.from}`);
  }

  const now = deps.now();
  const randomBytes =
    deps.randomBytes ?? defaultRandomBytes;
  const ulid = encodeUlid(now.getTime(), randomBytes());
  const messageId = `<${ulid}@${fromMailbox.domain}>`;

  const headers: string[] = [];
  headers.push(`From: ${formatAddress(fromMailbox.raw)}`);
  headers.push(`To: ${formatAddressList(input.to)}`);
  if (input.cc && input.cc.length > 0) {
    headers.push(`Cc: ${formatAddressList(input.cc)}`);
  }
  // Bcc is intentionally absent — see header comment.
  headers.push(`Subject: ${encodeHeaderTextIfNeeded(input.subject)}`);
  headers.push(`Date: ${formatRfc5322Date(now)}`);
  headers.push(`Message-ID: ${messageId}`);
  if (input.inReplyTo !== undefined) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
  }
  if (input.references !== undefined && input.references.length > 0) {
    headers.push(`References: ${input.references.join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  const body = renderBody(input, headers);

  const wire = headers.join(CRLF) + CRLF + CRLF + body;
  return {
    raw: new TextEncoder().encode(wire),
    messageId,
    fromAddress: fromMailbox.addr,
    envelopeTo: [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ],
  };
}

function renderBody(input: ComposeInput, headers: string[]): string {
  const hasHtml =
    input.bodyHtml !== undefined && input.bodyHtml.length > 0;

  if (!hasHtml) {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push("Content-Transfer-Encoding: quoted-printable");
    return encodeQuotedPrintable(input.bodyText);
  }

  // multipart/alternative: text/plain part first (RFC 2046 §5.1.4 — least-
  // capable form first, most-capable last; the recipient picks the richest
  // they understand).
  const boundary = makeBoundary();
  headers.push(
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  );

  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset="utf-8"');
  parts.push("Content-Transfer-Encoding: quoted-printable");
  parts.push("");
  parts.push(encodeQuotedPrintable(input.bodyText));
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/html; charset="utf-8"');
  parts.push("Content-Transfer-Encoding: quoted-printable");
  parts.push("");
  parts.push(encodeQuotedPrintable(input.bodyHtml as string));
  parts.push(`--${boundary}--`);
  return parts.join(CRLF);
}

type Mailbox = {
  raw: string; // original input (including any display name)
  addr: string; // bare addr-spec (local@domain)
  domain: string;
};

const ADDR_RE = /^([^<>@]+)@([^<>@\s]+)$/;
const NAMED_ADDR_RE = /^(.*)<\s*([^<>@]+)@([^<>@\s]+)\s*>$/;

function parseMailbox(input: string): Mailbox | null {
  const trimmed = input.trim();
  const named = NAMED_ADDR_RE.exec(trimmed);
  if (named) {
    return {
      raw: trimmed,
      addr: `${named[2]}@${named[3]}`,
      domain: named[3]!,
    };
  }
  const bare = ADDR_RE.exec(trimmed);
  if (bare) {
    return { raw: trimmed, addr: trimmed, domain: bare[2]! };
  }
  return null;
}

function formatAddress(raw: string): string {
  // If raw contains a display name with non-ASCII, encoded-word the name.
  // We keep the addr-spec untouched — RFC 5322 forbids non-ASCII in addr-spec
  // anyway (IDN/SMTPUTF8 is out of scope for v1).
  const match = NAMED_ADDR_RE.exec(raw);
  if (!match) return raw;
  const namePart = match[1]!.trim().replace(/^"|"$/g, "");
  const addr = `${match[2]}@${match[3]}`;
  if (isAscii(namePart)) {
    return `${namePart} <${addr}>`;
  }
  return `${encodeWordBase64(namePart)} <${addr}>`;
}

function formatAddressList(addrs: readonly string[]): string {
  return addrs.map(formatAddress).join(", ");
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function encodeHeaderTextIfNeeded(s: string): string {
  return isAscii(s) ? s : encodeWordBase64(s);
}

function encodeWordBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return `=?utf-8?B?${btoa(bin)}?=`;
}

const QP_HEX = "0123456789ABCDEF";

function encodeQuotedPrintable(input: string): string {
  // Encode each byte that's not 7-bit printable, plus the literal '=' itself,
  // as =XX. We keep ASCII printable + space + tab. Newlines are normalized
  // to CRLF — body lines arrive at SES as CRLF on the wire regardless of
  // source line endings.
  const bytes = new TextEncoder().encode(input);
  let out = "";
  let lineLen = 0;

  function emit(token: string): void {
    if (lineLen + token.length > 75) {
      out += `=${CRLF}`;
      lineLen = 0;
    }
    out += token;
    lineLen += token.length;
  }

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0a /* \n */) {
      // Hard line break in source — emit CRLF, reset column.
      out += CRLF;
      lineLen = 0;
      continue;
    }
    if (b === 0x0d /* \r */) {
      // Strip lone CR; the following \n (if present) handles the break.
      continue;
    }
    if (b === 0x3d /* = */) {
      emit("=3D");
      continue;
    }
    if (b === 0x09 /* tab */ || (b >= 0x20 && b <= 0x7e)) {
      emit(String.fromCharCode(b));
      continue;
    }
    const hi = QP_HEX[(b >> 4) & 0x0f]!;
    const lo = QP_HEX[b & 0x0f]!;
    emit(`=${hi}${lo}`);
  }
  return out;
}

const RFC5322_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC5322_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatRfc5322Date(d: Date): string {
  const day = RFC5322_DAYS[d.getUTCDay()]!;
  const date = String(d.getUTCDate()).padStart(2, "0");
  const month = RFC5322_MONTHS[d.getUTCMonth()]!;
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${day}, ${date} ${month} ${year} ${hh}:${mm}:${ss} +0000`;
}

function makeBoundary(): string {
  // A boundary just needs to not appear in the body. Random hex via the
  // shared randomBytes path would couple the boundary to deps.randomBytes —
  // which is set to fixed bytes in tests and would collide between the
  // Message-ID and the boundary. Use a separate crypto draw.
  const bytes = defaultRandomBytes();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += QP_HEX[(bytes[i]! >> 4) & 0x0f]!.toLowerCase();
    hex += QP_HEX[bytes[i]! & 0x0f]!.toLowerCase();
  }
  return `boundary_${hex}`;
}

function defaultRandomBytes(): Uint8Array {
  const buf = new Uint8Array(ULID_RANDOM_BYTES);
  randomFillSync(buf);
  return buf;
}
