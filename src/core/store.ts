import type { ParsedMessage } from "./parser.js";

// Port for the message store. Pure types in core; the DDB-bound implementation
// lives in src/aws/dynamodb.ts in a later slice.
//
// ADR-0012 commits to a two-shape model:
//   - StoredMessage  (parse_status: "ok")    — full ADR-0004 layout
//   - SkeletonRow    (parse_status: "failed")— minimal pointer to raw S3
//
// Reader code branches on parse_status. Per ADR-0011, every row carries
// schema_v so readers can support multiple schema versions in parallel.

// Direction of a stored message (ADR-0017). Inbound mail (received via SES)
// is "in"; outbound copies (operator's own sends, persisted post-SES) are
// "out". Attribute-absent on the row collapses to "in" on read for back-
// compat with everything written before slice 3.
export type MessageDirection = "in" | "out";

export type StoredMessageBase = {
  internal_id: string;
  address: string;
  received_at: string;
  raw_s3_uri: string;
  schema_v: "1";
};

export type StoredMessage = StoredMessageBase & {
  parse_status: "ok";
  // Carried into the store call so the implementation can derive Address row,
  // message row, body chunks, and headers blob per ADR-0004. The shape of
  // those derived items is intentionally not pinned here — that's slice-of-DDB
  // territory and pinning it now would lock in chunking decisions prematurely.
  parsed: ParsedMessage;
  // Optional so existing inbound call sites stay terse; the store adapter
  // defaults a missing value to "in" on the wire.
  direction?: MessageDirection;
  // For outbound rows, the SES adapter result MUST overwrite parsed.headers.messageId
  // so GSI1 indexes the recipient-visible (SES-rewritten) RFC Message-ID, not
  // the composer's attempted id (ADR-0015 + ADR-0017). This is enforced by
  // the persist-outbound orchestrator before calling writeMessage.
};

export type SkeletonRow = StoredMessageBase & {
  parse_status: "failed";
  parse_error: string;
};

export type StoredRow = StoredMessage | SkeletonRow;

export interface MessageStore {
  writeMessage(row: StoredMessage): Promise<void>;
  writeSkeleton(row: SkeletonRow): Promise<void>;
}

export function isSkeletonRow(row: StoredRow): row is SkeletonRow {
  return row.parse_status === "failed";
}

// Read-side projection of a stored message — what get_message returns.
// Mirrors the on-the-wire shape ADR-0007 commits to: structured headers
// alongside the raw blob (so callers that need exact RFC 5322 bytes for
// HEADER search per ADR-0004 still have it), plus the assembled body text.
//
// bodyHtml and attachments are absent today: the write-side persists only
// bodyText chunks. They land here in a follow-up slice once the store is
// extended.

export type StoredMessageHeaders = {
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  auto_submitted: string;
  list_id: string | null;
};

export type ReadMessageOk = {
  parse_status: "ok";
  schema_v: "1";
  address: string;
  internal_id: string;
  received_at: string;
  raw_s3_uri: string;
  headers: StoredMessageHeaders;
  headers_blob: string;
  body_text: string;
  // ADR-0017: present on every read (defaults to "in" when the row was
  // written before slice 3 and has no `direction` attribute).
  direction: MessageDirection;
};

export type ReadMessageFailed = {
  parse_status: "failed";
  schema_v: "1";
  address: string;
  internal_id: string;
  received_at: string;
  raw_s3_uri: string;
  parse_error: string;
};

export type ReadMessage = ReadMessageOk | ReadMessageFailed;

// Inbox listing — metadata + snippet, no body chunks (ADR-0007). The cursor
// is opaque to callers (base64-encoded LastEvaluatedKey under the hood).

export type InboxRowOk = {
  parse_status: "ok";
  schema_v: "1";
  address: string;
  internal_id: string;
  received_at: string;
  message_id: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  in_reply_to: string | null;
  references: string | null;
  auto_submitted: string;
  list_id: string | null;
  snippet: string;
  // ADR-0017: defaults to "in" when the row predates slice 3.
  direction: MessageDirection;
};

export type InboxRowFailed = {
  parse_status: "failed";
  schema_v: "1";
  address: string;
  internal_id: string;
  received_at: string;
  raw_s3_uri: string;
  parse_error: string;
};

export type InboxRow = InboxRowOk | InboxRowFailed;

export type ListInboxInput = {
  address: string;
  limit: number;
  cursor?: string | null;
  // ISO-8601 timestamp; messages with internal_id strictly after the
  // ULID-derived bound are returned. Per ADR-0007, distinct from cursor —
  // `since` is for sync-style polling, `cursor` is for paging through one
  // result set.
  since?: string | null;
};

export type ListInboxResult = {
  messages: InboxRow[];
  next_cursor: string | null;
};

export interface MessageReader {
  getByMessageId(messageId: string): Promise<ReadMessage | null>;
  getByPrimaryKey(
    address: string,
    internalId: string,
  ): Promise<ReadMessage | null>;
  listInbox(input: ListInboxInput): Promise<ListInboxResult>;
}
