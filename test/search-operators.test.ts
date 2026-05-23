import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../src/core/search-operators.js";

// ADR-0036 (slice 8.17). Closed operator set:
//   from: / to: / subject:           — substring, AND across keys, OR within
//   is:unread / starred / snoozed    — boolean flags
//   has:attachment                   — boolean flag
//   in:trash / archive               — mutually exclusive view scope
//   "..."                            — quoted fragments may contain spaces
//   -prefix                          — negation
//
// The parser MUST 400 on any out-of-grammar input rather than silently
// folding it into free-text — the operator typed `is:unred` and wants to
// know they typo'd, not get back zero hits and assume the inbox is empty.

describe("parseSearchQuery — happy path", () => {
  it("treats a bare word as a single free-text fragment", () => {
    const r = parseSearchQuery("invoice");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.free).toEqual(["invoice"]);
      expect(r.value.from.include).toEqual([]);
    }
  });

  it("collects multiple free-text words", () => {
    const r = parseSearchQuery("q2 invoice paid");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.free).toEqual(["q2", "invoice", "paid"]);
  });

  it("parses a single from: operator", () => {
    const r = parseSearchQuery("from:bob@example.com");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.include).toEqual(["bob@example.com"]);
      expect(r.value.free).toEqual([]);
    }
  });

  it("ANDs across keys (from + subject + free-text)", () => {
    const r = parseSearchQuery("from:bob subject:invoice paid");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.include).toEqual(["bob"]);
      expect(r.value.subject.include).toEqual(["invoice"]);
      expect(r.value.free).toEqual(["paid"]);
    }
  });

  it("ORs within a single key (from:a from:b)", () => {
    const r = parseSearchQuery("from:alice from:bob");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.from.include).toEqual(["alice", "bob"]);
  });

  it("supports per-token negation with leading dash", () => {
    const r = parseSearchQuery("-from:noreply subject:digest");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.exclude).toEqual(["noreply"]);
      expect(r.value.from.include).toEqual([]);
      expect(r.value.subject.include).toEqual(["digest"]);
    }
  });

  it("preserves spaces inside quoted values", () => {
    const r = parseSearchQuery('subject:"q2 invoice"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.subject.include).toEqual(["q2 invoice"]);
  });

  it("treats a quoted bareword as a single free-text fragment", () => {
    const r = parseSearchQuery('"hello world"');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.free).toEqual(["hello world"]);
  });

  it("sets is:unread as a true flag", () => {
    const r = parseSearchQuery("is:unread");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.unread).toBe(true);
  });

  it("supports negated is: as a false flag (-is:unread → unread=false)", () => {
    const r = parseSearchQuery("-is:unread");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.unread).toBe(false);
  });

  it("sets has:attachment", () => {
    const r = parseSearchQuery("has:attachment");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flags.has_attachment).toBe(true);
  });

  it("sets in:trash as a view scope", () => {
    const r = parseSearchQuery("in:trash");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.view).toBe("trash");
  });

  it("sets in:archive as a view scope", () => {
    const r = parseSearchQuery("in:archive");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.view).toBe("archive");
  });

  it("normalizes operator keys to lowercase (FROM:bob)", () => {
    const r = parseSearchQuery("FROM:bob");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.from.include).toEqual(["bob"]);
  });

  it("returns an empty AST for an empty input", () => {
    const r = parseSearchQuery("");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.free).toEqual([]);
      expect(r.value.view).toBeNull();
      expect(r.value.flags).toEqual({});
    }
  });

  it("ignores runs of whitespace between tokens", () => {
    const r = parseSearchQuery("   from:bob    subject:hi   ");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from.include).toEqual(["bob"]);
      expect(r.value.subject.include).toEqual(["hi"]);
    }
  });
});

describe("parseSearchQuery — rejection paths", () => {
  it("rejects an unknown operator key (foo:)", () => {
    const r = parseSearchQuery("foo:bar");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("query");
      expect(r.error.code).toBe("invalid_value");
      expect(r.error.message).toMatch(/unknown operator/i);
    }
  });

  it("rejects an unknown is: value (is:unred)", () => {
    const r = parseSearchQuery("is:unred");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/unknown is:/);
      expect(r.error.position).toBeDefined();
    }
  });

  it("rejects an unknown has: value (has:gif)", () => {
    const r = parseSearchQuery("has:gif");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/unknown has:/);
  });

  it("rejects an unknown in: value (in:promotions)", () => {
    const r = parseSearchQuery("in:promotions");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/unknown in:/);
  });

  it("rejects negation on in: scope (-in:trash)", () => {
    const r = parseSearchQuery("-in:trash");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/negation/i);
  });

  it("rejects combining in:trash and in:archive", () => {
    const r = parseSearchQuery("in:trash in:archive");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/cannot combine/i);
  });

  it("rejects an empty value on a substring operator (from:)", () => {
    const r = parseSearchQuery("from:");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/non-empty/);
  });

  it("rejects an unclosed quote and reports the offending token's position", () => {
    const r = parseSearchQuery('subject:"q2 invoice');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/unclosed quote/);
      expect(r.error.position).toBe(0);
    }
  });

  it("flags the position at the start of the offending token, not the start of the input", () => {
    const r = parseSearchQuery("from:alice foo:bar");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // "foo:bar" starts at column 11 ("from:alice " is 11 chars).
      expect(r.error.position).toBe(11);
    }
  });
});
