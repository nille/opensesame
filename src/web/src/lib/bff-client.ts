// Typed client for the slice-7 BFF (ADR-0021).
//
// The BFF lifts transport outcomes to HTTP status codes; the client mirrors
// that into a discriminated result. UIs branch on `result.kind`, never on a
// raw status. When slice 9 swaps the BFF for an MCP client behind the same
// `/rpc/*` shape, only the base URL and the auth header change.

const BFF_BASE = (import.meta.env["VITE_BFF_BASE"] as string) ?? "http://127.0.0.1:3000";

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
export type RpcResult<T> = RpcOk<T> | RpcInvalid | RpcNotFound | RpcSuppressed | RpcError;

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

export type ReadMessageHeaders = {
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
  direction: "in" | "out";
  attachments: StoredAttachment[];
  read_at: string | null;
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
};

export type SendEmailResult = {
  message_id: string;
  sent_at: string;
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
  sendEmail(input: SendEmailInput): Promise<RpcResult<SendEmailResult>> {
    return call<SendEmailResult>("send_email", input);
  },
  health(): Promise<Response> {
    return fetch(`${BFF_BASE}/health`);
  },
};
