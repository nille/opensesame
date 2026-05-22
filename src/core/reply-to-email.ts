// reply_to_email orchestrator (ADR-0022).
//
// Pure builder: takes a parent ReadMessageOk and an operator-supplied body,
// returns a SendEmailInput-shaped envelope ready to hand to send_email. No
// I/O. The dispatcher loads the parent and the suppression check runs in the
// existing sendWithAudit path; this file just gets the headers/body right.
//
// What this enforces:
//   - In-Reply-To := parent.message_id
//   - References := parent.references ++ [parent.message_id], deduped, capped
//   - from        := parent.address (the operator mailbox the parent landed on)
//   - to          := [reply_target(parent)]                  if reply_all=false
//                    [reply_target(parent), to + cc minus self minus dupes]
//                                                            if reply_all=true
//   - subject     := canonicalize_re_prefix(parent.subject)
//   - body_text   := operator_body + attribution + quoted parent (always v1)
//
// Pre-conditions checked here (the dispatcher converts to HTTP):
//   - parent.parse_status === "ok"           else → ReplyParentUnrepliable("skeleton")
//   - parent.headers.message_id !== null      else → ReplyParentUnrepliable("no_message_id")

import { parseAddressList } from "./address.js";
import type { ReadMessageOk } from "./store.js";
import type { SendEmailInput } from "../bff/schemas.js";

// References cap per ADR-0022: keep the original (index 0) and the most
// recent N-1; oldest middle entries get trimmed first. 12 is generous for
// honest threads, tight enough that runaway chains don't blow line lengths.
export const REFERENCES_CAP = 12;

export type ReplyBody = {
  body_text: string;
  body_html?: string;
};

export type ReplyOptions = {
  reply_all: boolean;
};

export type ReplyParentUnrepliableReason = "skeleton" | "no_message_id";

export class ReplyParentUnrepliable extends Error {
  readonly reason: ReplyParentUnrepliableReason;
  constructor(reason: ReplyParentUnrepliableReason) {
    super(`parent is unrepliable: ${reason}`);
    this.name = "ReplyParentUnrepliable";
    this.reason = reason;
  }
}

export function buildReplyComposeInput(
  parent: ReadMessageOk,
  body: ReplyBody,
  opts: ReplyOptions,
): SendEmailInput {
  if (parent.headers.message_id === null) {
    throw new ReplyParentUnrepliable("no_message_id");
  }
  const parentMsgId = parent.headers.message_id;

  const references = buildReferences(parent.headers.references, parentMsgId);
  const recipients = deriveRecipients(parent, opts.reply_all);
  const subject = canonicalizeReSubject(parent.headers.subject ?? "");
  const bodyText = buildQuotedBody(parent, body.body_text);

  const out: SendEmailInput = {
    from: parent.address,
    to: recipients.to,
    subject,
    body_text: bodyText,
    in_reply_to: parentMsgId,
    references,
  };
  if (recipients.cc.length > 0) out.cc = recipients.cc;
  if (body.body_html !== undefined && body.body_html.length > 0) {
    out.body_html = body.body_html;
  }
  return out;
}

// References per RFC 5322 §3.6.4: parent's chain + parent's Message-ID,
// deduped on raw bracketed text, then trimmed oldest-first if over cap
// (preserving index 0 — the original anchor).
function buildReferences(
  parentReferences: string | null,
  parentMessageId: string,
): string[] {
  const chain = splitMessageIds(parentReferences);
  const alreadyHasParent = chain.some((id) => id === parentMessageId);
  const withParent = alreadyHasParent ? chain : [...chain, parentMessageId];
  if (withParent.length <= REFERENCES_CAP) return withParent;
  const head = withParent[0]!;
  const tail = withParent.slice(withParent.length - (REFERENCES_CAP - 1));
  return [head, ...tail];
}

// RFC 5322 §3.6.4 References = msg-id *("\s" msg-id). The angle brackets are
// part of the msg-id token; we keep them.
const MSG_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;

function splitMessageIds(raw: string | null): string[] {
  if (raw === null) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MSG_ID_RE.source, "g");
  while ((m = re.exec(raw)) !== null) out.push(m[0]);
  return out;
}

type Recipients = { to: string[]; cc: string[] };

function deriveRecipients(parent: ReadMessageOk, replyAll: boolean): Recipients {
  // Reply target = Reply-To when set, else From. Mailing-list mail relies on
  // this — falling through to `from` would silently misroute every list reply.
  const target =
    parent.headers.reply_to !== null
      ? pickFirstAddress(parent.headers.reply_to)
      : pickFirstAddress(parent.headers.from);

  if (target === null) {
    // No usable address on the parent — odd but possible (mangled headers).
    // Hand back an empty `to`; the BFF will reject before we ever get here in
    // practice, since send_email requires non-empty to[].
    return { to: [], cc: [] };
  }

  if (!replyAll) return { to: [target], cc: [] };

  // reply_all: union of parent.to + parent.cc, drop the operator's mailbox
  // (parent.address) and the reply target (already in `to`), dedupe.
  const self = parent.address.toLowerCase();
  const seen = new Set<string>([target.toLowerCase(), self]);
  const cc: string[] = [];
  for (const raw of [parent.headers.to, parent.headers.cc]) {
    for (const a of parseAddressList(raw)) {
      const key = a.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cc.push(a.address);
    }
  }
  return { to: [target], cc };
}

function pickFirstAddress(raw: string | null): string | null {
  const list = parseAddressList(raw);
  if (list.length === 0) return null;
  return list[0]!.address;
}

// Idempotent `Re: ` prefix per ADR-0022. Collapse runs of `Re:` (any case,
// optional whitespace) into a single canonical `Re: `. Localized prefixes
// (Aw:, Sv:, 回复:) are intentionally left intact — translating them is a
// footgun. Empty parent subject yields just `Re: `.
const RE_PREFIX_RE = /^(?:\s*[Rr][Ee]\s*:\s*)+/;

export function canonicalizeReSubject(subject: string): string {
  const stripped = subject.replace(RE_PREFIX_RE, "");
  return `Re: ${stripped}`;
}

// Top-posted operator body, then a blank line, an attribution line, then the
// parent body with each line prefixed `> `. Empty parent body yields no quote.
function buildQuotedBody(parent: ReadMessageOk, operatorBody: string): string {
  const parts: string[] = [operatorBody.trimEnd()];
  parts.push("");
  parts.push(buildAttributionLine(parent));
  const quoted = quoteLines(parent.body_text);
  if (quoted.length > 0) parts.push(quoted);
  return parts.join("\n");
}

function buildAttributionLine(parent: ReadMessageOk): string {
  const date = parent.headers.date ?? parent.received_at;
  const from = parent.headers.from ?? "(unknown sender)";
  return `On ${date}, ${from} wrote:`;
}

function quoteLines(bodyText: string): string {
  if (bodyText.length === 0) return "";
  // Strip a single trailing newline so we don't emit a `> ` on a phantom line.
  const trimmed = bodyText.endsWith("\n")
    ? bodyText.slice(0, bodyText.length - 1)
    : bodyText;
  return trimmed
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}
