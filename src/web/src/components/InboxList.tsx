import { useEffect, useRef, type JSX } from "react";
import type { InboxRow } from "../lib/bff-client.ts";
import {
  formatRowTimestamp,
  senderDisplay,
  shortMessageId,
} from "../lib/format.ts";

interface InboxListProps {
  messages: InboxRow[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  loading: boolean;
  offline: boolean;
  searchActive?: boolean;
}

// Triage-fast inbox: ~36–44px row, unread dot in the gutter, sender as
// proportional sans, timestamp + message-id excerpt in mono. Subject is
// the lead — bigger weight than the sender.

export function InboxList({
  messages,
  selectedIdx,
  onSelect,
  loading,
  offline,
  searchActive = false,
}: InboxListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected row visible as j/k moves through it.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-idx="${selectedIdx}"]`,
    );
    if (row) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  if (loading && messages.length === 0) {
    return (
      <div className="inbox-list">
        <div className="inbox-list__skeletons">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="inbox-row inbox-row--skel" />
          ))}
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    const empty = offline
      ? "0 messages · BFF unreachable"
      : searchActive
        ? "0 results · try a different query"
        : "0 messages · waiting for new mail";
    return (
      <div className="inbox-list">
        <div className="inbox-list__empty mono faint">{empty}</div>
      </div>
    );
  }

  return (
    <div className="inbox-list" ref={listRef}>
      {messages.map((row, idx) => {
        const selected = idx === selectedIdx;
        const failed = row.parse_status === "failed";
        const subject = !failed ? row.subject ?? "(no subject)" : "(parse failed)";
        const sender = !failed ? senderDisplay(row.from) : row.address;
        const messageIdExcerpt = !failed
          ? shortMessageId(row.message_id, 14)
          : row.internal_id.slice(0, 14);
        return (
          <div
            key={row.internal_id}
            data-idx={idx}
            className={
              "inbox-row" +
              (selected ? " inbox-row--selected" : "") +
              (failed ? " inbox-row--failed" : "")
            }
            onClick={() => onSelect(idx)}
            role="button"
            tabIndex={-1}
          >
            <div className="inbox-row__gutter">
              {/* Two flagged states share the gutter: parse_status="failed"
                  (danger) and unread inbound rows (accent). Outbound rows
                  are never flagged unread — they were never an inbox item
                  to read. */}
              {failed ? (
                <span className="inbox-row__dot inbox-row__dot--danger" />
              ) : row.read_at === null && row.direction === "in" ? (
                <span className="inbox-row__dot" />
              ) : null}
            </div>
            <div className="inbox-row__main">
              <div className="inbox-row__top">
                <span className="inbox-row__sender">{sender}</span>
                <span className="inbox-row__time mono faint">
                  {formatRowTimestamp(row.received_at)}
                </span>
              </div>
              <div className="inbox-row__subject">{subject}</div>
              <div className="inbox-row__meta mono faint">
                {messageIdExcerpt}
                {!failed && row.direction === "out" ? (
                  <span className="inbox-row__chip mono"> sent</span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
