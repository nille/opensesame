import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bff,
  type InboxRowOk,
  type InboxRowFailed,
  type ListThreadMessagesResult,
  type RpcResult,
  type StoredAttachment,
} from "../lib/bff-client.ts";
import { mergeThreadRows, type Thread } from "../lib/threading.ts";
import {
  formatBytes,
  formatRowTimestamp,
  senderDisplay,
} from "../lib/format.ts";
import { formatSnoozedUntil } from "../lib/snooze-presets.ts";
import { useKeyboard } from "../hooks/useKeyboard.ts";
import { StarButton } from "./Star.tsx";
import { SnoozeButton } from "./Snooze.tsx";

interface ReaderProps {
  // The selected thread, or null when nothing is selected. The thread is the
  // input — the latest row drives the subject and is auto-expanded; older
  // rows render as collapsed strips that expand on click (slice 8.6).
  thread: Thread | null;
  // Reply to the latest row. Each expanded MessageView also has its own
  // per-card Reply that targets that specific row's message_id.
  onReply: () => void;
  onReplyTo: (messageId: string) => void;
  // Whether intra-thread keyboard nav (J/K, slice 8.7) is live. False when
  // the composer is up — we don't want the stack moving under the operator
  // while they're typing a reply.
  keyboardEnabled: boolean;
  // Slice 8.10. The star indicator and toggle handler match the inbox-row
  // affordance — App resolves filled/pending from its intent map keyed by
  // rootKey, so the two surfaces stay in lockstep.
  starFilled: boolean;
  starPending: boolean;
  onToggleStar: (rootKey: string, next: boolean) => void;
  // Slice 8.11. Same shape as the star pair, but the indicator carries the
  // earliest unexpired wake-time (or null when not snoozed) and the toggle
  // commits a preset's wake-time / null.
  snoozedUntil: string | null;
  snoozePending: boolean;
  onPickSnooze: (rootKey: string, snoozedUntil: string | null) => void;
  // App routes the global `z` shortcut to this prop so the picker opens
  // alongside the visible reader-header button.
  snoozePickerOpen: boolean;
  onSnoozePickerOpenChange: (open: boolean) => void;
}

// Slice 8.6: the reader pane renders the whole conversation. Subject sits at
// the top (latest row's subject); the stack below shows messages newest-first,
// with the latest expanded by default and earlier messages as one-line strips
// that expand on click. Each expanded MessageView fires its own mark-read
// against its own row, which keeps the inbox unread dot honest — the dot
// disappears once every inbound row has actually been opened.
//
// Switching threads remounts this component (App passes key={rootKey}); the
// `expanded` set is re-seeded with the latest's id on every fresh mount.

export function Reader({
  thread,
  onReply,
  onReplyTo,
  keyboardEnabled,
  starFilled,
  starPending,
  onToggleStar,
  snoozedUntil,
  snoozePending,
  onPickSnooze,
  snoozePickerOpen,
  onSnoozePickerOpenChange,
}: ReaderProps): JSX.Element {
  if (thread === null) {
    return (
      <section className="reader reader--empty">
        <div className="reader__empty mono faint">
          select a message · j / k to move · enter / click to read
        </div>
      </section>
    );
  }

  // Failed lead → render the parse-failed card directly. Skeleton rows never
  // share a thread with parsed rows in slice 8.6 (groupIntoThreads keeps them
  // isolated), so a failed lead means the whole thread is one failed row.
  const lead = thread.rows[0];
  if (lead === undefined) {
    const failed = thread.failedRows[0];
    if (failed === undefined) return <section className="reader" />;
    return (
      <section className="reader">
        <FailedCard row={failed} />
      </section>
    );
  }

  // Subject comes from the latest row — same string the inbox row already
  // showed for the thread, with the canonical `Re:` already on the wire.
  const subject = lead.subject ?? "(no subject)";

  return (
    <ThreadReader
      thread={thread}
      subject={subject}
      onReply={onReply}
      onReplyTo={onReplyTo}
      keyboardEnabled={keyboardEnabled}
      starFilled={starFilled}
      starPending={starPending}
      onToggleStar={onToggleStar}
      snoozedUntil={snoozedUntil}
      snoozePending={snoozePending}
      onPickSnooze={onPickSnooze}
      snoozePickerOpen={snoozePickerOpen}
      onSnoozePickerOpenChange={onSnoozePickerOpenChange}
    />
  );
}

interface ThreadReaderProps {
  thread: Thread;
  subject: string;
  onReply: () => void;
  onReplyTo: (messageId: string) => void;
  keyboardEnabled: boolean;
  starFilled: boolean;
  starPending: boolean;
  onToggleStar: (rootKey: string, next: boolean) => void;
  snoozedUntil: string | null;
  snoozePending: boolean;
  onPickSnooze: (rootKey: string, snoozedUntil: string | null) => void;
  snoozePickerOpen: boolean;
  onSnoozePickerOpenChange: (open: boolean) => void;
}

function ThreadReader({
  thread,
  subject,
  onReply,
  onReplyTo,
  keyboardEnabled,
  starFilled,
  starPending,
  onToggleStar,
  snoozedUntil,
  snoozePending,
  onPickSnooze,
  snoozePickerOpen,
  onSnoozePickerOpenChange,
}: ThreadReaderProps): JSX.Element {
  // ADR-0027 (slice 8.9): when the thread has a server-stamped thread_id
  // (rootKey starts with "<"), fetch the full thread via list_thread_messages
  // and union with the in-window rows. Legacy rows (subject-fallback,
  // thread_id null) keep the in-window subset only.
  const expandable = thread.rootKey.startsWith("<");
  const threadQuery = useQuery<RpcResult<ListThreadMessagesResult>>({
    queryKey: ["thread", thread.rootKey],
    queryFn: () => bff.listThreadMessages({ thread_id: thread.rootKey }),
    enabled: expandable,
  });

  const rows = mergeThreadRows(thread.rows, threadQuery.data);

  // Seed the expansion set with the latest row's message_id (or its
  // internal_id when there's no message_id, which keeps the affordance
  // working for orphan rows that fell into a subject-fallback thread).
  const lead = rows[0]!;
  const leadKey = expansionKey(lead);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([leadKey]),
  );

  // If list_thread_messages later surfaces a newer row, the lead shifts;
  // make sure the new lead's card stays expanded by default.
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.has(leadKey)) return prev;
      const next = new Set(prev);
      next.add(leadKey);
      return next;
    });
  }, [leadKey]);

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Intra-thread nav (slice 8.7, ADR-0025). Capital J expands the topmost
  // collapsed strip; capital K collapses the bottommost expanded card that
  // isn't the lead. Lowercase j/k stay inter-thread (App owns those).
  // Modifiers other than Shift bail so OS shortcuts still work.
  useKeyboard(
    useCallback(
      (e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "J") {
          const next = rows.find((r) => !expanded.has(expansionKey(r)));
          if (next === undefined) return;
          e.preventDefault();
          setExpanded((prev) => new Set(prev).add(expansionKey(next)));
        } else if (e.key === "K") {
          // Walk bottom-up; skip the lead (rows[0]) so it stays open.
          for (let i = rows.length - 1; i > 0; i--) {
            const row = rows[i]!;
            const key = expansionKey(row);
            if (expanded.has(key)) {
              e.preventDefault();
              setExpanded((prev) => {
                const nextSet = new Set(prev);
                nextSet.delete(key);
                return nextSet;
              });
              return;
            }
          }
        }
      },
      [rows, expanded],
    ),
    keyboardEnabled,
  );

  // The header star + snooze match the gutter affordances — App resolves
  // filled/pending. Disabled for legacy threads (no server thread_id).
  const threadable = thread.rootKey.startsWith("<");

  return (
    <section className="reader">
      <header className="reader__head reader__head--thread">
        <div className="reader__subject-row">
          <h1 className="reader__subject">{lead.subject ?? subject}</h1>
          <StarButton
            filled={starFilled}
            pending={starPending}
            disabled={!threadable}
            variant="header"
            size={18}
            onToggle={(next) => onToggleStar(thread.rootKey, next)}
          />
          <SnoozeButton
            snoozedUntil={snoozedUntil}
            pending={snoozePending}
            disabled={!threadable}
            variant="header"
            size={18}
            onPickPreset={(next) => onPickSnooze(thread.rootKey, next)}
            controlledOpen={snoozePickerOpen}
            onOpenChange={onSnoozePickerOpenChange}
          />
        </div>
        <div className="reader__threadmeta mono faint">
          {rows.length + thread.failedRows.length}{" "}
          {rows.length + thread.failedRows.length === 1
            ? "message"
            : "messages"}
          {thread.hasOutbound ? " · sent" : ""}
          {snoozedUntil !== null
            ? " · snoozed until " + formatSnoozedUntil(snoozedUntil)
            : ""}
        </div>
      </header>
      <div className="reader__stack">
        {rows.map((row, idx) => {
          const key = expansionKey(row);
          const isOpen = expanded.has(key);
          const isLeadRow = idx === 0;
          if (isOpen) {
            return (
              <MessageView
                key={key}
                row={row}
                onReply={isLeadRow ? onReply : () => onReplyTo(row.message_id ?? "")}
                onCollapse={
                  isLeadRow
                    ? null
                    : () => toggle(key)
                }
                replyDisabled={row.message_id === null}
              />
            );
          }
          return (
            <MessageStrip key={key} row={row} onExpand={() => toggle(key)} />
          );
        })}
        {thread.failedRows.map((row) => (
          <FailedCard key={row.internal_id} row={row} />
        ))}
      </div>
    </section>
  );
}

// Per-row identity for React keys + the expansion set. internal_id is the
// only PK component that's always unique — message_id collides on
// self-addressed mail (one outbound + one inbound row sharing one Message-ID),
// which would otherwise let two strips share a React key and trigger a
// React duplicate-key warning + lose one of the rows.
function expansionKey(row: InboxRowOk): string {
  return row.internal_id;
}

interface MessageViewProps {
  row: InboxRowOk;
  onReply: () => void;
  // null when this card is the latest (its collapse would hide the active
  // selection's body). Otherwise renders a "collapse" affordance that hides
  // the card back to a strip.
  onCollapse: (() => void) | null;
  replyDisabled: boolean;
}

// Renders one fully-expanded message: header dl, body article, attachments.
// Fetches via bff.getMessage keyed by row.message_id and fires mark_read
// against the row's PK when it mounts (and the row is inbound + unread).
function MessageView({
  row,
  onReply,
  onCollapse,
  replyDisabled,
}: MessageViewProps): JSX.Element {
  const queryClient = useQueryClient();
  const messageId = row.message_id;

  const query = useQuery({
    queryKey: ["message", messageId],
    queryFn: () => {
      if (messageId === null) throw new Error("no message id");
      return bff.getMessage(messageId);
    },
    enabled: messageId !== null,
  });

  // Per-card mark-read. Each expanded inbound + unread row stamps read_at
  // server-side using its own PK. Outbound rows skip; rows that stay
  // collapsed never run this effect because they never mount as a
  // MessageView. The inbox unread dot lifts only after every inbound row
  // has been expanded at least once — which matches what the dot is saying.
  const shouldMark = row.direction === "in" && row.read_at === null;
  const markPkKey = shouldMark ? `${row.address}|${row.internal_id}` : null;
  useEffect(() => {
    if (markPkKey === null) return;
    let cancelled = false;
    void bff
      .markRead({ address: row.address, internal_id: row.internal_id })
      .then((r) => {
        if (cancelled) return;
        if (r.kind === "ok") {
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
        }
      });
    return () => {
      cancelled = true;
    };
    // markPkKey already encodes the PK; row reference doesn't drive identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markPkKey, queryClient]);

  // Loading: a compact card skeleton (not the full-pane one — the stack has
  // its own visual rhythm and a 5-line ghost would push later cards offscreen).
  if (messageId === null || query.isLoading) {
    return (
      <article className="msg-card msg-card--loading">
        <div className="msg-card__skel-line" />
        <div className="msg-card__skel-line msg-card__skel-line--short" />
      </article>
    );
  }

  const result = query.data;
  if (!result) return <article className="msg-card" />;

  if (result.kind === "not_found") {
    return (
      <article className="msg-card msg-card--notfound mono faint">
        no such message · {messageId}
      </article>
    );
  }

  if (result.kind === "error") {
    return (
      <article className="msg-card msg-card--error mono">
        error · {result.code}: {result.message}
      </article>
    );
  }

  if (result.kind !== "ok") {
    return <article className="msg-card" />;
  }

  const msg = result.value;
  if (msg.parse_status === "failed") {
    return (
      <article className="msg-card msg-card--parsefail mono">
        <span>parse failed · </span>
        <span className="faint">{msg.parse_error}</span>
        <div className="reader__rawuri mono faint">{msg.raw_s3_uri}</div>
      </article>
    );
  }

  return (
    <article className="msg-card msg-card--open">
      <div className="msg-card__head">
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
        <div className="msg-card__actions">
          <button
            className="btn btn--quiet"
            onClick={onReply}
            disabled={replyDisabled}
            title={replyDisabled ? "no Message-ID — cannot reply" : undefined}
          >
            <span>Reply</span>
            {onCollapse === null ? <span className="mono faint">r</span> : null}
          </button>
          {onCollapse !== null ? (
            <button className="btn btn--quiet" onClick={onCollapse}>
              <span>Collapse</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="msg-card__body">{msg.body_text}</div>
      {msg.attachments.length > 0 && msg.headers.message_id !== null ? (
        <Attachments
          messageId={msg.headers.message_id}
          attachments={msg.attachments}
        />
      ) : null}
    </article>
  );
}

interface MessageStripProps {
  row: InboxRowOk;
  onExpand: () => void;
}

// One-line collapsed view: sender · snippet · timestamp. Clicking the strip
// (or pressing Enter when focused) expands it in place.
function MessageStrip({ row, onExpand }: MessageStripProps): JSX.Element {
  const sender = senderDisplay(row.from);
  const unread = row.direction === "in" && row.read_at === null;
  const showSentChip = row.direction === "out";
  return (
    <button
      type="button"
      className={"msg-strip" + (unread ? " msg-strip--unread" : "")}
      onClick={onExpand}
    >
      <span className="msg-strip__gutter">
        {unread ? <span className="msg-strip__dot" /> : null}
      </span>
      <span className="msg-strip__sender">{sender}</span>
      <span className="msg-strip__snippet">{row.snippet}</span>
      <span className="msg-strip__time mono faint">
        {formatRowTimestamp(row.received_at)}
        {showSentChip ? <span className="msg-strip__chip mono"> sent</span> : null}
      </span>
    </button>
  );
}

interface FailedCardProps {
  row: InboxRowFailed;
}

function FailedCard({ row }: FailedCardProps): JSX.Element {
  return (
    <article className="msg-card msg-card--parsefail mono">
      <span>parse failed · </span>
      <span className="faint">{row.parse_error}</span>
      <div className="reader__rawuri mono faint">{row.raw_s3_uri}</div>
    </article>
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
    <section className="reader__attachments" aria-labelledby={`attachments-${messageId}`}>
      <h2 id={`attachments-${messageId}`} className="reader__attachments-title mono">
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
