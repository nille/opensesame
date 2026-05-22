import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  bff,
  type ReadMessageHeaders,
  type ReplyToEmailRpcResult,
  type RpcResult,
  type SendEmailResult,
} from "../lib/bff-client.ts";
import {
  canonicalReSubject,
  previewQuotedBody,
  previewReplyAllCc,
  previewReplyTarget,
} from "../lib/reply-preview.ts";

export interface ComposerSeed {
  to?: string;
  cc?: string;
  subject?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
}

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
}

interface ComposerProps {
  from: string;
  seed: ComposerSeed | null;
  parent: ComposerReplyParent | null;
  onCancel: () => void;
  onSent: () => void;
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
  onCancel,
  onSent,
}: ComposerProps): JSX.Element {
  const replyMode = parent !== null;

  const [to, setTo] = useState(seed?.to ?? "");
  const [cc, setCc] = useState(seed?.cc ?? "");
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [bodyText, setBodyText] = useState(seed?.bodyText ?? "");
  const [replyAll, setReplyAll] = useState(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "error"; message: string }
    | { kind: "blocked"; recipients: string[] }
    | { kind: "invalid"; field: string; message: string }
    | { kind: "parent_unrepliable"; reason: string; message: string }
  >({ kind: "idle" });

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
        onCancel();
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

  const send = async (): Promise<void> => {
    setStatus({ kind: "sending" });

    if (parent !== null) {
      const result: ReplyToEmailRpcResult = await bff.replyToEmail({
        message_id: parent.message_id,
        body_text: bodyText,
        reply_all: replyAll,
      });
      if (result.kind === "ok") {
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
          ) : replyMode ? (
            <span>⌘↵ to send · a toggles reply-all · esc to cancel</span>
          ) : (
            <span>⌘↵ to send · esc to cancel</span>
          )}
        </div>
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
