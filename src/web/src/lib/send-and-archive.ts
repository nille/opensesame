// ADR-0038 (slice 8.17). Pure orchestrator for the client-side
// send-and-archive compound. Composer calls this in its `Send + archive`
// path so the sequencing — pre-stamp pendingArchives → fire reply RPC →
// fan out per outcome — lives in one testable unit.
//
// The orchestrator owns the *order* of the side-effects: the optimistic
// archive stamp lands before the reply RPC fires, and is rolled back the
// instant the reply rejects (before any error UI lands). On reply-OK the
// orchestrator hands the thread_id back to the caller so App.tsx can
// close the composer and run the archive RPC. On reply-error it returns
// the failure envelope unchanged for the composer to surface in its
// existing error UI.

import type { ReplyToEmailRpcResult } from "./bff-client.ts";

export interface SendAndArchiveDeps {
  // Pre-stamp the App's pendingArchives map. Always called once, before
  // the reply RPC, when the caller has signalled `archive: true`.
  stampArchive: (threadId: string) => void;
  // Roll back the pre-stamp. Called once on reply-error. Never called on
  // reply-OK — the caller fires the archive RPC there, which owns its
  // own cleanup (drop on success, drop on archive-error → row reappears).
  dropArchive: (threadId: string) => void;
  // Fire the reply RPC. Stubbed in tests.
  replyToEmail: () => Promise<ReplyToEmailRpcResult>;
}

export interface SendAndArchiveOutcome {
  // The reply RPC's result, unchanged. Composer uses this to drive its
  // existing send-status reducer (suppressed / invalid_request /
  // parent_unrepliable / not_found / generic error).
  reply: ReplyToEmailRpcResult;
  // True when the orchestrator pre-stamped the archive map. Always true
  // when `threadId` was non-null at call time. False otherwise (the
  // legacy null-thread_id path falls back to plain reply with no stamp).
  stamped: boolean;
  // True when the orchestrator wants the caller to fire archive_thread
  // for this threadId. Only true on reply-OK with a non-null threadId.
  shouldArchive: boolean;
}

export async function sendAndArchive(
  threadId: string | null,
  deps: SendAndArchiveDeps,
): Promise<SendAndArchiveOutcome> {
  const willStamp = threadId !== null;
  if (willStamp) deps.stampArchive(threadId);

  const reply = await deps.replyToEmail();

  if (reply.kind === "ok") {
    return {
      reply,
      stamped: willStamp,
      shouldArchive: willStamp,
    };
  }

  // Reply failed — drop the optimistic stamp so the row snaps back into
  // the inbox before the composer renders its error UI.
  if (willStamp) deps.dropArchive(threadId);
  return {
    reply,
    stamped: willStamp,
    shouldArchive: false,
  };
}
