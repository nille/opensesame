import { describe, expect, it, vi } from "vitest";
import {
  dispatch,
  type BffDeps,
  type SendEmailResult,
} from "../src/bff/dispatcher.js";
import type { SendEmailInput } from "../src/bff/schemas.js";
import type { SearchEmailInput as ReaderSearchEmailInput } from "../src/core/store.js";

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
      searchEmail: vi.fn(noop),
      listThreadMessages: vi.fn(noop),
      starThread: vi.fn(noop),
      snoozeThread: vi.fn(noop),
      trashThread: vi.fn(noop),
      markThreadRead: vi.fn(noop),
      archiveThread: vi.fn(noop),
      saveDraft: vi.fn(noop),
      listDrafts: vi.fn(noop),
      getDraft: vi.fn(noop),
      deleteDraft: vi.fn(noop),
      addThreadLabel: vi.fn(noop),
      removeThreadLabel: vi.fn(noop),
      listLabels: vi.fn(noop),
      createLabel: vi.fn(noop),
      deleteLabel: vi.fn(noop),
      renameLabel: vi.fn(noop),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        reply_to: null,
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
      body_html: null,
      direction: "in" as const,
      attachments: [],
      read_at: null,
      thread_id: null,
      starred_at: null,
      snoozed_until: null,
      trashed_at: null,      archived_at: null,
      labels: [],
    };
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(async () => stored),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        reply_to: null,
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
      body_html: null,
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
      thread_id: null,
      starred_at: null,
      snoozed_until: null,
      trashed_at: null,      archived_at: null,
      labels: [],
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        reply_to: null,
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
      body_html: null,
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
      thread_id: null,
      starred_at: null,
      snoozed_until: null,
      trashed_at: null,      archived_at: null,
      labels: [],
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
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

  it("search_email: 400 when query is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/search_email", {
      address: "alice@example.com",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "query",
    });
  });

  it("search_email: 400 with parser message + position when query has unknown operator (ADR-0036)", async () => {
    // The closed operator set is enforced by the parser; bad grammar must
    // surface as a 400 with a field-pointer body the web client can render
    // inline, not silently fall through to substring search.
    const r = await dispatch(makeDeps(), "/rpc/search_email", {
      address: "alice@example.com",
      query: "from:alice foo:bar",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "query",
      reason: "invalid_value",
    });
    const body = r.body as { message: string; position?: number };
    expect(body.message).toMatch(/unknown operator/i);
    // "foo:bar" begins at column 11 — the BFF echoes the parser's offset
    // so the UI can underline the offending token.
    expect(body.position).toBe(11);
  });

  it("search_email: 400 when query has an unclosed quote", async () => {
    const r = await dispatch(makeDeps(), "/rpc/search_email", {
      address: "alice@example.com",
      query: 'subject:"q2',
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "query",
      reason: "invalid_value",
    });
    expect((r.body as { message: string }).message).toMatch(/unclosed quote/);
  });

  it("search_email: 200 — forwards parsed input with nullable defaults filled in", async () => {
    const searchEmail = vi.fn(
      async (
        _input: ReaderSearchEmailInput,
      ): Promise<{ messages: never[]; next_cursor: null }> => ({
        messages: [],
        next_cursor: null,
      }),
    );
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail,
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/search_email", {
      address: "alice@example.com",
      query: "invoice",
      from: "bob@example.com",
    });
    expect(r.status).toBe(200);
    // ADR-0036 (slice 8.17): the parsed AST rides through to the reader
    // alongside the legacy wire fields. Match on the relevant fields and
    // assert the AST has a single free-text fragment.
    expect(searchEmail).toHaveBeenCalledTimes(1);
    const call = searchEmail.mock.calls[0]![0] as {
      address: string;
      query: string;
      limit: number;
      cursor: unknown;
      since: unknown;
      until: unknown;
      from: unknown;
      to: unknown;
      subject: unknown;
      ast: { free: string[] };
    };
    expect(call).toMatchObject({
      address: "alice@example.com",
      query: "invoice",
      limit: 50,
      cursor: null,
      since: null,
      until: null,
      from: "bob@example.com",
      to: null,
      subject: null,
    });
    expect(call.ast.free).toEqual(["invoice"]);
    expect(r.body).toEqual({ messages: [], next_cursor: null });
  });

  // ----- reply_to_email (ADR-0022) -----

  function makeParentOk(over: Record<string, unknown> = {}) {
    return {
      parse_status: "ok" as const,
      schema_v: "1" as const,
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000PARENT",
      received_at: "2026-05-19T14:23:10.901Z",
      raw_s3_uri: "s3://bucket/k",
      headers: {
        from: "Sender <sender@example.com>",
        to: "alice@acme.com",
        cc: null,
        reply_to: null,
        subject: "Q2 invoice",
        date: "Tue, 19 May 2026 14:23:10 +0000",
        message_id: "<orig-1@example.com>",
        in_reply_to: null,
        references: null,
        auto_submitted: "no",
        list_id: null,
      },
      headers_blob: "",
      body_text: "hi alice",
      body_html: null,
      direction: "in" as const,
      attachments: [],
      read_at: null,
      thread_id: null,
      starred_at: null,
      snoozed_until: null,
      trashed_at: null,      archived_at: null,
      labels: [],
      ...over,
    };
  }

  it("reply_to_email: 400 when message_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/reply_to_email", {
      body_text: "hi",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "message_id",
    });
  });

  it("reply_to_email: 400 when body_text is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/reply_to_email", {
      message_id: "<orig-1@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "body_text",
    });
  });

  it("reply_to_email: 404 parent_not_found when reader returns null", async () => {
    const getByMessageId = vi.fn(async () => null);
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId,
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/reply_to_email", {
      message_id: "<missing@example.com>",
      body_text: "hi",
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "parent_not_found" });
  });

  it("reply_to_email: 422 parent_unrepliable when parent is a skeleton row", async () => {
    const skeleton = {
      parse_status: "failed" as const,
      schema_v: "1" as const,
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000FAILED",
      received_at: "2026-05-19T14:23:10.901Z",
      raw_s3_uri: "s3://bucket/k",
      parse_error: "multipart missing boundary",
    };
    const getByMessageId = vi.fn(async () => skeleton);
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId,
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/reply_to_email", {
      message_id: "<broken@example.com>",
      body_text: "hi",
    });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      code: "parent_unrepliable",
      reason: "skeleton",
    });
  });

  it("reply_to_email: 422 parent_unrepliable when parent has no Message-ID header", async () => {
    const parent = makeParentOk({
      headers: { ...makeParentOk().headers, message_id: null },
    });
    const getByMessageId = vi.fn(async () => parent);
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId,
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/reply_to_email", {
      message_id: "<orig-1@example.com>",
      body_text: "hi",
    });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      code: "parent_unrepliable",
      reason: "no_message_id",
    });
  });

  it("reply_to_email: 200 — derives from/to/subject/in_reply_to and forwards to sendEmail", async () => {
    const parent = makeParentOk();
    const getByMessageId = vi.fn(async () => parent);
    let captured: SendEmailInput | null = null;
    const sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
      captured = input;
      return {
        message_id: "<reply-new@acme.com>",
        sent_at: "2026-05-21T19:00:00.000Z",
      };
    };
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId,
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
      sendEmail,
    });
    const r = await dispatch(deps, "/rpc/reply_to_email", {
      message_id: "<orig-1@example.com>",
      body_text: "thanks",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      message_id: "<reply-new@acme.com>",
      sent_at: "2026-05-21T19:00:00.000Z",
    });
    expect(captured).not.toBeNull();
    const args = captured!;
    expect(args.from).toBe("alice@acme.com");
    expect(args.to).toEqual(["sender@example.com"]);
    expect(args.subject).toBe("Re: Q2 invoice");
    expect(args.in_reply_to).toBe("<orig-1@example.com>");
    expect(args.references).toEqual(["<orig-1@example.com>"]);
  });

  it("reply_to_email: 409 suppressed when sendEmail throws SuppressionBlockError", async () => {
    const { SuppressionBlockError } = await import(
      "../src/core/suppression.js"
    );
    const parent = makeParentOk();
    const getByMessageId = vi.fn(async () => parent);
    const sendEmail = vi.fn(async () => {
      throw new SuppressionBlockError([
        {
          recipient: "sender@example.com",
          reason: "bounced_permanent",
          last_event_at: "2026-05-20T12:00:00.000Z",
        },
      ]);
    });
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId,
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
      sendEmail,
    });
    const r = await dispatch(deps, "/rpc/reply_to_email", {
      message_id: "<orig-1@example.com>",
      body_text: "hi",
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: "suppressed",
      blocked_recipients: ["sender@example.com"],
    });
  });

  // ----- list_thread_messages (ADR-0027) -----

  it("list_thread_messages: 400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/list_thread_messages", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("list_thread_messages: 400 when thread_id is not a string", async () => {
    const r = await dispatch(makeDeps(), "/rpc/list_thread_messages", {
      thread_id: 42,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("list_thread_messages: 200 — forwards parsed input with default limit", async () => {
    const listThreadMessages = vi.fn(async () => ({
      messages: [],
      next_cursor: null,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages,
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/list_thread_messages", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(200);
    expect(listThreadMessages).toHaveBeenCalledWith({
      thread_id: "<root@example.com>",
      limit: 50,
      cursor: null,
    });
    expect(r.body).toEqual({ messages: [], next_cursor: null });
  });

  it("list_thread_messages: caps limit at 200 even if a larger value is requested", async () => {
    // ADR-0027 caps at 200 to keep a single Query bounded.
    const listThreadMessages = vi.fn(async () => ({
      messages: [],
      next_cursor: null,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages,
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/list_thread_messages", {
      thread_id: "<root@example.com>",
      limit: 5000,
    });
    expect(r.status).toBe(200);
    expect(listThreadMessages).toHaveBeenCalledWith({
      thread_id: "<root@example.com>",
      limit: 200,
      cursor: null,
    });
  });

  it("list_thread_messages: forwards an explicit cursor through to the reader", async () => {
    const listThreadMessages = vi.fn(async () => ({
      messages: [],
      next_cursor: "next-page",
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages,
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/list_thread_messages", {
      thread_id: "<root@example.com>",
      cursor: "page-2",
      limit: 10,
    });
    expect(r.status).toBe(200);
    expect(listThreadMessages).toHaveBeenCalledWith({
      thread_id: "<root@example.com>",
      limit: 10,
      cursor: "page-2",
    });
    expect(r.body).toMatchObject({ next_cursor: "next-page" });
  });

  it("list_thread_messages: 500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/list_thread_messages", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

describe("dispatch /rpc/star_thread (ADR-0028)", () => {
  it("star_thread: 400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/star_thread", { starred: true });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("star_thread: 400 when starred is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/star_thread", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "starred",
    });
  });

  it("star_thread: 400 when starred is not a boolean", async () => {
    const r = await dispatch(makeDeps(), "/rpc/star_thread", {
      thread_id: "<root@example.com>",
      starred: "yes",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "starred",
    });
  });

  it("star_thread: 200 — forwards parsed input and echoes the reader result", async () => {
    const starThread = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      starred: true,
      starred_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread,
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/star_thread", {
      thread_id: "<root@example.com>",
      starred: true,
    });
    expect(r.status).toBe(200);
    expect(starThread).toHaveBeenCalledTimes(1);
    expect(starThread).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", starred: true },
      expect.any(Date),
    );
    expect(r.body).toEqual({
      thread_id: "<root@example.com>",
      starred: true,
      starred_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    });
  });

  it("star_thread: 200 with updated_count 0 for an empty thread (no row → no-op, not 404)", async () => {
    const starThread = vi.fn(async () => ({
      thread_id: "<orphan@example.com>",
      starred: true,
      starred_at: "2026-05-22T10:00:00.000Z",
      updated_count: 0,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread,
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/star_thread", {
      thread_id: "<orphan@example.com>",
      starred: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated_count: 0 });
  });

  it("star_thread: 500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/star_thread", {
      thread_id: "<root@example.com>",
      starred: true,
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

// ADR-0029 (slice 8.11). Same status-code shape as star_thread — empty
// thread is a 200 no-op rather than 404. The dispatcher threads a single
// `now` through parseSnoozeThreadInput and reader.snoozeThread so the past-
// time guard and the reader's snapshot agree on a single instant.
describe("dispatch /rpc/snooze_thread (ADR-0029)", () => {
  // Wake times far enough in the future that a slow CI run can't drift past
  // them while the test executes.
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const PAST = "2000-01-01T00:00:00.000Z";

  it("snooze_thread: 400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/snooze_thread", {
      snoozed_until: FUTURE,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("snooze_thread: 400 when snoozed_until is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "snoozed_until",
    });
  });

  it("snooze_thread: 400 when snoozed_until is not a string or null", async () => {
    const r = await dispatch(makeDeps(), "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
      snoozed_until: 12345,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "snoozed_until",
    });
  });

  it("snooze_thread: 400 when snoozed_until is unparseable ISO", async () => {
    const r = await dispatch(makeDeps(), "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
      snoozed_until: "not a date",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "snoozed_until",
    });
  });

  it("snooze_thread: 400 when snoozed_until is in the past — typo'd wake time, not silent no-op", async () => {
    const r = await dispatch(makeDeps(), "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
      snoozed_until: PAST,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "snoozed_until",
    });
  });

  it("snooze_thread: 200 — forwards parsed input and echoes the reader result (snoozing)", async () => {
    const snoozeThread = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      snoozed_until: FUTURE,
      updated_count: 3,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread,
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
      snoozed_until: FUTURE,
    });
    expect(r.status).toBe(200);
    expect(snoozeThread).toHaveBeenCalledTimes(1);
    expect(snoozeThread).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", snoozed_until: FUTURE },
      expect.any(Date),
    );
    expect(r.body).toEqual({
      thread_id: "<root@example.com>",
      snoozed_until: FUTURE,
      updated_count: 3,
    });
  });

  it("snooze_thread: 200 — forwards null snoozed_until for unsnoozing", async () => {
    const snoozeThread = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      snoozed_until: null,
      updated_count: 2,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread,
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
      snoozed_until: null,
    });
    expect(r.status).toBe(200);
    expect(snoozeThread).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", snoozed_until: null },
      expect.any(Date),
    );
    expect(r.body).toMatchObject({ snoozed_until: null, updated_count: 2 });
  });

  it("snooze_thread: 200 with updated_count 0 for an empty thread (no rows → no-op, not 404)", async () => {
    const snoozeThread = vi.fn(async () => ({
      thread_id: "<orphan@example.com>",
      snoozed_until: FUTURE,
      updated_count: 0,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread,
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/snooze_thread", {
      thread_id: "<orphan@example.com>",
      snoozed_until: FUTURE,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated_count: 0 });
  });

  it("snooze_thread: 500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/snooze_thread", {
      thread_id: "<root@example.com>",
      snoozed_until: FUTURE,
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

// ADR-0030 (slice 8.12). Same status-code shape as star_thread — boolean
// toggle, empty thread is 200 no-op rather than 404.
describe("dispatch /rpc/trash_thread (ADR-0030)", () => {
  it("trash_thread: 400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/trash_thread", { trashed: true });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("trash_thread: 400 when trashed is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/trash_thread", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "trashed",
    });
  });

  it("trash_thread: 400 when trashed is not a boolean", async () => {
    const r = await dispatch(makeDeps(), "/rpc/trash_thread", {
      thread_id: "<root@example.com>",
      trashed: "yes",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "trashed",
    });
  });

  it("trash_thread: 200 — forwards parsed input and echoes the reader result", async () => {
    const trashThread = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      trashed: true,
      trashed_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread,
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/trash_thread", {
      thread_id: "<root@example.com>",
      trashed: true,
    });
    expect(r.status).toBe(200);
    expect(trashThread).toHaveBeenCalledTimes(1);
    expect(trashThread).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", trashed: true },
      expect.any(Date),
    );
    expect(r.body).toEqual({
      thread_id: "<root@example.com>",
      trashed: true,
      trashed_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    });
  });

  it("trash_thread: 200 with updated_count 0 for an empty thread (no row → no-op, not 404)", async () => {
    const trashThread = vi.fn(async () => ({
      thread_id: "<orphan@example.com>",
      trashed: true,
      trashed_at: "2026-05-22T10:00:00.000Z",
      updated_count: 0,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread,
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/trash_thread", {
      thread_id: "<orphan@example.com>",
      trashed: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated_count: 0 });
  });

  it("trash_thread: 500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/trash_thread", {
      thread_id: "<root@example.com>",
      trashed: true,
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

// ADR-0031 (slice 8.13). Same status-code shape as star/trash — boolean
// toggle; empty thread or outbound-only thread is 200 no-op (updated_count:
// 0), not 404.
describe("dispatch /rpc/mark_thread_read (ADR-0031)", () => {
  it("mark_thread_read: 400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/mark_thread_read", {
      read: true,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("mark_thread_read: 400 when read is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/mark_thread_read", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "read",
    });
  });

  it("mark_thread_read: 400 when read is not a boolean", async () => {
    const r = await dispatch(makeDeps(), "/rpc/mark_thread_read", {
      thread_id: "<root@example.com>",
      read: "yes",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "read",
    });
  });

  it("mark_thread_read: 200 — forwards parsed input and echoes the reader result", async () => {
    const markThreadRead = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      read: true,
      read_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead,
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/mark_thread_read", {
      thread_id: "<root@example.com>",
      read: true,
    });
    expect(r.status).toBe(200);
    expect(markThreadRead).toHaveBeenCalledTimes(1);
    expect(markThreadRead).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", read: true },
      expect.any(Date),
    );
    expect(r.body).toEqual({
      thread_id: "<root@example.com>",
      read: true,
      read_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    });
  });

  it("mark_thread_read: 200 with updated_count 0 for outbound-only thread (no inbound rows → no-op, not 404)", async () => {
    const markThreadRead = vi.fn(async () => ({
      thread_id: "<sent-only@example.com>",
      read: true,
      read_at: "2026-05-22T10:00:00.000Z",
      updated_count: 0,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead,
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/mark_thread_read", {
      thread_id: "<sent-only@example.com>",
      read: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated_count: 0 });
  });

  it("mark_thread_read: 500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/mark_thread_read", {
      thread_id: "<root@example.com>",
      read: true,
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

// ADR-0034 (slice 8.16). Same status-code shape as trash_thread —
// boolean toggle; empty thread is 200 no-op (updated_count: 0).
describe("dispatch /rpc/archive_thread (ADR-0034)", () => {
  it("archive_thread: 400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/archive_thread", {
      archived: true,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "thread_id",
    });
  });

  it("archive_thread: 400 when archived is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/archive_thread", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "archived",
    });
  });

  it("archive_thread: 400 when archived is not a boolean", async () => {
    const r = await dispatch(makeDeps(), "/rpc/archive_thread", {
      thread_id: "<root@example.com>",
      archived: "yes",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "archived",
    });
  });

  it("archive_thread: 200 — forwards parsed input and echoes the reader result", async () => {
    const archiveThread = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      archived: true,
      archived_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread,
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/archive_thread", {
      thread_id: "<root@example.com>",
      archived: true,
    });
    expect(r.status).toBe(200);
    expect(archiveThread).toHaveBeenCalledTimes(1);
    expect(archiveThread).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", archived: true },
      expect.any(Date),
    );
    expect(r.body).toEqual({
      thread_id: "<root@example.com>",
      archived: true,
      archived_at: "2026-05-22T10:00:00.000Z",
      updated_count: 3,
    });
  });

  it("archive_thread: 200 with updated_count 0 for an empty thread (no row → no-op, not 404)", async () => {
    const archiveThread = vi.fn(async () => ({
      thread_id: "<orphan@example.com>",
      archived: true,
      archived_at: "2026-05-22T10:00:00.000Z",
      updated_count: 0,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread,
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/archive_thread", {
      thread_id: "<orphan@example.com>",
      archived: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated_count: 0 });
  });

  it("archive_thread: 200 — un-archive (archived: false) echoes archived_at: null", async () => {
    const archiveThread = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      archived: false,
      archived_at: null,
      updated_count: 2,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread,
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/archive_thread", {
      thread_id: "<root@example.com>",
      archived: false,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      archived: false,
      archived_at: null,
      updated_count: 2,
    });
  });

  it("archive_thread: 500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/archive_thread", {
      thread_id: "<root@example.com>",
      archived: true,
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

// ADR-0035 (slice 8.17): drafts. save / list / get / delete map to
// 200 / 400 / 404 / 500. No 409 (no suppression posture). No 422.
describe("dispatch /rpc/save_draft (ADR-0035)", () => {
  it("400 when address is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/save_draft", {
      draft_id: null,
      body_text: "hi",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "address",
    });
  });

  it("400 when draft_id is absent (not the same as null)", async () => {
    const r = await dispatch(makeDeps(), "/rpc/save_draft", {
      address: "alice@acme.com",
      body_text: "hi",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "draft_id",
    });
  });

  it("400 when body_text is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/save_draft", {
      address: "alice@acme.com",
      draft_id: null,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "body_text",
    });
  });

  it("200 — first save: passes draft_id=null through to the reader", async () => {
    const saveDraft = vi.fn(async () => ({
      draft_id: "01KS500000000000000000DR01",
      created_at: "2026-05-22T10:00:00.000Z",
      updated_at: "2026-05-22T10:00:00.000Z",
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft,
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/save_draft", {
      address: "alice@acme.com",
      draft_id: null,
      body_text: "hello",
      subject: "WIP",
    });
    expect(r.status).toBe(200);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "alice@acme.com",
        draft_id: null,
        body_text: "hello",
        subject: "WIP",
      }),
      expect.any(Date),
    );
    expect(r.body).toEqual({
      draft_id: "01KS500000000000000000DR01",
      created_at: "2026-05-22T10:00:00.000Z",
      updated_at: "2026-05-22T10:00:00.000Z",
    });
  });

  it("404 when the reader returns null (stale draft_id)", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(async () => null),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/save_draft", {
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
      body_text: "x",
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "draft_not_found" });
  });

  it("500 when the reader throws", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(async () => {
          throw new Error("ddb boom");
        }),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/save_draft", {
      address: "alice@acme.com",
      draft_id: null,
      body_text: "x",
    });
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: "internal_error" });
  });
});

describe("dispatch /rpc/list_drafts (ADR-0035)", () => {
  it("400 when address is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/list_drafts", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "address",
    });
  });

  it("200 — clamps limit to MAX_DRAFTS_LIMIT and forwards cursor", async () => {
    const listDrafts = vi.fn(async () => ({ drafts: [], next_cursor: null }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts,
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/list_drafts", {
      address: "alice@acme.com",
      limit: 99999,
      cursor: "opaque-cursor-string",
    });
    expect(r.status).toBe(200);
    expect(listDrafts).toHaveBeenCalledTimes(1);
    expect(listDrafts).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "alice@acme.com",
        // 200 = MAX_DRAFTS_LIMIT in dispatcher.ts (clamped from 99999).
        limit: 200,
        cursor: "opaque-cursor-string",
      }),
    );
  });

  it("200 — defaults limit and cursor when omitted", async () => {
    const listDrafts = vi.fn(async () => ({ drafts: [], next_cursor: null }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts,
        getDraft: vi.fn(),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/list_drafts", {
      address: "alice@acme.com",
    });
    expect(r.status).toBe(200);
    expect(listDrafts).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "alice@acme.com",
        cursor: null,
      }),
    );
  });
});

describe("dispatch /rpc/get_draft (ADR-0035)", () => {
  it("400 when draft_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/get_draft", {
      address: "alice@acme.com",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "draft_id",
    });
  });

  it("404 when the reader returns null", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(async () => null),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/get_draft", {
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DRXX",
    });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: "draft_not_found" });
  });

  it("200 — echoes the projected draft", async () => {
    const stored = {
      schema_v: "1" as const,
      kind: "draft" as const,
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
      body_text: "hi",
      body_html: null,
      to: null,
      cc: null,
      subject: null,
      in_reply_to: null,
      references: null,
      created_at: "2026-05-22T09:00:00.000Z",
      updated_at: "2026-05-22T10:00:00.000Z",
    };
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(async () => stored),
        deleteDraft: vi.fn(),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/get_draft", {
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(stored);
  });
});

describe("dispatch /rpc/delete_draft (ADR-0035)", () => {
  it("400 when draft_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/delete_draft", {
      address: "alice@acme.com",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: "invalid_request",
      field: "draft_id",
    });
  });

  it("200 — echoes deleted: true on a hit", async () => {
    const deleteDraft = vi.fn(async () => ({
      draft_id: "01KS500000000000000000DR01",
      deleted: true,
    }));
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft,
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/delete_draft", {
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      draft_id: "01KS500000000000000000DR01",
      deleted: true,
    });
  });

  it("200 — echoes deleted: false on a miss (idempotent, not 404)", async () => {
    const deps = makeDeps({
      reader: {
        listInbox: vi.fn(),
        getByMessageId: vi.fn(),
        getByPrimaryKey: vi.fn(),
        markRead: vi.fn(),
        markReadByPrimaryKey: vi.fn(),
        searchEmail: vi.fn(),
        listThreadMessages: vi.fn(),
        starThread: vi.fn(),
        snoozeThread: vi.fn(),
        trashThread: vi.fn(),
        markThreadRead: vi.fn(),
        archiveThread: vi.fn(),
        saveDraft: vi.fn(),
        listDrafts: vi.fn(),
        getDraft: vi.fn(),
        deleteDraft: vi.fn(async () => ({
          draft_id: "01KS500000000000000000DRXX",
          deleted: false,
        })),
        addThreadLabel: vi.fn(),
        removeThreadLabel: vi.fn(),
        listLabels: vi.fn(),
        createLabel: vi.fn(),
        deleteLabel: vi.fn(),
        renameLabel: vi.fn(),
      },
    });
    const r = await dispatch(deps, "/rpc/delete_draft", {
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DRXX",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deleted: false });
  });
});

// ADR-0037 (slice 8.17). Label RPCs. The reader-side label methods are
// exercised in test/labels.test.ts; the dispatcher tests below verify
// schema rejection (400 with field pointer), happy-path forwarding, and
// the 409 already_exists conflict mapping for create / rename.

// Stub-builder for label dispatcher tests. Each helper takes the one method
// the test cares about and fills the rest with `vi.fn()` stubs so the
// `BffDeps.reader` shape stays satisfied.
function readerWith(
  partial: Partial<BffDeps["reader"]>,
): BffDeps["reader"] {
  return {
    listInbox: vi.fn(),
    getByMessageId: vi.fn(),
    getByPrimaryKey: vi.fn(),
    markRead: vi.fn(),
    markReadByPrimaryKey: vi.fn(),
    searchEmail: vi.fn(),
    listThreadMessages: vi.fn(),
    starThread: vi.fn(),
    snoozeThread: vi.fn(),
    trashThread: vi.fn(),
    markThreadRead: vi.fn(),
    archiveThread: vi.fn(),
    saveDraft: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    deleteDraft: vi.fn(),
    addThreadLabel: vi.fn(),
    removeThreadLabel: vi.fn(),
    listLabels: vi.fn(),
    createLabel: vi.fn(),
    deleteLabel: vi.fn(),
    renameLabel: vi.fn(),
    ...partial,
  };
}

describe("dispatch /rpc/add_thread_label (ADR-0037)", () => {
  it("400 when thread_id is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/add_thread_label", {
      label: "work",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "thread_id" });
  });

  it("400 when label is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/add_thread_label", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "label" });
  });

  it("400 when label exceeds 32 characters", async () => {
    const r = await dispatch(makeDeps(), "/rpc/add_thread_label", {
      thread_id: "<root@example.com>",
      label: "x".repeat(33),
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "label" });
  });

  it("200 — forwards parsed input and echoes the reader result", async () => {
    const addThreadLabel = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      label: "work",
      labels: ["work"],
      updated_count: 2,
    }));
    const deps = makeDeps({ reader: readerWith({ addThreadLabel }) });
    const r = await dispatch(deps, "/rpc/add_thread_label", {
      thread_id: "<root@example.com>",
      label: "Work",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      thread_id: "<root@example.com>",
      label: "work",
      labels: ["work"],
      updated_count: 2,
    });
    expect(addThreadLabel).toHaveBeenCalledWith(
      { thread_id: "<root@example.com>", label: "Work" },
      expect.any(Date),
    );
  });
});

describe("dispatch /rpc/remove_thread_label (ADR-0037)", () => {
  it("400 when label is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/remove_thread_label", {
      thread_id: "<root@example.com>",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "label" });
  });

  it("200 — forwards parsed input and echoes the reader result", async () => {
    const removeThreadLabel = vi.fn(async () => ({
      thread_id: "<root@example.com>",
      label: "work",
      labels: [],
      updated_count: 1,
    }));
    const deps = makeDeps({ reader: readerWith({ removeThreadLabel }) });
    const r = await dispatch(deps, "/rpc/remove_thread_label", {
      thread_id: "<root@example.com>",
      label: "work",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated_count: 1, labels: [] });
  });
});

describe("dispatch /rpc/list_labels (ADR-0037)", () => {
  it("400 when address is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/list_labels", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "address" });
  });

  it("200 — forwards address and returns the catalog list", async () => {
    const listLabels = vi.fn(async () => ({
      labels: [
        {
          label: "alpha",
          display_name: "Alpha",
          created_at: "2026-05-21T00:00:00.000Z",
        },
      ],
    }));
    const deps = makeDeps({ reader: readerWith({ listLabels }) });
    const r = await dispatch(deps, "/rpc/list_labels", {
      address: "alice@acme.com",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      labels: [
        expect.objectContaining({ label: "alpha", display_name: "Alpha" }),
      ],
    });
    expect(listLabels).toHaveBeenCalledWith({ address: "alice@acme.com" });
  });
});

describe("dispatch /rpc/create_label (ADR-0037)", () => {
  it("400 when label is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/create_label", {
      address: "alice@acme.com",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "label" });
  });

  it("200 — happy path forwards address+label and echoes the new catalog entry", async () => {
    const createLabel = vi.fn(async () => ({
      label: "work",
      display_name: "Work",
      created_at: "2026-05-22T10:00:00.000Z",
    }));
    const deps = makeDeps({ reader: readerWith({ createLabel }) });
    const r = await dispatch(deps, "/rpc/create_label", {
      address: "alice@acme.com",
      label: "Work",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ label: "work", display_name: "Work" });
  });

  it("409 already_exists when reader returns null (ConditionalCheckFailed)", async () => {
    const createLabel = vi.fn(async () => null);
    const deps = makeDeps({ reader: readerWith({ createLabel }) });
    const r = await dispatch(deps, "/rpc/create_label", {
      address: "alice@acme.com",
      label: "Work",
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "already_exists" });
  });
});

describe("dispatch /rpc/delete_label (ADR-0037)", () => {
  it("400 when address is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/delete_label", {
      label: "work",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "address" });
  });

  it("200 — echoes the strip result, including incomplete: true on a paged cap", async () => {
    const deleteLabel = vi.fn(async () => ({
      label: "work",
      updated_row_count: 1000,
      incomplete: true,
    }));
    const deps = makeDeps({ reader: readerWith({ deleteLabel }) });
    const r = await dispatch(deps, "/rpc/delete_label", {
      address: "alice@acme.com",
      label: "Work",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      label: "work",
      updated_row_count: 1000,
      incomplete: true,
    });
  });
});

describe("dispatch /rpc/rename_label (ADR-0037)", () => {
  it("400 when from is missing", async () => {
    const r = await dispatch(makeDeps(), "/rpc/rename_label", {
      address: "alice@acme.com",
      to: "Career",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "from" });
  });

  it("400 when from and to differ only in case", async () => {
    const r = await dispatch(makeDeps(), "/rpc/rename_label", {
      address: "alice@acme.com",
      from: "Work",
      to: "WORK",
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_request", field: "to" });
  });

  it("200 — happy path forwards the triple and echoes the strip result", async () => {
    const renameLabel = vi.fn(async () => ({
      from: "work",
      to: "career",
      updated_row_count: 3,
      incomplete: false,
    }));
    const deps = makeDeps({ reader: readerWith({ renameLabel }) });
    const r = await dispatch(deps, "/rpc/rename_label", {
      address: "alice@acme.com",
      from: "Work",
      to: "Career",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      from: "work",
      to: "career",
      updated_row_count: 3,
    });
  });

  it("409 already_exists when reader returns null (destination row already exists)", async () => {
    const renameLabel = vi.fn(async () => null);
    const deps = makeDeps({ reader: readerWith({ renameLabel }) });
    const r = await dispatch(deps, "/rpc/rename_label", {
      address: "alice@acme.com",
      from: "Work",
      to: "Career",
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "already_exists" });
  });
});
