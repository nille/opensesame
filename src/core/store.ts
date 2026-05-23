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
// ADR-0042 (slice 8.21): body_html is populated on read by the BFF
// re-parsing raw_s3_uri rather than from a stored chunk. The store side
// still persists only body_text chunks; the field lands in this projection
// because the dispatcher injects it before serializing.

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
  // ADR-0042 (slice 8.21): rich-text reading. Populated by the BFF on
  // get_message via re-parse from raw_s3_uri; null when no text/html part
  // exists, the raw fetch failed, or the parse threw. The web reader falls
  // back to body_text in those cases. Not persisted in DDB chunks; storage
  // remains text-only.
  body_html: string | null;
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
  // ADR-0028 (slice 8.10): per-row sparse star annotation. Stamped on every
  // row in a thread when starThread is called. Attribute-absent → null →
  // unstarred. The client's groupIntoThreads aggregates "any starred row →
  // starred thread."
  starred_at: string | null;
  // ADR-0029 (slice 8.11): per-row sparse snooze annotation. ISO-8601 wake
  // time. Attribute-absent → null → not snoozed. Snooze is per-thread
  // fan-out like star, but the aggregation rule is "every row carries an
  // unexpired snoozed_until → snoozed", so a fresh inbound reply (which
  // arrives without the attribute) auto-wakes the conversation.
  snoozed_until: string | null;
  // ADR-0030 (slice 8.12): per-row sparse trash annotation. ISO-8601
  // timestamp the row was trashed. Attribute-absent → null → not trashed.
  // Aggregation rule mirrors snooze ("every row stamped → trashed"), so a
  // fresh inbound reply auto-resurfaces the conversation in the inbox.
  trashed_at: string | null;
  // ADR-0034 (slice 8.16): per-row sparse archive annotation. ISO-8601
  // timestamp the row was archived. Attribute-absent → null → not archived.
  // Aggregation and wake-on-reply rules mirror trash; archive lives
  // alongside trash so the two states are independent.
  archived_at: string | null;
  // ADR-0037 (slice 8.17): per-row sparse multi-valued label set, projected
  // from the DynamoDB String Set `labels` attribute. Always an array on the
  // wire (never null, never absent). Sorted lexicographic case-insensitive
  // so the same set renders identically across rounds of refetching.
  // Attribute-absent on the row → []. Aggregation rule for the thread is OR
  // (any row carries the label → thread is labelled), per the star precedent.
  labels: string[];
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
  // ADR-0028 (slice 8.10): per-row sparse star annotation. The Starred
  // sidebar entry filters the in-window inbox rows client-side via
  // groupIntoThreads.
  starred_at: string | null;
  // ADR-0029 (slice 8.11): per-row sparse snooze annotation. The Snoozed
  // sidebar entry filters in-window threads client-side; wake-on-reply
  // falls out of the "every row unexpired → snoozed" aggregation.
  snoozed_until: string | null;
  // ADR-0030 (slice 8.12): per-row sparse trash annotation. The Trash
  // sidebar entry is the only view that surfaces trashed threads; every
  // other view filters them out. Wake-on-reply falls out of the "every
  // row stamped → trashed" aggregation.
  trashed_at: string | null;
  // ADR-0034 (slice 8.16): per-row sparse archive annotation. The Archive
  // sidebar entry surfaces archived threads; every other day-to-day view
  // (Inbox, Sent, Starred, Snoozed, Trash) filters them out. Wake-on-reply
  // falls out of the same every-row aggregation as trash.
  archived_at: string | null;
  // ADR-0037 (slice 8.17): per-row sparse multi-valued label set. Same OR
  // aggregation rule as starred — any row carries the label → thread is
  // labelled. Always an array (never null, never absent), sorted
  // lexicographic case-insensitive.
  labels: string[];
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
  // ADR-0036 (slice 8.17). Operator AST + flag-shape view scope. The
  // dispatcher pre-parses `query` and passes the AST in; direct callers
  // (CLI tests, future MCP wrapper) can pass `null` and let the reader
  // parse its own input.
  ast?: import("./search-operators.js").SearchAst | null;
};

export type SearchEmailResult = {
  messages: InboxRow[];
  next_cursor: string | null;
};

// list_thread_messages per ADR-0027. Single Query against ThreadIdGSI scoped
// to one thread; ScanIndexForward=true so the conversation reads oldest-first
// (matches the reader-stack rendering order). Cursor is opaque, same shape as
// listInbox / searchEmail (base64-encoded LastEvaluatedKey under the hood).
//
// No `address` in the input — the GSI partition is the thread, and a thread
// belongs to exactly one mailbox (every row in a thread shares an `address`
// because outbound replies clone the inbound parent's `address`). The
// indexing rule guarantees colocation, so cross-mailbox leakage is not
// possible by construction.
export type ListThreadMessagesInput = {
  thread_id: string;
  limit: number;
  cursor?: string | null;
};

export type ListThreadMessagesResult = {
  messages: InboxRow[];
  next_cursor: string | null;
};

// star_thread per ADR-0028. `starred: true` stamps `starred_at = now` on
// every row in the thread; `starred: false` removes the attribute. Star is
// a UI toggle — re-starring overwrites the timestamp rather than preserving
// first-star-wins (cf. mark_read's first-open semantics). updated_count
// reports how many rows were actually written; an empty thread returns 0
// rather than 404 so a stale inbox-window rollup doesn't surface as an
// error.
export type StarThreadInput = {
  thread_id: string;
  starred: boolean;
};

export type StarThreadResult = {
  thread_id: string;
  starred: boolean;
  starred_at: string | null;
  updated_count: number;
};

// snooze_thread per ADR-0029. `snoozed_until: <iso>` stamps that wake time
// on every row in the thread; `snoozed_until: null` removes the attribute.
// Like star, snooze is a UI toggle — re-snoozing overwrites the wake time
// rather than preserving first-snooze-wins. updated_count reports how many
// rows were actually written; an empty thread returns 0 rather than 404 so
// a stale inbox-window rollup doesn't surface as an error.
//
// The wake-on-reply behavior is handled on the read side (the client
// aggregation rule treats an unstamped row as "this conversation is
// awake"). The write path doesn't know about thread freshness; it just
// stamps the rows it resolves via ThreadIdGSI at the moment of the call.
export type SnoozeThreadInput = {
  thread_id: string;
  snoozed_until: string | null;
};

export type SnoozeThreadResult = {
  thread_id: string;
  snoozed_until: string | null;
  updated_count: number;
};

// trash_thread per ADR-0030. `trashed: true` stamps `trashed_at = now` on
// every row in the thread; `trashed: false` removes the attribute. Like
// star, the wire shape is a boolean toggle — re-trashing overwrites the
// timestamp. The result echoes `trashed_at` so the caller can render the
// affordance without a refetch. Empty thread → updated_count: 0, no 404
// (consistent with star_thread / snooze_thread).
export type TrashThreadInput = {
  thread_id: string;
  trashed: boolean;
};

export type TrashThreadResult = {
  thread_id: string;
  trashed: boolean;
  trashed_at: string | null;
  updated_count: number;
};

// archive_thread per ADR-0034. `archived: true` stamps `archived_at = now`
// on every row in the thread; `archived: false` removes the attribute. Wire
// shape mirrors trash (boolean toggle, ISO-or-null echo). Empty thread →
// updated_count: 0, no 404.
export type ArchiveThreadInput = {
  thread_id: string;
  archived: boolean;
};

export type ArchiveThreadResult = {
  thread_id: string;
  archived: boolean;
  archived_at: string | null;
  updated_count: number;
};

// Result of mark_read. Distinguishes a no-op (already read) from a fresh
// stamp so the BFF can return both 200 paths without a write churn for the
// idempotent case. `not_found` is its own variant so the dispatcher can map
// to 404 without having to re-Get the row.
export type MarkReadResult =
  | { kind: "marked"; read_at: string }
  | { kind: "already_read"; read_at: string }
  | { kind: "not_found" };

// ADR-0035 (slice 8.17). Drafts are a parallel data plane in the Messages
// table — same partition (`address`), different SK prefix (`DRAFT#<ulid>`).
// schema_v stays "1"; `kind: "draft"` is the explicit row marker so a Query
// that accidentally surfaces a draft (e.g. an inbox scan that forgets to
// guard the SK prefix) can fast-skip it. Recipient fields are nullable
// strings (not `string[]`) so re-opening a draft preserves exactly the
// bytes the operator typed, including a trailing comma mid-completion;
// address-list splitting lives only in the send-time `parseAddrList`.
//
// ADR-0042 (slice 8.21) extension: `body_html` is the TipTap-serialized
// HTML when the operator's draft carries any rich-text formatting (bold,
// italic, link, list, blockquote). Null on plain-text drafts and on every
// draft created before the field existed; the composer falls back to
// loading body_text as paragraphs in that case.
export type StoredDraft = {
  schema_v: "1";
  kind: "draft";
  address: string;
  draft_id: string;
  body_text: string;
  body_html: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  in_reply_to: string | null;
  references: string | null;
  created_at: string;
  updated_at: string;
};

// `draft_id: null` on first save — the reader mints a ULID. Subsequent
// saves pass the canonical id back. Recipient fields are optional on the
// wire (caller can omit) and nullable when present (caller can clear).
// `body_html` follows the same absent-vs-null trichotomy: omitted = leave
// the stored value alone on upsert, null = clear (operator stripped all
// formatting), string = set.
export type SaveDraftInput = {
  address: string;
  draft_id: string | null;
  body_text: string;
  body_html?: string | null;
  to?: string | null;
  cc?: string | null;
  subject?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
};

// Echoes both timestamps so the composer's "saved · 2s ago" footer and
// optimistic-pending machinery render without a refetch — same posture as
// archive_thread echoing archived_at.
export type SaveDraftResult = {
  draft_id: string;
  created_at: string;
  updated_at: string;
};

export type ListDraftsInput = {
  address: string;
  limit: number;
  cursor?: string | null;
};

export type ListDraftsResult = {
  drafts: StoredDraft[];
  next_cursor: string | null;
};

export type GetDraftInput = {
  address: string;
  draft_id: string;
};

export type DeleteDraftInput = {
  address: string;
  draft_id: string;
};

// `deleted: false` is the idempotent no-op shape — the row was already gone.
// Same posture as mark_read returning already_read rather than 404.
export type DeleteDraftResult = {
  draft_id: string;
  deleted: boolean;
};

// ADR-0031 (slice 8.13). Per-thread read/unread toggle. Wire shape mirrors
// star (boolean) — the per-thread path is last-write-wins to behave like a
// UI toggle; the per-row markRead from slice 8.2 stays first-write-wins for
// audit. Fan-out targets inbound rows only (direction == "in") — outbound
// rows are never "unread". Empty / outbound-only thread → updated_count: 0.
export type MarkThreadReadInput = {
  thread_id: string;
  read: boolean;
};

export type MarkThreadReadResult = {
  thread_id: string;
  read: boolean;
  read_at: string | null;
  updated_count: number;
};

// ADR-0037 (slice 8.17). Labels are a multi-valued sparse attribute on
// Messages rows (DynamoDB String Set). Membership is many-to-many: a thread
// can carry N labels and a label can apply to N threads. The OR aggregation
// rule from star applies — any row with the label → thread labelled.
//
// `label` on the wire is the lowercased form (catalog identity is
// case-insensitive). Display casing is preserved separately via the catalog
// row's `display_name`.
export type AddThreadLabelInput = {
  thread_id: string;
  label: string;
};

export type RemoveThreadLabelInput = {
  thread_id: string;
  label: string;
};

// `labels` is the post-state for the operator's lead row, sorted
// lexicographic case-insensitive. Same posture as archive_thread echoing
// archived_at — the optimistic UI renders without a refetch.
export type ThreadLabelResult = {
  thread_id: string;
  label: string;
  labels: string[];
  updated_count: number;
};

// ADR-0037 (slice 8.17). Catalog row: explicit `LABEL#<lowercased>` items
// colocated with the message rows on the same partition. The
// case-preserved label is stored in `display_name`; `label` is the
// canonical lowercased form used for catalog identity and on-the-wire
// fan-out values.
export type LabelCatalogEntry = {
  label: string;
  display_name: string;
  created_at: string;
};

export type ListLabelsInput = {
  address: string;
};

export type ListLabelsResult = {
  labels: LabelCatalogEntry[];
};

export type CreateLabelInput = {
  address: string;
  // Case-preserved as typed by the operator. The reader lowercases for
  // catalog identity and stores the original in `display_name`.
  label: string;
};

export type DeleteLabelInput = {
  address: string;
  label: string;
};

// `incomplete: true` when `MAX_RENAME_FANOUT` was hit. The operator can
// re-call to continue the strip; the per-row delete is idempotent at the
// set-value level so repeats are safe.
export type DeleteLabelResult = {
  label: string;
  updated_row_count: number;
  incomplete: boolean;
};

export type RenameLabelInput = {
  address: string;
  from: string;
  to: string;
};

export type RenameLabelResult = {
  from: string;
  to: string;
  updated_row_count: number;
  incomplete: boolean;
};

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
  // ADR-0027 (slice 8.9): paginated read of every Messages row sharing a
  // thread_id. Implementations Query against ThreadIdGSI ascending by
  // internal_id (== oldest-first by received-at-millisecond, with ULID
  // tiebreaks). Skeleton rows (parse_status="failed") never carry a thread_id
  // and so never appear here in practice, but the return type stays unified
  // with listInbox/searchEmail so the wire shape is identical.
  listThreadMessages(
    input: ListThreadMessagesInput,
  ): Promise<ListThreadMessagesResult>;
  // ADR-0028 (slice 8.10): toggle the star annotation on every row in the
  // thread. Resolves rows via ThreadIdGSI (slice 8.9) and fans out
  // conditional UpdateItems guarded by attribute_exists(address) so a
  // stale primary key cannot create a phantom row. Plain SET / REMOVE on
  // starred_at — star is a UI toggle, not a first-event timestamp.
  starThread(input: StarThreadInput, now: Date): Promise<StarThreadResult>;
  // ADR-0029 (slice 8.11): toggle the snooze annotation on every row in
  // the thread. Same fan-out shape as starThread; `snoozed_until: <iso>`
  // sets the wake time, `null` removes the attribute. The `now` parameter
  // is used only to timestamp the operation in tests / diagnostics —
  // past-time validation lives in the BFF schema, the reader trusts its
  // input.
  snoozeThread(
    input: SnoozeThreadInput,
    now: Date,
  ): Promise<SnoozeThreadResult>;
  // ADR-0030 (slice 8.12): toggle the trash annotation on every row in
  // the thread. Same fan-out shape as starThread / snoozeThread;
  // `trashed: true` stamps `trashed_at = now` on every row, `trashed: false`
  // removes the attribute. The `now` parameter timestamps the trash
  // operation when stamping.
  trashThread(input: TrashThreadInput, now: Date): Promise<TrashThreadResult>;
  // ADR-0031 (slice 8.13): toggle read/unread across every inbound row in
  // the thread. Resolves rows via ThreadIdGSI, projects `direction` to
  // skip outbound rows, then fans out SET/REMOVE on `read_at`. Last-write-
  // wins (UI toggle, distinct from the first-write-wins per-row markRead
  // from slice 8.2). Wake-on-reply is implicit: a fresh inbound row lands
  // without `read_at`, so `Thread.unread` flips back automatically.
  markThreadRead(
    input: MarkThreadReadInput,
    now: Date,
  ): Promise<MarkThreadReadResult>;
  // ADR-0034 (slice 8.16): toggle the archive annotation on every row in
  // the thread. Same fan-out shape as starThread / snoozeThread /
  // trashThread; `archived: true` stamps `archived_at = now`,
  // `archived: false` removes the attribute. Archive is independent from
  // trash — a thread is never simultaneously archived and trashed in
  // practice (operator chooses one or the other), but the storage allows
  // both without conflict.
  archiveThread(
    input: ArchiveThreadInput,
    now: Date,
  ): Promise<ArchiveThreadResult>;
  // ADR-0035 (slice 8.17): upsert-by-id. `draft_id: null` on first save
  // mints a fresh ULID; subsequent saves are conditional UpdateItems
  // guarded by `attribute_exists(address) AND #kind = :draft` so a stale
  // primary key cannot create a phantom draft and a draft deleted from
  // another tab cannot be silently revived. ConditionalCheckFailed surfaces
  // as null — the dispatcher maps it to 404 draft_not_found.
  saveDraft(
    input: SaveDraftInput,
    now: Date,
  ): Promise<SaveDraftResult | null>;
  // ADR-0035 (slice 8.17): Query the address partition's DRAFT# region.
  // Descending so most-recently-created drafts sort first; ULID-time-prefix
  // is the SK so no separate updated_at index is needed.
  listDrafts(input: ListDraftsInput): Promise<ListDraftsResult>;
  // ADR-0035 (slice 8.17): point-Get a single draft. Returns null on
  // missing — dispatcher maps to 404.
  getDraft(input: GetDraftInput): Promise<StoredDraft | null>;
  // ADR-0035 (slice 8.17): unconditional DeleteItem. Idempotent — already-
  // missing returns `deleted: false` rather than 404. The wire shape
  // mirrors mark_read's `already_read` posture so a double-click doesn't
  // surface a stale-key error.
  deleteDraft(input: DeleteDraftInput): Promise<DeleteDraftResult>;
  // ADR-0037 (slice 8.17): add the label to every row in the thread (set
  // ADD via fanOutThreadAttribute's `setOp: "add"` branch). Idempotent at
  // the set-value level — re-applying is a no-op. Resolves rows via
  // ThreadIdGSI; empty thread → updated_count: 0.
  addThreadLabel(
    input: AddThreadLabelInput,
    now: Date,
  ): Promise<ThreadLabelResult>;
  // ADR-0037 (slice 8.17): remove the label from every row in the thread
  // (set DELETE via fanOutThreadAttribute's `setOp: "delete"` branch).
  // DDB drops the attribute when the last set value is removed.
  removeThreadLabel(
    input: RemoveThreadLabelInput,
    now: Date,
  ): Promise<ThreadLabelResult>;
  // ADR-0037 (slice 8.17): list catalog entries for the mailbox.
  // Single Query with begins_with(SK, "LABEL#"); v1 catalogs are
  // operator-scale and fit in one page.
  listLabels(input: ListLabelsInput): Promise<ListLabelsResult>;
  // ADR-0037 (slice 8.17): conditional PutItem with
  // attribute_not_exists(SK). Returns null on conflict — dispatcher maps
  // to 409 already_exists.
  createLabel(
    input: CreateLabelInput,
    now: Date,
  ): Promise<LabelCatalogEntry | null>;
  // ADR-0037 (slice 8.17): DeleteItem on the catalog row + bulk strip
  // across rows carrying the value. Capped at MAX_RENAME_FANOUT; the
  // result echoes `incomplete: true` when the cap is hit so the operator
  // can re-call. Missing catalog row → 200 no-op (idempotent).
  deleteLabel(input: DeleteLabelInput): Promise<DeleteLabelResult>;
  // ADR-0037 (slice 8.17): catalog new + catalog old delete + bulk
  // fan-out across rows carrying `from`. Returns null on `to` already
  // existing in the catalog (dispatcher maps to 409); MAX_RENAME_FANOUT
  // ceiling surfaced via `incomplete`.
  renameLabel(
    input: RenameLabelInput,
    now: Date,
  ): Promise<RenameLabelResult | null>;
}
