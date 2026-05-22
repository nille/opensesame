import { describe, expect, it, vi } from "vitest";
import { dispatch, type BffDeps } from "../src/bff/dispatcher.js";

// Dispatcher is framework-agnostic per ADR-0021: it takes a parsed
// {path, body} and returns {status, body}. The Hono adapter wraps it
// trivially; tests bypass Hono entirely.
//
// The dispatcher's job is:
//   1. route table lookup (404 on unknown tool)
//   2. per-tool input parsing (400 on shape mismatch)
//   3. handler invocation
//   4. error → HTTP status mapping (404 not found, 409 suppression, etc.)
//
// We test it against stubbed BffDeps so handler logic is mocked out — the
// handler-level behavior is covered by handler-specific tests.

function makeDeps(overrides: Partial<BffDeps> = {}): BffDeps {
  // Intentionally shallow — every field is a stub the test fills in.
  const noop: () => never = () => {
    throw new Error("test stub: not configured for this call");
  };
  return {
    reader: {
      listInbox: vi.fn(noop),
      getByMessageId: vi.fn(noop),
      getByPrimaryKey: vi.fn(noop),
      markRead: vi.fn(noop),
      markReadByPrimaryKey: vi.fn(noop),
    },
    sendEmail: vi.fn(noop),
    ...overrides,
  };
}

describe("dispatch", () => {
  it("returns 404 for an unknown tool name", async () => {
    const deps = makeDeps();
    const r = await dispatch(deps, "/rpc/no_such_tool", {});
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "tool_not_found" });
  });

  it("returns 404 for a path that isn't /rpc/<name>", async () => {
    const r = await dispatch(makeDeps(), "/health", {});
    expect(r.status).toBe(404);
  });

  it("returns 400 with a field-pointer body when input parsing fails", async () => {
    const r = await dispatch(makeDeps(), "/rpc/read_inbox", { limit: 10 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "address",
    });
  });

  it("read_inbox: forwards parsed input to reader.listInbox and returns its result", async () => {
    const listInbox = vi.fn(async () => ({
      messages: [],
      next_cursor: null,
    }));
    const deps = makeDeps({
      reader: {
        listInbox,
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/read_inbox", {
      address: "alice@example.com",
      limit: 5,
    });
    expect(r.status).toBe(200);
    expect(listInbox).toHaveBeenCalledWith({
      address: "alice@example.com",
      limit: 5,
      // dispatcher fills nullable fields the reader expects
      since: null,
      cursor: null,
    });
    expect(r.body).toEqual({ messages: [], next_cursor: null });
  });

  it("get_message: returns 404 when the reader returns null", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => null),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<missing@example.com>",
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "message_not_found" });
  });

  it("get_message: returns 200 with the read message on success", async () => {
    const stored = {
      parse_status: "ok" as const,
      schema_v: "1" as const,
      address: "alice@example.com",
      internal_id: "01J0000000ABCDEFGHJKMNPQRS",
      received_at: "2026-05-21T12:00:00Z",
      raw_s3_uri: "s3://opensesame-raw-mime-x/abc",
      headers: {
        from: "sender@example.com",
        to: "alice@example.com",
        cc: null,
        subject: "Hello",
        date: "Thu, 21 May 2026 12:00:00 +0000",
        message_id: "<msg-1@example.com>",
        in_reply_to: null,
        references: null,
        auto_submitted: "no",
        list_id: null,
      },
      headers_blob: "From: ...",
      body_text: "Hi there.",
      direction: "in" as const,
      attachments: [],
      read_at: null,
    };
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => stored),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      headers: { subject: "Hello" },
      body_text: "Hi there.",
    });
  });

  it("send_email: 200 with the sender's result on success", async () => {
    const sendEmail = vi.fn(async () => ({
      message_id: "<sent-1@example.com>",
      sent_at: "2026-05-21T12:34:56.000Z",
    }));
    const deps = makeDeps({ sendEmail });
    const r = await dispatch(deps, "/rpc/send_email", {
      from: "test@nille.net",
      to: ["alice@example.com"],
      subject: "Hi",
      body_text: "Body.",
    });
    expect(r.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(r.body).toEqual({
      message_id: "<sent-1@example.com>",
      sent_at: "2026-05-21T12:34:56.000Z",
    });
  });

  it("send_email: 409 with blocked_recipients when sender throws SuppressionBlockError", async () => {
    const { SuppressionBlockError } = await import(
      "../src/core/suppression.js"
    );
    const sendEmail = vi.fn(async () => {
      throw new SuppressionBlockError([
        {
          recipient: "blocked@example.com",
          reason: "bounced_permanent",
          last_event_at: "2026-05-20T00:00:00Z",
        },
      ]);
    });
    const deps = makeDeps({ sendEmail });
    const r = await dispatch(deps, "/rpc/send_email", {
      from: "test@nille.net",
      to: ["blocked@example.com"],
      subject: "Hi",
      body_text: "Body.",
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: "suppressed",
      blocked_recipients: ["blocked@example.com"],
    });
  });

  it("get_attachment: 400 when part_index is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/get_attachment", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "part_index",
    });
  });

  it("get_attachment: 400 when part_index is negative", async () => {
    const r = await dispatch(makeDeps(), "/rpc/get_attachment", {
      message_id: "<msg-1@example.com>",
      part_index: -1,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ field: "part_index" });
  });

  it("get_attachment: 501 when no presigner is configured on deps", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/get_attachment", {
      message_id: "<msg-1@example.com>",
      part_index: 0,
    });
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ code: "not_implemented" });
  });

  it("get_attachment: 404 when the message is not found", async () => {
    const deps: BffDeps = {
      ...makeDeps(),
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => null),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
      attachmentPresigner: {
        presignDownload: vi.fn(),
      },
      attachmentBucket: "raw-mime-test",
    };
    const r = await dispatch(deps, "/rpc/get_attachment", {
      message_id: "<gone@example.com>",
      part_index: 0,
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "message_not_found" });
  });

  it("get_attachment: 404 when the message parsed but has no matching part_index", async () => {
    const stored = {
      parse_status: "ok" as const,
      schema_v: "1" as const,
      address: "alice@example.com",
      internal_id: "01J0000000ABCDEFGHJKMNPQRS",
      received_at: "2026-05-21T12:00:00Z",
      raw_s3_uri: "s3://opensesame-raw-mime-x/abc",
      headers: {
        from: "sender@example.com",
        to: "alice@example.com",
        cc: null,
        subject: "Hello",
        date: null,
        message_id: "<msg-1@example.com>",
        in_reply_to: null,
        references: null,
        auto_submitted: "no",
        list_id: null,
      },
      headers_blob: "",
      body_text: "",
      direction: "in" as const,
      attachments: [
        {
          filename: "x.png",
          content_type: "image/png",
          size_bytes: 4,
          content_id: null,
          part_index: 0,
          sha256: "aaaa",
        },
      ],
      read_at: null,
    };
    const presign = vi.fn();
    const deps: BffDeps = {
      ...makeDeps(),
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => stored),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
      attachmentPresigner: { presignDownload: presign },
      attachmentBucket: "raw-mime-test",
    };
    const r = await dispatch(deps, "/rpc/get_attachment", {
      message_id: "<msg-1@example.com>",
      part_index: 7,
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "attachment_not_found" });
    expect(presign).not.toHaveBeenCalled();
  });

  it("get_attachment: 404 when the message parse_status is failed", async () => {
    const skeleton = {
      parse_status: "failed" as const,
      schema_v: "1" as const,
      address: "alice@example.com",
      internal_id: "01J0000000ABCDEFGHJKMNPQRS",
      received_at: "2026-05-21T12:00:00Z",
      raw_s3_uri: "s3://opensesame-raw-mime-x/abc",
      parse_error: "bad MIME",
    };
    const deps: BffDeps = {
      ...makeDeps(),
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => skeleton),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
      attachmentPresigner: { presignDownload: vi.fn() },
      attachmentBucket: "raw-mime-test",
    };
    const r = await dispatch(deps, "/rpc/get_attachment", {
      message_id: "<msg-1@example.com>",
      part_index: 0,
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "attachment_not_found" });
  });

  it("get_attachment: 200 with presigned URL and metadata on success", async () => {
    const stored = {
      parse_status: "ok" as const,
      schema_v: "1" as const,
      address: "alice@example.com",
      internal_id: "01J0000000ABCDEFGHJKMNPQRS",
      received_at: "2026-05-21T12:00:00Z",
      raw_s3_uri: "s3://opensesame-raw-mime-x/abc",
      headers: {
        from: "s@example.com",
        to: "alice@example.com",
        cc: null,
        subject: "Hi",
        date: null,
        message_id: "<msg-1@example.com>",
        in_reply_to: null,
        references: null,
        auto_submitted: "no",
        list_id: null,
      },
      headers_blob: "",
      body_text: "",
      direction: "in" as const,
      attachments: [
        {
          filename: null,
          content_type: "application/octet-stream",
          size_bytes: 7,
          content_id: null,
          part_index: 0,
          sha256: "0000",
        },
        {
          filename: "report.pdf",
          content_type: "application/pdf",
          size_bytes: 12345,
          content_id: null,
          part_index: 1,
          sha256: "abcd",
        },
      ],
      read_at: null,
    };
    const presign = vi.fn(async () => ({
      url: "https://s3.example.com/signed-url",
      expiresAt: "2026-05-21T12:01:00.000Z",
    }));
    const deps: BffDeps = {
      ...makeDeps(),
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => stored),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
      },
      attachmentPresigner: { presignDownload: presign },
      attachmentBucket: "raw-mime-test",
    };
    const r = await dispatch(deps, "/rpc/get_attachment", {
      message_id: "<msg-1@example.com>",
      part_index: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      url: "https://s3.example.com/signed-url",
      expires_at: "2026-05-21T12:01:00.000Z",
      content_type: "application/pdf",
      filename: "report.pdf",
      size_bytes: 12345,
    });
    // Address + internal_id come from the stored message; bucket from deps.
    expect(presign).toHaveBeenCalledWith({
      bucket: "raw-mime-test",
      key: "attachments/alice@example.com/01J0000000ABCDEFGHJKMNPQRS/1",
      contentType: "application/pdf",
      filename: "report.pdf",
      expiresInSeconds: 60,
    });
  });

  it("mark_read: 400 when message_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/mark_read", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "message_id",
    });
  });

  it("mark_read: 404 when the reader returns kind=not_found", async () => {
    const markRead = vi.fn(async () => ({ kind: "not_found" as const }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead,
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/mark_read", {
      message_id: "<missing@example.com>",
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "message_not_found" });
    expect(markRead).toHaveBeenCalledWith("<missing@example.com>", expect.any(Date));
  });

  it("mark_read: 200 with already_read=false on first stamp", async () => {
    const markRead = vi.fn(async () => ({
      kind: "marked" as const,
      read_at: "2026-05-21T18:30:00.000Z",
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead,
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/mark_read", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      message_id: "<msg-1@example.com>",
      read_at: "2026-05-21T18:30:00.000Z",
      already_read: false,
    });
  });

  it("mark_read: 200 with already_read=true on second open (no write)", async () => {
    const markRead = vi.fn(async () => ({
      kind: "already_read" as const,
      read_at: "2026-05-21T17:00:00.000Z",
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead,
        markReadByPrimaryKey: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/mark_read", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      message_id: "<msg-1@example.com>",
      read_at: "2026-05-21T17:00:00.000Z",
      already_read: true,
    });
  });

  it("mark_read: by primary key — calls markReadByPrimaryKey, skips the GSI form, echoes (address, internal_id)", async () => {
    const markRead = vi.fn();
    const markReadByPrimaryKey = vi.fn(async () => ({
      kind: "marked" as const,
      read_at: "2026-05-21T18:30:00.000Z",
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead,
        markReadByPrimaryKey,
      },
    });
    const r = await dispatch(deps, "/rpc/mark_read", {
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000READ4",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000READ4",
      read_at: "2026-05-21T18:30:00.000Z",
      already_read: false,
    });
    expect(markReadByPrimaryKey).toHaveBeenCalledWith(
      "alice@acme.com",
      "01HF7E0000000000000000READ4",
      expect.any(Date),
    );
    expect(markRead).not.toHaveBeenCalled();
  });

  it("mark_read: by primary key — 404 when the row was deleted between list and click", async () => {
    const markReadByPrimaryKey = vi.fn(async () => ({ kind: "not_found" as const }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey,
      },
    });
    const r = await dispatch(deps, "/rpc/mark_read", {
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000GONE0",
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "message_not_found" });
  });

  it("mark_read: 400 when only address is supplied (the by_primary_key form requires both)", async () => {
    const r = await dispatch(makeDeps(), "/rpc/mark_read", {
      address: "alice@acme.com",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "internal_id",
    });
  });

  it("send_email: 5xx with a generic error body when the sender throws an unrelated error", async () => {
    const sendEmail = vi.fn(async () => {
      throw new Error("ddb conditional check failed");
    });
    const deps = makeDeps({ sendEmail });
    const r = await dispatch(deps, "/rpc/send_email", {
      from: "test@nille.net",
      to: ["alice@example.com"],
      subject: "Hi",
      body_text: "Body.",
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
    // Don't leak the raw DDB message to the response body — it might
    // include conditional-expression internals or AWS request IDs.
    expect(JSON.stringify(r.body)).not.toContain("ddb conditional");
  });
});
