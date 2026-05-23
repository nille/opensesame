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
  type LabelCatalogEntry,
  type ListDraftsResult,
  type ListLabelsResult,
  type ReadMessage,
  type RpcResult,
  type StoredDraft,
} from "../lib/bff-client.ts";
import { useTheme } from "../hooks/useTheme.ts";
import { useKeyboard } from "../hooks/useKeyboard.ts";
import { useDebounced } from "../hooks/useDebounced.ts";
import { Rail, type RailLabel } from "./Rail.tsx";
import { InboxList } from "./InboxList.tsx";
import { DraftsList } from "./DraftsList.tsx";
import { Reader } from "./Reader.tsx";
import { LabelPicker, type LabelPresence } from "./LabelPicker.tsx";
import { groupIntoThreads, type Thread } from "../lib/threading.ts";
import {
  Composer,
  type ComposerReplyParent,
  type ComposerSeed,
} from "./Composer.tsx";
import { BulkActionBar } from "./BulkActionBar.tsx";
import { computeRange, threadableRootKeys } from "../lib/selection.ts";
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
      // ADR-0035 (slice 8.17). Set when the operator clicks a draft row
      // in the drafts view — pre-loads the composer fields and stamps
      // the existing draft_id as the upsert handle for auto-saves.
      resumeDraft: StoredDraft | null;
    };

type View =
  | "inbox"
  | "sent"
  | "starred"
  | "snoozed"
  | "trashed"
  | "archived"
  | "drafts"
  // ADR-0037 (slice 8.17). Label-scoped view. The label key is the
  // canonical lowercased form (catalog identity); rail / title use the
  // catalog's display_name when rendering.
  | { kind: "label"; label: string };

// View identity used by selection-clear effects. Object views collapse
// to their kind tag; primitive views stay as-is so existing useEffects
// keyed on `view` keep working.
function viewKey(v: View): string {
  return typeof v === "string" ? v : `label:${v.label}`;
}

export function App(): JSX.Element {
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("inbox");
  const [pane, setPane] = useState<PaneState>({ mode: "reader" });
  const [selectedIdx, setSelectedIdx] = useState(0);
  // ADR-0035 (slice 8.17). Drafts have their own ordinal selection state
  // since the drafts list is flat (StoredDraft[]) rather than threaded —
  // sharing selectedIdx with the inbox would have the cursor jump around
  // every time the operator switches views.
  const [draftSelectedIdx, setDraftSelectedIdx] = useState(0);
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
  // ADR-0029 (slice 8.11). Same pattern as pendingStars but the value is
  // either an ISO wake-time (snoozing) or null (unsnoozing). Mixing the
  // two intents in one map keeps the map's "no entry === server-authoritative"
  // semantics regardless of which direction the operator picked.
  const [pendingSnoozes, setPendingSnoozes] = useState<
    Map<string, string | null>
  >(() => new Map());
  // ADR-0030 (slice 8.12). Optimistic-pending trash intent map keyed by
  // Thread.rootKey; mirrors pendingStars (boolean toggle, not nullable
  // wake time). Set on toggle, cleared when the next inbox poll surfaces
  // the new authoritative trashed_at, or rolled back on RPC error.
  const [pendingTrashes, setPendingTrashes] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  // ADR-0031 (slice 8.13). Optimistic-pending read intent map. The map
  // stores the *target* read state — `true` means the operator just marked
  // the thread read, `false` means just marked unread. Cleared on next
  // inbox poll (server-authoritative) or rolled back on RPC error.
  const [pendingReads, setPendingReads] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  // ADR-0034 (slice 8.16). Optimistic-pending archive intent map; mirrors
  // pendingTrashes (boolean toggle, server-authoritative resolves on the
  // next inbox poll). Archive is independent from trash — a row can be
  // archived without being trashed and vice versa.
  const [pendingArchives, setPendingArchives] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  // ADR-0037 (slice 8.17). Optimistic-pending label deltas keyed by
  // Thread.rootKey. Each entry holds two sets: labels the operator
  // intends to add and labels they intend to remove. Mixing the two
  // intents in one entry lets a bulk session queue several toggles per
  // thread before the RPCs settle. Cleared per-(rootKey, label) on
  // success; the whole thread entry is dropped when both sets are
  // empty so isLabelPending() can short-circuit.
  const [pendingLabels, setPendingLabels] = useState<
    Map<string, { add: Set<string>; remove: Set<string> }>
  >(() => new Map());
  // Picker state. `null` means closed; otherwise a target descriptor
  // that says which threads the picker applies to. Single-thread vs
  // bulk is implicit in the rootKeys set's size, so the same picker
  // component handles both.
  const [labelPicker, setLabelPicker] = useState<{
    rootKeys: string[];
    anchor: "row" | "header" | "bulk";
  } | null>(null);
  // The reader-header snooze picker is controlled so the global `z` shortcut
  // can pop it open while keeping the gutter pickers self-managed.
  const [readerSnoozePickerOpen, setReaderSnoozePickerOpen] = useState(false);
  // ADR-0032 (slice 8.14). Bulk multi-select. The selection set keys by
  // Thread.rootKey — the same handle every annotation flow already uses —
  // so a bulk apply just fans out the existing per-thread handlers over
  // the set. Subject-fallback rollups (rootKey not starting with "<") are
  // never selectable; the same gate that disables the per-row buttons also
  // gates the row checkbox.
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  // The most-recent plain-click anchor for Shift+click range selection.
  // Reset on view switch / search transition / Esc-clear, mirroring the
  // selection set itself. Null means "no anchor yet" — a Shift+click with
  // no anchor falls back to a plain toggle.
  const [anchorRootKey, setAnchorRootKey] = useState<string | null>(null);
  // Picker open state for the bulk-action-bar's snooze button (mirrors the
  // reader-header pattern so the picker can be closed declaratively).
  const [bulkSnoozePickerOpen, setBulkSnoozePickerOpen] = useState(false);

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

  // ADR-0035 (slice 8.17). Drafts query — refetched on Composer save/delete
  // via invalidate, so the rail count and Drafts view stay current without
  // polling. Stale-time longer than inbox: drafts mutate from one tab and
  // we don't need cross-tab freshness right now.
  const draftsQuery = useQuery({
    queryKey: ["drafts", MAILBOX],
    queryFn: (): Promise<RpcResult<ListDraftsResult>> =>
      bff.listDrafts({ address: MAILBOX, limit: 100 }),
    staleTime: 60_000,
  });

  const drafts = useMemo<StoredDraft[]>(() => {
    const r = draftsQuery.data;
    if (!r || r.kind !== "ok") return [];
    return r.value.drafts;
  }, [draftsQuery.data]);

  const draftsCount = drafts.length;

  // ADR-0037 (slice 8.17). Label catalog query. Refetched on
  // create/delete/rename via invalidate; the rail labels section
  // and the picker both read from it. Stale-time matches drafts —
  // the catalog mutates rarely.
  const labelsCatalogQuery = useQuery({
    queryKey: ["labels", MAILBOX],
    queryFn: (): Promise<RpcResult<ListLabelsResult>> =>
      bff.listLabels({ address: MAILBOX }),
    staleTime: 60_000,
  });

  const labelCatalog = useMemo<LabelCatalogEntry[]>(() => {
    const r = labelsCatalogQuery.data;
    if (!r || r.kind !== "ok") return [];
    return r.value.labels;
  }, [labelsCatalogQuery.data]);

  // Lowercased canonical key → display_name. Drives the inbox-row
  // chip casing and the rail labels section.
  const labelDisplayNames = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const e of labelCatalog) m.set(e.label, e.display_name);
    return m;
  }, [labelCatalog]);

  // Force a drafts re-fetch from the composer's auto-save / delete hooks.
  // Cheap — listDrafts is one DDB query against the address partition.
  const onDraftsChanged = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ["drafts", MAILBOX] });
  }, [queryClient]);

  const deleteDraftFromList = useCallback(
    (draftId: string): void => {
      void bff
        .deleteDraft({ address: MAILBOX, draft_id: draftId })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["drafts", MAILBOX] });
        });
    },
    [queryClient],
  );

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

  // ADR-0029 (slice 8.11). The inbox view hides snoozed threads — that's
  // the whole point of snooze. Pending intents win over server state so the
  // operator's freshly-picked snooze removes the row instantly (and a
  // pending unsnooze surfaces a row that was snoozed mid-poll). The
  // Starred and Snoozed views deliberately don't apply this filter:
  // starred snoozed threads stay visible in Starred (operator intent),
  // and Snoozed is the very list of these rows.
  const isSnoozedNow = useCallback(
    (t: Thread): boolean => {
      const pending = pendingSnoozes.get(t.rootKey);
      if (pending !== undefined) return pending !== null;
      return t.snoozed;
    },
    [pendingSnoozes],
  );

  // ADR-0030 (slice 8.12). Pending intents win over server state so a
  // freshly-trashed thread vanishes from non-Trash views instantly (and
  // a pending untrash surfaces a thread that was trashed mid-poll).
  const isTrashedNow = useCallback(
    (t: Thread): boolean => {
      const pending = pendingTrashes.get(t.rootKey);
      if (pending !== undefined) return pending;
      return t.trashed;
    },
    [pendingTrashes],
  );

  // ADR-0034 (slice 8.16). Same posture as isTrashedNow but for archive —
  // hide archived threads from inbox/starred/snoozed/sent the moment the
  // operator hits `e`, surface them in the Archive view instantly, and
  // wake-on-reply restores them via the server clearing archived_at.
  const isArchivedNow = useCallback(
    (t: Thread): boolean => {
      const pending = pendingArchives.get(t.rootKey);
      if (pending !== undefined) return pending;
      return t.archived;
    },
    [pendingArchives],
  );

  // ADR-0037 (slice 8.17). Apply the pending-labels delta map on top of
  // the thread's server-aggregated `labels` so the inbox row's chips and
  // the label-view filter both see the operator's freshly-toggled state
  // before the next inbox poll arrives. Both sets are lowercased.
  const effectiveLabels = useCallback(
    (t: Thread): string[] => {
      const delta = pendingLabels.get(t.rootKey);
      if (delta === undefined) return t.labels;
      const out = new Set<string>(t.labels);
      for (const l of delta.add) out.add(l);
      for (const l of delta.remove) out.delete(l);
      return Array.from(out).sort((a, b) => a.localeCompare(b));
    },
    [pendingLabels],
  );

  const inboxThreads = useMemo(
    () =>
      allThreads.filter(
        (t) =>
          (t.failedRows.length > 0 ||
            t.rows.some((r) => r.direction === "in")) &&
          !isSnoozedNow(t) &&
          !isTrashedNow(t) &&
          !isArchivedNow(t),
      ),
    [allThreads, isSnoozedNow, isTrashedNow, isArchivedNow],
  );

  const sentThreads = useMemo(
    () =>
      allThreads.filter(
        (t) => t.hasOutbound && !isTrashedNow(t) && !isArchivedNow(t),
      ),
    [allThreads, isTrashedNow, isArchivedNow],
  );

  // ADR-0028 (slice 8.10). Threads visible to the operator with at least
  // one starred row, or an outstanding pending-star intent. Including
  // pending entries means the row stays in the Starred view during the
  // optimistic flicker — without it, an operator who toggles from the
  // Starred view watches the row vanish before the RPC has even returned.
  const starredThreads = useMemo(
    () =>
      allThreads.filter((t) => {
        if (isTrashedNow(t)) return false;
        if (isArchivedNow(t)) return false;
        const pending = pendingStars.get(t.rootKey);
        if (pending !== undefined) return pending;
        return t.starred;
      }),
    [allThreads, pendingStars, isTrashedNow, isArchivedNow],
  );

  const searchThreads = useMemo<Thread[]>(
    () => groupIntoThreads(searchMessages),
    [searchMessages],
  );

  // Snoozed view: ascending by wake-time so the next thread to surface
  // sits at the top, mirroring "what wakes next?" reading order. Pending
  // intents are applied via isSnoozedNow upstream of the sort so a
  // freshly-snoozed thread joins the list in real time.
  const snoozedThreads = useMemo<Thread[]>(() => {
    const list = allThreads.filter(
      (t) => isSnoozedNow(t) && !isTrashedNow(t) && !isArchivedNow(t),
    );
    return list.slice().sort((a, b) => {
      const aPending = pendingSnoozes.get(a.rootKey);
      const bPending = pendingSnoozes.get(b.rootKey);
      const aUntil = (aPending ?? a.snoozedUntil) ?? "";
      const bUntil = (bPending ?? b.snoozedUntil) ?? "";
      return aUntil.localeCompare(bUntil);
    });
  }, [allThreads, isSnoozedNow, isTrashedNow, isArchivedNow, pendingSnoozes]);

  // Trash view: show only the trashed threads, sorted newest-first by
  // most-recent activity (same default as Inbox). Pending-untrash entries
  // are excluded so the row vanishes from Trash the instant the operator
  // hits #.
  const trashedThreads = useMemo<Thread[]>(
    () => allThreads.filter((t) => isTrashedNow(t)),
    [allThreads, isTrashedNow],
  );

  // Archive view: parallel of trashedThreads — show only the archived
  // threads. Independent of trash; an archived thread that is also
  // trashed shows in Trash, not Archive (trash is the harder gate, and
  // showing it in both surfaces would let the operator un-archive a row
  // they meant to keep deleted). The Archive view is the operator's
  // long-term record; ordering matches Inbox (most-recent activity first).
  const archivedThreads = useMemo<Thread[]>(
    () => allThreads.filter((t) => isArchivedNow(t) && !isTrashedNow(t)),
    [allThreads, isArchivedNow, isTrashedNow],
  );

  // ADR-0037 (slice 8.17). Label view: every thread carrying the picked
  // label, with trash/archive elided (matching how Inbox hides them).
  // Pending-add deltas surface a freshly-tagged thread immediately;
  // pending-remove deltas vanish the row from the view in real time.
  // Snoozed threads stay visible in label views — the operator chose
  // the classification deliberately and the label view is how they
  // navigate to it.
  const labelView = typeof view === "object" ? view.label : null;
  const labelThreads = useMemo<Thread[]>(() => {
    if (labelView === null) return [];
    return allThreads.filter(
      (t) =>
        effectiveLabels(t).includes(labelView) &&
        !isTrashedNow(t) &&
        !isArchivedNow(t),
    );
  }, [allThreads, labelView, effectiveLabels, isTrashedNow, isArchivedNow]);

  const threads = searchActive
    ? searchThreads
    : labelView !== null
      ? labelThreads
      : view === "inbox"
        ? inboxThreads
        : view === "starred"
          ? starredThreads
          : view === "snoozed"
            ? snoozedThreads
            : view === "trashed"
              ? trashedThreads
              : view === "archived"
                ? archivedThreads
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
  const snoozedThreadCount = snoozedThreads.length;
  const trashedThreadCount = trashedThreads.length;
  const archivedThreadCount = archivedThreads.length;

  // ADR-0037 (slice 8.17). Per-label thread count for the rail labels
  // section. Counts every thread (visible to inbox/snoozed/labeled) that
  // carries the label in its effective set — pending-add bumps the
  // count immediately, pending-remove drops it. Trash + archive are
  // elided to mirror the label-view filter so the rail count and the
  // view's row count agree.
  const labelThreadCounts = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const t of allThreads) {
      if (isTrashedNow(t)) continue;
      if (isArchivedNow(t)) continue;
      for (const l of effectiveLabels(t)) {
        m.set(l, (m.get(l) ?? 0) + 1);
      }
    }
    return m;
  }, [allThreads, effectiveLabels, isTrashedNow, isArchivedNow]);

  // Rail labels rows. The catalog drives the order (created_at desc as
  // returned by list_labels); the rail just renders. Catalog-only entries
  // with zero current matches still appear so the operator can navigate to
  // empty labels — the count column shows "—" in that case.
  const railLabels = useMemo<RailLabel[]>(
    () =>
      labelCatalog.map((e) => ({
        label: e.label,
        display_name: e.display_name,
        count: labelThreadCounts.get(e.label) ?? 0,
      })),
    [labelCatalog, labelThreadCounts],
  );

  // Picker presence resolver. For a single-thread picker, this is just
  // "does the focused thread carry the label". For a bulk picker, returns
  // "on" iff every targeted thread carries it; "mixed" if some do and
  // some don't; "off" otherwise. Pending deltas win, mirroring how
  // `effectiveLabels` overlays the server view everywhere else.
  const pickerPresenceOf = useCallback(
    (label: string): LabelPresence => {
      if (labelPicker === null) return "off";
      const lower = label.toLowerCase();
      let onCount = 0;
      let total = 0;
      for (const t of allThreads) {
        if (!labelPicker.rootKeys.includes(t.rootKey)) continue;
        total += 1;
        if (effectiveLabels(t).includes(lower)) onCount += 1;
      }
      if (total === 0) return "off";
      if (onCount === total) return "on";
      if (onCount === 0) return "off";
      return "mixed";
    },
    [labelPicker, allThreads, effectiveLabels],
  );

  // Pending-key set for the picker's row dimming. Any label whose pending
  // delta touches *any* of the picker's targets is considered pending so a
  // bulk operator's repeated clicks all see a "yes, that one's in flight"
  // hint. Returns lowercased keys to match the picker's identity model.
  const pickerPendingKeys = useMemo<Set<string>>(() => {
    if (labelPicker === null) return new Set();
    const out = new Set<string>();
    for (const rootKey of labelPicker.rootKeys) {
      const delta = pendingLabels.get(rootKey);
      if (delta === undefined) continue;
      for (const k of delta.add) out.add(k);
      for (const k of delta.remove) out.add(k);
    }
    return out;
  }, [labelPicker, pendingLabels]);

  const closePicker = useCallback((): void => {
    setLabelPicker(null);
  }, []);

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

  // ADR-0036 (slice 8.17). Surface server-side parser failures inline.
  // The BFF returns 400 invalid_request with field=query when the operator
  // grammar is broken (unclosed quote, unknown is:/in: value, …). We pluck
  // the message so the rail can render it where "N hits" usually lives.
  const searchError: string | null = (() => {
    const r = searchQueryResult.data;
    if (!r) return null;
    if (r.kind !== "invalid_request") return null;
    if (r.field !== "query") return null;
    return r.message;
  })();

  // Keep the selection in range as the inbox refreshes.
  useEffect(() => {
    if (selectedIdx >= threads.length && threads.length > 0) {
      setSelectedIdx(threads.length - 1);
    }
  }, [threads.length, selectedIdx]);

  // Same posture for the drafts list — if a draft was deleted from
  // another tab the index might point past the end.
  useEffect(() => {
    if (draftSelectedIdx >= drafts.length && drafts.length > 0) {
      setDraftSelectedIdx(drafts.length - 1);
    }
  }, [drafts.length, draftSelectedIdx]);

  // Bulk-select helpers (ADR-0032, slice 8.14). Selection is purely
  // client-side state; clearing on view switch / search transition keeps it
  // from carrying invisible rows across mode changes.
  const clearSelection = useCallback(() => {
    setSelection((prev) => (prev.size === 0 ? prev : new Set()));
    setAnchorRootKey(null);
    setBulkSnoozePickerOpen(false);
  }, []);

  // Switching views snaps to the top and re-opens the reader on first row.
  // Also clears any active search — the rail nav is meaningless inside a
  // search results list.
  const switchView = useCallback(
    (next: View) => {
      setView(next);
      setSelectedIdx(0);
      setDraftSelectedIdx(0);
      setPane({ mode: "reader" });
      setSearchQuery("");
      setLabelPicker(null);
      clearSelection();
    },
    [clearSelection],
  );

  // Reset selection when the source list changes shape (entering / leaving
  // search, or the search query itself changing).
  useEffect(() => {
    setSelectedIdx(0);
    clearSelection();
  }, [searchActive, debouncedQuery, clearSelection]);

  // Stable string identity for `view` — the View type is a union of
  // string | { kind: "label"; label }, so direct dep comparison would
  // re-fire on every render that produces a new label-view object.
  const viewIdentity = viewKey(view);

  // Close the reader's snooze picker whenever the selected thread changes
  // — leaving it open across selections produces a popover anchored to a
  // stale row and confuses the operator about which thread the picker
  // applies to.
  useEffect(() => {
    setReaderSnoozePickerOpen(false);
  }, [selectedIdx, viewIdentity, searchActive]);

  // Same posture for the label picker — switching threads / views or
  // entering search closes any open picker.
  useEffect(() => {
    setLabelPicker(null);
  }, [selectedIdx, viewIdentity, searchActive]);

  const openCompose = useCallback((seed: ComposerSeed | null) => {
    setPane({
      mode: "composer",
      seed,
      replyParentId: null,
      resumeDraft: null,
    });
  }, []);

  // ADR-0035 (slice 8.17). Resume a saved draft. Loads the row into the
  // composer and stamps the existing draft_id as the upsert handle, so
  // subsequent auto-saves overwrite the same row instead of minting new
  // ones.
  const resumeDraft = useCallback((draft: StoredDraft): void => {
    setPane({
      mode: "composer",
      seed: null,
      replyParentId: null,
      resumeDraft: draft,
    });
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
      resumeDraft: null,
    });
  }, [selectedRow]);

  // Per-card reply (slice 8.6). The expanded MessageView passes its own
  // row's message_id; the composer flow is otherwise identical to the
  // latest-row reply path.
  const replyToMessage = useCallback((messageId: string): void => {
    if (messageId === "") return;
    setPane({
      mode: "composer",
      seed: null,
      replyParentId: messageId,
      resumeDraft: null,
    });
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

  // ADR-0029 (slice 8.11). Toggle snooze on every row in the thread.
  // Optimistic write keyed by rootKey (=== server thread_id for any
  // server-stamped thread). Mirrors toggleStar: stamp intent → fire RPC
  // → drop on success / roll back on failure. The map distinguishes
  // "no entry" (server-authoritative) from a literal `null` value
  // (in-flight unsnooze), so .has() / .get() both behave correctly.
  const pickSnooze = useCallback(
    (rootKey: string, snoozedUntil: string | null): void => {
      if (!rootKey.startsWith("<")) return;
      setPendingSnoozes((prev) => {
        const m = new Map(prev);
        m.set(rootKey, snoozedUntil);
        return m;
      });
      void bff
        .snoozeThread({ thread_id: rootKey, snoozed_until: snoozedUntil })
        .then((r) => {
          if (r.kind !== "ok") {
            setPendingSnoozes((prev) => {
              const m = new Map(prev);
              m.delete(rootKey);
              return m;
            });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
          setPendingSnoozes((prev) => {
            const m = new Map(prev);
            m.delete(rootKey);
            return m;
          });
        });
    },
    [queryClient],
  );

  // ADR-0030 (slice 8.12). Mirror of toggleStar — boolean trash toggle
  // with optimistic-pending intent. Subject-fallback rollups are gated
  // upstream by TrashButton.disabled; the early return is a defense in
  // depth.
  const toggleTrash = useCallback(
    (rootKey: string, next: boolean): void => {
      if (!rootKey.startsWith("<")) return;
      setPendingTrashes((prev) => {
        const m = new Map(prev);
        m.set(rootKey, next);
        return m;
      });
      void bff
        .trashThread({ thread_id: rootKey, trashed: next })
        .then((r) => {
          if (r.kind !== "ok") {
            setPendingTrashes((prev) => {
              const m = new Map(prev);
              m.delete(rootKey);
              return m;
            });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
          setPendingTrashes((prev) => {
            const m = new Map(prev);
            m.delete(rootKey);
            return m;
          });
        });
    },
    [queryClient],
  );

  // ADR-0034 (slice 8.16). Optimistic stamp on the pendingArchives map.
  // Split out from toggleArchive so ADR-0038's send-and-archive can
  // pre-stamp before the reply RPC fires (the stamp lands the moment
  // the operator commits; the archive RPC waits on send-OK).
  const stampPendingArchive = useCallback(
    (rootKey: string, next: boolean): void => {
      setPendingArchives((prev) => {
        const m = new Map(prev);
        m.set(rootKey, next);
        return m;
      });
    },
    [],
  );

  const dropPendingArchive = useCallback((rootKey: string): void => {
    setPendingArchives((prev) => {
      const m = new Map(prev);
      m.delete(rootKey);
      return m;
    });
  }, []);

  // ADR-0034 (slice 8.16). Fire archive_thread and reconcile the pending
  // entry. Assumes the caller has already stamped the optimistic state.
  // On OK, invalidate the inbox poll and drop the entry; on failure,
  // drop the entry so the row reverts to the server-authoritative state.
  const runArchiveRpc = useCallback(
    (rootKey: string, next: boolean): void => {
      void bff
        .archiveThread({ thread_id: rootKey, archived: next })
        .then((r) => {
          if (r.kind !== "ok") {
            dropPendingArchive(rootKey);
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
          dropPendingArchive(rootKey);
        });
    },
    [queryClient, dropPendingArchive],
  );

  // ADR-0034 (slice 8.16). Toggle archive on every row in the thread.
  // Mirror of toggleTrash; archive is independent from trash, so the
  // pending map keys don't collide with pendingTrashes.
  const toggleArchive = useCallback(
    (rootKey: string, next: boolean): void => {
      if (!rootKey.startsWith("<")) return;
      stampPendingArchive(rootKey, next);
      runArchiveRpc(rootKey, next);
    },
    [stampPendingArchive, runArchiveRpc],
  );

  // ADR-0038 (slice 8.17). Send-and-archive callback. Composer pre-stamps
  // pendingArchives before its reply RPC; on reply-OK it invokes this to
  // close the composer and fire archive_thread. On reply error the
  // composer drops the stamp via onArchiveStampDrop and the row stays in
  // the inbox. On send-OK + archive-error the runArchiveRpc rollback
  // already drops the entry — the row reappears, the operator presses
  // `e` to retry archive manually (spec §Failure modes).
  const onSentAndArchive = useCallback(
    (threadId: string): void => {
      setPane({ mode: "reader" });
      void inboxQuery.refetch();
      runArchiveRpc(threadId, true);
    },
    [inboxQuery, runArchiveRpc],
  );

  // ADR-0031 (slice 8.13). Toggle read/unread on every inbound row in the
  // thread. Mirror of toggleTrash. The map stores the target read state so
  // the optimistic UI can flip the dot/badge before the RPC settles.
  const toggleRead = useCallback(
    (rootKey: string, next: boolean): void => {
      if (!rootKey.startsWith("<")) return;
      setPendingReads((prev) => {
        const m = new Map(prev);
        m.set(rootKey, next);
        return m;
      });
      void bff
        .markThreadRead({ thread_id: rootKey, read: next })
        .then((r) => {
          if (r.kind !== "ok") {
            setPendingReads((prev) => {
              const m = new Map(prev);
              m.delete(rootKey);
              return m;
            });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
          setPendingReads((prev) => {
            const m = new Map(prev);
            m.delete(rootKey);
            return m;
          });
        });
    },
    [queryClient],
  );

  // ADR-0037 (slice 8.17). Apply or remove a label on one thread,
  // optimistic-pending. The pending entry is a per-thread delta map:
  // an `add` set and a `remove` set, both keyed by lowercased label.
  // Toggle updates the right set and clears the opposite (a fresh
  // intent supersedes the prior one). On RPC success the queue entry
  // for that label is dropped and the next inbox poll surfaces the
  // server-truth `labels` array; on RPC failure the same entry is
  // dropped without invalidating, so the row falls back to whatever
  // the last poll said.
  const toggleLabel = useCallback(
    (rootKey: string, label: string, target: "on" | "off"): void => {
      if (!rootKey.startsWith("<")) return;
      const lower = label.toLowerCase();
      setPendingLabels((prev) => {
        const m = new Map(prev);
        const cur = m.get(rootKey) ?? {
          add: new Set<string>(),
          remove: new Set<string>(),
        };
        const add = new Set(cur.add);
        const remove = new Set(cur.remove);
        if (target === "on") {
          add.add(lower);
          remove.delete(lower);
        } else {
          remove.add(lower);
          add.delete(lower);
        }
        m.set(rootKey, { add, remove });
        return m;
      });
      const fire =
        target === "on"
          ? bff.addThreadLabel({ thread_id: rootKey, label: lower })
          : bff.removeThreadLabel({ thread_id: rootKey, label: lower });
      void fire.then((r) => {
        setPendingLabels((prev) => {
          const m = new Map(prev);
          const cur = m.get(rootKey);
          if (cur === undefined) return prev;
          const add = new Set(cur.add);
          const remove = new Set(cur.remove);
          add.delete(lower);
          remove.delete(lower);
          if (add.size === 0 && remove.size === 0) {
            m.delete(rootKey);
          } else {
            m.set(rootKey, { add, remove });
          }
          return m;
        });
        if (r.kind === "ok") {
          void queryClient.invalidateQueries({ queryKey: ["inbox"] });
        }
      });
    },
    [queryClient],
  );

  // Create a new label catalog entry, then immediately apply it to a
  // set of target threads. 409 already_exists is treated as success —
  // a parallel session created the same name first, so we just apply
  // the existing label across the targets. The catalog query is
  // invalidated either way.
  const createAndApplyLabel = useCallback(
    async (
      rootKeys: string[],
      label: string,
    ): Promise<void> => {
      const trimmed = label.trim();
      if (trimmed === "") return;
      const r = await bff.createLabel({ address: MAILBOX, label: trimmed });
      // 409 → label already exists; treat the conflict as if the
      // operator had picked the existing row from the list.
      if (r.kind !== "ok" && r.kind !== "conflict") return;
      void queryClient.invalidateQueries({ queryKey: ["labels", MAILBOX] });
      const lower = trimmed.toLowerCase();
      for (const rootKey of rootKeys) {
        toggleLabel(rootKey, lower, "on");
      }
    },
    [queryClient, toggleLabel],
  );

  const onPickerToggle = useCallback(
    (label: string, target: "on" | "off"): void => {
      if (labelPicker === null) return;
      for (const rootKey of labelPicker.rootKeys) {
        toggleLabel(rootKey, label, target);
      }
    },
    [labelPicker, toggleLabel],
  );

  const onPickerCreate = useCallback(
    async (label: string): Promise<void> => {
      if (labelPicker === null) return;
      await createAndApplyLabel(labelPicker.rootKeys, label);
    },
    [labelPicker, createAndApplyLabel],
  );

  // ADR-0032 (slice 8.14). Toggle a thread's membership in the bulk
  // selection set. Plain toggle when `withShift` is false; Shift+click
  // extends an inclusive range from the anchor to the target in the
  // current `threads` view order. A Shift+click with no explicit anchor
  // falls back to the focused-for-reading row (selectedIdx) as the
  // implicit anchor — so "click row N, shift+click row M" gives range
  // [N..M] as the operator expects, rather than just {M} in isolation.
  const toggleSelection = useCallback(
    (rootKey: string, withShift: boolean): void => {
      if (!rootKey.startsWith("<")) return;
      // Resolve the effective anchor for this Shift+click: explicit
      // anchor wins, then the currently-focused-for-reading row's
      // rootKey, then null (plain toggle).
      const focusedRootKey = threads[selectedIdx]?.rootKey ?? null;
      const implicitAnchor =
        anchorRootKey ??
        (focusedRootKey && focusedRootKey.startsWith("<")
          ? focusedRootKey
          : null);
      if (withShift && implicitAnchor !== null && implicitAnchor !== rootKey) {
        const range = computeRange(threads, implicitAnchor, rootKey);
        if (range.length > 0) {
          setSelection((prev) => {
            const next = new Set(prev);
            for (const k of range) next.add(k);
            return next;
          });
          // Stamp the anchor on first range-extend so successive
          // Shift+clicks grow / shrink relative to the original click.
          if (anchorRootKey === null) setAnchorRootKey(implicitAnchor);
          return;
        }
      }
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(rootKey)) {
          next.delete(rootKey);
        } else {
          next.add(rootKey);
        }
        return next;
      });
      setAnchorRootKey(rootKey);
    },
    [anchorRootKey, threads, selectedIdx],
  );

  // ADR-0033 (slice 8.15). Master "select all in view" toggle. Click
  // semantics: any non-empty selection collapses to empty (mouse and
  // keyboard agree on the terminal state); an empty selection expands
  // to every threadable rootKey in the current view. Anchor jumps to
  // the first row of the new "all" set so a follow-up Shift+click
  // extends from the top — the natural reading-order start.
  const toggleSelectAll = useCallback((): void => {
    const all = threadableRootKeys(threads);
    if (all.length === 0) return;
    if (selection.size === 0) {
      setSelection(new Set(all));
      setAnchorRootKey(all[0] ?? null);
    } else {
      // Partial or full → collapse to empty. Single click target,
      // single terminal state.
      setSelection(new Set());
      setAnchorRootKey(null);
    }
  }, [threads, selection.size]);

  // Bulk apply: fan out one of the per-thread handlers over the current
  // selection. Promise.allSettled posture means a per-thread failure
  // rolls back only that row (each handler owns its own pending-map
  // rollback) and the rest of the selection still applies.
  const bulkApply = useCallback(
    (apply: (rootKey: string) => void): void => {
      for (const rootKey of selection) apply(rootKey);
    },
    [selection],
  );

  // Disambiguation predicates for the bulk action bar buttons. "All
  // starred" means every selected thread already shows starred (server
  // value, optionally overridden by a pending intent). The bar uses
  // these to pick "Star All" vs "Unstar All" and similar pairs. Mixed
  // selections default to the add-to-set bias (Star All / Trash All /
  // Mark Read All).
  const allSelectedStarred = useMemo<boolean>(() => {
    if (selection.size === 0) return false;
    for (const t of threads) {
      if (!selection.has(t.rootKey)) continue;
      const pending = pendingStars.get(t.rootKey);
      const filled = pending ?? t.starred;
      if (!filled) return false;
    }
    return true;
  }, [selection, threads, pendingStars]);

  const allSelectedTrashed = useMemo<boolean>(() => {
    if (selection.size === 0) return false;
    for (const t of threads) {
      if (!selection.has(t.rootKey)) continue;
      const pending = pendingTrashes.get(t.rootKey);
      const filled = pending ?? t.trashed;
      if (!filled) return false;
    }
    return true;
  }, [selection, threads, pendingTrashes]);

  const allSelectedArchived = useMemo<boolean>(() => {
    if (selection.size === 0) return false;
    for (const t of threads) {
      if (!selection.has(t.rootKey)) continue;
      const pending = pendingArchives.get(t.rootKey);
      const filled = pending ?? t.archived;
      if (!filled) return false;
    }
    return true;
  }, [selection, threads, pendingArchives]);

  // For mark-read disambiguation: "all read" means every selected thread
  // has zero unread inbound rows. A selection containing only outbound
  // threads would render the button disabled (handled below) — this
  // predicate doesn't gate that case, just picks the verb.
  const allSelectedRead = useMemo<boolean>(() => {
    if (selection.size === 0) return false;
    for (const t of threads) {
      if (!selection.has(t.rootKey)) continue;
      const pending = pendingReads.get(t.rootKey);
      const unread =
        pending !== undefined ? !pending : t.unread;
      if (unread) return false;
    }
    return true;
  }, [selection, threads, pendingReads]);

  // Disable mark-read All when every selected thread has no inbound
  // rows — there is nothing to flip on the wire. Outbound-only threads
  // can't be unread.
  const anySelectedHasInbound = useMemo<boolean>(() => {
    if (selection.size === 0) return false;
    for (const t of threads) {
      if (!selection.has(t.rootKey)) continue;
      if (t.rows.some((r) => r.direction === "in")) return true;
    }
    return false;
  }, [selection, threads]);

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
      thread_id: msg.thread_id,
    };
  }, [replyParentId, replyParentQuery.data]);

  // Keyboard.
  useKeyboard(
    useCallback(
      (e: KeyboardEvent) => {
        if (pane.mode === "composer") return; // composer owns its own keys
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === "Escape" && selection.size > 0) {
          // Slice 8.14. Esc clears a non-empty selection. Composer-mode
          // is handled by the early return above, so this only fires in
          // reader-mode; search input has its own Escape handler that
          // doesn't bubble here.
          e.preventDefault();
          clearSelection();
          return;
        }
        if (e.key === "j") {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(threads.length - 1, i + 1));
        } else if (e.key === "k") {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(0, i - 1));
        } else if (e.key === "X" && e.shiftKey) {
          // Slice 8.15 (ADR-0033). Shift+x toggles select-all-in-view.
          // No-op when the view has no threadable rows. Independent of
          // the focused row — the master toggle is a view-level gesture.
          e.preventDefault();
          toggleSelectAll();
        } else if (e.key === "x") {
          // Slice 8.14. Toggle the focused thread's selection
          // membership. Same gate as star/snooze/trash/read — server
          // thread ids only.
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          toggleSelection(t.rootKey, false);
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
        } else if (e.key === "z") {
          // Slice 8.11. Open the picker for the selected thread.
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          setReaderSnoozePickerOpen(true);
        } else if (e.key === "Z") {
          // Capital Z is the immediate-unsnooze shortcut — bypasses the
          // picker so power-users can wake a thread with one keystroke.
          // No-op when the thread isn't currently snoozed (including a
          // pending unsnooze that hasn't returned yet).
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          const pending = pendingSnoozes.get(t.rootKey);
          const currentlySnoozed =
            pending !== undefined ? pending !== null : t.snoozed;
          if (!currentlySnoozed) return;
          e.preventDefault();
          pickSnooze(t.rootKey, null);
        } else if (e.key === "#") {
          // Slice 8.12. Toggle trash on the selected thread. Same gate
          // as star/snooze — server-stamped thread ids only.
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          const pending = pendingTrashes.get(t.rootKey);
          const current = pending ?? t.trashed;
          toggleTrash(t.rootKey, !current);
        } else if (e.key === "e") {
          // Slice 8.16 (ADR-0034). Toggle archive on the selected thread.
          // Gmail's archive shortcut. Same gate as the other annotation
          // toggles — server-stamped thread ids only.
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          const pending = pendingArchives.get(t.rootKey);
          const current = pending ?? t.archived;
          toggleArchive(t.rootKey, !current);
        } else if (e.key === "U" && e.shiftKey) {
          // Slice 8.13. Shift+U toggles read/unread on the selected
          // thread (Gmail convention). Plain `u` is reserved for a
          // future archive shortcut.
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          const pending = pendingReads.get(t.rootKey);
          // The map stores the *target* state, not the current — when
          // present, the thread is currently in that target state. When
          // absent, fall back to t.unread (true → unread → next: read).
          const currentlyUnread =
            pending !== undefined ? !pending : t.unread;
          toggleRead(t.rootKey, currentlyUnread);
        } else if (e.key === "l") {
          // Slice 8.17 (ADR-0037). Open the label picker on the focused
          // thread, or scoped to the current selection when one exists.
          // Same gate as star/snooze/trash — server-stamped thread ids
          // only. Selection-scoped picker filters out non-threadable
          // rootKeys so a bulk apply never fires against a synthetic key.
          if (selection.size > 0) {
            const rootKeys = Array.from(selection).filter((k) =>
              k.startsWith("<"),
            );
            if (rootKeys.length === 0) return;
            e.preventDefault();
            setLabelPicker({ rootKeys, anchor: "bulk" });
            return;
          }
          const t = threads[selectedIdx];
          if (t === undefined) return;
          if (!t.rootKey.startsWith("<")) return;
          e.preventDefault();
          setLabelPicker({ rootKeys: [t.rootKey], anchor: "header" });
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
              "z / Z    snooze (picker) / unsnooze immediately",
              "#        trash / untrash selected thread",
              "e        archive / unarchive selected thread",
              "Shift+U  mark thread read / unread",
              "l        label picker (enter toggles, ⌘↩ closes)",
              "x        add / remove focused thread from selection",
              "Shift+x  select / deselect all in view",
              "c        compose new",
              "⌘↵       send (in composer)",
              "⇧⌘↵      send reply and archive thread (in composer)",
              "t        toggle theme",
              "esc      close composer / clear search / clear selection",
              "?        this cheat sheet",
              "",
              "search operators (ADR-0036)",
              "  from:bob  subject:invoice  to:alice",
              "  is:unread | is:starred | is:snoozed",
              "  has:attachment",
              "  in:trash | in:archive",
              '  "quoted phrase"  -from:noreply  (negate with leading -)',
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
        pendingSnoozes,
        pendingTrashes,
        pendingReads,
        pendingArchives,
        toggleStar,
        pickSnooze,
        toggleTrash,
        toggleRead,
        toggleArchive,
        openCompose,
        replyToCurrent,
        toggle,
        selection.size,
        toggleSelection,
        toggleSelectAll,
        clearSelection,
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
        snoozedCount={snoozedThreadCount}
        trashedCount={trashedThreadCount}
        archivedCount={archivedThreadCount}
        draftsCount={draftsCount}
        labels={railLabels}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchInputRef={searchInputRef}
        searching={searchActive && searchQueryResult.isFetching}
        searchHitCount={searchHitCount}
        searchError={searchError}
        onSearchKeyDown={onSearchKeyDown}
      />
      <div className="inbox-column">
        {view === "drafts" && !searchActive ? (
          <DraftsList
            drafts={drafts}
            selectedIdx={draftSelectedIdx}
            onSelect={setDraftSelectedIdx}
            onResume={resumeDraft}
            onDelete={deleteDraftFromList}
            loading={draftsQuery.isLoading}
            offline={draftsQuery.data?.kind === "error"}
          />
        ) : (
          <>
        {selection.size > 0 ? (
          <BulkActionBar
            count={selection.size}
            allStarred={allSelectedStarred}
            allTrashed={allSelectedTrashed}
            allArchived={allSelectedArchived}
            allRead={allSelectedRead}
            anyHasInbound={anySelectedHasInbound}
            snoozePickerOpen={bulkSnoozePickerOpen}
            onSnoozePickerOpenChange={setBulkSnoozePickerOpen}
            onClear={clearSelection}
            onStarAll={() =>
              bulkApply((rootKey) => toggleStar(rootKey, !allSelectedStarred))
            }
            onTrashAll={() =>
              bulkApply((rootKey) => toggleTrash(rootKey, !allSelectedTrashed))
            }
            onArchiveAll={() =>
              bulkApply((rootKey) =>
                toggleArchive(rootKey, !allSelectedArchived),
              )
            }
            onMarkReadAll={() =>
              bulkApply((rootKey) => toggleRead(rootKey, !allSelectedRead))
            }
            onPickSnooze={(snoozedUntil) =>
              bulkApply((rootKey) => pickSnooze(rootKey, snoozedUntil))
            }
          />
        ) : null}
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
          pendingSnoozes={pendingSnoozes}
          onPickSnooze={pickSnooze}
          pendingTrashes={pendingTrashes}
          onToggleTrash={toggleTrash}
          pendingArchives={pendingArchives}
          onToggleArchive={toggleArchive}
          pendingReads={pendingReads}
          onToggleRead={toggleRead}
          selection={selection}
          onToggleSelection={toggleSelection}
          onToggleSelectAll={toggleSelectAll}
          selectionActive={selection.size > 0}
          pendingLabels={pendingLabels}
          labelDisplayNames={labelDisplayNames}
        />
          </>
        )}
      </div>
      {pane.mode === "reader" ? (
        (() => {
          // Resolve the star indicator state for the selected thread once,
          // mirroring the inbox-row logic so the gutter and reader header
          // never disagree mid-flight.
          const t = threads[selectedIdx] ?? null;
          const pending = t === null ? undefined : pendingStars.get(t.rootKey);
          const filled = t === null ? false : (pending ?? t.starred);
          const snoozePending =
            t === null ? undefined : pendingSnoozes.get(t.rootKey);
          const snoozedUntil =
            t === null
              ? null
              : snoozePending !== undefined
                ? snoozePending
                : t.snoozedUntil;
          const trashPending =
            t === null ? undefined : pendingTrashes.get(t.rootKey);
          const trashFilled =
            t === null ? false : (trashPending ?? t.trashed);
          const archivePending =
            t === null ? undefined : pendingArchives.get(t.rootKey);
          const archiveFilled =
            t === null ? false : (archivePending ?? t.archived);
          // Slice 8.13. The map stores the *target* read state, so a pending
          // entry flips the unread bit immediately. Without an entry, fall
          // back to the server-aggregated `unread`.
          const readPending =
            t === null ? undefined : pendingReads.get(t.rootKey);
          const unread =
            t === null
              ? false
              : readPending !== undefined
                ? !readPending
                : t.unread;
          const readerLabels = t === null ? [] : effectiveLabels(t);
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
              snoozedUntil={snoozedUntil}
              snoozePending={snoozePending !== undefined}
              onPickSnooze={pickSnooze}
              snoozePickerOpen={readerSnoozePickerOpen}
              onSnoozePickerOpenChange={setReaderSnoozePickerOpen}
              trashFilled={trashFilled}
              trashPending={trashPending !== undefined}
              onToggleTrash={toggleTrash}
              archiveFilled={archiveFilled}
              archivePending={archivePending !== undefined}
              onToggleArchive={toggleArchive}
              unread={unread}
              readPending={readPending !== undefined}
              onToggleRead={toggleRead}
              labels={readerLabels}
              labelDisplayNames={labelDisplayNames}
              onOpenLabelPicker={(rootKey) =>
                setLabelPicker({ rootKeys: [rootKey], anchor: "header" })
              }
              onSelectLabel={(label) =>
                switchView({ kind: "label", label })
              }
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
          resumeDraft={pane.resumeDraft}
          onCancel={() => setPane({ mode: "reader" })}
          onSent={onSent}
          onSentAndArchive={onSentAndArchive}
          onArchiveStamp={stampPendingArchive}
          onArchiveStampDrop={dropPendingArchive}
          onDraftsChanged={onDraftsChanged}
        />
      )}
      {labelPicker !== null ? (
        <div
          className={
            "label-picker-overlay" +
            (labelPicker.anchor === "bulk"
              ? " label-picker-overlay--bulk"
              : labelPicker.anchor === "row"
                ? " label-picker-overlay--row"
                : " label-picker-overlay--header")
          }
          // Outside-click dismissal. The picker itself stops propagation
          // (see LabelPicker.tsx) so clicks inside the panel won't bubble
          // here — only true outside clicks reach the overlay.
          onMouseDown={closePicker}
        >
          <LabelPicker
            catalog={labelCatalog}
            pendingKeys={pickerPendingKeys}
            presenceOf={pickerPresenceOf}
            onToggle={onPickerToggle}
            onCreate={onPickerCreate}
            onClose={closePicker}
          />
        </div>
      ) : null}
    </div>
  );
}
