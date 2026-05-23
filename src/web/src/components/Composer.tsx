import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  bff,
  type ReadMessageHeaders,
  type ReplyToEmailRpcResult,
  type RpcResult,
  type SaveDraftInput,
  type SendEmailResult,
  type StoredDraft,
} from "../lib/bff-client.ts";
import {
  canonicalReSubject,
  previewQuotedBody,
  previewReplyAllCc,
  previewReplyTarget,
} from "../lib/reply-preview.ts";
import { sendAndArchive } from "../lib/send-and-archive.ts";

export interface ComposerSeed {
  to?: string;
  cc?: string;
  subject?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
}

// ADR-0035 (slice 8.17). Auto-save debounce. 1500ms is the gap between a
// fast typist's keystroke runs — long enough to skip mid-word writes, short
// enough that a draft survives a tab close within ~1.5s of the last edit.
const DRAFT_AUTOSAVE_DELAY_MS = 1500;

// Parent context for reply mode (ADR-0022). When present, the composer
// renders derived recipients/subject as read-only mono lines and routes
// Send through bff.replyToEmail — the server resolves the parent again
// and remains authoritative for threading + suppression.
export interface ComposerReplyParent {
  message_id: string;
  // Parent's mailbox (the operator's address that received the parent).
  // Used for the from line and for self-elision in the reply_all Cc preview.
  address: string;
  headers: ReadMessageHeaders;
  // Parent's plain-text body. Rendered below the operator's textarea as a
  // preview of what the server will quote.
  body_text: string;
  // Parent's ingest timestamp — fallback for the attribution line when
  // the parent has no Date: header.
  received_at: string;
  // ADR-0038 (slice 8.17). Server-stamped thread root for send-and-archive.
  // Null on legacy / unparseable parents — those threads can't be replied
  // to (parent_unrepliable already gates this), so the null path is
  // unreachable in practice; we type it null-safe to mirror ReadMessageOk.
  thread_id: string | null;
}

interface ComposerProps {
  from: string;
  seed: ComposerSeed | null;
  parent: ComposerReplyParent | null;
  // ADR-0035 (slice 8.17). When set, the composer pre-loads its fields from
  // a saved draft and treats the existing draft_id as the upsert handle for
  // subsequent auto-saves. Send-success deletes the draft. Resume implies
  // not-reply mode (parent === null) — the rail's drafts view doesn't know
  // about reply parents.
  resumeDraft?: StoredDraft | null;
  onCancel: () => void;
  onSent: () => void;
  // ADR-0038 (slice 8.17). Send-and-archive callback. Composer pre-stamps
  // the App's pendingArchives map via onArchiveStamp, fires the reply RPC,
  // and on reply-OK invokes this with the parent's thread_id so App can
  // close the composer and fire archive_thread. On reply error the
  // composer drops the stamp via onArchiveStampDrop. Optional — only the
  // "Send + archive" path uses it; bare Send still calls onSent().
  onSentAndArchive?: (threadId: string) => void;
  // ADR-0038. Pre-stamp / drop hooks for the optimistic archive-on-reply
  // flow. Called by the composer (not App) so the stamp lands the moment
  // the operator commits the send-and-archive button — same perceived
  // latency as a bare `e` press.
  onArchiveStamp?: (threadId: string, next: boolean) => void;
  onArchiveStampDrop?: (threadId: string) => void;
  // Fired after each successful save / delete so the parent can refresh
  // its drafts list and the rail count without re-polling.
  onDraftsChanged?: () => void;
}

// Inline composer — takes over the reader pane, never a modal. The 409
// suppression case renders blocked recipients under the To: field; the
// 500 case keeps the draft and surfaces a quiet line under the send button.
//
// Reply mode (parent !== null): To/Cc/Subject become derived read-only mono
// lines; Send calls reply_to_email; `a` toggles reply_all.

export function Composer({
  from,
  seed,
  parent,
  resumeDraft,
  onCancel,
  onSent,
  onSentAndArchive,
  onArchiveStamp,
  onArchiveStampDrop,
  onDraftsChanged,
}: ComposerProps): JSX.Element {
  const replyMode = parent !== null;
  // ADR-0038 (slice 8.17). The "Send + archive" affordance shows only
  // when reply mode is active, the parent has a server-stamped
  // thread_id, and the App has wired the callbacks. Legacy parents with
  // null thread_id (parse_status === "ok" but pre-ADR-0026 rows) keep
  // single-button behavior — they fall through to the bare reply path.
  const canSendAndArchive =
    replyMode &&
    parent.thread_id !== null &&
    onSentAndArchive !== undefined &&
    onArchiveStamp !== undefined;
  // Drafts only exist for fresh compose — reply mode routes through
  // reply_to_email (the parent's threading is server-authoritative; saving
  // an in-progress reply as a draft would lose that linkage). A future
  // slice can wire reply-as-draft once the schema carries the reply
  // parent's message_id.
  const draftsEnabled = !replyMode;

  const [to, setTo] = useState(resumeDraft?.to ?? seed?.to ?? "");
  const [cc, setCc] = useState(resumeDraft?.cc ?? seed?.cc ?? "");
  const [subject, setSubject] = useState(
    resumeDraft?.subject ?? seed?.subject ?? "",
  );
  const [bodyText, setBodyText] = useState(
    resumeDraft?.body_text ?? seed?.bodyText ?? "",
  );
  const [replyAll, setReplyAll] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "error"; message: string }
    | { kind: "blocked"; recipients: string[] }
    | { kind: "invalid"; field: string; message: string }
    | { kind: "parent_unrepliable"; reason: string; message: string }
  >({ kind: "idle" });
  // The minted draft id. null until the first save returns; subsequent
  // saves pass it back as the upsert handle. A 404 (draft deleted from
  // another tab) clears it so the next debounce mints a fresh row.
  const [draftId, setDraftId] = useState<string | null>(
    resumeDraft?.draft_id ?? null,
  );
  // Saving spinner state. Kept tiny — the footer renders "saved · HH:MM"
  // when idle and "saving…" while in flight. Don't conflate with `status`
  // (which is for send-time errors only).
  const [draftStatus, setDraftStatus] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; at: string }
    | { kind: "error"; message: string }
  >(resumeDraft !== null && resumeDraft !== undefined
    ? { kind: "saved", at: resumeDraft.updated_at }
    : { kind: "idle" });

  // Reply mode previews — UI-side mirror of the server derivation. Cheap to
  // recompute and keeps the operator honest about what will be sent.
  const replyPreview = useMemo(() => {
    if (parent === null) return null;
    const target = previewReplyTarget(
      parent.headers.reply_to,
      parent.headers.from,
    );
    const ccLine = replyAll
      ? previewReplyAllCc(
          parent.headers.to,
          parent.headers.cc,
          parent.address,
          target,
        )
      : "";
    return {
      to: target,
      cc: ccLine,
      subject: canonicalReSubject(parent.headers.subject),
    };
  }, [parent, replyAll]);

  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // In reply mode the recipients/subject are derived; drop focus straight
    // into the body so the operator can start typing. Same for fresh compose
    // when the seed pre-fills To.
    if (replyMode || (seed?.to && seed.to.length > 0)) {
      const ta = document.querySelector<HTMLTextAreaElement>(
        ".composer__body",
      );
      ta?.focus();
    } else {
      toRef.current?.focus();
    }
  }, [seed, replyMode]);

  // Esc cancels the composer. ⌘↵ sends. In reply mode, `a` (when not in a
  // text field) flips reply_all — the textarea swallows the event so the
  // operator can still type the letter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Save-on-blur: persist whatever's in the buffer before the
        // composer goes away. The save is fire-and-forget; the parent
        // will reload the drafts list when the operator opens it next.
        if (draftsEnabled && hasContent(to, cc, subject, bodyText)) {
          void saveDraftNow();
        }
        onCancel();
      } else if (
        replyMode &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key === "Enter"
      ) {
        // ADR-0038 (slice 8.17). Shift+⌘↵ in reply mode sends the reply
        // and archives the parent thread in one gesture.
        e.preventDefault();
        void sendInternal({ archive: true });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      } else if (replyMode && e.key === "a" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setReplyAll((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // send is stable enough; eslint can complain in a follow-up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, bodyText, seed, parent, replyAll]);

  // ADR-0035 (slice 8.17). Debounced auto-save. Fires 1500ms after the
  // last edit when the buffer has any content. The first save mints a
  // ULID and stamps draftId; subsequent saves upsert the same row.
  // Empty buffers don't fire — a freshly-opened composer with nothing
  // typed shouldn't create a phantom draft.
  useEffect(() => {
    if (!draftsEnabled) return;
    if (!hasContent(to, cc, subject, bodyText)) return;
    const handle = window.setTimeout(() => {
      void saveDraftNow();
    }, DRAFT_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(handle);
    // saveDraftNow closes over draftId/from/to/cc/subject/bodyText, so
    // we depend on the inputs themselves rather than a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, bodyText, draftsEnabled]);

  const saveDraftNow = async (): Promise<void> => {
    setDraftStatus({ kind: "saving" });
    const input: SaveDraftInput = {
      address: from,
      body_text: bodyText,
    };
    if (draftId !== null) input.draft_id = draftId;
    if (to.length > 0) input.to = to;
    if (cc.length > 0) input.cc = cc;
    if (subject.length > 0) input.subject = subject;
    const r = await bff.saveDraft(input);
    if (r.kind === "ok") {
      setDraftId(r.value.draft_id);
      setDraftStatus({ kind: "saved", at: r.value.updated_at });
      onDraftsChanged?.();
      return;
    }
    if (r.kind === "not_found") {
      // Stale draft_id — another tab deleted the row. Drop the id and
      // let the next debounce mint a fresh one. The local buffer is
      // preserved so the operator doesn't lose what they typed.
      setDraftId(null);
      setDraftStatus({
        kind: "error",
        message: "draft was deleted elsewhere — saving as new",
      });
      return;
    }
    setDraftStatus({
      kind: "error",
      message: "code" in r ? `${r.code}: ${r.message}` : "save failed",
    });
  };

  const send = (): Promise<void> => sendInternal({ archive: false });

  // ADR-0038 (slice 8.17). Sends the reply (or new compose) and, when
  // `archive` is true and the parent thread_id is known, fires the App's
  // archive-on-reply callback after a successful send. Pre-stamps the
  // App's pendingArchives map *before* the reply RPC so the inbox row
  // vanishes the instant the operator commits — same perceived latency
  // as a bare `e` press. On send error the stamp is dropped before the
  // composer surfaces the error UI; the row snaps back into the inbox.
  const sendInternal = async ({
    archive,
  }: {
    archive: boolean;
  }): Promise<void> => {
    setStatus({ kind: "sending" });

    if (parent !== null) {
      // Send-and-archive is gated on a known thread_id + the App
      // callbacks. Both should be present when the operator clicks the
      // second button. Defensive null guard stays — a legacy parent
      // slipping through still sends as a plain reply.
      const willArchive =
        archive &&
        parent.thread_id !== null &&
        onSentAndArchive !== undefined &&
        onArchiveStamp !== undefined &&
        onArchiveStampDrop !== undefined;
      const archiveThreadId = willArchive ? parent.thread_id : null;

      const outcome = await sendAndArchive(archiveThreadId, {
        stampArchive: (tid) => onArchiveStamp?.(tid, true),
        dropArchive: (tid) => onArchiveStampDrop?.(tid),
        replyToEmail: () =>
          bff.replyToEmail({
            message_id: parent.message_id,
            body_text: bodyText,
            reply_all: replyAll,
          }),
      });
      const result: ReplyToEmailRpcResult = outcome.reply;
      if (result.kind === "ok") {
        if (
          outcome.shouldArchive &&
          archiveThreadId !== null &&
          onSentAndArchive !== undefined
        ) {
          // App handles closing the composer + firing archive_thread.
          onSentAndArchive(archiveThreadId);
        } else {
          onSent();
        }
        return;
      }
      if (result.kind === "suppressed") {
        setStatus({ kind: "blocked", recipients: result.blocked_recipients });
        return;
      }
      if (result.kind === "invalid_request") {
        setStatus({
          kind: "invalid",
          field: result.field,
          message: result.message,
        });
        return;
      }
      if (result.kind === "parent_unrepliable") {
        setStatus({
          kind: "parent_unrepliable",
          reason: result.reason,
          message: result.message,
        });
        return;
      }
      if (result.kind === "not_found") {
        setStatus({ kind: "error", message: `${result.code}: ${result.message}` });
        return;
      }
      setStatus({
        kind: "error",
        message: "code" in result ? `${result.code}: ${result.message}` : "reply failed",
      });
      return;
    }

    const recipients = parseAddrList(to);
    const ccList = parseAddrList(cc);
    const input: Parameters<typeof bff.sendEmail>[0] = {
      from,
      to: recipients,
      subject,
      body_text: bodyText,
    };
    if (ccList.length > 0) input.cc = ccList;
    if (seed?.inReplyTo && seed.inReplyTo.length > 0) {
      input.in_reply_to = seed.inReplyTo;
    }
    if (seed?.references && seed.references.length > 0) {
      input.references = seed.references.split(/\s+/).filter((s) => s.length > 0);
    }

    const result: RpcResult<SendEmailResult> = await bff.sendEmail(input);
    if (result.kind === "ok") {
      // ADR-0035 (slice 8.17). Send-success deletes the draft. Fire and
      // forget — a stale draft on send-success is a worse UI than missing
      // the rare 500 here, and the server-side delete is idempotent.
      if (draftsEnabled && draftId !== null) {
        const idToDelete = draftId;
        void bff
          .deleteDraft({ address: from, draft_id: idToDelete })
          .then(() => onDraftsChanged?.());
      }
      onSent();
      return;
    }
    if (result.kind === "suppressed") {
      setStatus({ kind: "blocked", recipients: result.blocked_recipients });
      return;
    }
    if (result.kind === "invalid_request") {
      setStatus({
        kind: "invalid",
        field: result.field,
        message: result.message,
      });
      return;
    }
    setStatus({
      kind: "error",
      message: "code" in result ? `${result.code}: ${result.message}` : "send failed",
    });
  };

  const fromAddress = parent !== null ? parent.address : from;

  return (
    <section className="composer">
      <header className="composer__head">
        <div className="composer__title mono faint">
          {replyMode
            ? replyAll
              ? "compose · reply-all"
              : "compose · reply"
            : draftId !== null
              ? "compose · draft"
              : "compose · new"}
        </div>
        <button className="btn btn--quiet" onClick={onCancel}>
          <span>Cancel</span>
          <span className="mono faint">esc</span>
        </button>
      </header>

      <Field label="from" mono>
        <span className="composer__from mono">{fromAddress}</span>
      </Field>

      <Field
        label="to"
        mono
        invalid={status.kind === "invalid" && status.field === "to"}
      >
        {replyMode && replyPreview !== null ? (
          <span className="composer__from mono">
            {replyPreview.to.length > 0 ? replyPreview.to : "—"}
          </span>
        ) : (
          <input
            ref={toRef}
            className="composer__input mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="alice@example.com"
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>
      {status.kind === "blocked" ? (
        <div className="composer__blocked mono">
          <span className="composer__blocked-label">blocked · </span>
          {status.recipients.map((r, i) => (
            <span key={r}>
              <span className="composer__blocked-recipient">{r}</span>
              {i < status.recipients.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      ) : null}

      <Field label="cc" mono>
        {replyMode && replyPreview !== null ? (
          <span className="composer__from mono">
            {replyPreview.cc.length > 0 ? replyPreview.cc : "—"}
          </span>
        ) : (
          <input
            className="composer__input mono"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="(optional)"
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </Field>

      <Field
        label="subject"
        invalid={status.kind === "invalid" && status.field === "subject"}
      >
        {replyMode && replyPreview !== null ? (
          <span className="composer__from">{replyPreview.subject}</span>
        ) : (
          <input
            className="composer__input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        )}
      </Field>

      <textarea
        className="composer__body"
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        placeholder={replyMode ? "Reply…" : "Body…"}
        spellCheck
      />

      {parent !== null ? (
        <pre className="composer__quote mono faint">
          {previewQuotedBody({
            parentDate: parent.headers.date,
            parentFrom: parent.headers.from,
            parentReceivedAt: parent.received_at,
            parentBodyText: parent.body_text,
          })}
        </pre>
      ) : null}

      <footer className="composer__foot">
        <div className="composer__footmeta mono faint">
          {status.kind === "error" ? (
            <span>{status.message}</span>
          ) : status.kind === "invalid" ? (
            <span>
              invalid · {status.field}: {status.message}
            </span>
          ) : status.kind === "parent_unrepliable" ? (
            <span>
              cannot reply · {status.reason}: {status.message}
            </span>
          ) : status.kind === "sending" ? (
            <span>sending…</span>
          ) : draftsEnabled && draftStatus.kind === "saving" ? (
            <span>saving draft…</span>
          ) : draftsEnabled && draftStatus.kind === "saved" ? (
            <span>saved · {formatSavedAt(draftStatus.at)}</span>
          ) : draftsEnabled && draftStatus.kind === "error" ? (
            <span>{draftStatus.message}</span>
          ) : replyMode && canSendAndArchive ? (
            <span>
              ⌘↵ to send · ⇧⌘↵ send + archive · a toggles reply-all · esc to cancel
            </span>
          ) : replyMode ? (
            <span>⌘↵ to send · a toggles reply-all · esc to cancel</span>
          ) : (
            <span>⌘↵ to send · esc to cancel</span>
          )}
        </div>
        <div className="composer__send-row">
          <button
            className="btn btn--primary"
            onClick={() => void send()}
            disabled={status.kind === "sending"}
          >
            <span>
              {status.kind === "sending"
                ? "Sending…"
                : replyMode
                  ? replyAll
                    ? "Send reply-all"
                    : "Send reply"
                  : "Send"}
            </span>
            <span className="mono faint">⌘↵</span>
          </button>
          {replyMode && canSendAndArchive ? (
            <button
              className="btn btn--primary composer__send-archive"
              onClick={() => void sendInternal({ archive: true })}
              disabled={status.kind === "sending"}
              title="Send reply and archive the thread"
            >
              <span aria-hidden className="composer__send-archive-icon">
                ▾
              </span>
              <span>Send + archive</span>
              <span className="mono faint">⇧⌘↵</span>
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

function Field({
  label,
  mono,
  invalid,
  children,
}: {
  label: string;
  mono?: boolean;
  invalid?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={"composer__field" + (invalid ? " composer__field--invalid" : "")}>
      <div className={"composer__label mono" + (mono ? "" : "")}>{label}</div>
      <div className="composer__field-value">{children}</div>
    </div>
  );
}

function parseAddrList(s: string): string[] {
  return s
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

// True when at least one of the four user-editable fields has any
// non-whitespace content. Used to skip auto-saving an empty composer
// (which would create phantom drafts on every Compose-then-Esc).
function hasContent(
  to: string,
  cc: string,
  subject: string,
  bodyText: string,
): boolean {
  return (
    to.trim().length > 0 ||
    cc.trim().length > 0 ||
    subject.trim().length > 0 ||
    bodyText.trim().length > 0
  );
}

// HH:MM in local time — matches the rail's polled-at footer so the
// "saved" line reads in the same register.
function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
