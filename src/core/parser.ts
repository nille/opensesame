export type ParsedHeaders = {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  // ADR-0010 mapping: forwarded verbatim so consumers can suppress
  // auto-responder loops per RFC 3834 without re-parsing.
  autoSubmitted: string;
  // ADR-0010: List-Id verbatim, null when absent.
  listId: string | null;
  // ADR-0010: flat lowercase map of inbound X-* headers, capped at
  // CUSTOM_HEADERS_MAX_BYTES total. Overflow is silently dropped and
  // signalled via customHeadersTruncated.
  customHeaders: Record<string, string>;
  customHeadersTruncated: boolean;
};

const CUSTOM_HEADERS_MAX_BYTES = 4096;
const customHeaderEncoder = new TextEncoder();

export type AttachmentSummary = {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
};

export type ParsedMessage = {
  headers: ParsedHeaders;
  headersBlob: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: AttachmentSummary[];
};

export class MimeParseError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "MimeParseError";
    this.reason = reason;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });

export function parseMime(raw: Uint8Array): ParsedMessage {
  const text = decoder.decode(raw);
  const sepIndex = findHeaderBodySeparator(text);
  const headersBlob = sepIndex === -1 ? text : text.slice(0, sepIndex);
  const bodyRaw = sepIndex === -1 ? "" : text.slice(sepIndex + 4);

  const headers = parseHeaderFields(headersBlob);
  const contentType = parseContentType(headerValue(headers, "content-type"));
  const encoding = (headerValue(headers, "content-transfer-encoding") ?? "")
    .trim()
    .toLowerCase();

  const extracted = extractBodies(bodyRaw, contentType, encoding);
  const { customHeaders, customHeadersTruncated } = collectCustomHeaders(headers);

  return {
    headers: {
      from: decodeStructuredHeader(headerValue(headers, "from")),
      to: decodeStructuredHeader(headerValue(headers, "to")),
      cc: decodeStructuredHeader(headerValue(headers, "cc")),
      subject: decodeStructuredHeader(headerValue(headers, "subject")),
      date: headerValue(headers, "date"),
      messageId: headerValue(headers, "message-id"),
      inReplyTo: headerValue(headers, "in-reply-to"),
      references: headerValue(headers, "references"),
      autoSubmitted: headerValue(headers, "auto-submitted") ?? "no",
      listId: headerValue(headers, "list-id"),
      customHeaders,
      customHeadersTruncated,
    },
    headersBlob,
    bodyText: extracted.bodyText,
    bodyHtml: extracted.bodyHtml,
    attachments: extracted.attachments,
  };
}

type ContentType = {
  type: string;
  params: Map<string, string>;
};

function parseContentType(raw: string | null): ContentType {
  if (!raw) return { type: "text/plain", params: new Map() };
  const parts = raw.split(";").map((p) => p.trim());
  const head = parts[0]?.toLowerCase() ?? "text/plain";
  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params.set(k, v);
  }
  return { type: head, params };
}

type Extracted = {
  bodyText: string;
  bodyHtml: string | null;
  attachments: AttachmentSummary[];
};

function extractBodies(
  bodyRaw: string,
  ct: ContentType,
  encoding: string,
): Extracted {
  // Single accumulator threaded through the recursive walk. "First text/plain
  // wins" / "first text/html wins" precedence holds across nested multiparts —
  // matching how mainstream MUAs (Gmail, Apple Mail) and `email.message.walk()`
  // collapse a tree like multipart/mixed { multipart/alternative { plain,
  // html }, attachment } down to a single body pair plus an attachment list.
  const acc: Extracted = { bodyText: "", bodyHtml: null, attachments: [] };
  walkPart(bodyRaw, ct, encoding, acc);
  return acc;
}

function walkPart(
  bodyRaw: string,
  ct: ContentType,
  encoding: string,
  acc: Extracted,
): void {
  if (ct.type.startsWith("multipart/")) {
    const boundary = ct.params.get("boundary");
    if (!boundary) {
      throw new MimeParseError(
        `multipart Content-Type missing required boundary parameter (type=${ct.type})`,
      );
    }
    for (const part of splitMultipart(bodyRaw, boundary)) {
      const partHeaders = parseHeaderFields(part.headersBlob);
      const partCt = parseContentType(headerValue(partHeaders, "content-type"));
      const partEnc = (headerValue(partHeaders, "content-transfer-encoding") ?? "")
        .trim()
        .toLowerCase();
      const disposition = parseContentDisposition(
        headerValue(partHeaders, "content-disposition"),
      );

      if (disposition.type === "attachment") {
        acc.attachments.push(
          buildAttachmentSummary(part, partCt, disposition, partHeaders),
        );
        continue;
      }

      walkPart(part.body, partCt, partEnc, acc);
    }
    return;
  }

  if (ct.type === "text/plain" && acc.bodyText === "") {
    acc.bodyText = normalizeNewlines(decodeBody(bodyRaw, encoding, ct));
    return;
  }
  if (ct.type === "text/html" && acc.bodyHtml === null) {
    acc.bodyHtml = normalizeNewlines(decodeBody(bodyRaw, encoding, ct));
    return;
  }
}

function decodeBody(body: string, encoding: string, _ct: ContentType): string {
  switch (encoding) {
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    case "base64":
      return decodeBase64Utf8(body);
    case "":
    case "7bit":
    case "8bit":
    case "binary":
      return body;
    default:
      return body;
  }
}

function decodeStructuredHeader(value: string | null): string | null {
  if (value === null) return null;
  return decodeEncodedWords(value);
}

// RFC 2047: =?charset?encoding?encoded-text?=
// We only support utf-8 (the v1 charset assumption); anything else is left
// as-is so callers see the raw form rather than silently mojibake.
const ENCODED_WORD_RE = /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g;

function decodeEncodedWords(input: string): string {
  // Per RFC 2047 §6.2, whitespace between adjacent encoded-words is ignored.
  // Apply that first so multiword sequences glue correctly, then decode.
  const glued = input.replace(/(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(=\?)/g, "$1$2");
  return glued.replace(ENCODED_WORD_RE, (_match, charset, enc, payload) => {
    const cs = String(charset).toLowerCase();
    if (cs !== "utf-8" && cs !== "utf8") return _match;
    if (enc === "Q" || enc === "q") {
      // Q-encoding: like quoted-printable, but underscores are spaces.
      const qp = String(payload).replace(/_/g, " ");
      return decodeQuotedPrintable(qp);
    }
    return decodeBase64Utf8(String(payload));
  });
}

function decodeBase64Utf8(input: string): string {
  // Strip whitespace per RFC 2045 §6.8 — base64 is permitted line-wrapped.
  const stripped = input.replace(/\s+/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function decodeQuotedPrintable(input: string): string {
  // Drop soft line breaks: a literal "=" at end of a line means "no break".
  const collapsed = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i]!;
    if (ch === "=" && i + 2 < collapsed.length) {
      const hex = collapsed.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // Each non-escape character must already be 7-bit ASCII per RFC 2045.
    // We pass it through as-is and let the UTF-8 decoder handle it.
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

type Disposition = {
  type: string;
  params: Map<string, string>;
};

function parseContentDisposition(raw: string | null): Disposition {
  if (!raw) return { type: "inline", params: new Map() };
  const parts = raw.split(";").map((p) => p.trim());
  const head = (parts[0] ?? "inline").toLowerCase();
  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params.set(k, v);
  }
  return { type: head, params };
}

function buildAttachmentSummary(
  part: MimePart,
  ct: ContentType,
  disposition: Disposition,
  headers: HeaderMap,
): AttachmentSummary {
  const filename =
    disposition.params.get("filename") ?? ct.params.get("name") ?? null;
  const contentId = headerValue(headers, "content-id");
  return {
    filename,
    contentType: ct.type,
    sizeBytes: new TextEncoder().encode(part.body).length,
    contentId,
  };
}

type MimePart = { headersBlob: string; body: string };

function splitMultipart(bodyRaw: string, boundary: string): MimePart[] {
  const delim = `--${boundary}`;
  const close = `${delim}--`;
  const lines = bodyRaw.split("\r\n");

  const parts: MimePart[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === delim || line === close) {
      if (current !== null) {
        parts.push(toPart(current));
      }
      current = line === close ? null : [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  return parts;
}

function toPart(lines: string[]): MimePart {
  const sepIdx = lines.indexOf("");
  if (sepIdx === -1) {
    return { headersBlob: lines.join("\r\n"), body: "" };
  }
  const headersBlob = lines.slice(0, sepIdx).join("\r\n");
  const body = lines.slice(sepIdx + 1).join("\r\n");
  return { headersBlob, body };
}

function findHeaderBodySeparator(text: string): number {
  return text.indexOf("\r\n\r\n");
}

type HeaderMap = Map<string, string>;

function parseHeaderFields(blob: string): HeaderMap {
  const map: HeaderMap = new Map();
  if (blob.length === 0) return map;
  const lines = blob.split("\r\n");
  let current: { name: string; value: string } | null = null;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (current) current.value += " " + line.trim();
      continue;
    }
    if (current) commit(map, current);
    const colon = line.indexOf(":");
    if (colon === -1) {
      current = null;
      continue;
    }
    current = {
      name: line.slice(0, colon).toLowerCase(),
      value: line.slice(colon + 1).trim(),
    };
  }
  if (current) commit(map, current);
  return map;
}

function commit(map: HeaderMap, h: { name: string; value: string }): void {
  if (!map.has(h.name)) map.set(h.name, h.value);
}

function collectCustomHeaders(headers: HeaderMap): {
  customHeaders: Record<string, string>;
  customHeadersTruncated: boolean;
} {
  const out: Record<string, string> = {};
  let used = 0;
  let truncated = false;
  for (const [name, value] of headers) {
    if (!name.startsWith("x-")) continue;
    const cost =
      customHeaderEncoder.encode(name).length +
      customHeaderEncoder.encode(value).length;
    if (used + cost > CUSTOM_HEADERS_MAX_BYTES) {
      truncated = true;
      continue;
    }
    out[name] = value;
    used += cost;
  }
  return { customHeaders: out, customHeadersTruncated: truncated };
}

function headerValue(map: HeaderMap, name: string): string | null {
  return map.get(name) ?? null;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
