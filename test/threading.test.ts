import { describe, expect, it } from "vitest";
import { deriveThreadId } from "../src/core/threading.js";

describe("deriveThreadId", () => {
  // Per ADR-0002 + ADR-0010 the thread_id is best-effort and derived from
  // RFC 5322 threading headers. The rule (so all replies in a thread share
  // one stable id):
  //   1. first valid token of References (the conversation root)
  //   2. else In-Reply-To
  //   3. else this message's own Message-ID (this message starts a thread)
  //   4. else null

  it("uses the first References token as the root for replies", () => {
    expect(
      deriveThreadId({
        messageId: "<reply-2@example.com>",
        inReplyTo: "<reply-1@example.com>",
        references: "<root@example.com> <reply-1@example.com>",
      }),
    ).toBe("<root@example.com>");
  });

  it("falls back to In-Reply-To when References is absent", () => {
    expect(
      deriveThreadId({
        messageId: "<reply-2@example.com>",
        inReplyTo: "<orig-1@example.com>",
        references: null,
      }),
    ).toBe("<orig-1@example.com>");
  });

  it("uses the message's own Message-ID for new threads", () => {
    // No threading headers → this message *is* the thread root.
    expect(
      deriveThreadId({
        messageId: "<fresh@example.com>",
        inReplyTo: null,
        references: null,
      }),
    ).toBe("<fresh@example.com>");
  });

  it("returns null when nothing usable is available", () => {
    // Per ADR-0010 consumers must tolerate empty/unstable thread ids.
    expect(
      deriveThreadId({
        messageId: null,
        inReplyTo: null,
        references: null,
      }),
    ).toBeNull();
  });

  it("prefers References even when In-Reply-To is also present", () => {
    // References carries the full ancestry; its first token is the most
    // stable root across the thread.
    expect(
      deriveThreadId({
        messageId: "<m3@example.com>",
        inReplyTo: "<m2@example.com>",
        references: "<m1@example.com> <m2@example.com>",
      }),
    ).toBe("<m1@example.com>");
  });

  it("handles multiple whitespace-separated tokens in References", () => {
    expect(
      deriveThreadId({
        messageId: "<m4@example.com>",
        inReplyTo: "<m3@example.com>",
        references:
          "  <m1@example.com>   <m2@example.com>\t<m3@example.com>  ",
      }),
    ).toBe("<m1@example.com>");
  });

  it("skips malformed References tokens and uses the first valid one", () => {
    // Some clients emit junk between angle-bracketed ids. We must not return
    // an unbracketed string token as a thread id.
    expect(
      deriveThreadId({
        messageId: "<m2@example.com>",
        inReplyTo: null,
        references: "garbage <root@example.com> <m1@example.com>",
      }),
    ).toBe("<root@example.com>");
  });

  it("trims whitespace around In-Reply-To values", () => {
    expect(
      deriveThreadId({
        messageId: "<m2@example.com>",
        inReplyTo: "   <orig@example.com>   ",
        references: null,
      }),
    ).toBe("<orig@example.com>");
  });

  it("falls back to messageId when References has no valid tokens", () => {
    expect(
      deriveThreadId({
        messageId: "<m1@example.com>",
        inReplyTo: null,
        references: "garbage no-brackets",
      }),
    ).toBe("<m1@example.com>");
  });
});
