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
  // ADR-0026 (slice 8.8): server-derived thread_id, computed from the same
  // RFC 5322 threading headers `deriveThreadId` already feeds into the
  // MailIngested event. null when the headers are too sparse — the row simply
  // omits the attribute and the client's JWZ fallback handles it.
  thread_id?: string | null;
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
  // ADR-0022 (slice 8.4): tail-add. Rows written before 8.4 collapse to null
  // on read; reply_to_email's reply_target falls back to `from` in that case.
  reply_to: string | null;
  subject: string | null;
  date: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  auto_submitted: string;
  list_id: string | null;
};

// Attachment projection on the read side. The bytes themselves live in S3
// under attachments/{address}/{internal_id}/{partIndex} — readers that need
// them resolve via the get_attachment RPC, which mints a presigned URL.
// snake_case mirrors the DDB-stored shape.
export type StoredAttachment = {
  filename: string | null;
  content_type: string;
  size_bytes: number;
  content_id: string | null;
  part_index: number;
  sha256: string;
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
  // Attachment summaries, possibly empty. Bytes are not inlined — clients
  // that want the file resolve via get_attachment.
  attachments: StoredAttachment[];
  // ISO-8601 timestamp the row was first marked read by an operator client,
  // or null when still unread. Attribute-absent on the DDB row collapses to
  // null so older messages projected through the reader are unread by default
  // until the slice 8.2 backfill stamps `read_at = received_at` on them.
  read_at: string | null;
  // ADR-0026 (slice 8.8): server-stamped thread root. null on rows written
  // before slice 8.8 (no backfill) and on parses too sparse for
  // deriveThreadId. The web client's JWZ fallback handles null.
  thread_id: string | null;
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
  // ADR-0022 (slice 8.4): tail-add. Inbox rows before 8.4 are null here.
  reply_to: string | null;
  subject: string | null;
  date: string | null;
  in_reply_to: string | null;
  references: string | null;
  auto_submitted: string;
  list_id: string | null;
  snippet: string;
  // ADR-0017: defaults to "in" when the row predates slice 3.
  direction: MessageDirection;
  // null when the row has never been opened (or was written before slice 8.2);
  // ISO-8601 timestamp once an operator client called mark_read.
  read_at: string | null;
  // ADR-0026 (slice 8.8): server-stamped thread root, null when the row
  // predates this slice or the parse was too sparse for deriveThreadId.
  thread_id: string | null;
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

// search_email per ADR-0007 / ADR-0004. `query` is the substring to match
// across headers_blob and body chunks; structured filters (from/to/subject)
// AND-compose with the substring match. since/until bound the time window via
// internal_id, the same way listInbox's `since` does.
//
// Cursor pagination is opaque, mirroring listInbox: callers pass the prior
// next_cursor to fetch the next page. Empty result + null cursor is the
// terminal state. Substring matching is case-insensitive (ADR-0004 doesn't
// pin case-folding, but operator UX expects it).
export type SearchEmailInput = {
  address: string;
  query: string;
  limit: number;
  cursor?: string | null;
  since?: string | null;
  until?: string | null;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
};

export type SearchEmailResult = {
  messages: InboxRow[];
  next_cursor: string | null;
};

// Result of mark_read. Distinguishes a no-op (already read) from a fresh
// stamp so the BFF can return both 200 paths without a write churn for the
// idempotent case. `not_found` is its own variant so the dispatcher can map
// to 404 without having to re-Get the row.
export type MarkReadResult =
  | { kind: "marked"; read_at: string }
  | { kind: "already_read"; read_at: string }
  | { kind: "not_found" };

export interface MessageReader {
  getByMessageId(messageId: string): Promise<ReadMessage | null>;
  getByPrimaryKey(
    address: string,
    internalId: string,
  ): Promise<ReadMessage | null>;
  listInbox(input: ListInboxInput): Promise<ListInboxResult>;
  // Stamp `read_at = now` on the row identified by RFC 5322 Message-ID, but
  // only when no `read_at` is set yet. When already set, returns the existing
  // value without writing — the read timestamp tracks first-open, not last-open.
  //
  // Self-addressed mail produces two rows (in + out) sharing one Message-ID;
  // GSI1 disambiguation here picks whichever DDB returns first. UIs that
  // already hold the inbox row's primary key should prefer markReadByPrimaryKey
  // to avoid stamping the wrong direction. This overload remains for callers
  // (MCP, future API consumers) that only have a Message-ID in hand.
  markRead(messageId: string, now: Date): Promise<MarkReadResult>;
  // Direct primary-key variant — no GSI hop, no direction ambiguity. The UI
  // calls this from the inbox row, where (address, internal_id) is already in
  // hand. Idempotent in the same way as markRead.
  markReadByPrimaryKey(
    address: string,
    internalId: string,
    now: Date,
  ): Promise<MarkReadResult>;
  // Substring search across one address's mail per ADR-0004. Latency budget
  // is 3-10s and grows with mailbox size — implementations Query the address
  // partition with FilterExpression for headers/snippet matches, then fan
  // out per-message body-chunk Queries for any rows that didn't already
  // match on metadata. Cursor opacity matches listInbox.
  searchEmail(input: SearchEmailInput): Promise<SearchEmailResult>;
}
