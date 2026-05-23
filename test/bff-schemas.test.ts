import { describe, expect, it } from "vitest";
import {
  parseAddThreadLabelInput,
  parseArchiveThreadInput,
  parseCreateLabelInput,
  parseDeleteDraftInput,
  parseDeleteLabelInput,
  parseGetDraftInput,
  parseGetMessageInput,
  parseListDraftsInput,
  parseListLabelsInput,
  parseMarkThreadReadInput,
  parseReadInboxInput,
  parseRemoveThreadLabelInput,
  parseRenameLabelInput,
  parseSaveDraftInput,
  parseSearchEmailInput,
  parseSendEmailInput,
  parseSnoozeThreadInput,
  parseStarThreadInput,
  parseTrashThreadInput,
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
      // ADR-0036 (slice 8.17): a parsed AST rides alongside the wire shape.
      expect(r.value).toMatchObject(required);
      expect(r.value.ast.free).toEqual(["hello"]);
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
      expect(r.value).toMatchObject({
        ...required,
        limit: 25,
        cursor: "opaque",
        since: "2026-05-01T00:00:00Z",
        until: "2026-05-21T00:00:00Z",
        from: "bob@example.com",
        to: "alice@example.com",
        subject: "report",
      });
      expect(r.value.ast).toBeDefined();
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

  // ADR-0036 (slice 8.17): legacy top-level `from`/`to`/`subject` stay on
  // the wire shape unchanged — the reader's resolveAst() folds them into
  // the AST at execution time. Schema-level test only asserts that the
  // wire fields survive the parse and that the AST itself reflects only
  // what the query parser produced.
  it("preserves legacy top-level from/to/subject on the wire shape", () => {
    const r = parseSearchEmailInput({
      address: "alice@example.com",
      query: "invoice",
      from: "bob@example.com",
      to: "alice@example.com",
      subject: "report",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.from).toBe("bob@example.com");
      expect(r.value.to).toBe("alice@example.com");
      expect(r.value.subject).toBe("report");
      // The query had no operators — the AST holds only the free-text fragment.
      expect(r.value.ast.free).toEqual(["invoice"]);
      expect(r.value.ast.from.include).toEqual([]);
      expect(r.value.ast.to.include).toEqual([]);
      expect(r.value.ast.subject.include).toEqual([]);
    }
  });

  it("parses query operators into the AST (from:, is:, in:)", () => {
    const r = parseSearchEmailInput({
      address: "alice@example.com",
      query: "from:bob is:unread in:archive paid",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ast.from.include).toEqual(["bob"]);
      expect(r.value.ast.flags.unread).toBe(true);
      expect(r.value.ast.view).toBe("archive");
      expect(r.value.ast.free).toEqual(["paid"]);
    }
  });

  it("returns 400 with a parser position when the query has bad grammar", () => {
    const r = parseSearchEmailInput({
      address: "alice@example.com",
      query: "from:alice foo:bar",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("query");
      expect(r.error.code).toBe("invalid_value");
      expect(r.error.position).toBe(11);
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

describe("parseSnoozeThreadInput (ADR-0029)", () => {
  // Pin a fixed `now` so past-time validation is deterministic. Wake times
  // older than this instant must be rejected; newer ones must pass.
  const NOW = new Date("2026-05-22T10:00:00.000Z");
  const FUTURE = "2026-05-23T09:00:00.000Z";
  const PAST = "2026-05-21T09:00:00.000Z";

  it("accepts a valid {thread_id, snoozed_until: <future iso>} body", () => {
    const r = parseSnoozeThreadInput(
      { thread_id: "<root@example.com>", snoozed_until: FUTURE },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        thread_id: "<root@example.com>",
        snoozed_until: FUTURE,
      });
    }
  });

  it("accepts {snoozed_until: null} for unsnoozing", () => {
    const r = parseSnoozeThreadInput(
      { thread_id: "<root@example.com>", snoozed_until: null },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.snoozed_until).toBeNull();
  });

  it("rejects a missing thread_id", () => {
    const r = parseSnoozeThreadInput({ snoozed_until: FUTURE }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects an empty thread_id", () => {
    const r = parseSnoozeThreadInput(
      { thread_id: "", snoozed_until: FUTURE },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a missing snoozed_until field", () => {
    const r = parseSnoozeThreadInput({ thread_id: "<root@example.com>" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("snoozed_until");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a non-string non-null snoozed_until", () => {
    const r = parseSnoozeThreadInput(
      { thread_id: "<root@example.com>", snoozed_until: 1234 },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("snoozed_until");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects an unparseable snoozed_until ISO string", () => {
    const r = parseSnoozeThreadInput(
      { thread_id: "<root@example.com>", snoozed_until: "not a date" },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("snoozed_until");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a snoozed_until in the past — typo'd wake time should 400, not silently no-op", () => {
    const r = parseSnoozeThreadInput(
      { thread_id: "<root@example.com>", snoozed_until: PAST },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("snoozed_until");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a snoozed_until equal to now (boundary — must be strictly future)", () => {
    const r = parseSnoozeThreadInput(
      {
        thread_id: "<root@example.com>",
        snoozed_until: NOW.toISOString(),
      },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("snoozed_until");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a non-object body", () => {
    expect(parseSnoozeThreadInput(null, NOW).ok).toBe(false);
    expect(parseSnoozeThreadInput([], NOW).ok).toBe(false);
    expect(parseSnoozeThreadInput("hello", NOW).ok).toBe(false);
  });
});

describe("parseTrashThreadInput (ADR-0030)", () => {
  it("accepts a valid {thread_id, trashed: true} body", () => {
    const r = parseTrashThreadInput({
      thread_id: "<root@example.com>",
      trashed: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        thread_id: "<root@example.com>",
        trashed: true,
      });
    }
  });

  it("accepts {trashed: false} for untrashing", () => {
    const r = parseTrashThreadInput({
      thread_id: "<root@example.com>",
      trashed: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.trashed).toBe(false);
  });

  it("rejects a missing thread_id", () => {
    const r = parseTrashThreadInput({ trashed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects an empty thread_id with code=missing", () => {
    const r = parseTrashThreadInput({ thread_id: "", trashed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a missing trashed with code=missing", () => {
    const r = parseTrashThreadInput({ thread_id: "<root@example.com>" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("trashed");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a non-boolean trashed", () => {
    const r = parseTrashThreadInput({
      thread_id: "<root@example.com>",
      trashed: "yes",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("trashed");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects a non-object body", () => {
    expect(parseTrashThreadInput(null).ok).toBe(false);
    expect(parseTrashThreadInput([]).ok).toBe(false);
    expect(parseTrashThreadInput("hello").ok).toBe(false);
  });
});

describe("parseMarkThreadReadInput (ADR-0031)", () => {
  it("accepts a valid {thread_id, read: true} body", () => {
    const r = parseMarkThreadReadInput({
      thread_id: "<root@example.com>",
      read: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        thread_id: "<root@example.com>",
        read: true,
      });
    }
  });

  it("accepts {read: false} for marking unread", () => {
    const r = parseMarkThreadReadInput({
      thread_id: "<root@example.com>",
      read: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.read).toBe(false);
  });

  it("rejects a missing thread_id", () => {
    const r = parseMarkThreadReadInput({ read: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects an empty thread_id with code=missing", () => {
    const r = parseMarkThreadReadInput({ thread_id: "", read: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a missing read with code=missing", () => {
    const r = parseMarkThreadReadInput({ thread_id: "<root@example.com>" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("read");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a non-boolean read", () => {
    const r = parseMarkThreadReadInput({
      thread_id: "<root@example.com>",
      read: "yes",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("read");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects a non-object body", () => {
    expect(parseMarkThreadReadInput(null).ok).toBe(false);
    expect(parseMarkThreadReadInput([]).ok).toBe(false);
    expect(parseMarkThreadReadInput("hello").ok).toBe(false);
  });
});

describe("parseArchiveThreadInput (ADR-0034)", () => {
  it("accepts a valid {thread_id, archived: true} body", () => {
    const r = parseArchiveThreadInput({
      thread_id: "<root@example.com>",
      archived: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        thread_id: "<root@example.com>",
        archived: true,
      });
    }
  });

  it("accepts {archived: false} for un-archiving", () => {
    const r = parseArchiveThreadInput({
      thread_id: "<root@example.com>",
      archived: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.archived).toBe(false);
  });

  it("rejects a missing thread_id", () => {
    const r = parseArchiveThreadInput({ archived: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects an empty thread_id with code=missing", () => {
    const r = parseArchiveThreadInput({ thread_id: "", archived: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("thread_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a missing archived with code=missing", () => {
    const r = parseArchiveThreadInput({ thread_id: "<root@example.com>" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("archived");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects a non-boolean archived", () => {
    const r = parseArchiveThreadInput({
      thread_id: "<root@example.com>",
      archived: "yes",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("archived");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects a non-object body", () => {
    expect(parseArchiveThreadInput(null).ok).toBe(false);
    expect(parseArchiveThreadInput([]).ok).toBe(false);
    expect(parseArchiveThreadInput("hello").ok).toBe(false);
  });
});

describe("parseSaveDraftInput (ADR-0035)", () => {
  it("accepts a first-save body (draft_id: null)", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: null,
      body_text: "hello",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.address).toBe("alice@acme.com");
      expect(r.value.draft_id).toBeNull();
      expect(r.value.body_text).toBe("hello");
      expect("to" in r.value).toBe(false);
    }
  });

  it("accepts an upsert body with optional recipient/subject fields", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
      body_text: "hi",
      to: "bob@example.com",
      cc: null,
      subject: "Re: Q2",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.draft_id).toBe("01KS500000000000000000DR01");
      expect(r.value.to).toBe("bob@example.com");
      expect(r.value.cc).toBeNull();
      expect(r.value.subject).toBe("Re: Q2");
    }
  });

  it("preserves the absent-vs-null distinction on optional fields", () => {
    // Absent → leave alone on the reader side. Null → clear. The schema
    // must keep both visible to the dispatcher; that's the whole reason
    // the parser uses an explicit "in obj" check.
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
      body_text: "x",
      to: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("to" in r.value).toBe(true);
      expect(r.value.to).toBeNull();
      expect("cc" in r.value).toBe(false);
      expect("subject" in r.value).toBe(false);
    }
  });

  it("accepts an empty body_text — operator typed only a subject", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: null,
      body_text: "",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing address", () => {
    const r = parseSaveDraftInput({ draft_id: null, body_text: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("address");
  });

  it("rejects a missing draft_id (different from null)", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      body_text: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("draft_id");
      expect(r.error.code).toBe("missing");
    }
  });

  it("rejects an empty-string draft_id", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: "",
      body_text: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("draft_id");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a numeric draft_id", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: 42,
      body_text: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("draft_id");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects a missing body_text", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("body_text");
  });

  it("rejects a non-string body_text", () => {
    const r = parseSaveDraftInput({
      address: "alice@acme.com",
      draft_id: null,
      body_text: 123,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("body_text");
      expect(r.error.code).toBe("invalid_type");
    }
  });

  it("rejects a non-object body", () => {
    expect(parseSaveDraftInput(null).ok).toBe(false);
    expect(parseSaveDraftInput([]).ok).toBe(false);
    expect(parseSaveDraftInput("x").ok).toBe(false);
  });
});

describe("parseListDraftsInput (ADR-0035)", () => {
  it("accepts the minimal required body", () => {
    const r = parseListDraftsInput({ address: "alice@acme.com" });
    expect(r.ok).toBe(true);
  });

  it("accepts an explicit limit + cursor", () => {
    const r = parseListDraftsInput({
      address: "alice@acme.com",
      limit: 10,
      cursor: "opaque",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limit).toBe(10);
      expect(r.value.cursor).toBe("opaque");
    }
  });

  it("rejects a missing address", () => {
    const r = parseListDraftsInput({ limit: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("address");
  });

  it("rejects a non-integer or non-positive limit", () => {
    expect(
      parseListDraftsInput({ address: "alice@acme.com", limit: 0 }).ok,
    ).toBe(false);
    expect(
      parseListDraftsInput({ address: "alice@acme.com", limit: -1 }).ok,
    ).toBe(false);
    expect(
      parseListDraftsInput({ address: "alice@acme.com", limit: "10" }).ok,
    ).toBe(false);
  });
});

describe("parseGetDraftInput (ADR-0035)", () => {
  it("accepts the address + draft_id pair", () => {
    const r = parseGetDraftInput({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing draft_id", () => {
    const r = parseGetDraftInput({ address: "alice@acme.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("draft_id");
  });

  it("rejects an empty draft_id", () => {
    const r = parseGetDraftInput({
      address: "alice@acme.com",
      draft_id: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("draft_id");
  });
});

describe("parseDeleteDraftInput (ADR-0035)", () => {
  it("accepts the address + draft_id pair", () => {
    const r = parseDeleteDraftInput({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing address", () => {
    const r = parseDeleteDraftInput({
      draft_id: "01KS500000000000000000DR01",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("address");
  });
});

// ADR-0037 (slice 8.17). Operator-defined labels. The label-name validator
// is shared across add/remove/create/delete/rename — its rules:
//   - non-empty after trim
//   - ≤ 32 characters
//   - no commas (catalog identity is comma-free for future cli-style filters)
//   - no control characters
// Casing is preserved on the wire; the reader lowercases for catalog identity.

describe("parseAddThreadLabelInput (ADR-0037)", () => {
  it("accepts a thread_id + label pair, trimming surrounding whitespace", () => {
    const r = parseAddThreadLabelInput({
      thread_id: "<root@example.com>",
      label: "  Work  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        thread_id: "<root@example.com>",
        label: "Work",
      });
    }
  });

  it("rejects a missing thread_id", () => {
    const r = parseAddThreadLabelInput({ label: "work" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("thread_id");
  });

  it("rejects a missing label", () => {
    const r = parseAddThreadLabelInput({ thread_id: "<root@example.com>" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("label");
  });

  it("rejects an empty-after-trim label", () => {
    const r = parseAddThreadLabelInput({
      thread_id: "<root@example.com>",
      label: "   ",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("label");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a label longer than 32 characters", () => {
    const r = parseAddThreadLabelInput({
      thread_id: "<root@example.com>",
      label: "x".repeat(33),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("label");
  });

  it("rejects a label containing a comma", () => {
    const r = parseAddThreadLabelInput({
      thread_id: "<root@example.com>",
      label: "Work, urgent",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("label");
  });

  it("rejects a label containing a control character", () => {
    const r = parseAddThreadLabelInput({
      thread_id: "<root@example.com>",
      label: "Work\nNext",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("label");
  });

  it("rejects a non-string label", () => {
    const r = parseAddThreadLabelInput({
      thread_id: "<root@example.com>",
      label: 42,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("label");
      expect(r.error.code).toBe("invalid_type");
    }
  });
});

describe("parseRemoveThreadLabelInput (ADR-0037)", () => {
  it("accepts the same shape as add_thread_label (shared validator)", () => {
    const r = parseRemoveThreadLabelInput({
      thread_id: "<root@example.com>",
      label: "work",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing thread_id with the same field pointer as add", () => {
    const r = parseRemoveThreadLabelInput({ label: "work" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("thread_id");
  });
});

describe("parseListLabelsInput (ADR-0037)", () => {
  it("accepts an address-only body", () => {
    const r = parseListLabelsInput({ address: "alice@acme.com" });
    expect(r.ok).toBe(true);
  });

  it("rejects a missing address", () => {
    const r = parseListLabelsInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("address");
  });
});

describe("parseCreateLabelInput / parseDeleteLabelInput (ADR-0037)", () => {
  it("create: accepts an address + label pair, preserving casing", () => {
    const r = parseCreateLabelInput({
      address: "alice@acme.com",
      label: "Work",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.label).toBe("Work");
  });

  it("delete: accepts the same shape (shared address+label validator)", () => {
    const r = parseDeleteLabelInput({
      address: "alice@acme.com",
      label: "Work",
    });
    expect(r.ok).toBe(true);
  });

  it("create: rejects a missing address", () => {
    const r = parseCreateLabelInput({ label: "work" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("address");
  });

  it("create: rejects an empty label", () => {
    const r = parseCreateLabelInput({
      address: "alice@acme.com",
      label: "",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("label");
  });
});

describe("parseRenameLabelInput (ADR-0037)", () => {
  it("accepts an address + from + to triple, preserving casing on both", () => {
    const r = parseRenameLabelInput({
      address: "alice@acme.com",
      from: "Work",
      to: "Career",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        address: "alice@acme.com",
        from: "Work",
        to: "Career",
      });
    }
  });

  it("rejects same-key rename even when casing differs (catalog identity is case-insensitive)", () => {
    const r = parseRenameLabelInput({
      address: "alice@acme.com",
      from: "Work",
      to: "WORK",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe("to");
      expect(r.error.code).toBe("invalid_value");
    }
  });

  it("rejects a missing from", () => {
    const r = parseRenameLabelInput({
      address: "alice@acme.com",
      to: "Career",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("from");
  });

  it("rejects a missing to", () => {
    const r = parseRenameLabelInput({
      address: "alice@acme.com",
      from: "Work",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe("to");
  });
});
