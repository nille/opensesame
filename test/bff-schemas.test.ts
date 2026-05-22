import { describe, expect, it } from "vitest";
import {
  parseGetMessageInput,
  parseReadInboxInput,
  parseSendEmailInput,
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
