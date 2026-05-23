import { describe, expect, it, vi } from "vitest";
import { dispatch, type BffDeps } from "../src/bff/dispatcher.js";
import type { RawMessageReader } from "../src/core/raw-store.js";

// ADR-0042 (slice 8.21). The BFF re-parses raw MIME from S3 on every
// get_message call to surface body_html alongside body_text. The
// re-parse is best-effort: any failure (no rawReader, missing object,
// parser throws, no html part in the message) returns body_html: null
// so the text/plain fallback always works.

function makeDeps(overrides: Partial<BffDeps> = {}): BffDeps {
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

function makeStored() {
  return {
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
    headers_blob: "From: sender@example.com\r\n",
    body_text: "Hi there.",
    body_html: null,
    direction: "in" as const,
    attachments: [],
    read_at: null,
    thread_id: null,
    starred_at: null,
    snoozed_until: null,
    trashed_at: null,
    archived_at: null,
    labels: [],
  };
}

// CRLF .eml builder. multipart/alternative with text/plain + text/html.
function makeMultipartAlternative(): Uint8Array {
  const boundary = "alt-1";
  const eml = [
    "From: sender@example.com",
    "To: alice@example.com",
    "Subject: Hello",
    "Message-ID: <msg-1@example.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    "Hi there.",
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    "<p>Hi <b>there</b>.</p>",
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new TextEncoder().encode(eml);
}

function makePlainTextOnly(): Uint8Array {
  const eml = [
    "From: sender@example.com",
    "To: alice@example.com",
    "Subject: Hello",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi there.",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(eml);
}

describe("get_message body_html re-parse (ADR-0042)", () => {
  it("fills body_html from a re-parsed multipart/alternative message", async () => {
    const stored = makeStored();
    const rawReader: RawMessageReader = {
      getRaw: vi.fn(async () => makeMultipartAlternative()),
    };
    const deps = makeDeps({
      reader: {
        ...makeDeps().reader,
        getByMessageId: vi.fn(async () => stored),
      },
      rawReader,
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    const body = r.body as { body_html: string | null };
    expect(body.body_html).not.toBeNull();
    expect(body.body_html).toContain("<b>there</b>");
    expect(rawReader.getRaw).toHaveBeenCalledWith(stored.raw_s3_uri);
  });

  it("returns body_html: null when the raw fetch resolves to null (missing object)", async () => {
    const stored = makeStored();
    const rawReader: RawMessageReader = {
      getRaw: vi.fn(async () => null),
    };
    const deps = makeDeps({
      reader: {
        ...makeDeps().reader,
        getByMessageId: vi.fn(async () => stored),
      },
      rawReader,
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect((r.body as { body_html: string | null }).body_html).toBeNull();
  });

  it("returns body_html: null when the raw fetch throws (network failure)", async () => {
    const stored = makeStored();
    const rawReader: RawMessageReader = {
      getRaw: vi.fn(async () => {
        throw new Error("S3 timeout");
      }),
    };
    const deps = makeDeps({
      reader: {
        ...makeDeps().reader,
        getByMessageId: vi.fn(async () => stored),
      },
      rawReader,
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect((r.body as { body_html: string | null }).body_html).toBeNull();
  });

  it("returns body_html: null when the message has only a text/plain part", async () => {
    const stored = makeStored();
    const rawReader: RawMessageReader = {
      getRaw: vi.fn(async () => makePlainTextOnly()),
    };
    const deps = makeDeps({
      reader: {
        ...makeDeps().reader,
        getByMessageId: vi.fn(async () => stored),
      },
      rawReader,
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect((r.body as { body_html: string | null }).body_html).toBeNull();
  });

  it("returns body_html: null when no rawReader is configured (CLI driver mode)", async () => {
    const stored = makeStored();
    const deps = makeDeps({
      reader: {
        ...makeDeps().reader,
        getByMessageId: vi.fn(async () => stored),
      },
      // no rawReader — back to text-only behaviour
    });
    const r = await dispatch(deps, "/rpc/get_message", {
      message_id: "<msg-1@example.com>",
    });
    expect(r.status).toBe(200);
    expect((r.body as { body_html: string | null }).body_html).toBeNull();
  });
});
