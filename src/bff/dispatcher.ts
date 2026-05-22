// Framework-agnostic BFF dispatcher (ADR-0021).
//
// Takes a parsed { path, body } and returns { status, body }. The Hono
// adapter wraps this trivially; tests bypass Hono entirely by calling
// dispatch() directly.
//
// Responsibilities:
//   1. Route table lookup by tool name. 404 on unknown.
//   2. Per-tool input parsing via src/bff/schemas. 400 on shape mismatch
//      with a field-pointer body.
//   3. Handler invocation against deps.
//   4. Error → HTTP status mapping (404 for not-found, 409 for suppression,
//      500 for unexpected).
//
// The handler bodies are intentionally thin — the real work lives in the
// core ports (MessageReader, sendEmail). Slice 9 swaps the deps for an MCP
// client; this file does not change.

import type {
  AttachmentPresigner,
  PresignAttachmentInput,
} from "../core/attachment-store.js";
import { makeAttachmentS3Key } from "../core/attachment-store.js";
import {
  buildReplyComposeInput,
  ReplyParentUnrepliable,
} from "../core/reply-to-email.js";
import type {
  ListInboxInput,
  MessageReader,
  SearchEmailInput as ReaderSearchEmailInput,
} from "../core/store.js";
import { SuppressionBlockError } from "../core/suppression.js";
import {
  parseGetAttachmentInput,
  parseGetMessageInput,
  parseMarkReadInput,
  parseReadInboxInput,
  parseReplyToEmailInput,
  parseSearchEmailInput,
  parseSendEmailInput,
  type ParseError,
  type SendEmailInput,
} from "./schemas.js";

export type SendEmailResult = {
  message_id: string;
  sent_at: string;
};

export type BffDeps = {
  reader: MessageReader;
  sendEmail: (input: SendEmailInput) => Promise<SendEmailResult>;
  // get_attachment: optional so existing tests/drivers keep working without
  // wiring presigning. When absent the dispatcher returns 501 for the tool.
  attachmentPresigner?: AttachmentPresigner;
  // Bucket holding `attachments/...` objects. Must be the same bucket the
  // ingest/persist-outbound path writes to (the raw-MIME bucket per ADR-0012).
  attachmentBucket?: string;
};

// 60s is enough for the browser to follow the redirect immediately. Short
// TTLs limit blast radius if a URL leaks via referrer or shoulder-surfing.
const ATTACHMENT_URL_TTL_SECONDS = 60;

export type DispatchResult = {
  status: number;
  body: unknown;
};

const DEFAULT_INBOX_LIMIT = 50;

const RPC_PREFIX = "/rpc/";

export async function dispatch(
  deps: BffDeps,
  path: string,
  body: unknown,
): Promise<DispatchResult> {
  if (!path.startsWith(RPC_PREFIX)) {
    return notFound("tool_not_found", `no tool at path ${path}`);
  }

  const tool = path.slice(RPC_PREFIX.length);
  switch (tool) {
    case "read_inbox":
      return handleReadInbox(deps, body);
    case "get_message":
      return handleGetMessage(deps, body);
    case "get_attachment":
      return handleGetAttachment(deps, body);
    case "mark_read":
      return handleMarkRead(deps, body);
    case "search_email":
      return handleSearchEmail(deps, body);
    case "send_email":
      return handleSendEmail(deps, body);
    case "reply_to_email":
      return handleReplyToEmail(deps, body);
    default:
      return notFound("tool_not_found", `unknown tool: ${tool}`);
  }
}

async function handleReadInbox(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseReadInboxInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ListInboxInput = {
    address: parsed.value.address,
    limit: parsed.value.limit ?? DEFAULT_INBOX_LIMIT,
    since: parsed.value.since ?? null,
    cursor: parsed.value.cursor ?? null,
  };

  try {
    const result = await deps.reader.listInbox(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleGetMessage(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseGetMessageInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const message = await deps.reader.getByMessageId(parsed.value.message_id);
    if (message === null) {
      return {
        status: 404,
        body: {
          code: "message_not_found",
          message: `no message with id ${parsed.value.message_id}`,
        },
      };
    }
    return ok(message);
  } catch (err) {
    return internalError(err);
  }
}

async function handleGetAttachment(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseGetAttachmentInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  if (deps.attachmentPresigner === undefined || deps.attachmentBucket === undefined) {
    return {
      status: 501,
      body: {
        code: "not_implemented",
        message:
          "get_attachment is not configured on this BFF (missing presigner)",
      },
    };
  }

  try {
    const message = await deps.reader.getByMessageId(parsed.value.message_id);
    if (message === null) {
      return {
        status: 404,
        body: {
          code: "message_not_found",
          message: `no message with id ${parsed.value.message_id}`,
        },
      };
    }
    if (message.parse_status === "failed") {
      // Skeleton rows never carry an attachment list — parse never produced
      // one. Surface as 404 so the UI can render "no attachments" cleanly.
      return {
        status: 404,
        body: {
          code: "attachment_not_found",
          message: "message failed to parse and has no attachments",
        },
      };
    }
    const attachment = message.attachments.find(
      (a) => a.part_index === parsed.value.part_index,
    );
    if (attachment === undefined) {
      return {
        status: 404,
        body: {
          code: "attachment_not_found",
          message: `no attachment with part_index ${parsed.value.part_index}`,
        },
      };
    }

    const presignInput: PresignAttachmentInput = {
      bucket: deps.attachmentBucket,
      key: makeAttachmentS3Key(
        message.address,
        message.internal_id,
        attachment.part_index,
      ),
      contentType: attachment.content_type,
      filename: attachment.filename,
      expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    };
    const presigned = await deps.attachmentPresigner.presignDownload(
      presignInput,
    );
    return ok({
      url: presigned.url,
      expires_at: presigned.expiresAt,
      content_type: attachment.content_type,
      filename: attachment.filename,
      size_bytes: attachment.size_bytes,
    });
  } catch (err) {
    return internalError(err);
  }
}

async function handleMarkRead(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseMarkReadInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);
  const input = parsed.value;

  try {
    const now = new Date();
    const result =
      input.kind === "by_primary_key"
        ? await deps.reader.markReadByPrimaryKey(
            input.address,
            input.internal_id,
            now,
          )
        : await deps.reader.markRead(input.message_id, now);

    if (result.kind === "not_found") {
      const ident =
        input.kind === "by_primary_key"
          ? `${input.address}/${input.internal_id}`
          : input.message_id;
      return {
        status: 404,
        body: {
          code: "message_not_found",
          message: `no message ${ident}`,
        },
      };
    }
    // Echo whichever identifier the caller supplied, so the response shape
    // mirrors the request and the UI doesn't need a second lookup.
    const echo: Record<string, unknown> =
      input.kind === "by_primary_key"
        ? { address: input.address, internal_id: input.internal_id }
        : { message_id: input.message_id };
    return ok({
      ...echo,
      read_at: result.read_at,
      already_read: result.kind === "already_read",
    });
  } catch (err) {
    return internalError(err);
  }
}

async function handleSearchEmail(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseSearchEmailInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderSearchEmailInput = {
    address: parsed.value.address,
    query: parsed.value.query,
    limit: parsed.value.limit ?? DEFAULT_INBOX_LIMIT,
    cursor: parsed.value.cursor ?? null,
    since: parsed.value.since ?? null,
    until: parsed.value.until ?? null,
    from: parsed.value.from ?? null,
    to: parsed.value.to ?? null,
    subject: parsed.value.subject ?? null,
  };

  try {
    const result = await deps.reader.searchEmail(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleSendEmail(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseSendEmailInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const result = await deps.sendEmail(parsed.value);
    return ok(result);
  } catch (err) {
    if (err instanceof SuppressionBlockError) {
      return {
        status: 409,
        body: {
          code: "suppressed",
          message: "one or more recipients are on the suppression list",
          blocked_recipients: err.suppressed.map((s) => s.recipient),
        },
      };
    }
    return internalError(err);
  }
}

async function handleReplyToEmail(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseReplyToEmailInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);
  const input = parsed.value;

  let parent;
  try {
    parent = await deps.reader.getByMessageId(input.message_id);
  } catch (err) {
    return internalError(err);
  }
  if (parent === null) {
    return {
      status: 404,
      body: {
        code: "parent_not_found",
        message: `no message with id ${input.message_id}`,
      },
    };
  }
  if (parent.parse_status === "failed") {
    return {
      status: 422,
      body: {
        code: "parent_unrepliable",
        reason: "skeleton",
        message: "parent failed to parse and cannot be replied to",
      },
    };
  }

  let compose: SendEmailInput;
  try {
    const replyBody =
      input.body_html !== undefined
        ? { body_text: input.body_text, body_html: input.body_html }
        : { body_text: input.body_text };
    compose = buildReplyComposeInput(parent, replyBody, {
      reply_all: input.reply_all ?? false,
    });
  } catch (err) {
    if (err instanceof ReplyParentUnrepliable) {
      return {
        status: 422,
        body: {
          code: "parent_unrepliable",
          reason: err.reason,
          message: err.message,
        },
      };
    }
    return internalError(err);
  }

  // Reuse the send_email path: shared suppression handling, audit trail,
  // outbound persistence (ADR-0017). The 409 mapping below mirrors send_email.
  try {
    const result = await deps.sendEmail(compose);
    return ok(result);
  } catch (err) {
    if (err instanceof SuppressionBlockError) {
      return {
        status: 409,
        body: {
          code: "suppressed",
          message: "one or more recipients are on the suppression list",
          blocked_recipients: err.suppressed.map((s) => s.recipient),
        },
      };
    }
    return internalError(err);
  }
}

function ok(value: unknown): DispatchResult {
  return { status: 200, body: value };
}

function notFound(code: string, message: string): DispatchResult {
  return { status: 404, body: { code, message } };
}

function invalidRequest(error: ParseError): DispatchResult {
  return {
    status: 400,
    body: {
      code: "invalid_request",
      field: error.field,
      reason: error.code,
      message: error.message,
    },
  };
}

// Never echoes the underlying error message — could carry DDB conditional
// expression text or AWS request IDs that don't belong in a UI response.
function internalError(_err: unknown): DispatchResult {
  return {
    status: 500,
    body: {
      code: "internal_error",
      message: "an unexpected error occurred",
    },
  };
}
