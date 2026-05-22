import { describe, expect, it } from "vitest";
import {
  canonicalReSubject,
  previewQuotedBody,
  previewReplyAllCc,
  previewReplyTarget,
} from "../../src/web/src/lib/reply-preview.js";

// The composer's reply preview is UI-side only — the server's
// buildReplyComposeInput remains authoritative. These tests cover the
// surface the operator sees in the To/Cc/Subject lines while drafting.

describe("canonicalReSubject", () => {
  it("prepends Re: to a fresh subject", () => {
    expect(canonicalReSubject("Q2 invoice")).toBe("Re: Q2 invoice");
  });

  it("does not double-stamp when parent already starts with Re:", () => {
    expect(canonicalReSubject("Re: Q2 invoice")).toBe("Re: Q2 invoice");
  });

  it("collapses runs of Re: regardless of case", () => {
    expect(canonicalReSubject("RE: re: Re: status")).toBe("Re: status");
  });

  it("yields just `Re: ` for null parent subject", () => {
    expect(canonicalReSubject(null)).toBe("Re: ");
  });

  it("leaves localized prefixes intact", () => {
    expect(canonicalReSubject("Aw: Hallo")).toBe("Re: Aw: Hallo");
  });
});

describe("previewQuotedBody", () => {
  it("renders attribution + > prefixed body lines", () => {
    expect(
      previewQuotedBody({
        parentDate: "Tue, 19 May 2026 14:23:10 +0000",
        parentFrom: "Bob <bob@example.com>",
        parentReceivedAt: "2026-05-19T14:23:10.901Z",
        parentBodyText: "hi alice\nhope you are well\n",
      }),
    ).toBe(
      [
        "On Tue, 19 May 2026 14:23:10 +0000, Bob <bob@example.com> wrote:",
        "> hi alice",
        "> hope you are well",
      ].join("\n"),
    );
  });

  it("falls back to received_at and (unknown sender) when date/from are absent", () => {
    expect(
      previewQuotedBody({
        parentDate: null,
        parentFrom: null,
        parentReceivedAt: "2026-05-19T14:23:10.901Z",
        parentBodyText: "x",
      }),
    ).toBe(
      ["On 2026-05-19T14:23:10.901Z, (unknown sender) wrote:", "> x"].join("\n"),
    );
  });

  it("quotes empty parent lines as bare > with no trailing space", () => {
    expect(
      previewQuotedBody({
        parentDate: "d",
        parentFrom: "f",
        parentReceivedAt: "r",
        parentBodyText: "para 1\n\npara 2\n",
      }),
    ).toContain("> para 1\n>\n> para 2");
  });

  it("emits attribution only when parent body is empty", () => {
    expect(
      previewQuotedBody({
        parentDate: "d",
        parentFrom: "f",
        parentReceivedAt: "r",
        parentBodyText: "",
      }),
    ).toBe("On d, f wrote:");
  });
});

describe("previewReplyTarget", () => {
  it("prefers Reply-To over From when both are present", () => {
    expect(
      previewReplyTarget("list-replies@example.com", "Sender <s@example.com>"),
    ).toBe("list-replies@example.com");
  });

  it("falls back to From when Reply-To is null", () => {
    expect(previewReplyTarget(null, "Sender <s@example.com>")).toBe(
      "Sender <s@example.com>",
    );
  });

  it("returns empty string when both are null", () => {
    expect(previewReplyTarget(null, null)).toBe("");
  });
});

describe("previewReplyAllCc", () => {
  it("returns empty when there are no parent recipients", () => {
    expect(previewReplyAllCc(null, null, "alice@acme.com", "s@x")).toBe("");
  });

  it("unions parent.to and parent.cc and drops self + target", () => {
    const out = previewReplyAllCc(
      "alice@acme.com, bob@example.com",
      "carol@example.com, sender@example.com",
      "alice@acme.com",
      "sender@example.com",
    );
    expect(out).toBe("bob@example.com, carol@example.com");
  });

  it("dedupes when an address appears in both to and cc", () => {
    const out = previewReplyAllCc(
      "bob@example.com",
      "bob@example.com, carol@example.com",
      "alice@acme.com",
      "sender@example.com",
    );
    expect(out).toBe("bob@example.com, carol@example.com");
  });

  it("treats display-name forms case-insensitively when matching self/target", () => {
    const out = previewReplyAllCc(
      "Bob <bob@example.com>, ALICE@acme.com",
      "Sender <sender@example.com>",
      "alice@acme.com",
      "sender@example.com",
    );
    expect(out).toBe("Bob <bob@example.com>");
  });
});
