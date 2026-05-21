// Suppression list — pure types and helpers (ADR-0019).
//
// Slice 5 introduces a per-recipient suppression list keyed on the
// lowercased email address. The bounce-handler Lambda writes to it on
// permanent-bounce / complaint events; the send path consults it before
// dispatching. Both ends share the normalization function defined here.
//
// Storage adapter: src/aws/dynamodb-suppression.ts.
// Send-path integration: src/core/send-with-audit.ts.

export type SuppressionReason = "bounced_permanent" | "complained";

export type SuppressedRecipient = {
  // Always lowercased (run through normalizeRecipient before storing or
  // querying). Keeps the DDB key stable across "Alice@Example.com" vs
  // "alice@example.com" inputs.
  recipient: string;
  reason: SuppressionReason;
  // ISO-8601 timestamp of the most recent suppressing event for this
  // recipient. Used by the upsert guard so a stale event can't overwrite a
  // fresher one.
  last_event_at: string;
};

// Read-side port consulted by sendWithAudit before SES.send.
//
// Implementations should batch (BatchGetItem) for multi-recipient sends —
// the send path will call checkRecipients with the union of to + cc + bcc.
export interface SuppressionList {
  checkRecipients(
    recipients: readonly string[],
  ): Promise<SuppressedRecipient[]>;
}

// Write-side port called by the bounce-handler Lambda (ADR-0019). One call
// per affected recipient when the SES event maps to a suppressing reason.
//
// Returns `true` when the row was written or already existed in a fresher
// state (idempotent); `false` only when the input was malformed (e.g.
// recipient that fails normalization). Errors propagate so the Lambda's
// retry budget covers transient DDB failures.
export type SuppressionUpsertInput = {
  recipient: string;
  reason: SuppressionReason;
  // ISO-8601 timestamp of this event — used both as the freshness guard
  // and as `first_event_at` on a brand-new row.
  event_at: string;
  ses_message_id: string;
  event_id: string;
};

export interface SuppressionWriter {
  upsert(input: SuppressionUpsertInput): Promise<boolean>;
}

// Thrown by sendWithAudit when the pre-flight check finds suppressed
// recipients and `allowSuppressed` is not set. CLI drivers catch it to
// surface a non-zero exit; future MCP-tool layer maps it to a structured
// `{error: {code, message, retriable}}` per ADR-0007.
export class SuppressionBlockError extends Error {
  readonly suppressed: readonly SuppressedRecipient[];
  constructor(suppressed: readonly SuppressedRecipient[]) {
    super(formatSuppressionMessage(suppressed));
    this.name = "SuppressionBlockError";
    this.suppressed = suppressed;
  }
}

function formatSuppressionMessage(
  suppressed: readonly SuppressedRecipient[],
): string {
  const parts = suppressed.map(
    (s) => `${s.recipient} (${s.reason}, last event ${s.last_event_at})`,
  );
  return `send blocked: ${suppressed.length} recipient(s) on suppression list — ${parts.join("; ")}`;
}

// Normalize an email address into the form used as the Suppressions PK.
// Returns null if the input doesn't structurally look like local@domain —
// callers should treat null as "skip this entry," not "fail the send."
//
// v1 lowers the entire string. Domains are RFC-mandated case-insensitive;
// local-parts are technically case-sensitive but every mainstream MTA we
// integrate with (Gmail, Outlook, AWS SES) treats them as case-insensitive,
// and SES itself emits lowercased recipients in event payloads. Keying on
// the lowered form aligns with received data and avoids subtle "Alice and
// alice are different recipients" bugs. ADR-0019 documents the trade-off.
export function normalizeRecipient(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;

  // Strip a single pair of surrounding angle brackets — operator-pasted
  // mailbox-list values sometimes carry them ("<alice@example.com>").
  if (s.length >= 2 && s.startsWith("<") && s.endsWith(">")) {
    s = s.slice(1, -1).trim();
  }
  if (s.length === 0) return null;

  const at = s.indexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  // Reject anything with more than one @ — ambiguous, can't normalize safely.
  if (s.indexOf("@", at + 1) !== -1) return null;

  return s.toLowerCase();
}
