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
import { parseMime } from "../core/parser.js";
import type { RawMessageReader } from "../core/raw-store.js";
import {
  buildReplyComposeInput,
  ReplyParentUnrepliable,
} from "../core/reply-to-email.js";
import type {
  AddThreadLabelInput as ReaderAddThreadLabelInput,
  CreateLabelInput as ReaderCreateLabelInput,
  DeleteDraftInput as ReaderDeleteDraftInput,
  DeleteLabelInput as ReaderDeleteLabelInput,
  GetDraftInput as ReaderGetDraftInput,
  ListDraftsInput as ReaderListDraftsInput,
  ListInboxInput,
  ListLabelsInput as ReaderListLabelsInput,
  ListThreadMessagesInput as ReaderListThreadMessagesInput,
  MessageReader,
  RemoveThreadLabelInput as ReaderRemoveThreadLabelInput,
  RenameLabelInput as ReaderRenameLabelInput,
  SaveDraftInput as ReaderSaveDraftInput,
  SearchEmailInput as ReaderSearchEmailInput,
} from "../core/store.js";
import { SuppressionBlockError } from "../core/suppression.js";
import {
  parseAddThreadLabelInput,
  parseArchiveThreadInput,
  parseCreateLabelInput,
  parseDeleteDraftInput,
  parseDeleteLabelInput,
  parseGetAttachmentInput,
  parseGetDraftInput,
  parseGetMessageInput,
  parseListDraftsInput,
  parseListLabelsInput,
  parseListThreadMessagesInput,
  parseMarkReadInput,
  parseMarkThreadReadInput,
  parseReadInboxInput,
  parseRemoveThreadLabelInput,
  parseRenameLabelInput,
  parseReplyToEmailInput,
  parseSaveDraftInput,
  parseSearchEmailInput,
  parseSendEmailInput,
  parseSnoozeThreadInput,
  parseStarThreadInput,
  parseTrashThreadInput,
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
  // ADR-0042 (slice 8.21): reading rich text. When provided, get_message
  // re-parses the raw MIME from S3 and fills body_html on the response. When
  // absent (tests, CLI drivers), get_message returns body_html: null.
  rawReader?: RawMessageReader;
};

// 60s is enough for the browser to follow the redirect immediately. Short
// TTLs limit blast radius if a URL leaks via referrer or shoulder-surfing.
const ATTACHMENT_URL_TTL_SECONDS = 60;

export type DispatchResult = {
  status: number;
  body: unknown;
};

const DEFAULT_INBOX_LIMIT = 50;
// Threading conversations rarely exceed this; the cap stays bounded so a
// single Query against the GSI is the page-size minimum, not a scan-size
// runaway. ADR-0027 calls out 200 as the upper bound.
const DEFAULT_THREAD_LIMIT = 50;
const MAX_THREAD_LIMIT = 200;
// ADR-0035: drafts list page size. Cap matches DEFAULT_INBOX_LIMIT — the
// composer rarely needs more than a screenful at once.
const DEFAULT_DRAFTS_LIMIT = 50;
const MAX_DRAFTS_LIMIT = 200;

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
    case "list_thread_messages":
      return handleListThreadMessages(deps, body);
    case "star_thread":
      return handleStarThread(deps, body);
    case "snooze_thread":
      return handleSnoozeThread(deps, body);
    case "trash_thread":
      return handleTrashThread(deps, body);
    case "mark_thread_read":
      return handleMarkThreadRead(deps, body);
    case "archive_thread":
      return handleArchiveThread(deps, body);
    case "save_draft":
      return handleSaveDraft(deps, body);
    case "list_drafts":
      return handleListDrafts(deps, body);
    case "get_draft":
      return handleGetDraft(deps, body);
    case "delete_draft":
      return handleDeleteDraft(deps, body);
    case "add_thread_label":
      return handleAddThreadLabel(deps, body);
    case "remove_thread_label":
      return handleRemoveThreadLabel(deps, body);
    case "list_labels":
      return handleListLabels(deps, body);
    case "create_label":
      return handleCreateLabel(deps, body);
    case "delete_label":
      return handleDeleteLabel(deps, body);
    case "rename_label":
      return handleRenameLabel(deps, body);
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
    if (message.parse_status === "ok") {
      const bodyHtml = await tryRehydrateHtml(deps, message.raw_s3_uri);
      return ok({ ...message, body_html: bodyHtml });
    }
    return ok(message);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0042 (slice 8.21). Best-effort re-parse of the raw MIME object to
// extract a text/html part for the reader pane. Returns null on every
// failure path (no raw reader configured, missing S3 object, parser
// throws, no html part in the message). The dispatcher never propagates
// these failures: the text/plain render is the always-correct fallback.
async function tryRehydrateHtml(
  deps: BffDeps,
  rawS3Uri: string,
): Promise<string | null> {
  if (deps.rawReader === undefined) return null;
  try {
    const raw = await deps.rawReader.getRaw(rawS3Uri);
    if (raw === null) return null;
    const parsed = parseMime(raw);
    return parsed.bodyHtml;
  } catch {
    return null;
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
    ast: parsed.value.ast,
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

async function handleListThreadMessages(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseListThreadMessagesInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const requested = parsed.value.limit ?? DEFAULT_THREAD_LIMIT;
  const input: ReaderListThreadMessagesInput = {
    thread_id: parsed.value.thread_id,
    limit: Math.min(requested, MAX_THREAD_LIMIT),
    cursor: parsed.value.cursor ?? null,
  };

  try {
    const result = await deps.reader.listThreadMessages(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0028 (slice 8.10). Star is a 200 in every non-malformed-input case
// — empty thread (no rows on ThreadIdGSI) returns updated_count: 0 rather
// than 404 so a stale inbox-window rollup doesn't surface as an error.
async function handleStarThread(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseStarThreadInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const result = await deps.reader.starThread(parsed.value, new Date());
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0029 (slice 8.11). Same status-code shape as star_thread — empty
// thread is a 200 no-op rather than 404. The schema enforces the
// "snoozed_until must be in the future" guard, threading `now` through
// so dispatch and parse share one clock.
async function handleSnoozeThread(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const now = new Date();
  const parsed = parseSnoozeThreadInput(body, now);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const result = await deps.reader.snoozeThread(parsed.value, now);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0030 (slice 8.12). Same status-code shape as star_thread / snooze_thread
// — empty thread is a 200 no-op rather than 404. Wire shape mirrors
// star_thread (boolean toggle, not a nullable timestamp).
async function handleTrashThread(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseTrashThreadInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const result = await deps.reader.trashThread(parsed.value, new Date());
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0031 (slice 8.13). Per-thread read/unread toggle. Empty thread or
// outbound-only thread is a 200 no-op (updated_count: 0), not 404.
async function handleMarkThreadRead(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseMarkThreadReadInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const result = await deps.reader.markThreadRead(parsed.value, new Date());
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0034 (slice 8.16). Per-thread archive toggle. Same status-code
// shape as trash_thread — empty thread is a 200 no-op rather than 404.
async function handleArchiveThread(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseArchiveThreadInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  try {
    const result = await deps.reader.archiveThread(parsed.value, new Date());
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0035 (slice 8.17). Drafts: parallel data plane in the Messages
// table. save / list / get / delete map to 200 / 400 / 404 / 500 — no 409
// (no suppression posture), no 422 (no parent-required guard).

async function handleSaveDraft(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseSaveDraftInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  // Build the reader-shaped input — keep absent optional fields absent so
  // the reader can distinguish "don't touch" from "explicit null".
  const wire = parsed.value;
  const input: ReaderSaveDraftInput = {
    address: wire.address,
    draft_id: wire.draft_id,
    body_text: wire.body_text,
  };
  for (const f of [
    "body_html",
    "to",
    "cc",
    "subject",
    "in_reply_to",
    "references",
  ] as const) {
    if (f in wire) {
      const v = wire[f];
      if (v !== undefined) input[f] = v;
    }
  }

  try {
    const result = await deps.reader.saveDraft(input, new Date());
    if (result === null) {
      return {
        status: 404,
        body: {
          code: "draft_not_found",
          message: `no draft ${wire.draft_id} for ${wire.address}`,
        },
      };
    }
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleListDrafts(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseListDraftsInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const requested = parsed.value.limit ?? DEFAULT_DRAFTS_LIMIT;
  const input: ReaderListDraftsInput = {
    address: parsed.value.address,
    limit: Math.min(requested, MAX_DRAFTS_LIMIT),
    cursor: parsed.value.cursor ?? null,
  };

  try {
    const result = await deps.reader.listDrafts(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleGetDraft(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseGetDraftInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderGetDraftInput = {
    address: parsed.value.address,
    draft_id: parsed.value.draft_id,
  };

  try {
    const result = await deps.reader.getDraft(input);
    if (result === null) {
      return {
        status: 404,
        body: {
          code: "draft_not_found",
          message: `no draft ${input.draft_id} for ${input.address}`,
        },
      };
    }
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleDeleteDraft(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseDeleteDraftInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderDeleteDraftInput = {
    address: parsed.value.address,
    draft_id: parsed.value.draft_id,
  };

  try {
    const result = await deps.reader.deleteDraft(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

// ADR-0037 (slice 8.17). Operator-defined labels.
//
// add_thread_label / remove_thread_label fan out across ThreadIdGSI; empty
// thread is a 200 no-op (updated_count: 0), mirroring star_thread's posture.
// list_labels is one Query against the catalog SK prefix. create_label /
// rename_label return null on conflict → 409 already_exists; delete_label
// is idempotent against a missing catalog entry — the bulk strip across
// rows runs regardless of whether the catalog row was there.

async function handleAddThreadLabel(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseAddThreadLabelInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderAddThreadLabelInput = {
    thread_id: parsed.value.thread_id,
    label: parsed.value.label,
  };

  try {
    const result = await deps.reader.addThreadLabel(input, new Date());
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleRemoveThreadLabel(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseRemoveThreadLabelInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderRemoveThreadLabelInput = {
    thread_id: parsed.value.thread_id,
    label: parsed.value.label,
  };

  try {
    const result = await deps.reader.removeThreadLabel(input, new Date());
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleListLabels(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseListLabelsInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderListLabelsInput = { address: parsed.value.address };

  try {
    const result = await deps.reader.listLabels(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleCreateLabel(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseCreateLabelInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderCreateLabelInput = {
    address: parsed.value.address,
    label: parsed.value.label,
  };

  try {
    const result = await deps.reader.createLabel(input, new Date());
    if (result === null) {
      return {
        status: 409,
        body: {
          code: "already_exists",
          message: `label ${input.label} already exists for ${input.address}`,
        },
      };
    }
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleDeleteLabel(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseDeleteLabelInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderDeleteLabelInput = {
    address: parsed.value.address,
    label: parsed.value.label,
  };

  try {
    const result = await deps.reader.deleteLabel(input);
    return ok(result);
  } catch (err) {
    return internalError(err);
  }
}

async function handleRenameLabel(
  deps: BffDeps,
  body: unknown,
): Promise<DispatchResult> {
  const parsed = parseRenameLabelInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  const input: ReaderRenameLabelInput = {
    address: parsed.value.address,
    from: parsed.value.from,
    to: parsed.value.to,
  };

  try {
    const result = await deps.reader.renameLabel(input, new Date());
    if (result === null) {
      return {
        status: 409,
        body: {
          code: "already_exists",
          message: `label ${input.to} already exists for ${input.address}`,
        },
      };
    }
    return ok(result);
  } catch (err) {
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
  const body: Record<string, unknown> = {
    code: "invalid_request",
    field: error.field,
    reason: error.code,
    message: error.message,
  };
  // ADR-0036: search-operator parse errors carry an optional byte offset
  // so the web client can underline the bad token. Reserved on the wire
  // even though slice 8.17's UI only renders the message.
  if (error.position !== undefined) body.position = error.position;
  return { status: 400, body };
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
