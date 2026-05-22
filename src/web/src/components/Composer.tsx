import { useEffect, useRef, useState, type JSX } from "react";
import { bff, type RpcResult, type SendEmailResult } from "../lib/bff-client.ts";

export interface ComposerSeed {
  to?: string;
  cc?: string;
  subject?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
}

interface ComposerProps {
  from: string;
  seed: ComposerSeed | null;
  onCancel: () => void;
  onSent: () => void;
}

// Inline composer — takes over the reader pane, never a modal. The 409
// suppression case renders blocked recipients under the To: field; the
// 500 case keeps the draft and surfaces a quiet line under the send button.

export function Composer({
  from,
  seed,
  onCancel,
  onSent,
}: ComposerProps): JSX.Element {
  const [to, setTo] = useState(seed?.to ?? "");
  const [cc, setCc] = useState(seed?.cc ?? "");
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [bodyText, setBodyText] = useState(seed?.bodyText ?? "");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "error"; message: string }
    | { kind: "blocked"; recipients: string[] }
    | { kind: "invalid"; field: string; message: string }
  >({ kind: "idle" });

  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Focus the first empty field. Reply-with-quote drops focus into the body.
    if (seed?.to && seed.to.length > 0) {
      const ta = document.querySelector<HTMLTextAreaElement>(
        ".composer__body",
      );
      ta?.focus();
    } else {
      toRef.current?.focus();
    }
  }, [seed]);

  // Esc cancels the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // send is stable enough; eslint can complain in a follow-up
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, subject, bodyText, seed]);

  const send = async (): Promise<void> => {
    setStatus({ kind: "sending" });
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

  return (
    <section className="composer">
      <header className="composer__head">
        <div className="composer__title mono faint">
          {seed?.inReplyTo ? "compose · reply" : "compose · new"}
        </div>
        <button className="btn btn--quiet" onClick={onCancel}>
          <span>Cancel</span>
          <span className="mono faint">esc</span>
        </button>
      </header>

      <Field label="from" mono>
        <span className="composer__from mono">{from}</span>
      </Field>

      <Field
        label="to"
        mono
        invalid={status.kind === "invalid" && status.field === "to"}
      >
        <input
          ref={toRef}
          className="composer__input mono"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="alice@example.com"
          spellCheck={false}
          autoComplete="off"
        />
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
        <input
          className="composer__input mono"
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          placeholder="(optional)"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>

      <Field label="subject" invalid={status.kind === "invalid" && status.field === "subject"}>
        <input
          className="composer__input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </Field>

      <textarea
        className="composer__body"
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        placeholder="Body…"
        spellCheck
      />

      <footer className="composer__foot">
        <div className="composer__footmeta mono faint">
          {status.kind === "error" ? (
            <span>{status.message}</span>
          ) : status.kind === "invalid" ? (
            <span>
              invalid · {status.field}: {status.message}
            </span>
          ) : status.kind === "sending" ? (
            <span>sending…</span>
          ) : (
            <span>⌘↵ to send · esc to cancel</span>
          )}
        </div>
        <button
          className="btn btn--primary"
          onClick={() => void send()}
          disabled={status.kind === "sending"}
        >
          <span>{status.kind === "sending" ? "Sending…" : "Send"}</span>
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
