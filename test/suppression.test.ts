import { describe, expect, it } from "vitest";
import {
  normalizeRecipient,
  SuppressionBlockError,
  type SuppressedRecipient,
  type SuppressionList,
} from "../src/core/suppression.js";

describe("normalizeRecipient", () => {
  // Per ADR-0019: lower the entire string for v1. Matches what SES emits in
  // bounce/complaint event payloads, which is the input the bounce-handler
  // path uses to write the Suppressions row.
  it("lowercases both the local-part and the domain", () => {
    expect(normalizeRecipient("Alice@Example.COM")).toBe("alice@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRecipient("  bob@example.com  ")).toBe("bob@example.com");
  });

  it("returns null for inputs without a single @", () => {
    expect(normalizeRecipient("not-an-email")).toBeNull();
    expect(normalizeRecipient("")).toBeNull();
    expect(normalizeRecipient("   ")).toBeNull();
    expect(normalizeRecipient("two@@signs.com")).toBeNull();
  });

  it("returns null when local-part or domain is empty", () => {
    expect(normalizeRecipient("@example.com")).toBeNull();
    expect(normalizeRecipient("alice@")).toBeNull();
  });

  it("strips angle brackets if present (mailbox-list quirk)", () => {
    // SES never emits angle-bracketed addresses in event payloads, but the
    // CLI driver receives the raw `--to` value which a user can paste with
    // brackets. Normalizing here keeps the suppression key stable.
    expect(normalizeRecipient("<Alice@Example.com>")).toBe("alice@example.com");
  });
});

describe("SuppressionBlockError", () => {
  it("carries the offending recipients for the audit-log writer", () => {
    const offenders: SuppressedRecipient[] = [
      {
        recipient: "alice@example.com",
        reason: "bounced_permanent",
        last_event_at: "2026-05-21T17:00:00.000Z",
      },
    ];
    const err = new SuppressionBlockError(offenders);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SuppressionBlockError");
    expect(err.suppressed).toEqual(offenders);
    expect(err.message).toMatch(/alice@example\.com/);
    expect(err.message).toMatch(/bounced_permanent/);
  });

  it("formats multiple offenders into the message", () => {
    const offenders: SuppressedRecipient[] = [
      {
        recipient: "alice@example.com",
        reason: "bounced_permanent",
        last_event_at: "2026-05-21T17:00:00.000Z",
      },
      {
        recipient: "bob@example.com",
        reason: "complained",
        last_event_at: "2026-05-22T08:00:00.000Z",
      },
    ];
    const err = new SuppressionBlockError(offenders);
    expect(err.message).toMatch(/alice@example\.com/);
    expect(err.message).toMatch(/bob@example\.com/);
    expect(err.message).toMatch(/complained/);
  });
});

describe("SuppressionList port shape", () => {
  // Compile-time contract — this test only fails if the type drifts.
  it("matches the documented signature", () => {
    const stub: SuppressionList = {
      async checkRecipients() {
        return [];
      },
    };
    expect(typeof stub.checkRecipients).toBe("function");
  });
});
