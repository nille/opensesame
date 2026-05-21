export type ThreadingHeaders = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
};

// ADR-0002 + ADR-0010: best-effort thread id from RFC 5322 threading headers.
// Pick the first References msg-id as the conversation root so every reply in
// a thread shares one stable id; fall back through In-Reply-To, then this
// message's own Message-ID (it starts a thread), then null.
export function deriveThreadId(h: ThreadingHeaders): string | null {
  const fromReferences = firstMsgId(h.references);
  if (fromReferences !== null) return fromReferences;

  const fromInReplyTo = firstMsgId(h.inReplyTo);
  if (fromInReplyTo !== null) return fromInReplyTo;

  const own = firstMsgId(h.messageId);
  if (own !== null) return own;

  return null;
}

const MSG_ID_RE = /<[^<>\s]+@[^<>\s]+>/;

function firstMsgId(raw: string | null): string | null {
  if (raw === null) return null;
  const match = MSG_ID_RE.exec(raw);
  return match === null ? null : match[0];
}
