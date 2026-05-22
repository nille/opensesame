import type { JSX } from "react";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bff, type StoredAttachment } from "../lib/bff-client.ts";
import { formatBytes } from "../lib/format.ts";

interface ReaderProps {
  messageId: string | null;
  onReply: () => void;
  // Primary key of the row currently selected in the inbox. Threaded through
  // so mark_read can target THIS row by (address, internal_id) instead of
  // re-resolving by RFC 5322 Message-ID. Self-addressed mail produces two
  // rows sharing one Message-ID and the GSI hop picks one non-deterministically;
  // the inbox already has the right PK in hand, so use it.
  selectedPk: { address: string; internal_id: string } | null;
  // Whether the selected inbox row is unread + inbound. Controls whether the
  // mark_read effect fires at all — outbound rows aren't "unread" to begin with.
  selectedUnread: boolean;
}

// Reader displays one message as a feature article: subject as h1, mono
// metadata block, body in proportional sans at --t-lg with 68ch measure.
//
// Empty (nothing selected) and not-found (BFF 404) are distinct copy states.
// HTML body rendering is intentionally absent in slice 8 — text only.

export function Reader({
  messageId,
  onReply,
  selectedPk,
  selectedUnread,
}: ReaderProps): JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["message", messageId],
    queryFn: () => {
      if (messageId === null) throw new Error("no message id");
      return bff.getMessage(messageId);
    },
    enabled: messageId !== null,
  });

  // Stamp read_at server-side using the inbox row's primary key. Decoupled
  // from get_message: the row resolved by Message-ID may be the wrong one
  // (self-addressed mail), but the inbox row's PK is unambiguous.
  const markPkKey =
    selectedUnread && selectedPk !== null
      ? `${selectedPk.address}|${selectedPk.internal_id}`
      : null;
  useEffect(() => {
    if (markPkKey === null || selectedPk === null) return;
    let cancelled = false;
    void bff
      .markRead({
        address: selectedPk.address,
        internal_id: selectedPk.internal_id,
      })
      .then((r) => {
        if (cancelled) return;
        if (r.kind === "ok") {
          // Refresh inbox so the unread dot disappears without waiting for
          // the next 30s poll.
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
        }
      });
    return () => {
      cancelled = true;
    };
    // markPkKey changes whenever selectedPk does; selectedPk is captured
    // by reference for the call body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markPkKey, queryClient]);

  if (messageId === null) {
    return (
      <section className="reader reader--empty">
        <div className="reader__empty mono faint">
          select a message · j / k to move · enter / click to read
        </div>
      </section>
    );
  }

  if (query.isLoading) {
    return (
      <section className="reader reader--loading">
        <div className="reader__skel-h1" />
        <div className="reader__skel-meta" />
        <div className="reader__skel-line" />
        <div className="reader__skel-line" />
        <div className="reader__skel-line reader__skel-line--short" />
      </section>
    );
  }

  const result = query.data;
  if (!result) return <section className="reader" />;

  if (result.kind === "not_found") {
    return (
      <section className="reader reader--notfound">
        <div className="reader__notfound mono">
          <span className="muted">no such message · </span>
          <span className="faint">{messageId}</span>
        </div>
      </section>
    );
  }

  if (result.kind === "error") {
    return (
      <section className="reader reader--error">
        <div className="reader__error mono">
          <span>error · </span>
          <span className="faint">{result.code}: {result.message}</span>
        </div>
      </section>
    );
  }

  if (result.kind !== "ok") {
    return <section className="reader" />;
  }

  const msg = result.value;
  if (msg.parse_status === "failed") {
    return (
      <section className="reader reader--parsefail">
        <div className="reader__parsefail mono">
          <span>parse failed · </span>
          <span className="faint">{msg.parse_error}</span>
        </div>
        <div className="reader__rawuri mono faint">{msg.raw_s3_uri}</div>
      </section>
    );
  }

  return (
    <section className="reader">
      <header className="reader__head">
        <h1 className="reader__subject">
          {msg.headers.subject ?? "(no subject)"}
        </h1>
        <dl className="reader__meta mono">
          <dt>from</dt>
          <dd>{msg.headers.from ?? "—"}</dd>
          <dt>to</dt>
          <dd>{msg.headers.to ?? "—"}</dd>
          {msg.headers.cc !== null ? (
            <>
              <dt>cc</dt>
              <dd>{msg.headers.cc}</dd>
            </>
          ) : null}
          <dt>date</dt>
          <dd>{msg.headers.date ?? msg.received_at}</dd>
          <dt>id</dt>
          <dd className="faint">{msg.headers.message_id ?? "—"}</dd>
        </dl>
        <div className="reader__actions">
          <button className="btn btn--quiet" onClick={onReply}>
            <span>Reply</span>
            <span className="mono faint">r</span>
          </button>
        </div>
      </header>
      <article className="reader__body">{msg.body_text}</article>
      {msg.attachments.length > 0 && msg.headers.message_id !== null ? (
        <Attachments
          messageId={msg.headers.message_id}
          attachments={msg.attachments}
        />
      ) : null}
    </section>
  );
}

interface AttachmentsProps {
  messageId: string;
  attachments: StoredAttachment[];
}

// Renders the attachment list and resolves each download lazily — fetch the
// presigned URL only when the operator clicks. Open in a new tab so the
// browser uses the URL's Content-Disposition to drive download UX, instead
// of routing through a fetch + Blob roundtrip we'd have to free.
function Attachments({ messageId, attachments }: AttachmentsProps): JSX.Element {
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [errorIdx, setErrorIdx] = useState<number | null>(null);

  const handleClick = async (partIndex: number): Promise<void> => {
    setBusyIdx(partIndex);
    setErrorIdx(null);
    const result = await bff.getAttachment({
      message_id: messageId,
      part_index: partIndex,
    });
    setBusyIdx(null);
    if (result.kind === "ok") {
      window.open(result.value.url, "_blank", "noopener,noreferrer");
      return;
    }
    setErrorIdx(partIndex);
  };

  return (
    <section className="reader__attachments" aria-labelledby="attachments-label">
      <h2 id="attachments-label" className="reader__attachments-title mono">
        attachments · {attachments.length}
      </h2>
      <ul className="reader__attachments-list">
        {attachments.map((att) => (
          <li key={att.part_index} className="attachment">
            <button
              className="attachment__row"
              type="button"
              onClick={() => void handleClick(att.part_index)}
              disabled={busyIdx === att.part_index}
            >
              <span className="attachment__name">
                {att.filename ?? `part-${att.part_index}`}
              </span>
              <span className="attachment__meta mono faint">
                {att.content_type} · {formatBytes(att.size_bytes)}
              </span>
              <span className="attachment__action mono">
                {busyIdx === att.part_index
                  ? "…"
                  : errorIdx === att.part_index
                    ? "retry"
                    : "↓"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
