import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bff,
  type InboxRow,
  type ReadMessage,
  type RpcResult,
} from "../lib/bff-client.ts";
import { useTheme } from "../hooks/useTheme.ts";
import { useKeyboard } from "../hooks/useKeyboard.ts";
import { useDebounced } from "../hooks/useDebounced.ts";
import { Rail } from "./Rail.tsx";
import { InboxList } from "./InboxList.tsx";
import { Reader } from "./Reader.tsx";
import { groupIntoThreads, type Thread } from "../lib/threading.ts";
import {
  Composer,
  type ComposerReplyParent,
  type ComposerSeed,
} from "./Composer.tsx";
import "./app.css";

// The active mailbox is configured per deploy, not picked in-product.
const MAILBOX = (import.meta.env["VITE_MAILBOX"] as string) ?? "test@nille.net";
const POLL_MS = 30_000;

type PaneState =
  | { mode: "reader" }
  | {
      mode: "composer";
      seed: ComposerSeed | null;
      // Set in reply mode (ADR-0022). The composer takes the parent's
      // message_id and passes it through to bff.replyToEmail; the server
      // re-loads the parent and remains authoritative for threading.
      replyParentId: string | null;
    };

type View = "inbox" | "sent" | "starred";

export function App(): JSX.Element {
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("inbox");
  const [pane, setPane] = useState<PaneState>({ mode: "reader" });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebounced(searchQuery.trim(), 220);
  const searchActive = debouncedQuery.length > 0;
  const searchInputRef = useRef<HTMLInputElement>(null);
  // ADR-0028 (slice 8.10). Optimistic-pending star intent map keyed by
  // Thread.rootKey. Set on toggle, cleared when the next inbox poll
  // surfaces the new authoritative starred_at (or rolled back on error).
  const [pendingStars, setPendingStars] = useState<Map<string, boolean>>(
    () => new Map(),
  );

  const inboxQuery = useQuery({
    queryKey: ["inbox", MAILBOX],
    queryFn: async (): Promise<RpcResult<{ messages: InboxRow[]; next_cursor: string | null }>> => {
      const r = await bff.readInbox({ address: MAILBOX, limit: 50 });
      setLastPolledAt(new Date().toISOString());
      return r;
    },
    refetchInterval: POLL_MS,
  });

  // Search runs on a separate query keyed off the debounced input. Disabled
  // until the user types — empty query is "show me the inbox", not a search.
  const searchQueryResult = useQuery({
    queryKey: ["search", MAILBOX, debouncedQuery],
    queryFn: (): Promise<RpcResult<{ messages: InboxRow[]; next_cursor: string | null }>> =>
      bff.searchEmail({ address: MAILBOX, query: debouncedQuery, limit: 50 }),
    enabled: searchActive,
    staleTime: 30_000,
  });

  // Pull every message read_inbox returned. Threading runs over the full
  // set so an outbound reply can roll up under the inbound parent it
  // answered — direction filtering happens at the thread level.
  const allMessages = useMemo<InboxRow[]>(() => {
    const r = inboxQuery.data;
    if (!r || r.kind !== "ok") return [];
    return r.value.messages;
  }, [inboxQuery.data]);

  // Search results stay flat — a hit means "this specific message
  // matched"; rolling it up hides the row the operator came for.
  const searchMessages = useMemo<InboxRow[]>(() => {
    const r = searchQueryResult.data;
    if (!r || r.kind !== "ok") return [];
    return r.value.messages;
  }, [searchQueryResult.data]);

  // All threads from the full inbox set. Filtering by view (inbox/sent)
  // happens after threading so a sent reply rolls up with its inbound
  // parent in both views, mirroring Gmail.
  const allThreads = useMemo<Thread[]>(
    () => groupIntoThreads(allMessages),
    [allMessages],
  );

  const inboxThreads = useMemo(
    () =>
      allThreads.filter(
        (t) =>
          t.failedRows.length > 0 || t.rows.some((r) => r.direction === "in"),
      ),
    [allThreads],
  );

  const sentThreads = useMemo(
    () => allThreads.filter((t) => t.hasOutbound),
    [allThreads],
  );

  // ADR-0028 (slice 8.10). Threads visible to the operator with at least
  // one starred row, or an outstanding pending-star intent. Including
  // pending entries means the row stays in the Starred view during the
  // optimistic flicker — without it, an operator who toggles from the
  // Starred view watches the row vanish before the RPC has even returned.
  const starredThreads = useMemo(
    () =>
      allThreads.filter((t) => {
        const pending = pendingStars.get(t.rootKey);
        if (pending !== undefined) return pending;
        return t.starred;
      }),
    [allThreads, pendingStars],
  );

  const searchThreads = useMemo<Thread[]>(
    () => groupIntoThreads(searchMessages),
    [searchMessages],
  );

  const threads = searchActive
    ? searchThreads
    : view === "inbox"
      ? inboxThreads
      : view === "starred"
        ? starredThreads
        : sentThreads;

  // Rail counts stay as message counts (per ADR-0023): triage volume is
  // what the operator wants to see, not conversation count.
  const inboxMessageCount = useMemo(
    () =>
      allMessages.filter(
        (m) => m.parse_status === "failed" || m.direction === "in",
      ).length,
    [allMessages],
  );
  const sentMessageCount = useMemo(
    () =>
      allMessages.filter(
        (m) => m.parse_status === "ok" && m.direction === "out",
      ).length,
    [allMessages],
  );
  // Rail counter for the Starred entry — distinct threads, not messages.
  // The Starred view's primary unit is the conversation, and the count
  // doubles as a calm "how many am I tracking" cue.
  const starredThreadCount = starredThreads.length;

  // Kept around for the search-loading skeleton check.
  const messages = searchActive ? searchMessages : allMessages;

  // Pull the lead row out of the selected thread for code paths that still
  // operate on a single message (reader, reply target, mark-read PK).
  const selectedRow = useMemo(() => {
    const t = threads[selectedIdx];
    if (t === undefined) return undefined;
    return t.rows[0] ?? t.failedRows[0];
  }, [threads, selectedIdx]);

  const offline = inboxQuery.data?.kind === "error";

  const searchHitCount: number | null = searchActive
    ? searchQueryResult.isFetching && searchQueryResult.data === undefined
      ? null
      : searchMessages.length
    : null;

  // Keep the selection in range as the inbox refreshes.
  useEffect(() => {
    if (selectedIdx >= threads.length && threads.length > 0) {
      setSelectedIdx(threads.length - 1);
    }
  }, [threads.length, selectedIdx]);

  // Switching views snaps to the top and re-opens the reader on first row.
  // Also clears any active search — the rail nav is meaningless inside a
  // search results list.
  const switchView = useCallback((next: View) => {
    setView(next);
    setSelectedIdx(0);
    setPane({ mode: "reader" });
    setSearchQuery("");
  }, []);

  // Reset selection when the source list changes shape (entering / leaving
  // search, or the search query itself changing).
  useEffect(() => {
    setSelectedIdx(0);
  }, [searchActive, debouncedQuery]);

  const openCompose = useCallback((seed: ComposerSeed | null) => {
    setPane({ mode: "composer", seed, replyParentId: null });
  }, []);

  const onSent = useCallback(() => {
    setPane({ mode: "reader" });
    void inboxQuery.refetch();
  }, [inboxQuery]);

  // Reply opens the composer in reply mode keyed by the parent's RFC 5322
  // Message-ID. The composer fetches the parent itself (already cached by
  // the reader's get_message query) and shows derived recipients/subject;
  // no need to seed the input fields, the server is authoritative.
  const replyToCurrent = useCallback((): void => {
    const row = selectedRow;
    if (!row || row.parse_status !== "ok" || row.message_id === null) return;
    setPane({
      mode: "composer",
      seed: null,
      replyParentId: row.message_id,
    });
  }, [selectedRow]);

  // Per-card reply (slice 8.6). The expanded MessageView passes its own
  // row's message_id; the composer flow is otherwise identical to the
  // latest-row reply path.
  const replyToMessage = useCallback((messageId: string): void => {
    if (messageId === "") return;
    setPane({ mode: "composer", seed: null, replyParentId: messageId });
  }, []);

  // ADR-0028 (slice 8.10). Toggle the star on every row in the thread.
  // Optimistic write: stamp the intent map immediately, fire star_thread,
  // then either drop the entry on success (the next inbox poll surfaces
  // the authoritative starred_at) or roll back on failure. The map keys
  // by Thread.rootKey, which equals the server's thread_id for any
  // server-stamped thread (the only ones we let the operator star).
  const toggleStar = useCallback(
    (rootKey: string, next: boolean): void => {
      // Subject-fallback rollups (no `<…>` rootKey) are gated upstream by
      // StarButton.disabled, but defend here too so a future caller doesn't
      // accidentally fire UpdateItems against a synthetic key.
      if (!rootKey.startsWith("<")) return;
      setPendingStars((prev) => {
        const m = new Map(prev);
        m.set(rootKey, next);
        return m;
      });
      void bff
        .starThread({ thread_id: rootKey, starred: next })
        .then((r) => {
          if (r.kind !== "ok") {
            // Roll back the optimistic state and drop the intent so the row
            // returns to whatever the last inbox poll said.
            setPendingStars((prev) => {
              const m = new Map(prev);
              m.delete(rootKey);
              return m;
            });
            return;
          }
          // Success path: invalidate the inbox query so the next poll
          // surfaces the new starred_at on every row, then drop the
          // intent. We deliberately don't optimistically write the new
          // starred_at into the cached rows — keeping the intent map
          // separate from the row cache means a stale poll can't quietly
          // overwrite a fresh toggle.
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
          setPendingStars((prev) => {
            const m = new Map(prev);
            m.delete(rootKey);
            return m;
          });
        });
    },
    [queryClient],
  );

  // Resolve the parent for reply mode. Reuses the same ["message", id] cache
  // entry that the Reader populated, so this is a free hit in the common case.
  const replyParentId =
    pane.mode === "composer" ? pane.replyParentId : null;
  const replyParentQuery = useQuery({
    queryKey: ["message", replyParentId],
    queryFn: (): Promise<RpcResult<ReadMessage>> => {
      if (replyParentId === null) throw new Error("no reply parent id");
      return bff.getMessage(replyParentId);
    },
    enabled: replyParentId !== null,
  });

  const replyParent: ComposerReplyParent | null = useMemo(() => {
    if (replyParentId === null) return null;
    const r = replyParentQuery.data;
    if (!r || r.kind !== "ok") return null;
    const msg = r.value;
    if (msg.parse_status !== "ok") return null;
    return {
      message_id: replyParentId,
      address: msg.address,
      headers: msg.headers,
      body_text: msg.body_text,
      received_at: msg.received_at,
    };
  }, [replyParentId, replyParentQuery.data]);

  // Keyboard.
  useKeyboard(
    useCallback(
      (e: KeyboardEvent) => {
        if (pane.mode === "composer") return; // composer owns its own keys
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === "j") {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(threads.length - 1, i + 1));
        } else if (e.key === "k") {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(0, i - 1));
        } else if (e.key === "c") {
          e.preventDefault();
          openCompose(null);
        } else if (e.key === "r") {
          e.preventDefault();
          replyToCurrent();
        } else if (e.key === "s") {
          // Slice 8.10. Toggle the selected thread's star. Disabled for
          // legacy / subject-fallback rollups (rootKey doesn't start with
          // "<") — we silently swallow the keypress in that case rather
          // than firing a UpdateItem fan-out against a synthetic key.
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          const pending = pendingStars.get(t.rootKey);
          const current = pending ?? t.starred;
          toggleStar(t.rootKey, !current);
        } else if (e.key === "/") {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else if (e.key === "?") {
          e.preventDefault();
          alert(
            [
              "j / k    move selection between threads",
              "J / K    expand / collapse next message in thread",
              "enter    open message (auto-opened in reader)",
              "/        focus search",
              "r        reply to latest in thread",
              "s        star / unstar selected thread",
              "c        compose new",
              "t        toggle theme",
              "esc      close composer / clear search",
              "?        this cheat sheet",
            ].join("\n"),
          );
        } else if (e.key === "t") {
          e.preventDefault();
          toggle();
        }
      },
      [
        pane,
        threads,
        selectedIdx,
        pendingStars,
        toggleStar,
        openCompose,
        replyToCurrent,
        toggle,
      ],
    ),
    pane.mode !== "composer",
  );

  // The rail's <input> swallows window keydown events (useKeyboard skips
  // INPUT/TEXTAREA), so Escape-to-clear lives on the input itself.
  const onSearchKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setSearchQuery("");
      searchInputRef.current?.blur();
    }
  }, []);

  return (
    <div className="app-shell">
      <Rail
        mailbox={MAILBOX}
        theme={theme}
        onToggleTheme={toggle}
        lastPolledAt={lastPolledAt}
        offline={offline}
        onCompose={() => openCompose(null)}
        view={view}
        onChangeView={switchView}
        inboxCount={inboxMessageCount}
        sentCount={sentMessageCount}
        starredCount={starredThreadCount}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchInputRef={searchInputRef}
        searching={searchActive && searchQueryResult.isFetching}
        searchHitCount={searchHitCount}
        onSearchKeyDown={onSearchKeyDown}
      />
      <InboxList
        threads={threads}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
        loading={
          searchActive
            ? searchQueryResult.isFetching && messages.length === 0
            : inboxQuery.isLoading
        }
        offline={offline}
        searchActive={searchActive}
        pendingStars={pendingStars}
        onToggleStar={toggleStar}
      />
      {pane.mode === "reader" ? (
        (() => {
          // Resolve the star indicator state for the selected thread once,
          // mirroring the inbox-row logic so the gutter and reader header
          // never disagree mid-flight.
          const t = threads[selectedIdx] ?? null;
          const pending = t === null ? undefined : pendingStars.get(t.rootKey);
          const filled = t === null ? false : (pending ?? t.starred);
          return (
            <Reader
              // key remounts the Reader on thread change so the in-card
              // expansion set (slice 8.6) starts fresh — otherwise rows from
              // the previous thread bleed into the new one's stack.
              key={t?.rootKey ?? "empty"}
              thread={t}
              onReply={replyToCurrent}
              onReplyTo={replyToMessage}
              keyboardEnabled={pane.mode === "reader"}
              starFilled={filled}
              starPending={pending !== undefined}
              onToggleStar={toggleStar}
            />
          );
        })()
      ) : pane.replyParentId !== null && replyParent === null ? (
        <section className="composer">
          <header className="composer__head">
            <div className="composer__title mono faint">compose · reply…</div>
            <button
              className="btn btn--quiet"
              onClick={() => setPane({ mode: "reader" })}
            >
              <span>Cancel</span>
              <span className="mono faint">esc</span>
            </button>
          </header>
          <div className="composer__field">
            <div className="composer__label mono">parent</div>
            <div className="composer__field-value mono faint">
              {replyParentQuery.isLoading
                ? "loading…"
                : replyParentQuery.data?.kind === "not_found"
                  ? "parent not found"
                  : replyParentQuery.data?.kind === "ok" &&
                      replyParentQuery.data.value.parse_status === "failed"
                    ? "parent failed to parse — cannot reply"
                    : "could not load parent"}
            </div>
          </div>
        </section>
      ) : (
        <Composer
          from={MAILBOX}
          seed={pane.seed}
          parent={replyParent}
          onCancel={() => setPane({ mode: "reader" })}
          onSent={onSent}
        />
      )}
    </div>
  );
}
