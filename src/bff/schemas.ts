// Hand-rolled parsers for the three slice-7 BFF tools (ADR-0021).
// Project convention: no Zod for flat shapes — see the `normalizeAuditRow`
// idiom in src/core/audit-query.ts and the in-tree-primitives memory.
//
// Each parser returns { ok: true, value } or { ok: false, error: { field,
// code } } so the dispatcher can map a 400 with a field-pointer body.
//
// Inputs match the MCP tool inputSchema shape (ADR-0007). When the MCP
// server lands, these types are the same JSON schemas the server publishes.

export type ParseError = {
  field: string;
  code: "missing" | "invalid_type" | "invalid_value";
  message: string;
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

  const out: SearchEmailInput = { address, query };

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
