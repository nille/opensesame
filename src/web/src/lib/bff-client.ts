// Typed client for the slice-7 BFF (ADR-0021).
//
// The BFF lifts transport outcomes to HTTP status codes; the client mirrors
// that into a discriminated result. UIs branch on `result.kind`, never on a
// raw status. When slice 9 swaps the BFF for an MCP client behind the same
// `/rpc/*` shape, only the base URL and the auth header change.

// `import.meta.env` is provided by Vite at build time. The cast keeps the
// access portable across tsconfigs that don't include `vite/client`
// (e.g. the top-level project tsconfig that builds tests).
const BFF_BASE =
  ((import.meta as { env?: Record<string, string | undefined> }).env?.[
    "VITE_BFF_BASE"
  ] ?? "http://127.0.0.1:3000");

export type RpcOk<T> = { kind: "ok"; value: T };
export type RpcInvalid = {
  kind: "invalid_request";
  field: string;
  reason: "missing" | "invalid_type" | "invalid_value";
  message: string;
};
export type RpcNotFound = { kind: "not_found"; code: string; message: string };
export type RpcSuppressed = {
  kind: "suppressed";
  message: string;
  blocked_recipients: string[];
};
export type RpcError = { kind: "error"; code: string; message: string };
export type RpcResult<T> =
  | RpcOk<T>
  | RpcInvalid
  | RpcNotFound
  | RpcSuppressed
  | RpcError;

// reply_to_email widens RpcResult with the 422 parent_unrepliable variant
// (ADR-0022). Other tools never produce 422, so we keep them tightly typed.
export type ReplyToEmailRpcResult =
  | RpcOk<SendEmailResult>
  | RpcInvalid
  | RpcNotFound
  | RpcSuppressed
  | { kind: "parent_unrepliable"; reason: "skeleton" | "no_message_id"; message: string }
  | RpcError;

async function call<T>(tool: string, body: unknown): Promise<RpcResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${BFF_BASE}/rpc/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      kind: "error",
      code: "network_error",
      message: err instanceof Error ? err.message : "BFF unreachable",
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return {
      kind: "error",
      code: "invalid_response",
      message: `BFF returned non-JSON for /rpc/${tool}`,
    };
  }

  if (res.ok) {
    return { kind: "ok", value: data as T };
  }

  const obj = (data ?? {}) as Record<string, unknown>;
  const code = typeof obj["code"] === "string" ? obj["code"] : "unknown";
  const message =
    typeof obj["message"] === "string" ? obj["message"] : `HTTP ${res.status}`;

  if (res.status === 400 && code === "invalid_request") {
    return {
      kind: "invalid_request",
      field: typeof obj["field"] === "string" ? obj["field"] : "body",
      reason: (obj["reason"] as RpcInvalid["reason"]) ?? "invalid_type",
      message,
    };
  }
  if (res.status === 404) {
    return { kind: "not_found", code, message };
  }
  if (res.status === 409 && code === "suppressed") {
    return {
      kind: "suppressed",
      message,
      blocked_recipients: Array.isArray(obj["blocked_recipients"])
        ? (obj["blocked_recipients"] as string[])
        : [],
    };
  }
  return { kind: "error", code, message };
}

// ---- shapes mirrored from src/core/store.ts and src/bff/dispatcher.ts ----

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
  reply_to: string | null;
  subject: string | null;
  date: string | null;
  in_reply_to: string | null;
  references: string | null;
  auto_submitted: string;
  list_id: string | null;
  snippet: string;
  direction: "in" | "out";
  // null when the message has never been opened. The UI uses this to render
  // an unread indicator in the inbox row gutter.
  read_at: string | null;
  // ADR-0026 (slice 8.8): server-stamped thread root. null when the row was
  // written before slice 8.8 or when the parse was too sparse to derive one;
  // groupIntoThreads falls back to JWZ-style key resolution in that case.
  thread_id: string | null;
  // ADR-0028 (slice 8.10): per-row sparse star annotation. null on rows
  // written before this slice or never starred. groupIntoThreads aggregates
  // any starred row → starred thread.
  starred_at: string | null;
  // ADR-0029 (slice 8.11): per-row sparse snooze wake-time. null on rows
  // never snoozed. groupIntoThreads aggregates "every row unexpired →
  // snoozed", so a fresh inbound reply (no snoozed_until) auto-wakes the
  // conversation.
  snoozed_until: string | null;
  // ADR-0030 (slice 8.12): per-row sparse trash annotation. null on rows
  // never trashed. groupIntoThreads aggregates "every row stamped → trashed",
  // so a fresh inbound reply auto-resurfaces the conversation in the inbox.
  trashed_at: string | null;
  // ADR-0034 (slice 8.16): per-row sparse archive annotation. null on rows
  // never archived. groupIntoThreads aggregates "every row stamped →
  // archived", same wake-on-reply shape as trash. Independent attribute.
  archived_at: string | null;
  // ADR-0037 (slice 8.17): per-row label set, projected from the DDB SS as
  // a sorted Array (lexicographic, case-insensitive). Empty on rows without
  // any label. groupIntoThreads aggregates "any row with X → thread has X"
  // — OR aggregation, same posture as star.
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

export type ListInboxResult = {
  messages: InboxRow[];
  next_cursor: string | null;
};

export type SearchEmailInput = {
  address: string;
  query: string;
  limit?: number;
  cursor?: string;
  since?: string;
  until?: string;
  from?: string;
  to?: string;
  subject?: string;
};

export type SearchEmailResult = ListInboxResult;

// ADR-0027 (slice 8.9): list_thread_messages returns the same wire shape as
// read_inbox / search_email. The reader stack expansion calls this on thread
// open and merges the result with the in-window rows.
export type ListThreadMessagesResult = ListInboxResult;

// ADR-0028 (slice 8.10): toggle the star annotation on every row in the
// thread. updated_count is the number of rows actually written; an empty
// thread (no rows on ThreadIdGSI) returns 0 rather than 404.
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

// ADR-0029 (slice 8.11): toggle the snooze annotation on every row in the
// thread. snoozed_until is the wake-time ISO when snoozing, or null when
// unsnoozing. Past wake times are rejected by the BFF (400).
export type SnoozeThreadInput = {
  thread_id: string;
  snoozed_until: string | null;
};

export type SnoozeThreadResult = {
  thread_id: string;
  snoozed_until: string | null;
  updated_count: number;
};

// ADR-0030 (slice 8.12): toggle the trash annotation on every row in the
// thread. Wire shape mirrors star — boolean toggle. The result echoes
// trashed_at so optimistic UI can render the chip without a refetch.
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

// ADR-0031 (slice 8.13): toggle read/unread across every inbound row in
// the thread. Boolean wire shape mirrors star/trash. The result echoes
// read_at so optimistic UI can render without a refetch. Outbound rows
// are skipped server-side, so updated_count counts only inbound writes.
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

// ADR-0034 (slice 8.16): toggle the archive annotation on every row in
// the thread. Wire shape mirrors trash. Echoes archived_at so the UI can
// render the chip without a refetch.
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

// ADR-0037 (slice 8.17). Operator-defined labels. Many-to-many membership:
// a thread carries N labels, a label applies to N threads. add_thread_label
// / remove_thread_label echo the operator's lead row's post-state so the
// optimistic UI can render chips without a refetch.
export type AddThreadLabelInput = { thread_id: string; label: string };
export type RemoveThreadLabelInput = { thread_id: string; label: string };

export type ThreadLabelResult = {
  thread_id: string;
  label: string;
  labels: string[];
  updated_count: number;
};

export type LabelCatalogEntry = {
  label: string;
  display_name: string;
  created_at: string;
};

export type ListLabelsInput = { address: string };
export type ListLabelsResult = { labels: LabelCatalogEntry[] };

export type CreateLabelInput = { address: string; label: string };

export type DeleteLabelInput = { address: string; label: string };
export type DeleteLabelResult = {
  label: string;
  updated_row_count: number;
  incomplete: boolean;
};

export type RenameLabelInput = { address: string; from: string; to: string };
export type RenameLabelResult = {
  from: string;
  to: string;
  updated_row_count: number;
  incomplete: boolean;
};

// 409 already_exists arrives as RpcError on this client; create / rename
// surface a typed `conflict` variant so the UI can branch without sniffing
// status codes.
export type RpcConflict = { kind: "conflict"; code: string; message: string };
export type CreateLabelRpcResult =
  | RpcOk<LabelCatalogEntry>
  | RpcInvalid
  | RpcConflict
  | RpcError;
export type RenameLabelRpcResult =
  | RpcOk<RenameLabelResult>
  | RpcInvalid
  | RpcConflict
  | RpcError;

export type ReadMessageHeaders = {
  from: string | null;
  to: string | null;
  cc: string | null;
  reply_to: string | null;
  subject: string | null;
  date: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  auto_submitted: string;
  list_id: string | null;
};

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
  headers: ReadMessageHeaders;
  headers_blob: string;
  body_text: string;
  // ADR-0042 (slice 8.21): rich-text reading. The BFF re-parses raw_s3_uri
  // on read and fills this when a text/html part exists. null when no HTML
  // part was found, the raw fetch failed, or the parser threw.
  body_html: string | null;
  direction: "in" | "out";
  attachments: StoredAttachment[];
  read_at: string | null;
  // ADR-0026 (slice 8.8): server-stamped thread root, or null on legacy /
  // unparseable rows.
  thread_id: string | null;
  // ADR-0028 (slice 8.10): per-row sparse star annotation.
  starred_at: string | null;
  // ADR-0029 (slice 8.11): per-row sparse snooze wake-time.
  snoozed_until: string | null;
  // ADR-0030 (slice 8.12): per-row sparse trash annotation.
  trashed_at: string | null;
  // ADR-0034 (slice 8.16): per-row sparse archive annotation.
  archived_at: string | null;
  // ADR-0037 (slice 8.17): per-row label set, sorted Array projection.
  labels: string[];
};

// One of `message_id` or (`address`, `internal_id`) is echoed back, mirroring
// the request shape. UIs that hold the inbox row should use the PK form to
// avoid the self-addressed-mail GSI ambiguity.
export type MarkReadResult = {
  message_id?: string;
  address?: string;
  internal_id?: string;
  read_at: string;
  already_read: boolean;
};

export type MarkReadInput =
  | { message_id: string }
  | { address: string; internal_id: string };

export type GetAttachmentResult = {
  url: string;
  expires_at: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
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

export type SendEmailAttachment = {
  filename: string;
  content_type: string;
  content_base64: string;
};

export type SendEmailInput = {
  from: string;
  to: string[];
  subject: string;
  body_text: string;
  cc?: string[];
  bcc?: string[];
  body_html?: string;
  in_reply_to?: string;
  references?: string[];
  // ADR-0040 (slice 8.19). Inline base64 attachments. Caller-supplied
  // base64; the composer re-emits as base64 with 76-col line folding.
  // BFF caps: 10MB per file, 25MB total decoded, 20 files max.
  attachments?: SendEmailAttachment[];
};

export type SendEmailResult = {
  message_id: string;
  sent_at: string;
};

export type ReplyToEmailInput = {
  message_id: string;
  body_text: string;
  body_html?: string;
  reply_all?: boolean;
};

// ADR-0035 (slice 8.17): drafts share the address partition with messages
// but live under SK prefix "DRAFT#" with a `kind: "draft"` marker. Optional
// recipient fields use the absent-vs-null trichotomy: omitted = "leave alone
// on upsert", null = "explicitly clear", string = "set". The wire shape is
// preserved end-to-end through schema → dispatcher → reader.
export type StoredDraft = {
  schema_v: "1";
  kind: "draft";
  address: string;
  draft_id: string;
  body_text: string;
  to: string | null;
  cc: string | null;
  subject: string | null;
  in_reply_to: string | null;
  references: string | null;
  created_at: string;
  updated_at: string;
};

// First save: omit draft_id (or pass null) and the server mints a ULID.
// Subsequent saves: pass the minted draft_id; the server upserts the row.
// Optional fields default to "absent" — pass null to explicitly clear, omit
// to leave the prior value alone.
export type SaveDraftInput = {
  address: string;
  draft_id?: string | null;
  body_text: string;
  to?: string | null;
  cc?: string | null;
  subject?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
};

export type SaveDraftResult = {
  draft_id: string;
  created_at: string;
  updated_at: string;
};

export type ListDraftsInput = {
  address: string;
  limit?: number;
  cursor?: string;
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

export type DeleteDraftResult = {
  draft_id: string;
  deleted: boolean;
};

// ---- API surface ----

export const bff = {
  readInbox(input: {
    address: string;
    limit?: number;
    since?: string;
    cursor?: string;
  }): Promise<RpcResult<ListInboxResult>> {
    return call<ListInboxResult>("read_inbox", input);
  },
  getMessage(messageId: string): Promise<RpcResult<ReadMessage>> {
    return call<ReadMessage>("get_message", { message_id: messageId });
  },
  getAttachment(input: {
    message_id: string;
    part_index: number;
  }): Promise<RpcResult<GetAttachmentResult>> {
    return call<GetAttachmentResult>("get_attachment", input);
  },
  markRead(input: MarkReadInput): Promise<RpcResult<MarkReadResult>> {
    return call<MarkReadResult>("mark_read", input);
  },
  searchEmail(input: SearchEmailInput): Promise<RpcResult<SearchEmailResult>> {
    return call<SearchEmailResult>("search_email", input);
  },
  listThreadMessages(input: {
    thread_id: string;
    limit?: number;
    cursor?: string;
  }): Promise<RpcResult<ListThreadMessagesResult>> {
    return call<ListThreadMessagesResult>("list_thread_messages", input);
  },
  starThread(input: StarThreadInput): Promise<RpcResult<StarThreadResult>> {
    return call<StarThreadResult>("star_thread", input);
  },
  snoozeThread(
    input: SnoozeThreadInput,
  ): Promise<RpcResult<SnoozeThreadResult>> {
    return call<SnoozeThreadResult>("snooze_thread", input);
  },
  trashThread(input: TrashThreadInput): Promise<RpcResult<TrashThreadResult>> {
    return call<TrashThreadResult>("trash_thread", input);
  },
  markThreadRead(
    input: MarkThreadReadInput,
  ): Promise<RpcResult<MarkThreadReadResult>> {
    return call<MarkThreadReadResult>("mark_thread_read", input);
  },
  archiveThread(
    input: ArchiveThreadInput,
  ): Promise<RpcResult<ArchiveThreadResult>> {
    return call<ArchiveThreadResult>("archive_thread", input);
  },
  sendEmail(input: SendEmailInput): Promise<RpcResult<SendEmailResult>> {
    return call<SendEmailResult>("send_email", input);
  },
  async replyToEmail(
    input: ReplyToEmailInput,
  ): Promise<ReplyToEmailRpcResult> {
    // reply_to_email shares wire shape with send_email but adds the 422
    // parent_unrepliable variant. The base `call` helper folds 422 into
    // RpcError (code-only) — we widen it here so the UI can branch on
    // reason.
    let res: Response;
    try {
      res = await fetch(`${BFF_BASE}/rpc/reply_to_email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch (err) {
      return {
        kind: "error",
        code: "network_error",
        message: err instanceof Error ? err.message : "BFF unreachable",
      };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return {
        kind: "error",
        code: "invalid_response",
        message: "BFF returned non-JSON for /rpc/reply_to_email",
      };
    }
    if (res.ok) {
      return { kind: "ok", value: data as SendEmailResult };
    }
    const obj = (data ?? {}) as Record<string, unknown>;
    const code = typeof obj["code"] === "string" ? obj["code"] : "unknown";
    const message =
      typeof obj["message"] === "string" ? obj["message"] : `HTTP ${res.status}`;
    if (res.status === 422 && code === "parent_unrepliable") {
      const reason =
        obj["reason"] === "skeleton" ? "skeleton" : "no_message_id";
      return { kind: "parent_unrepliable", reason, message };
    }
    if (res.status === 400 && code === "invalid_request") {
      return {
        kind: "invalid_request",
        field: typeof obj["field"] === "string" ? obj["field"] : "body",
        reason: (obj["reason"] as RpcInvalid["reason"]) ?? "invalid_type",
        message,
      };
    }
    if (res.status === 404) return { kind: "not_found", code, message };
    if (res.status === 409 && code === "suppressed") {
      return {
        kind: "suppressed",
        message,
        blocked_recipients: Array.isArray(obj["blocked_recipients"])
          ? (obj["blocked_recipients"] as string[])
          : [],
      };
    }
    return { kind: "error", code, message };
  },
  // ADR-0035 (slice 8.17). Persist a draft. First save omits draft_id;
  // subsequent saves pass the minted id and the server upserts. A 404
  // means the draft was deleted from another tab — UIs should drop the
  // stale id and fall back to first-save on the next debounce.
  saveDraft(input: SaveDraftInput): Promise<RpcResult<SaveDraftResult>> {
    return call<SaveDraftResult>("save_draft", input);
  },
  listDrafts(input: ListDraftsInput): Promise<RpcResult<ListDraftsResult>> {
    return call<ListDraftsResult>("list_drafts", input);
  },
  getDraft(input: GetDraftInput): Promise<RpcResult<StoredDraft>> {
    return call<StoredDraft>("get_draft", input);
  },
  deleteDraft(
    input: DeleteDraftInput,
  ): Promise<RpcResult<DeleteDraftResult>> {
    return call<DeleteDraftResult>("delete_draft", input);
  },
  // ADR-0037 (slice 8.17). Per-thread label fan-out + per-mailbox catalog.
  addThreadLabel(
    input: AddThreadLabelInput,
  ): Promise<RpcResult<ThreadLabelResult>> {
    return call<ThreadLabelResult>("add_thread_label", input);
  },
  removeThreadLabel(
    input: RemoveThreadLabelInput,
  ): Promise<RpcResult<ThreadLabelResult>> {
    return call<ThreadLabelResult>("remove_thread_label", input);
  },
  listLabels(input: ListLabelsInput): Promise<RpcResult<ListLabelsResult>> {
    return call<ListLabelsResult>("list_labels", input);
  },
  createLabel(input: CreateLabelInput): Promise<CreateLabelRpcResult> {
    return callConflictAware<LabelCatalogEntry>("create_label", input);
  },
  deleteLabel(
    input: DeleteLabelInput,
  ): Promise<RpcResult<DeleteLabelResult>> {
    return call<DeleteLabelResult>("delete_label", input);
  },
  renameLabel(input: RenameLabelInput): Promise<RenameLabelRpcResult> {
    return callConflictAware<RenameLabelResult>("rename_label", input);
  },
  health(): Promise<Response> {
    return fetch(`${BFF_BASE}/health`);
  },
};

// 409 already_exists is surfaced as a typed `conflict` variant so the
// catalog UI can branch without sniffing HTTP status codes. All other
// error shapes pass through unchanged. Used by create_label and rename_label;
// other tools never produce 409 already_exists.
async function callConflictAware<T>(
  tool: string,
  body: unknown,
): Promise<RpcOk<T> | RpcInvalid | RpcConflict | RpcError> {
  let res: Response;
  try {
    res = await fetch(`${BFF_BASE}/rpc/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      kind: "error",
      code: "network_error",
      message: err instanceof Error ? err.message : "BFF unreachable",
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return {
      kind: "error",
      code: "invalid_response",
      message: `BFF returned non-JSON for /rpc/${tool}`,
    };
  }
  if (res.ok) {
    return { kind: "ok", value: data as T };
  }
  const obj = (data ?? {}) as Record<string, unknown>;
  const code = typeof obj["code"] === "string" ? obj["code"] : "unknown";
  const message =
    typeof obj["message"] === "string" ? obj["message"] : `HTTP ${res.status}`;
  if (res.status === 400 && code === "invalid_request") {
    return {
      kind: "invalid_request",
      field: typeof obj["field"] === "string" ? obj["field"] : "body",
      reason: (obj["reason"] as RpcInvalid["reason"]) ?? "invalid_type",
      message,
    };
  }
  if (res.status === 409 && code === "already_exists") {
    return { kind: "conflict", code, message };
  }
  return { kind: "error", code, message };
}
