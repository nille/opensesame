import { parseAddressList, type ParsedAddress } from "./address.js";
import type { AttachmentSummary, ParsedMessage } from "./parser.js";
import { deriveThreadId } from "./threading.js";

// Verdicts mirror SES verbatim (ADR-0010). We don't constrain the union
// because SES occasionally adds new tokens (`GRAY`, `PROCESSING_FAILED`, …)
// and Open Sesame's contract is "pass-through, do not re-judge".
export type SesVerdict = string;

export type SesVerdicts = {
  spam: SesVerdict;
  virus: SesVerdict;
  dkim: SesVerdict;
  spf: SesVerdict;
  dmarc: SesVerdict;
};

export type BuildMailIngestedEventInput = {
  parsed: ParsedMessage;
  internalId: string;
  address: string;
  receivedAt: string;
  // True on-the-wire size of the raw MIME object in S3. Caller-supplied
  // because parsed.bodyText is post-decoding and can't recover this.
  sizeBytes: number;
  rawS3Uri: string;
  verdicts: SesVerdicts;
  eventId: string;
  occurredAt: string;
  deploymentId: string;
};

export type AttachmentEventEntry = {
  filename: string | null;
  content_type: string;
  size_bytes: number;
};

export type MailIngestedData = {
  message_id: string | null;
  internal_id: string;
  address: string;
  received_at: string;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string | null;
  in_reply_to: string | null;
  references: string[];
  thread_id: string | null;
  size_bytes: number;
  has_attachments: boolean;
  attachment_count: number;
  attachments: AttachmentEventEntry[];
  auto_submitted: string;
  list_id: string | null;
  custom_headers: Record<string, string>;
  // Additive per ADR-0010: only emitted when overflow happened. Omitting it
  // on the happy path keeps the wire shape identical to the documented
  // example for non-truncated messages.
  custom_headers_truncated?: true;
  spam_verdict: SesVerdict;
  virus_verdict: SesVerdict;
  dkim_verdict: SesVerdict;
  spf_verdict: SesVerdict;
  dmarc_verdict: SesVerdict;
  raw_s3_uri: string;
  // Additive per ADR-0010: only emitted on the skeleton-row path. Omitting on
  // the happy path keeps the documented example wire shape unchanged.
  parse_status?: "failed";
  parse_error?: string;
};

export type BuildMailIngestedSkeletonEventInput = {
  internalId: string;
  address: string;
  receivedAt: string;
  sizeBytes: number;
  rawS3Uri: string;
  parseError: string;
  verdicts: SesVerdicts;
  eventId: string;
  occurredAt: string;
  deploymentId: string;
};

export type MailIngestedEvent = {
  schema_version: "1";
  event_type: "MailIngested";
  event_id: string;
  occurred_at: string;
  deployment_id: string;
  data: MailIngestedData;
};

const MSG_ID_RE = /<[^<>\s]+@[^<>\s]+>/g;

export function buildMailIngestedEvent(
  input: BuildMailIngestedEventInput,
): MailIngestedEvent {
  const { parsed, verdicts } = input;
  const { headers, attachments } = parsed;

  const fromList = parseAddressList(headers.from);
  // RFC 5322 forbids more than one address in From for `mailbox` form, but
  // sender groups are valid. ADR-0010's example shows a single object — we
  // surface the first parsed entry and accept loss for the rare group case.
  const from = fromList.length === 0 ? null : fromList[0]!;

  const data: MailIngestedData = {
    message_id: headers.messageId,
    internal_id: input.internalId,
    address: input.address,
    received_at: input.receivedAt,
    from,
    to: parseAddressList(headers.to),
    cc: parseAddressList(headers.cc),
    subject: headers.subject,
    in_reply_to: headers.inReplyTo,
    references: extractReferences(headers.references),
    thread_id: deriveThreadId({
      messageId: headers.messageId,
      inReplyTo: headers.inReplyTo,
      references: headers.references,
    }),
    size_bytes: input.sizeBytes,
    has_attachments: attachments.length > 0,
    attachment_count: attachments.length,
    attachments: attachments.map(toAttachmentEntry),
    auto_submitted: headers.autoSubmitted,
    list_id: headers.listId,
    custom_headers: headers.customHeaders,
    spam_verdict: verdicts.spam,
    virus_verdict: verdicts.virus,
    dkim_verdict: verdicts.dkim,
    spf_verdict: verdicts.spf,
    dmarc_verdict: verdicts.dmarc,
    raw_s3_uri: input.rawS3Uri,
  };

  if (headers.customHeadersTruncated) {
    data.custom_headers_truncated = true;
  }

  return {
    schema_version: "1",
    event_type: "MailIngested",
    event_id: input.eventId,
    occurred_at: input.occurredAt,
    deployment_id: input.deploymentId,
    data,
  };
}

export function buildMailIngestedSkeletonEvent(
  input: BuildMailIngestedSkeletonEventInput,
): MailIngestedEvent {
  // ADR-0012: skeleton events still carry the full envelope and the routing
  // keys downstream consumers need. Header-derived fields are zeroed because
  // the parse never succeeded — consumers branch on parse_status before
  // touching them.
  const data: MailIngestedData = {
    message_id: null,
    internal_id: input.internalId,
    address: input.address,
    received_at: input.receivedAt,
    from: null,
    to: [],
    cc: [],
    subject: null,
    in_reply_to: null,
    references: [],
    thread_id: null,
    size_bytes: input.sizeBytes,
    has_attachments: false,
    attachment_count: 0,
    attachments: [],
    auto_submitted: "no",
    list_id: null,
    custom_headers: {},
    spam_verdict: input.verdicts.spam,
    virus_verdict: input.verdicts.virus,
    dkim_verdict: input.verdicts.dkim,
    spf_verdict: input.verdicts.spf,
    dmarc_verdict: input.verdicts.dmarc,
    raw_s3_uri: input.rawS3Uri,
    parse_status: "failed",
    parse_error: input.parseError,
  };

  return {
    schema_version: "1",
    event_type: "MailIngested",
    event_id: input.eventId,
    occurred_at: input.occurredAt,
    deployment_id: input.deploymentId,
    data,
  };
}

function toAttachmentEntry(a: AttachmentSummary): AttachmentEventEntry {
  return {
    filename: a.filename,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
  };
}

function extractReferences(raw: string | null): string[] {
  if (raw === null) return [];
  const out: string[] = [];
  // Use exec-loop to avoid relying on a stateful global regex across calls.
  let m: RegExpExecArray | null;
  const re = new RegExp(MSG_ID_RE.source, "g");
  while ((m = re.exec(raw)) !== null) out.push(m[0]);
  return out;
}
