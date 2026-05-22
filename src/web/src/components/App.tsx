import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { bff, type InboxRow, type RpcResult } from "../lib/bff-client.ts";
import { useTheme } from "../hooks/useTheme.ts";
import { useKeyboard } from "../hooks/useKeyboard.ts";
import { useDebounced } from "../hooks/useDebounced.ts";
import { Rail } from "./Rail.tsx";
import { InboxList } from "./InboxList.tsx";
import { Reader } from "./Reader.tsx";
import { Composer, type ComposerSeed } from "./Composer.tsx";
import "./app.css";

// The active mailbox is configured per deploy, not picked in-product.
const MAILBOX = (import.meta.env["VITE_MAILBOX"] as string) ?? "test@nille.net";
const POLL_MS = 30_000;

type PaneState =
  | { mode: "reader"; messageId: string | null }
  | { mode: "composer"; seed: ComposerSeed | null };

type View = "inbox" | "sent";

export function App(): JSX.Element {
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<View>("inbox");
  const [pane, setPane] = useState<PaneState>({ mode: "reader", messageId: null });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedQuery = useDebounced(searchQuery.trim(), 220);
  const searchActive = debouncedQuery.length > 0;
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Split the single read_inbox result into the two views the rail offers.
  // Parse-failed rows live in inbox (their direction is unknown and they
  // need triage) and never in sent.
  const allMessages = useMemo<InboxRow[]>(() => {
    const r = inboxQuery.data;
    if (!r || r.kind !== "ok") return [];
    return r.value.messages;
  }, [inboxQuery.data]);

  const inboxMessages = useMemo(
    () =>
      allMessages.filter((m) =>
        m.parse_status === "failed" ? true : m.direction === "in",
      ),
    [allMessages],
  );
  const sentMessages = useMemo(
    () =>
      allMessages.filter((m) => m.parse_status === "ok" && m.direction === "out"),
    [allMessages],
  );

  // Search results aren't filtered by direction — the operator wants every
  // hit, in or out, ordered the same way DDB returned them (newest-first).
  const searchMessages = useMemo<InboxRow[]>(() => {
    const r = searchQueryResult.data;
    if (!r || r.kind !== "ok") return [];
    return r.value.messages;
  }, [searchQueryResult.data]);

  const messages = searchActive
    ? searchMessages
    : view === "inbox"
      ? inboxMessages
      : sentMessages;

  const offline = inboxQuery.data?.kind === "error";

  const searchHitCount: number | null = searchActive
    ? searchQueryResult.isFetching && searchQueryResult.data === undefined
      ? null
      : searchMessages.length
    : null;

  // Keep the selection in range as the inbox refreshes.
  useEffect(() => {
    if (selectedIdx >= messages.length && messages.length > 0) {
      setSelectedIdx(messages.length - 1);
    }
  }, [messages.length, selectedIdx]);

  // Switching views snaps to the top and re-opens the reader on first row.
  // Also clears any active search — the rail nav is meaningless inside a
  // search results list.
  const switchView = useCallback((next: View) => {
    setView(next);
    setSelectedIdx(0);
    setPane({ mode: "reader", messageId: null });
    setSearchQuery("");
  }, []);

  // Reset selection when the source list changes shape (entering / leaving
  // search, or the search query itself changing).
  useEffect(() => {
    setSelectedIdx(0);
  }, [searchActive, debouncedQuery]);

  // Sync the reader to the selected row when in reader mode.
  useEffect(() => {
    if (pane.mode !== "reader") return;
    const row = messages[selectedIdx];
    if (!row) return;
    if (row.parse_status !== "ok") {
      setPane({ mode: "reader", messageId: null });
      return;
    }
    if (row.message_id !== pane.messageId) {
      setPane({ mode: "reader", messageId: row.message_id });
    }
  }, [selectedIdx, messages, pane]);

  const openCompose = useCallback((seed: ComposerSeed | null) => {
    setPane({ mode: "composer", seed });
  }, []);

  const onSent = useCallback(() => {
    setPane({ mode: "reader", messageId: null });
    void inboxQuery.refetch();
  }, [inboxQuery]);

  const replyToCurrent = useCallback((): void => {
    const row = messages[selectedIdx];
    if (!row || row.parse_status !== "ok") return;
    openCompose({
      to: row.from ?? "",
      subject: row.subject?.startsWith("Re:") ? row.subject : `Re: ${row.subject ?? ""}`,
      inReplyTo: row.message_id ?? "",
      references: row.references ?? "",
    });
  }, [messages, selectedIdx, openCompose]);

  // Keyboard.
  useKeyboard(
    useCallback(
      (e: KeyboardEvent) => {
        if (pane.mode === "composer") return; // composer owns its own keys
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === "j") {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(messages.length - 1, i + 1));
        } else if (e.key === "k") {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(0, i - 1));
        } else if (e.key === "c") {
          e.preventDefault();
          openCompose(null);
        } else if (e.key === "r") {
          e.preventDefault();
          replyToCurrent();
        } else if (e.key === "/") {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else if (e.key === "?") {
          e.preventDefault();
          alert(
            [
              "j / k    move selection",
              "enter    open message (auto-opened in reader)",
              "/        focus search",
              "r        reply to current",
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
      [pane, messages.length, openCompose, replyToCurrent, toggle],
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
        inboxCount={inboxMessages.length}
        sentCount={sentMessages.length}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchInputRef={searchInputRef}
        searching={searchActive && searchQueryResult.isFetching}
        searchHitCount={searchHitCount}
        onSearchKeyDown={onSearchKeyDown}
      />
      <InboxList
        messages={messages}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
        loading={
          searchActive
            ? searchQueryResult.isFetching && messages.length === 0
            : inboxQuery.isLoading
        }
        offline={offline}
        searchActive={searchActive}
      />
      {pane.mode === "reader" ? (
        (() => {
          const row = messages[selectedIdx];
          const selectedPk =
            row && row.parse_status === "ok"
              ? { address: row.address, internal_id: row.internal_id }
              : null;
          const selectedUnread =
            row?.parse_status === "ok" &&
            row.direction === "in" &&
            row.read_at === null;
          return (
            <Reader
              messageId={pane.messageId}
              onReply={replyToCurrent}
              selectedPk={selectedPk}
              selectedUnread={selectedUnread}
            />
          );
        })()
      ) : (
        <Composer
          from={MAILBOX}
          seed={pane.seed}
          onCancel={() => setPane({ mode: "reader", messageId: null })}
          onSent={onSent}
        />
      )}
    </div>
  );
}
