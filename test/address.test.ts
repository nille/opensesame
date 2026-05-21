import { describe, expect, it } from "vitest";
import { parseAddressList } from "../src/core/address.js";

describe("parseAddressList", () => {
  it("returns an empty list for null or empty input", () => {
    // ADR-0010 requires `to: []` etc. when the header is absent — null in,
    // empty array out keeps the event-payload builder branch-free.
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("   ")).toEqual([]);
  });

  it("parses a bare addr-spec with no display name", () => {
    expect(parseAddressList("alice@example.com")).toEqual([
      { address: "alice@example.com", name: null },
    ]);
  });

  it("parses a name-addr (display name + angle-bracketed address)", () => {
    expect(parseAddressList("Alice Smith <alice@example.com>")).toEqual([
      { address: "alice@example.com", name: "Alice Smith" },
    ]);
  });

  it("parses multiple comma-separated addresses", () => {
    expect(
      parseAddressList(
        "Alice <alice@example.com>, bob@example.com, Carol <carol@example.com>",
      ),
    ).toEqual([
      { address: "alice@example.com", name: "Alice" },
      { address: "bob@example.com", name: null },
      { address: "carol@example.com", name: "Carol" },
    ]);
  });

  it("strips surrounding double quotes from the display name", () => {
    expect(parseAddressList('"Alice Smith" <alice@example.com>')).toEqual([
      { address: "alice@example.com", name: "Alice Smith" },
    ]);
  });

  it("does not split on commas inside quoted display names", () => {
    // Without quote-aware splitting this would parse as four broken entries.
    expect(
      parseAddressList(
        '"Smith, John" <john@example.com>, "Doe, Jane" <jane@example.com>',
      ),
    ).toEqual([
      { address: "john@example.com", name: "Smith, John" },
      { address: "jane@example.com", name: "Doe, Jane" },
    ]);
  });

  it("preserves RFC 2047-decoded display names verbatim", () => {
    // parseMime already runs decodeStructuredHeader before we see the value,
    // so display names arrive as plain UTF-8 — we must not mangle Unicode.
    expect(parseAddressList("Björn <bjorn@example.com>")).toEqual([
      { address: "bjorn@example.com", name: "Björn" },
    ]);
  });

  it("normalizes the address to lowercase but preserves the display name's case", () => {
    // Email addresses are case-insensitive in practice for routing/matching;
    // ADR-0010 doesn't dictate this but downstream consumers compare addresses
    // as strings and benefit from a stable canonical form.
    expect(parseAddressList("Alice SMITH <Alice@Example.COM>")).toEqual([
      { address: "alice@example.com", name: "Alice SMITH" },
    ]);
  });

  it("skips entries that cannot be resolved to an address", () => {
    // A trailing dangling comma or stray token should not produce a phantom
    // entry with address: "" — the event-payload builder needs valid rows.
    expect(parseAddressList("alice@example.com, , <not-an-email>")).toEqual([
      { address: "alice@example.com", name: null },
    ]);
  });

  it("trims whitespace around display names and addresses", () => {
    expect(
      parseAddressList("   Alice   <  alice@example.com  >  "),
    ).toEqual([{ address: "alice@example.com", name: "Alice" }]);
  });
});
