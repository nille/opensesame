import { describe, expect, it } from "vitest";
import {
  buildReplyComposeInput,
  canonicalizeReSubject,
  ReplyParentUnrepliable,
  REFERENCES_CAP,
} from "../src/core/reply-to-email.js";
import type { ReadMessageOk } from "../src/core/store.js";

// Minimal ReadMessageOk factory — ADR-0022 builder is a pure function over
// (parent, body, opts). Each test overrides only the fields it exercises.
function makeParent(over: Partial<ReadMessageOk> = {}): ReadMessageOk {
  const base: ReadMessageOk = {
    parse_status: "ok",
    schema_v: "1",
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
    direction: "in",
    attachments: [],
    read_at: null,
    thread_id: null,
    starred_at: null,
    snoozed_until: null,
    trashed_at: null,
    archived_at: null,
    labels: [],
  };
  return {
    ...base,
    ...over,
    headers: { ...base.headers, ...(over.headers ?? {}) },
  };
}

describe("buildReplyComposeInput threading", () => {
  it("sets In-Reply-To to parent.message_id and seeds References when parent had none", () => {
    const parent = makeParent();
    const out = buildReplyComposeInput(
      parent,
      { body_text: "thanks" },
      { reply_all: false },
    );
    expect(out.in_reply_to).toBe("<orig-1@example.com>");
    expect(out.references).toEqual(["<orig-1@example.com>"]);
  });

  it("appends parent.message_id to parent's References (parent's view of the chain)", () => {
    const parent = makeParent({
      headers: {
        from: "Sender <sender@example.com>",
        to: "alice@acme.com",
        cc: null,
        reply_to: null,
        subject: "Re: Q2",
        date: null,
        message_id: "<reply-2@example.com>",
        in_reply_to: "<orig-1@example.com>",
        references: "<root@example.com> <orig-1@example.com>",
        auto_submitted: "no",
        list_id: null,
      },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.in_reply_to).toBe("<reply-2@example.com>");
    expect(out.references).toEqual([
      "<root@example.com>",
      "<orig-1@example.com>",
      "<reply-2@example.com>",
    ]);
  });

  it("does not double-stamp when parent.message_id already appears in parent.references", () => {
    // Some MUAs include their own Message-ID in References. We tolerate it.
    const parent = makeParent({
      headers: {
        from: "Sender <sender@example.com>",
        to: "alice@acme.com",
        cc: null,
        reply_to: null,
        subject: "X",
        date: null,
        message_id: "<weird-2@example.com>",
        in_reply_to: null,
        references: "<root@example.com> <weird-2@example.com>",
        auto_submitted: "no",
        list_id: null,
      },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.references).toEqual([
      "<root@example.com>",
      "<weird-2@example.com>",
    ]);
  });

  it("trims oldest middle entries when References would exceed REFERENCES_CAP, keeping the original anchor", () => {
    // 12-entry chain pre-existing → adding parent.message_id makes 13 → trim.
    const long = Array.from({ length: REFERENCES_CAP }, (_, i) => `<m${i}@x>`);
    const parent = makeParent({
      headers: {
        from: "S <s@x>",
        to: "alice@acme.com",
        cc: null,
        reply_to: null,
        subject: "X",
        date: null,
        message_id: "<latest@x>",
        in_reply_to: null,
        references: long.join(" "),
        auto_submitted: "no",
        list_id: null,
      },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.references).toBeDefined();
    expect(out.references!.length).toBe(REFERENCES_CAP);
    expect(out.references![0]).toBe("<m0@x>"); // anchor preserved
    expect(out.references![out.references!.length - 1]).toBe("<latest@x>");
  });
});

describe("buildReplyComposeInput subject canonicalization", () => {
  it("prepends Re: to a fresh subject", () => {
    const parent = makeParent({
      headers: { ...makeParent().headers, subject: "Q2 invoice" },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.subject).toBe("Re: Q2 invoice");
  });

  it("does not double-stamp when parent already starts with Re:", () => {
    const parent = makeParent({
      headers: { ...makeParent().headers, subject: "Re: Q2 invoice" },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.subject).toBe("Re: Q2 invoice");
  });

  it("collapses runs of Re: Re: Re: into a single canonical prefix", () => {
    const parent = makeParent({
      headers: { ...makeParent().headers, subject: "RE: re: Re: status" },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.subject).toBe("Re: status");
  });

  it("leaves localized prefixes intact, only stamps Re: in front", () => {
    // ADR-0022: don't translate, just don't double-stamp our own Re:.
    const parent = makeParent({
      headers: { ...makeParent().headers, subject: "Aw: Hallo" },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.subject).toBe("Re: Aw: Hallo");
  });

  it("yields just `Re: ` for an empty parent subject", () => {
    const parent = makeParent({
      headers: { ...makeParent().headers, subject: null },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.subject).toBe("Re: ");
  });

  it("canonicalizeReSubject is exported and idempotent", () => {
    expect(canonicalizeReSubject("Re: Re: hi")).toBe("Re: hi");
    expect(canonicalizeReSubject(canonicalizeReSubject("Re: hi"))).toBe(
      "Re: hi",
    );
  });
});

describe("buildReplyComposeInput recipients", () => {
  it("uses parent.from as the reply target when no Reply-To is set", () => {
    const parent = makeParent();
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.to).toEqual(["sender@example.com"]);
    expect(out.cc).toBeUndefined();
  });

  it("prefers Reply-To over From when present (mailing-list correctness)", () => {
    const parent = makeParent({
      headers: {
        ...makeParent().headers,
        reply_to: "list-replies@example.com",
      },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.to).toEqual(["list-replies@example.com"]);
  });

  it("reply_all=true puts target in to[], unions parent.to+parent.cc into cc[], drops self and target", () => {
    const parent = makeParent({
      headers: {
        ...makeParent().headers,
        from: "Sender <sender@example.com>",
        to: "alice@acme.com, bob@example.com",
        cc: "carol@example.com, sender@example.com",
      },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: true },
    );
    expect(out.to).toEqual(["sender@example.com"]);
    // cc: bob (from to), carol (from cc); alice removed (self), sender removed (target).
    expect(out.cc).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("reply_all dedupes when an address appears in both to and cc", () => {
    const parent = makeParent({
      headers: {
        ...makeParent().headers,
        from: "Sender <sender@example.com>",
        to: "bob@example.com",
        cc: "bob@example.com, carol@example.com",
      },
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: true },
    );
    expect(out.cc).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("from is always the parent's address (operator's mailbox for this thread)", () => {
    const parent = makeParent({ address: "support@acme.com" });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok" },
      { reply_all: false },
    );
    expect(out.from).toBe("support@acme.com");
  });
});

describe("buildReplyComposeInput body and quoting", () => {
  it("top-posts operator text, then attribution, then quoted parent body", () => {
    const parent = makeParent({
      headers: {
        ...makeParent().headers,
        from: "Bob <bob@example.com>",
        date: "Tue, 19 May 2026 14:23:10 +0000",
      },
      body_text: "hi alice\nhope you are well\n",
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "thanks bob" },
      { reply_all: false },
    );
    expect(out.body_text).toBe(
      [
        "thanks bob",
        "",
        "On Tue, 19 May 2026 14:23:10 +0000, Bob <bob@example.com> wrote:",
        "> hi alice",
        "> hope you are well",
      ].join("\n"),
    );
  });

  it("quotes empty parent lines as a bare `>` (no trailing space)", () => {
    const parent = makeParent({ body_text: "para 1\n\npara 2\n" });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "k" },
      { reply_all: false },
    );
    expect(out.body_text).toContain("> para 1\n>\n> para 2");
  });

  it("falls back to received_at and `(unknown sender)` when date/from are absent", () => {
    const parent = makeParent({
      headers: { ...makeParent().headers, from: null, date: null },
      received_at: "2026-05-19T14:23:10.901Z",
    });
    const out = buildReplyComposeInput(
      parent,
      { body_text: "k" },
      { reply_all: false },
    );
    expect(out.body_text).toContain(
      "On 2026-05-19T14:23:10.901Z, (unknown sender) wrote:",
    );
  });

  it("forwards body_html unchanged when the caller passes one (no auto-quote)", () => {
    const parent = makeParent();
    const out = buildReplyComposeInput(
      parent,
      { body_text: "ok", body_html: "<p>ok</p>" },
      { reply_all: false },
    );
    expect(out.body_html).toBe("<p>ok</p>");
  });
});

describe("buildReplyComposeInput parent rejection", () => {
  it("throws ReplyParentUnrepliable('no_message_id') when parent.message_id is null", () => {
    const parent = makeParent({
      headers: { ...makeParent().headers, message_id: null },
    });
    let caught: unknown = null;
    try {
      buildReplyComposeInput(
        parent,
        { body_text: "ok" },
        { reply_all: false },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReplyParentUnrepliable);
    expect((caught as ReplyParentUnrepliable).reason).toBe("no_message_id");
  });
});
