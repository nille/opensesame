// Hand-rolled parsers for the three slice-7 BFF tools (ADR-0021).
// Project convention: no Zod for flat shapes — see the `normalizeAuditRow`
// idiom in src/core/audit-query.ts and the in-tree-primitives memory.
//
// Each parser returns { ok: true, value } or { ok: false, error: { field,
// code } } so the dispatcher can map a 400 with a field-pointer body.
//
// Inputs match the MCP tool inputSchema shape (ADR-0007). When the MCP
// server lands, these types are the same JSON schemas the server publishes.

import {
  parseSearchQuery,
  type SearchAst,
} from "../core/search-operators.js";

export type ParseError = {
  field: string;
  code: "missing" | "invalid_type" | "invalid_value";
  message: string;
  position?: number;
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ParseError };

// ---- read_inbox ----

export type ReadInboxInput = {
  address: string;
  // Per ADR-0007: separate from `cursor`. ISO-8601 timestamp.
  since?: string;
  limit?: number;
  cursor?: string;
};

export function parseReadInboxInput(body: unknown): ParseResult<ReadInboxInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }

  const out: ReadInboxInput = { address };

  if (obj["since"] !== undefined) {
    const s = expectString(obj["since"]);
    if (s === null) {
      return fail("since", "invalid_type", "since must be an ISO-8601 string");
    }
    if (!Number.isFinite(Date.parse(s))) {
      return fail(
        "since",
        "invalid_value",
        "since is not a parseable ISO-8601 timestamp",
      );
    }
    out.since = s;
  }

  if (obj["limit"] !== undefined) {
    const n = obj["limit"];
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return fail("limit", "invalid_value", "limit must be a positive integer");
    }
    out.limit = n;
  }

  if (obj["cursor"] !== undefined) {
    const c = expectString(obj["cursor"]);
    if (c === null) {
      return fail("cursor", "invalid_type", "cursor must be a string");
    }
    out.cursor = c;
  }

  return ok(out);
}

// ---- get_message ----

export type GetMessageInput = {
  message_id: string;
};

export function parseGetMessageInput(
  body: unknown,
): ParseResult<GetMessageInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }
  const id = expectString(obj["message_id"]);
  if (id === null || id.length === 0) {
    return fail("message_id", "missing", "message_id is required");
  }
  return ok({ message_id: id });
}

// ---- get_attachment ----

export type GetAttachmentInput = {
  message_id: string;
  part_index: number;
};

export function parseGetAttachmentInput(
  body: unknown,
): ParseResult<GetAttachmentInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }
  const id = expectString(obj["message_id"]);
  if (id === null || id.length === 0) {
    return fail("message_id", "missing", "message_id is required");
  }
  const idx = obj["part_index"];
  if (idx === undefined) {
    return fail("part_index", "missing", "part_index is required");
  }
  if (
    typeof idx !== "number" ||
    !Number.isFinite(idx) ||
    !Number.isInteger(idx) ||
    idx < 0
  ) {
    return fail(
      "part_index",
      "invalid_value",
      "part_index must be a non-negative integer",
    );
  }
  return ok({ message_id: id, part_index: idx });
}

// ---- mark_read ----
//
// Two-form input. Self-addressed mail produces two rows (in + out) sharing
// one RFC 5322 Message-ID, so the GSI hop in the message_id form has a
// direction-ambiguity. UIs that already hold the inbox row's primary key
// should use the {address, internal_id} form; MCP and other consumers that
// only have a Message-ID stay on the message_id form.

export type MarkReadInput =
  | { kind: "by_message_id"; message_id: string }
  | { kind: "by_primary_key"; address: string; internal_id: string };

export function parseMarkReadInput(body: unknown): ParseResult<MarkReadInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }
  // Prefer the unambiguous primary-key form when both shapes are supplied.
  const address = expectString(obj["address"]);
  const internalId = expectString(obj["internal_id"]);
  if (address !== null || internalId !== null) {
    if (address === null || address.length === 0) {
      return fail("address", "missing", "address is required");
    }
    if (internalId === null || internalId.length === 0) {
      return fail("internal_id", "missing", "internal_id is required");
    }
    return ok({ kind: "by_primary_key", address, internal_id: internalId });
  }
  const id = expectString(obj["message_id"]);
  if (id === null || id.length === 0) {
    return fail("message_id", "missing", "message_id is required");
  }
  return ok({ kind: "by_message_id", message_id: id });
}

// ---- search_email ----
//
// Per ADR-0007: address + query are required, structured filters and time
// bounds optional. The query is the substring; structured filters (from,
// to, subject) AND-compose with it. since/until use ISO-8601 same as
// listInbox. Empty query is rejected — readInbox is the right tool for
// "give me everything", not search_email with an empty filter.

export type SearchEmailInput = {
  address: string;
  query: string;
  // ADR-0036 (slice 8.17). Parsed AST so the dispatcher can pass it
  // straight through to the reader without re-parsing. Always populated
  // when parseSearchEmailInput returns ok.
  ast: SearchAst;
  limit?: number;
  cursor?: string;
  since?: string;
  until?: string;
  from?: string;
  to?: string;
  subject?: string;
};

export function parseSearchEmailInput(
  body: unknown,
): ParseResult<SearchEmailInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }

  const query = expectString(obj["query"]);
  if (query === null) {
    return fail(
      "query",
      obj["query"] === undefined ? "missing" : "invalid_type",
      "query must be a non-empty string",
    );
  }
  if (query.length === 0) {
    return fail("query", "invalid_value", "query must be a non-empty string");
  }

  // ADR-0036: pre-parse the operator grammar at the BFF boundary. Invalid
  // grammar surfaces as a 400 with a position-aware message; valid input
  // produces an AST the reader executes verbatim.
  const parsedAst = parseSearchQuery(query);
  if (!parsedAst.ok) {
    const err: ParseError = {
      field: "query",
      code: "invalid_value",
      message: parsedAst.error.message,
    };
    if (parsedAst.error.position !== undefined) {
      err.position = parsedAst.error.position;
    }
    return { ok: false, error: err };
  }

  const out: SearchEmailInput = { address, query, ast: parsedAst.value };

  if (obj["limit"] !== undefined) {
    const n = obj["limit"];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n <= 0
    ) {
      return fail("limit", "invalid_value", "limit must be a positive integer");
    }
    out.limit = n;
  }

  if (obj["cursor"] !== undefined) {
    const c = expectString(obj["cursor"]);
    if (c === null) {
      return fail("cursor", "invalid_type", "cursor must be a string");
    }
    out.cursor = c;
  }

  for (const f of ["since", "until"] as const) {
    if (obj[f] !== undefined) {
      const s = expectString(obj[f]);
      if (s === null) {
        return fail(f, "invalid_type", `${f} must be an ISO-8601 string`);
      }
      if (!Number.isFinite(Date.parse(s))) {
        return fail(
          f,
          "invalid_value",
          `${f} is not a parseable ISO-8601 timestamp`,
        );
      }
      out[f] = s;
    }
  }

  for (const f of ["from", "to", "subject"] as const) {
    if (obj[f] !== undefined) {
      const s = expectString(obj[f]);
      if (s === null) {
        return fail(f, "invalid_type", `${f} must be a string`);
      }
      out[f] = s;
    }
  }

  return ok(out);
}

// ---- send_email ----

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

export function parseSendEmailInput(
  body: unknown,
): ParseResult<SendEmailInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const from = expectString(obj["from"]);
  if (from === null || from.length === 0) {
    return fail("from", "missing", "from is required");
  }

  const to = expectStringArray(obj["to"]);
  if (to === null || to.length === 0) {
    return fail(
      "to",
      to === null ? "invalid_type" : "missing",
      "to must be a non-empty array of strings",
    );
  }

  const subject = expectString(obj["subject"]);
  if (subject === null) {
    return fail(
      "subject",
      obj["subject"] === undefined ? "missing" : "invalid_type",
      "subject must be a string",
    );
  }

  const body_text = expectString(obj["body_text"]);
  if (body_text === null) {
    return fail(
      "body_text",
      obj["body_text"] === undefined ? "missing" : "invalid_type",
      "body_text must be a string",
    );
  }

  const out: SendEmailInput = { from, to, subject, body_text };

  if (obj["cc"] !== undefined) {
    const cc = expectStringArray(obj["cc"]);
    if (cc === null) {
      return fail("cc", "invalid_type", "cc must be an array of strings");
    }
    out.cc = cc;
  }
  if (obj["bcc"] !== undefined) {
    const bcc = expectStringArray(obj["bcc"]);
    if (bcc === null) {
      return fail("bcc", "invalid_type", "bcc must be an array of strings");
    }
    out.bcc = bcc;
  }
  if (obj["body_html"] !== undefined) {
    const h = expectString(obj["body_html"]);
    if (h === null) {
      return fail("body_html", "invalid_type", "body_html must be a string");
    }
    out.body_html = h;
  }
  if (obj["in_reply_to"] !== undefined) {
    const ir = expectString(obj["in_reply_to"]);
    if (ir === null) {
      return fail(
        "in_reply_to",
        "invalid_type",
        "in_reply_to must be a string",
      );
    }
    out.in_reply_to = ir;
  }
  if (obj["references"] !== undefined) {
    const refs = expectStringArray(obj["references"]);
    if (refs === null) {
      return fail(
        "references",
        "invalid_type",
        "references must be an array of strings",
      );
    }
    out.references = refs;
  }

  return ok(out);
}

// ---- reply_to_email ----

// Per ADR-0022 the caller passes only the parent's message_id and the body —
// from/to/cc/subject/in_reply_to/references are server-derived from the
// loaded parent. reply_all defaults to false; attachments are deferred to a
// later slice (signature mirrors ADR-0007 to keep the wire shape stable).
export type ReplyToEmailInput = {
  message_id: string;
  body_text: string;
  body_html?: string;
  reply_all?: boolean;
};

export function parseReplyToEmailInput(
  body: unknown,
): ParseResult<ReplyToEmailInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const messageId = expectString(obj["message_id"]);
  if (messageId === null || messageId.length === 0) {
    return fail("message_id", "missing", "message_id is required");
  }

  const bodyText = expectString(obj["body_text"]);
  if (bodyText === null) {
    return fail(
      "body_text",
      obj["body_text"] === undefined ? "missing" : "invalid_type",
      "body_text must be a string",
    );
  }

  const out: ReplyToEmailInput = {
    message_id: messageId,
    body_text: bodyText,
  };

  if (obj["body_html"] !== undefined) {
    const h = expectString(obj["body_html"]);
    if (h === null) {
      return fail("body_html", "invalid_type", "body_html must be a string");
    }
    out.body_html = h;
  }
  if (obj["reply_all"] !== undefined) {
    if (typeof obj["reply_all"] !== "boolean") {
      return fail(
        "reply_all",
        "invalid_type",
        "reply_all must be a boolean",
      );
    }
    out.reply_all = obj["reply_all"];
  }

  return ok(out);
}

// ---- list_thread_messages (ADR-0027) ----
//
// Single Query against ThreadIdGSI. No `address` in the input — the GSI
// partition is the thread, and a thread belongs to exactly one mailbox by
// indexing rule (every row in a thread shares an `address` because outbound
// replies clone the inbound parent's `address`). Limit defaults to 50; the
// dispatcher caps at 200.

export type ListThreadMessagesInput = {
  thread_id: string;
  limit?: number;
  cursor?: string;
};

export function parseListThreadMessagesInput(
  body: unknown,
): ParseResult<ListThreadMessagesInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  const out: ListThreadMessagesInput = { thread_id: threadId };

  if (obj["limit"] !== undefined) {
    const n = obj["limit"];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n <= 0
    ) {
      return fail("limit", "invalid_value", "limit must be a positive integer");
    }
    out.limit = n;
  }

  if (obj["cursor"] !== undefined) {
    const c = expectString(obj["cursor"]);
    if (c === null) {
      return fail("cursor", "invalid_type", "cursor must be a string");
    }
    out.cursor = c;
  }

  return ok(out);
}

// ---- star_thread (ADR-0028) ----
//
// Toggle the star annotation on every row in a thread. The dispatcher
// fans out per-row UpdateItems via ThreadIdGSI; the input is just the
// thread identity and the desired state.

export type StarThreadInput = {
  thread_id: string;
  starred: boolean;
};

export function parseStarThreadInput(
  body: unknown,
): ParseResult<StarThreadInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  if (obj["starred"] === undefined) {
    return fail("starred", "missing", "starred is required");
  }
  if (typeof obj["starred"] !== "boolean") {
    return fail("starred", "invalid_type", "starred must be a boolean");
  }

  return ok({ thread_id: threadId, starred: obj["starred"] });
}

// ---- snooze_thread (ADR-0029) ----
//
// Toggle the snooze annotation on every row in a thread. `snoozed_until`
// is a wake-time ISO-8601 string when snoozing or null when unsnoozing.
// The dispatcher fans out per-row UpdateItems via ThreadIdGSI; the input
// is just the thread identity and the desired wake time.
//
// `snoozed_until` is required (rather than defaulting to "now or null") so
// the wire shape is self-documenting: an explicit null means "unsnooze",
// a string means "snooze until this time". The past-time guard rejects
// snoozing into history — a typo'd wake time is friendlier as a 400
// than as a silent no-op.

export type SnoozeThreadInput = {
  thread_id: string;
  snoozed_until: string | null;
};

export function parseSnoozeThreadInput(
  body: unknown,
  now: Date = new Date(),
): ParseResult<SnoozeThreadInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  if (!("snoozed_until" in obj)) {
    return fail(
      "snoozed_until",
      "missing",
      "snoozed_until is required (ISO-8601 string to snooze, null to unsnooze)",
    );
  }

  const raw = obj["snoozed_until"];
  if (raw === null) {
    return ok({ thread_id: threadId, snoozed_until: null });
  }
  if (typeof raw !== "string") {
    return fail(
      "snoozed_until",
      "invalid_type",
      "snoozed_until must be a string or null",
    );
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return fail(
      "snoozed_until",
      "invalid_value",
      "snoozed_until is not a parseable ISO-8601 timestamp",
    );
  }
  if (parsed <= now.getTime()) {
    return fail(
      "snoozed_until",
      "invalid_value",
      "snoozed_until must be in the future",
    );
  }
  return ok({ thread_id: threadId, snoozed_until: raw });
}

// ---- trash_thread (ADR-0030) ----
//
// Toggle the trash (soft-delete) annotation on every row in a thread.
// Wire shape mirrors star: a boolean toggle, not a nullable timestamp.
// Re-trashing overwrites the on-row `trashed_at`; untrashing removes
// the attribute. The fan-out lives in the reader; the schema only
// validates wire shape.

export type TrashThreadInput = {
  thread_id: string;
  trashed: boolean;
};

export function parseTrashThreadInput(
  body: unknown,
): ParseResult<TrashThreadInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  if (obj["trashed"] === undefined) {
    return fail("trashed", "missing", "trashed is required");
  }
  if (typeof obj["trashed"] !== "boolean") {
    return fail("trashed", "invalid_type", "trashed must be a boolean");
  }

  return ok({ thread_id: threadId, trashed: obj["trashed"] });
}

// ADR-0031 (slice 8.13). Per-thread mark-read/unread toggle. Boolean wire
// shape mirrors star and trash; the dispatcher trusts the schema and the
// reader trusts its input.

export type MarkThreadReadInput = {
  thread_id: string;
  read: boolean;
};

export function parseMarkThreadReadInput(
  body: unknown,
): ParseResult<MarkThreadReadInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  if (obj["read"] === undefined) {
    return fail("read", "missing", "read is required");
  }
  if (typeof obj["read"] !== "boolean") {
    return fail("read", "invalid_type", "read must be a boolean");
  }

  return ok({ thread_id: threadId, read: obj["read"] });
}

// ---- archive_thread (ADR-0034) ----
//
// Toggle the archive annotation on every row in a thread. Wire shape is
// identical to trash (boolean toggle). The fan-out lives in the reader;
// the schema only validates wire shape.

export type ArchiveThreadInput = {
  thread_id: string;
  archived: boolean;
};

export function parseArchiveThreadInput(
  body: unknown,
): ParseResult<ArchiveThreadInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  if (obj["archived"] === undefined) {
    return fail("archived", "missing", "archived is required");
  }
  if (typeof obj["archived"] !== "boolean") {
    return fail("archived", "invalid_type", "archived must be a boolean");
  }

  return ok({ thread_id: threadId, archived: obj["archived"] });
}

// ---- save_draft (ADR-0035) ----
//
// Upsert-by-id. `draft_id: null` is first-save (server mints a ULID);
// `draft_id: <ulid>` is a subsequent save. The wire shape distinguishes
// "absent" (don't touch the field) from "explicit null" (clear the field)
// for to/cc/subject/in_reply_to/references — both round-trip through
// StoredDraft's nullable-string slots. body_text is required and may be
// empty; an empty body still counts as a saveable artifact (the operator
// just typed a subject and Cmd-Tabbed away).

export type SaveDraftWireInput = {
  address: string;
  draft_id: string | null;
  body_text: string;
  to?: string | null;
  cc?: string | null;
  subject?: string | null;
  in_reply_to?: string | null;
  references?: string | null;
};

export function parseSaveDraftInput(
  body: unknown,
): ParseResult<SaveDraftWireInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }

  // draft_id MUST be present (`null` for first-save, `string` for upsert).
  // An absent draft_id is a malformed request — the composer always knows
  // whether it's mid-typing a fresh draft or resuming one.
  if (!("draft_id" in obj)) {
    return fail(
      "draft_id",
      "missing",
      "draft_id is required (null for first save, string for upsert)",
    );
  }
  const rawId = obj["draft_id"];
  let draftId: string | null;
  if (rawId === null) {
    draftId = null;
  } else if (typeof rawId === "string") {
    if (rawId.length === 0) {
      return fail(
        "draft_id",
        "invalid_value",
        "draft_id must be null or a non-empty string",
      );
    }
    draftId = rawId;
  } else {
    return fail(
      "draft_id",
      "invalid_type",
      "draft_id must be null or a string",
    );
  }

  const bodyText = expectString(obj["body_text"]);
  if (bodyText === null) {
    return fail(
      "body_text",
      obj["body_text"] === undefined ? "missing" : "invalid_type",
      "body_text must be a string",
    );
  }

  const out: SaveDraftWireInput = {
    address,
    draft_id: draftId,
    body_text: bodyText,
  };

  for (const f of [
    "to",
    "cc",
    "subject",
    "in_reply_to",
    "references",
  ] as const) {
    if (f in obj) {
      const raw = obj[f];
      if (raw === null) {
        out[f] = null;
      } else if (typeof raw === "string") {
        out[f] = raw;
      } else {
        return fail(f, "invalid_type", `${f} must be a string or null`);
      }
    }
  }

  return ok(out);
}

// ---- list_drafts (ADR-0035) ----

export type ListDraftsWireInput = {
  address: string;
  limit?: number;
  cursor?: string;
};

export function parseListDraftsInput(
  body: unknown,
): ParseResult<ListDraftsWireInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }

  const out: ListDraftsWireInput = { address };

  if (obj["limit"] !== undefined) {
    const n = obj["limit"];
    if (
      typeof n !== "number" ||
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n <= 0
    ) {
      return fail("limit", "invalid_value", "limit must be a positive integer");
    }
    out.limit = n;
  }

  if (obj["cursor"] !== undefined) {
    const c = expectString(obj["cursor"]);
    if (c === null) {
      return fail("cursor", "invalid_type", "cursor must be a string");
    }
    out.cursor = c;
  }

  return ok(out);
}

// ---- get_draft / delete_draft (ADR-0035) ----

export type GetDraftWireInput = {
  address: string;
  draft_id: string;
};

export function parseGetDraftInput(
  body: unknown,
): ParseResult<GetDraftWireInput> {
  return parseAddressDraftId(body);
}

export type DeleteDraftWireInput = {
  address: string;
  draft_id: string;
};

export function parseDeleteDraftInput(
  body: unknown,
): ParseResult<DeleteDraftWireInput> {
  return parseAddressDraftId(body);
}

function parseAddressDraftId(
  body: unknown,
): ParseResult<{ address: string; draft_id: string }> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }

  const draftId = expectString(obj["draft_id"]);
  if (draftId === null || draftId.length === 0) {
    return fail("draft_id", "missing", "draft_id is required");
  }

  return ok({ address, draft_id: draftId });
}

// ---- label-name validator (ADR-0037, slice 8.17) ----
//
// Wire-level rules: 1–32 chars after trim, no ASCII control chars, no
// commas (a later `label:foo,bar` search syntax needs the comma free).
// Casing is preserved here; the dispatcher lowercases for catalog identity
// and the row-level fan-out. Empty-after-trim is rejected so we don't
// store invisible labels.

const LABEL_MAX_LEN = 32;

export function parseLabelName(
  raw: unknown,
  field: string = "label",
): ParseResult<string> {
  if (raw === undefined) {
    return fail(field, "missing", `${field} is required`);
  }
  if (typeof raw !== "string") {
    return fail(field, "invalid_type", `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fail(field, "invalid_value", `${field} must not be empty`);
  }
  if (trimmed.length > LABEL_MAX_LEN) {
    return fail(
      field,
      "invalid_value",
      `${field} must be ${LABEL_MAX_LEN} characters or fewer`,
    );
  }
  if (trimmed.includes(",")) {
    return fail(
      field,
      "invalid_value",
      `${field} must not contain commas`,
    );
  }
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return fail(
        field,
        "invalid_value",
        `${field} must not contain control characters`,
      );
    }
  }
  return ok(trimmed);
}

// ---- add_thread_label / remove_thread_label (ADR-0037) ----

export type AddThreadLabelWireInput = { thread_id: string; label: string };

export function parseAddThreadLabelInput(
  body: unknown,
): ParseResult<AddThreadLabelWireInput> {
  return parseThreadLabelTuple(body);
}

export type RemoveThreadLabelWireInput = { thread_id: string; label: string };

export function parseRemoveThreadLabelInput(
  body: unknown,
): ParseResult<RemoveThreadLabelWireInput> {
  return parseThreadLabelTuple(body);
}

function parseThreadLabelTuple(
  body: unknown,
): ParseResult<{ thread_id: string; label: string }> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }

  const threadId = expectString(obj["thread_id"]);
  if (threadId === null || threadId.length === 0) {
    return fail("thread_id", "missing", "thread_id is required");
  }

  const label = parseLabelName(obj["label"], "label");
  if (!label.ok) return label;

  return ok({ thread_id: threadId, label: label.value });
}

// ---- list_labels (ADR-0037) ----

export type ListLabelsWireInput = { address: string };

export function parseListLabelsInput(
  body: unknown,
): ParseResult<ListLabelsWireInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }
  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }
  return ok({ address });
}

// ---- create_label / delete_label (ADR-0037) ----

export type CreateLabelWireInput = { address: string; label: string };

export function parseCreateLabelInput(
  body: unknown,
): ParseResult<CreateLabelWireInput> {
  return parseAddressLabelTuple(body);
}

export type DeleteLabelWireInput = { address: string; label: string };

export function parseDeleteLabelInput(
  body: unknown,
): ParseResult<DeleteLabelWireInput> {
  return parseAddressLabelTuple(body);
}

function parseAddressLabelTuple(
  body: unknown,
): ParseResult<{ address: string; label: string }> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }
  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }
  const label = parseLabelName(obj["label"], "label");
  if (!label.ok) return label;
  return ok({ address, label: label.value });
}

// ---- rename_label (ADR-0037) ----

export type RenameLabelWireInput = {
  address: string;
  from: string;
  to: string;
};

export function parseRenameLabelInput(
  body: unknown,
): ParseResult<RenameLabelWireInput> {
  const obj = expectObject(body);
  if (obj === null) {
    return fail("body", "invalid_type", "request body must be a JSON object");
  }
  const address = expectString(obj["address"]);
  if (address === null || address.length === 0) {
    return fail("address", "missing", "address is required");
  }
  const from = parseLabelName(obj["from"], "from");
  if (!from.ok) return from;
  const to = parseLabelName(obj["to"], "to");
  if (!to.ok) return to;
  if (from.value.toLowerCase() === to.value.toLowerCase()) {
    return fail(
      "to",
      "invalid_value",
      "to must differ from from (case-insensitive)",
    );
  }
  return ok({ address, from: from.value, to: to.value });
}

// ---- helpers ----

function expectObject(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function expectString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function expectStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const item of v) {
    if (typeof item !== "string") return null;
  }
  return v as string[];
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail<T>(
  field: string,
  code: ParseError["code"],
  message: string,
): ParseResult<T> {
  return { ok: false, error: { field, code, message } };
}
