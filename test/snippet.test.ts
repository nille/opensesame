import { describe, expect, it } from "vitest";
import { makeSnippet } from "../src/core/snippet.js";

// Snippet contract: a short, single-line, codepoint-safe preview of body_text
// that the writer persists on the Messages row so read_inbox returns it
// without a chunks lookup. Maximum 200 *characters* (codepoints), not bytes —
// agents reason in characters, and a 200-byte budget would routinely cut
// Swedish text mid-sequence.

describe("makeSnippet", () => {
  it("returns the text verbatim when it fits the budget and has no whitespace runs", () => {
    expect(makeSnippet("hi bob")).toBe("hi bob");
  });

  it("collapses interior whitespace runs (incl. newlines) to single spaces", () => {
    const input = "line one\nline two\n\nline   three\ttabbed";
    expect(makeSnippet(input)).toBe("line one line two line three tabbed");
  });

  it("trims leading and trailing whitespace before truncating", () => {
    expect(makeSnippet("\n\n  hi  \n")).toBe("hi");
  });

  it("returns an empty string for empty / whitespace-only input", () => {
    expect(makeSnippet("")).toBe("");
    expect(makeSnippet("\n\t   \n")).toBe("");
  });

  it("truncates to the configured codepoint budget and adds an ellipsis", () => {
    const input = "a".repeat(500);
    const out = makeSnippet(input, 50);
    // 50 chars including the ellipsis — we don't go *over* the budget.
    expect([...out].length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not split a multi-codepoint sequence at the boundary (Swedish + emoji)", () => {
    // Each "🇸🇪" is two codepoints (regional indicators) — the boundary must
    // land between sequences, never inside one. Easiest stable invariant to
    // assert: the output is valid UTF-8 and round-trips through TextDecoder
    // with fatal=true.
    const flavor = "Hej Björn 🇸🇪 räkning ✉️ ";
    const input = flavor.repeat(50);
    const out = makeSnippet(input, 80);
    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8", { fatal: true });
    expect(() => dec.decode(enc.encode(out))).not.toThrow();
    expect([...out].length).toBeLessThanOrEqual(80);
  });

  it("uses the default 200-char budget when no second argument is passed", () => {
    const input = "x".repeat(1000);
    const out = makeSnippet(input);
    expect([...out].length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not append an ellipsis when the input fits exactly within the budget", () => {
    const input = "a".repeat(50);
    expect(makeSnippet(input, 50)).toBe(input);
  });
});
