import { useEffect, useRef, type JSX } from "react";
import type { StoredDraft } from "../lib/bff-client.ts";
import { formatRowTimestamp } from "../lib/format.ts";

interface DraftsListProps {
  drafts: StoredDraft[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  onResume: (draft: StoredDraft) => void;
  onDelete: (draftId: string) => void;
  loading: boolean;
  offline: boolean;
}

// Drafts view (ADR-0035, slice 8.17). Mirrors InboxList shape but renders
// from a flat list of StoredDraft rows instead of threads — drafts have
// no threading model, they're individual unsaved messages. Empty fields
// render as faint italic placeholders ("(no recipient)" / "(no subject)")
// since absence is the normal mid-flight state for a draft.

export function DraftsList({
  drafts,
  selectedIdx,
  onSelect,
  onResume,
  onDelete,
  loading,
  offline,
}: DraftsListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-idx="${selectedIdx}"]`,
    );
    if (row) row.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (loading && drafts.length === 0) {
    return (
      <div className="inbox-list">
        <div className="inbox-list__skeletons">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="inbox-row inbox-row--skel" />
          ))}
        </div>
      </div>
    );
  }

  if (drafts.length === 0) {
    const empty = offline
      ? "0 drafts · BFF unreachable"
      : "0 drafts · start composing — we'll save as you type";
    return (
      <div className="inbox-list">
        <div className="inbox-list__empty mono faint">{empty}</div>
      </div>
    );
  }

  return (
    <div className="inbox-list" ref={listRef}>
      {drafts.map((draft, idx) => {
        const focused = idx === selectedIdx;
        const recipient = draft.to ?? "";
        const subject = draft.subject ?? "";
        const hasRecipient = recipient.trim().length > 0;
        const hasSubject = subject.trim().length > 0;
        const snippet = previewSnippet(draft.body_text);
        return (
          <div
            key={draft.draft_id}
            data-idx={idx}
            className={
              "inbox-row" + (focused ? " inbox-row--selected" : "")
            }
            onClick={() => {
              onSelect(idx);
              onResume(draft);
            }}
            role="button"
            tabIndex={-1}
          >
            <div className="inbox-row__gutter">
              {/* No unread dot — every draft is "in progress". The gutter
                  shows just one affordance: delete. Resume is the row
                  click; delete is the explicit out. */}
              <div className="inbox-row__gutter-actions">
                <button
                  type="button"
                  className="btn btn--quiet drafts-row__delete mono"
                  title="Delete draft"
                  aria-label="Delete draft"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(draft.draft_id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="inbox-row__main">
              <div className="inbox-row__top">
                <span className="inbox-row__sender">
                  {hasRecipient ? (
                    recipient
                  ) : (
                    <span className="drafts-row__placeholder mono faint">
                      (no recipient)
                    </span>
                  )}
                </span>
                <span className="inbox-row__top-end">
                  <span className="inbox-row__time mono faint">
                    {formatRowTimestamp(draft.updated_at)}
                  </span>
                </span>
              </div>
              <div className="inbox-row__subject">
                {hasSubject ? (
                  subject
                ) : (
                  <span className="drafts-row__placeholder mono faint">
                    (no subject)
                  </span>
                )}
              </div>
              <div className="inbox-row__meta mono faint">
                {snippet.length > 0 ? snippet : "(empty)"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// First non-blank line of the body, capped so the row doesn't overflow.
// Drafts often have a one-liner placeholder followed by quoted parent —
// the first line is the operator's actual text.
function previewSnippet(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (firstLine === undefined) return "";
  const cap = 120;
  return firstLine.length > cap ? firstLine.slice(0, cap) + "…" : firstLine;
}
