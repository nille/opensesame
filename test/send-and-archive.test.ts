import { describe, expect, it, vi } from "vitest";
import { sendAndArchive } from "../src/web/src/lib/send-and-archive.js";
import type { ReplyToEmailRpcResult } from "../src/web/src/lib/bff-client.js";

// ADR-0038 (slice 8.17). The send-and-archive orchestrator owns the
// ordering invariant the spec calls out in §Implementation:
//   1. Pre-stamp pendingArchives BEFORE the reply RPC fires.
//   2. On reply-OK, hand the threadId back so the caller fires
//      archive_thread (the orchestrator does NOT itself fire archive —
//      that's runArchiveRpc on the App side, which owns its rollback).
//   3. On reply-error, drop the pre-stamp before the caller surfaces
//      the error UI. The row snaps back into the inbox before the
//      operator sees the toast.
//   4. With threadId === null (legacy parent), no stamp is taken and
//      the reply path falls through unchanged.

const okReply: ReplyToEmailRpcResult = {
  kind: "ok",
  value: {
    message_id: "<reply-1@example.com>",
    sent_at: "2026-05-22T10:00:00.000Z",
  },
};

const suppressedReply: ReplyToEmailRpcResult = {
  kind: "suppressed",
  message: "all recipients suppressed",
  blocked_recipients: ["bounces@example.com"],
};

const notFoundReply: ReplyToEmailRpcResult = {
  kind: "not_found",
  code: "not_found",
  message: "parent message not found",
};

describe("sendAndArchive (ADR-0038)", () => {
  it("stamps the archive map before the reply RPC fires", async () => {
    const order: string[] = [];
    const stamp = vi.fn((tid: string) => order.push(`stamp:${tid}`));
    const drop = vi.fn();
    const reply = vi.fn(async (): Promise<ReplyToEmailRpcResult> => {
      order.push("reply");
      return okReply;
    });

    const result = await sendAndArchive("<root-1@example.com>", {
      stampArchive: stamp,
      dropArchive: drop,
      replyToEmail: reply,
    });

    // The stamp lands first. Same-tick ordering is the whole point: the
    // inbox row vanishes the moment the operator commits, not after the
    // reply round-trip lands.
    expect(order).toEqual(["stamp:<root-1@example.com>", "reply"]);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
    expect(result.shouldArchive).toBe(true);
    expect(result.stamped).toBe(true);
    expect(result.reply).toBe(okReply);
  });

  it("returns shouldArchive: true on reply-OK, leaving archive RPC to the caller", async () => {
    const stamp = vi.fn();
    const drop = vi.fn();
    const result = await sendAndArchive("<root-2@example.com>", {
      stampArchive: stamp,
      dropArchive: drop,
      replyToEmail: async () => okReply,
    });

    // The orchestrator never fires archive itself — it returns the
    // intent. App.tsx's onSentAndArchive runs runArchiveRpc with its
    // own rollback path (send-OK + archive-error → row reappears).
    expect(result.shouldArchive).toBe(true);
    expect(drop).not.toHaveBeenCalled();
  });

  it("rolls back the stamp on reply-error before returning", async () => {
    const order: string[] = [];
    const stamp = vi.fn((tid: string) => order.push(`stamp:${tid}`));
    const drop = vi.fn((tid: string) => order.push(`drop:${tid}`));
    const reply = vi.fn(async (): Promise<ReplyToEmailRpcResult> => {
      order.push("reply");
      return suppressedReply;
    });

    const result = await sendAndArchive("<root-3@example.com>", {
      stampArchive: stamp,
      dropArchive: drop,
      replyToEmail: reply,
    });

    // Drop must run before the orchestrator returns — the composer's
    // existing error UI renders synchronously off the returned envelope,
    // so a late drop would briefly leave the row hidden.
    expect(order).toEqual([
      "stamp:<root-3@example.com>",
      "reply",
      "drop:<root-3@example.com>",
    ]);
    expect(result.shouldArchive).toBe(false);
    expect(result.stamped).toBe(true);
    expect(result.reply).toBe(suppressedReply);
  });

  it("rolls back on every non-ok reply envelope (not_found, invalid_request, generic error)", async () => {
    const drop = vi.fn();
    const result = await sendAndArchive("<root-4@example.com>", {
      stampArchive: vi.fn(),
      dropArchive: drop,
      replyToEmail: async () => notFoundReply,
    });
    expect(drop).toHaveBeenCalledWith("<root-4@example.com>");
    expect(result.shouldArchive).toBe(false);
  });

  it("skips the stamp entirely when threadId is null (legacy parent)", async () => {
    const stamp = vi.fn();
    const drop = vi.fn();
    const result = await sendAndArchive(null, {
      stampArchive: stamp,
      dropArchive: drop,
      replyToEmail: async () => okReply,
    });
    expect(stamp).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
    expect(result.stamped).toBe(false);
    expect(result.shouldArchive).toBe(false);
    expect(result.reply).toBe(okReply);
  });

  it("does not call dropArchive on reply-OK — that's the caller's archive RPC's job", async () => {
    const drop = vi.fn();
    await sendAndArchive("<root-5@example.com>", {
      stampArchive: vi.fn(),
      dropArchive: drop,
      replyToEmail: async () => okReply,
    });
    // The pending entry stays stamped through the archive RPC's own
    // lifecycle; runArchiveRpc on the App side drops it on success or
    // on archive-error (rollback for the send-OK + archive-error
    // failure mode the spec calls out).
    expect(drop).not.toHaveBeenCalled();
  });
});
