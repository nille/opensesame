import { describe, expect, it } from "vitest";
import {
  parseGetMessageInput,
  parseReadInboxInput,
  parseSearchEmailInput,
  parseSendEmailInput,
  parseStarThreadInput,
} from "../src/bff/schemas.js";

// Hand-rolled parser tests (ADR-0021). Each parser must:
//   - return a typed input on the happy path
//   - return a structured ParseError pointing at the first offending field
//     when the body is wrong, *not* throw
//   - reject extra fields strictly enough to catch typos but not aliasing
//     between optional shapes (e.g. cc/bcc absent vs cc/bcc empty)

describe("parseReadInboxInput", () => {
  it("accepts the minimal required body", () => {
    const r = parseReadInboxInput({ address: "alice@example.com" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.address).toBe("alice@example.com");
      expect(r.value.limit).toBeUndefined();
      expect(r.value.cursor).toBeUndefined();
      expect(r.value.since).toBeUndefined();
    }
  });

  it("accepts every optional field", () => {
    const r = parseReadInboxInput({
      address: "alice@example.com",
      since: "2026-05-01T00:00:00Z",
      limit: 25,
      cursor: "opaque-cursor-string",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        address: "alice@example.com",
        since: "2026-05-01T00:00:00Z",
        limit: 25,
        cursor: "opaque-cursor-string",
      });
    }
  });

  it("rejects a missing address with a field-pointer error", () => {
    const r = parseReadInboxInput({ limit: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("address");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a non-positive limit", () => {
    const r = parseReadInboxInput({ address: "a@b.co", limit: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("limit");
  });

  it("rejects a non-string cursor", () => {
    const r = parseReadInboxInput({ address: "a@b.co", cursor: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("cursor");
  });

  it("rejects a malformed since timestamp", () => {
    const r = parseReadInboxInput({ address: "a@b.co", since: "tomorrow" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("since");
  });

  it("rejects a non-object body", () => {
    expect(parseReadInboxInput(null).ok).toBe(false);
    expect(parseReadInboxInput("hello").ok).toBe(false);
    expect(parseReadInboxInput([]).ok).toBe(false);
  });
});

describe("parseGetMessageInput", () => {
  it("accepts a valid message_id", () => {
    const r = parseGetMessageInput({ message_id: "<abc@example.com>" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.message_id).toBe("<abc@example.com>");
  });

  it("rejects a missing message_id", () => {
    const r = parseGetMessageInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("message_id");
  });

  it("rejects an empty message_id", () => {
    const r = parseGetMessageInput({ message_id: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("message_id");
  });
});

describe("parseSendEmailInput", () => {
  const minimal = {
    from: "test@nille.net",
    to: ["alice@example.com"],
    subject: "Hello",
    body_text: "Hi.",
  };

  it("accepts the minimal required body", () => {
    const r = parseSendEmailInput(minimal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from).toBe("test@nille.net");
      expect(r.value.to).toEqual(["alice@example.com"]);
      expect(r.value.subject).toBe("Hello");
      expect(r.value.body_text).toBe("Hi.");
    }
  });

  it("accepts every optional field", () => {
    const r = parseSendEmailInput({
      ...minimal,
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      body_html: "<p>Hi.</p>",
      in_reply_to: "<orig@example.com>",
      references: ["<orig@example.com>", "<earlier@example.com>"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cc).toEqual(["c@example.com"]);
      expect(r.value.bcc).toEqual(["d@example.com"]);
      expect(r.value.body_html).toBe("<p>Hi.</p>");
      expect(r.value.in_reply_to).toBe("<orig@example.com>");
      expect(r.value.references).toEqual([
        "<orig@example.com>",
        "<earlier@example.com>",
      ]);
    }
  });

  it("rejects a missing from", () => {
    const r = parseSendEmailInput({ ...minimal, from: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("from");
  });

  it("rejects an empty to[]", () => {
    const r = parseSendEmailInput({ ...minimal, to: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("to");
  });

  it("rejects to[] with a non-string entry", () => {
    const r = parseSendEmailInput({ ...minimal, to: ["a@b.co", 42] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("to");
  });

  it("rejects a missing body_text", () => {
    const r = parseSendEmailInput({ ...minimal, body_text: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("body_text");
  });

  it("rejects a non-string subject", () => {
    const r = parseSendEmailInput({ ...minimal, subject: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("subject");
  });

  it("rejects a non-array references", () => {
    const r = parseSendEmailInput({ ...minimal, references: "not an array" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("references");
  });
});

describe("parseSearchEmailInput", () => {
  const required = { address: "alice@example.com", query: "hello" };

  it("accepts the minimal required body", () => {
    const r = parseSearchEmailInput(required);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual(required);
    }
  });

  it("accepts every optional field", () => {
    const r = parseSearchEmailInput({
      ...required,
      limit: 25,
      cursor: "opaque",
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-21T00:00:00Z",
      from: "bob@example.com",
      to: "alice@example.com",
      subject: "report",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        ...required,
        limit: 25,
        cursor: "opaque",
        since: "2026-05-01T00:00:00Z",
        until: "2026-05-21T00:00:00Z",
        from: "bob@example.com",
        to: "alice@example.com",
        subject: "report",
      });
    }
  });

  it("rejects an empty query (use read_inbox for 'everything')", () => {
    const r = parseSearchEmailInput({ ...required, query: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("query");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a missing query with code=missing", () => {
    const r = parseSearchEmailInput({ address: required.address });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("query");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a missing address", () => {
    const r = parseSearchEmailInput({ query: "hello" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("address");
  });

  it("rejects an unparseable since", () => {
    const r = parseSearchEmailInput({ ...required, since: "not-a-date" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("since");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a non-string from", () => {
    const r = parseSearchEmailInput({ ...required, from: 42 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("from");
      expect(r.error.code).toBe("invalid_type");
    }
  });
});

describe("parseStarThreadInput (ADR-0028)", () => {
  it("accepts a valid {thread_id, starred: true} body", () => {
    const r = parseStarThreadInput({
      thread_id: "<root@example.com>",
      starred: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        thread_id: "<root@example.com>",
        starred: true,
      });
    }
  });

  it("accepts {starred: false} for unstarring", () => {
    const r = parseStarThreadInput({
      thread_id: "<root@example.com>",
      starred: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.starred).toBe(false);
  });

  it("rejects a missing thread_id", () => {
    const r = parseStarThreadInput({ starred: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects an empty thread_id with code=missing", () => {
    const r = parseStarThreadInput({ thread_id: "", starred: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a missing starred with code=missing", () => {
    const r = parseStarThreadInput({ thread_id: "<root@example.com>" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("starred");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a non-boolean starred", () => {
    const r = parseStarThreadInput({
      thread_id: "<root@example.com>",
      starred: "yes",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("starred");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects a non-object body", () => {
    expect(parseStarThreadInput(null).ok).toBe(false);
    expect(parseStarThreadInput([]).ok).toBe(false);
    expect(parseStarThreadInput("hello").ok).toBe(false);
  });
});
