import { describe, expect, it } from "vitest";
import {
  groupIntoThreads,
  mergeThreadRows,
} from "../../src/web/src/lib/threading.js";
// Pin a fixed `now` so snooze-aggregation tests are deterministic across
// CI runs — the predicate is `every parsed row's snoozed_until > now`.
import type {
  InboxRow,
  InboxRowFailed,
  InboxRowOk,
  ListThreadMessagesResult,
  RpcResult,
} from "../../src/web/src/lib/bff-client.js";

// Client-side threading (slice 8.5, ADR-0023). Mirrors the server's
// deriveThreadId rule for message-id rooted chains; falls back to
// normalized-subject + month bucket for orphans without headers.

function row(
  partial: Partial<InboxRowOk> & {
    internal_id: string;
    received_at: string;
  },
): InboxRowOk {
  return {
    parse_status: "ok",
    schema_v: "1",
    address: "alice@acme.com",
    message_id: null,
    from: null,
    to: null,
    cc: null,
    reply_to: null,
    subject: null,
    date: null,
    in_reply_to: null,
    references: null,
    auto_submitted: "no",
    list_id: null,
    snippet: "",
    direction: "in",
    read_at: "2026-05-21T00:00:00.000Z",
    thread_id: null,
    starred_at: null,
    snoozed_until: null,
    trashed_at: null,
    archived_at: null,
    ...partial,
  };
}

function failed(internal_id: string, received_at: string): InboxRowFailed {
  return {
    parse_status: "failed",
    schema_v: "1",
    address: "alice@acme.com",
    internal_id,
    received_at,
    raw_s3_uri: "s3://x/y",
    parse_error: "boom",
  };
}

describe("groupIntoThreads", () => {
  it("returns one thread per single message when no chain exists", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        subject: "first",
        from: "Bob <bob@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        subject: "second",
        from: "Carol <carol@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(2);
    expect(out[0]!.count).toBe(1);
    expect(out[1]!.count).toBe(1);
  });

  it("groups a linear chain via References", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<root@example.com>",
        subject: "Q2 invoice",
        from: "Bob <bob@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<r1@example.com>",
        subject: "Re: Q2 invoice",
        from: "Alice <alice@acme.com>",
        in_reply_to: "<root@example.com>",
        references: "<root@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000C",
        received_at: "2026-05-20T12:00:00.000Z",
        message_id: "<r2@example.com>",
        subject: "Re: Q2 invoice",
        from: "Bob <bob@example.com>",
        in_reply_to: "<r1@example.com>",
        references: "<root@example.com> <r1@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.rootKey).toBe("<root@example.com>");
  });

  it("sorts thread rows newest-first and surfaces the latest as the lead", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<root@example.com>",
        subject: "Q2 invoice",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T12:00:00.000Z",
        message_id: "<r1@example.com>",
        subject: "Re: Q2 invoice",
        references: "<root@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out[0]!.rows[0]!.message_id).toBe("<r1@example.com>");
    expect(out[0]!.latestReceivedAt).toBe("2026-05-20T12:00:00.000Z");
  });

  it("rolls up an outbound reply under its inbound parent (mixed direction)", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<root@example.com>",
        subject: "ping",
        direction: "in",
        from: "Bob <bob@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<myreply@example.com>",
        subject: "Re: ping",
        direction: "out",
        from: "Alice <alice@acme.com>",
        in_reply_to: "<root@example.com>",
        references: "<root@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.hasOutbound).toBe(true);
  });

  it("groups orphans (parent off-page) when they share a Reference root", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<r1@example.com>",
        subject: "Re: budget",
        in_reply_to: "<root@example.com>",
        references: "<root@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<r2@example.com>",
        subject: "Re: budget",
        in_reply_to: "<r1@example.com>",
        references: "<root@example.com> <r1@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.rootKey).toBe("<root@example.com>");
  });

  it("falls back to normalized subject + month bucket when no headers exist", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        subject: "Re: lunch?",
        from: "Bob <bob@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-21T12:00:00.000Z",
        subject: "Re: Re: lunch?",
        from: "Carol <carol@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.rootKey).toBe("subj:2026-05:lunch?");
  });

  it("splits subject-fallback rows across month buckets", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-04-30T10:00:00.000Z",
        subject: "lunch?",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-02T12:00:00.000Z",
        subject: "lunch?",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(2);
  });

  it("strips Re:/Fwd:/Fw: runs case-insensitively for the subject fallback", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        subject: "fwd: Re: FW: status",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        subject: "RE: status",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.rootKey).toBe("subj:2026-05:status");
  });

  it("does not strip localized prefixes — Aw: stays intact", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        subject: "Aw: Hallo",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        subject: "Re: Hallo",
      }),
    ];
    const out = groupIntoThreads(rows);
    // Two distinct fallback roots: "aw: hallo" and "hallo".
    expect(out).toHaveLength(2);
  });

  it("renders parse-failed rows as their own single-row threads", () => {
    const rows: InboxRow[] = [
      failed("01H0000000000000000000A", "2026-05-20T10:00:00.000Z"),
      failed("01H0000000000000000000B", "2026-05-20T11:00:00.000Z"),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(2);
    expect(out[0]!.count).toBe(1);
    expect(out[0]!.failedRows).toHaveLength(1);
  });

  it("sorts threads newest-first by latestReceivedAt", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        subject: "old",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        subject: "Re: old",
        references: "<a@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000C",
        received_at: "2026-05-20T12:00:00.000Z",
        message_id: "<c@example.com>",
        subject: "fresh",
      }),
    ];
    const out = groupIntoThreads(rows);
    // Two threads: <a> chain (latest 11:00) and <c> alone (12:00). The fresh
    // single message wins the top slot.
    expect(out).toHaveLength(2);
    expect(out[0]!.rootKey).toBe("<c@example.com>");
    expect(out[1]!.rootKey).toBe("<a@example.com>");
  });

  it("flags unread when any inbound row in the thread has read_at === null", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        direction: "in",
        read_at: "2026-05-20T10:30:00.000Z",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        direction: "in",
        references: "<a@example.com>",
        read_at: null,
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out[0]!.unread).toBe(true);
  });

  it("does not flag unread when only outbound rows lack read_at", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        direction: "in",
        read_at: "2026-05-20T10:30:00.000Z",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        direction: "out",
        references: "<a@example.com>",
        read_at: null,
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out[0]!.unread).toBe(false);
    expect(out[0]!.hasOutbound).toBe(true);
  });

  it("collects distinct senders newest-first, no duplicates", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        from: "Bob <bob@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        references: "<a@example.com>",
        from: "Alice <alice@acme.com>",
      }),
      row({
        internal_id: "01H0000000000000000000C",
        received_at: "2026-05-20T12:00:00.000Z",
        message_id: "<c@example.com>",
        references: "<a@example.com>",
        from: "Bob <bob@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    // Latest first: Bob (12:00), Alice (11:00). Bob at 10:00 deduped.
    expect(out[0]!.senders).toEqual(["Bob", "Alice"]);
  });

  it("uses server-stamped thread_id when present, even if headers disagree (ADR-0026)", () => {
    // Server-side thread_id takes precedence over the client's JWZ
    // resolution. If the server stamped two rows with the same thread_id we
    // cluster them, regardless of what References / In-Reply-To say.
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        thread_id: "<server-root@example.com>",
        subject: "alpha",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        thread_id: "<server-root@example.com>",
        subject: "beta",
        // Different (and disagreeing) header chain — server wins.
        in_reply_to: "<unrelated@example.com>",
        references: "<unrelated@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.rootKey).toBe("<server-root@example.com>");
    expect(out[0]!.count).toBe(2);
  });

  it("falls back to JWZ when thread_id is null (legacy / sparse rows, ADR-0026)", () => {
    // Rows written before slice 8.8 land with thread_id === null. The client
    // must still cluster them via the JWZ chain so the inbox doesn't
    // regress when the rollout is mid-flight.
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<root@example.com>",
        thread_id: null,
        subject: "Q2 invoice",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<r1@example.com>",
        thread_id: null,
        subject: "Re: Q2 invoice",
        in_reply_to: "<root@example.com>",
        references: "<root@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.rootKey).toBe("<root@example.com>");
    expect(out[0]!.count).toBe(2);
  });

  it("does not cluster rows with mismatched server thread_ids even when headers chain (ADR-0026)", () => {
    // If the server says these are different threads, trust it — even if a
    // misbehaving relay re-used References across unrelated conversations.
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        thread_id: "<thread-1@example.com>",
        subject: "ping",
        references: "<shared@example.com>",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b@example.com>",
        thread_id: "<thread-2@example.com>",
        subject: "ping",
        references: "<shared@example.com>",
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(2);
  });

  it("treats In-Reply-To alone (no References) as the parent edge", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<root@example.com>",
        subject: "ping",
      }),
      row({
        internal_id: "01H0000000000000000000B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<r1@example.com>",
        subject: "Re: ping",
        in_reply_to: "<root@example.com>",
        references: null,
      }),
    ];
    const out = groupIntoThreads(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.rootKey).toBe("<root@example.com>");
  });

  // ADR-0028 (slice 8.10). Thread.starred is per-row OR — any row with a
  // non-null starred_at marks the thread as starred. The aggregation has
  // to be defensive against partial states (mid-flight star_thread fanout
  // where one row was rejected by the conditional check) and against
  // direction (an outbound row can carry a starred_at, since the operator
  // may have starred the thread after replying).
  describe("Thread.starred aggregation (ADR-0028 / slice 8.10)", () => {
    it("returns false when no row carries starred_at", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
        }),
      ];
      const out = groupIntoThreads(rows);
      expect(out[0]!.starred).toBe(false);
    });

    it("returns true when any row carries starred_at", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          starred_at: null,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          starred_at: "2026-05-22T09:00:00.000Z",
        }),
      ];
      const out = groupIntoThreads(rows);
      expect(out[0]!.starred).toBe(true);
    });

    it("counts an outbound row's starred_at toward the thread state", () => {
      // The operator can star a thread after sending a reply — the
      // outbound row carries the timestamp and it should still flip the
      // thread's chip.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          direction: "in",
          starred_at: null,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<myreply@example.com>",
          references: "<root@example.com>",
          direction: "out",
          starred_at: "2026-05-22T09:00:00.000Z",
        }),
      ];
      const out = groupIntoThreads(rows);
      expect(out[0]!.starred).toBe(true);
      expect(out[0]!.hasOutbound).toBe(true);
    });

    it("treats parse-failed singletons as unstarred (no starred_at to read)", () => {
      // Skeleton rows never carry starred_at; their thread must report
      // false so the Starred view doesn't surface failed parses.
      const rows: InboxRow[] = [
        failed("01H0000000000000000000A", "2026-05-20T10:00:00.000Z"),
      ];
      const out = groupIntoThreads(rows);
      expect(out).toHaveLength(1);
      expect(out[0]!.starred).toBe(false);
    });

    it("survives a partial-fanout state where only some rows carry starred_at", () => {
      // After star_thread, in the rare case where one row's conditional
      // check failed (race with a delete), the thread still reads as
      // starred — operator intent is at the thread level.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          starred_at: "2026-05-22T09:00:00.000Z",
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          starred_at: null,
        }),
      ];
      const out = groupIntoThreads(rows);
      expect(out[0]!.starred).toBe(true);
    });
  });

  // ADR-0029 (slice 8.11). Thread.snoozed is per-row AND of unexpired
  // snoozed_until — the wake-on-reply semantics fall out for free, since
  // a fresh inbound row arrives with snoozed_until=null. A thread of
  // skeletons-only is not snoozable.
  describe("Thread.snoozed aggregation (ADR-0029 / slice 8.11)", () => {
    const NOW = new Date("2026-05-22T10:00:00.000Z");
    const FUTURE_EARLY = "2026-05-22T18:00:00.000Z";
    const FUTURE_LATE = "2026-05-23T09:00:00.000Z";
    const PAST = "2026-05-22T09:00:00.000Z";

    it("returns false when no row carries snoozed_until", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(false);
      expect(out[0]!.snoozedUntil).toBeNull();
    });

    it("returns true when every row carries an unexpired snoozed_until — earliest wake wins", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          snoozed_until: FUTURE_LATE,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          snoozed_until: FUTURE_EARLY,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(true);
      expect(out[0]!.snoozedUntil).toBe(FUTURE_EARLY);
    });

    it("wake-on-reply: a single unstamped row wakes the conversation", () => {
      // Two rows snoozed; a fresh inbound reply lands with snoozed_until
      // null (the snooze fan-out happened before this row existed). The
      // thread must read as awake even though the older rows are still
      // stamped.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          snoozed_until: FUTURE_LATE,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          snoozed_until: FUTURE_LATE,
        }),
        row({
          internal_id: "01H0000000000000000000C",
          received_at: "2026-05-22T09:30:00.000Z",
          message_id: "<r2@example.com>",
          references: "<root@example.com>",
          snoozed_until: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(false);
      expect(out[0]!.snoozedUntil).toBeNull();
    });

    it("an expired snooze on any row counts as awake (already-fired wake)", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          snoozed_until: PAST,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          snoozed_until: FUTURE_LATE,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(false);
      expect(out[0]!.snoozedUntil).toBeNull();
    });

    it("an unparseable snoozed_until is treated as awake — corrupt row can't pin the thread", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          snoozed_until: "not a date",
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          snoozed_until: FUTURE_LATE,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(false);
    });

    it("an outbound row with snoozed_until=null also wakes the thread (operator replied)", () => {
      // The operator can reply to a snoozed thread. The send path produces
      // a fresh row with no snoozed_until — same wake-on-reply rule applies.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          direction: "in",
          snoozed_until: FUTURE_LATE,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<myreply@example.com>",
          references: "<root@example.com>",
          direction: "out",
          snoozed_until: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(false);
      expect(out[0]!.hasOutbound).toBe(true);
    });

    it("a parse-failed singleton thread reads as not snoozed (skeleton can't be snoozed)", () => {
      const rows: InboxRow[] = [
        failed("01H0000000000000000000A", "2026-05-20T10:00:00.000Z"),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.snoozed).toBe(false);
      expect(out[0]!.snoozedUntil).toBeNull();
    });
  });

  // ADR-0030 (slice 8.12). Thread.trashed is per-row AND of trashed_at —
  // wake-on-reply falls out for free, since a fresh inbound row arrives
  // with trashed_at=null and the every-row predicate short-circuits to
  // false. A thread of skeletons-only is not trashed.
  describe("Thread.trashed aggregation (ADR-0030 / slice 8.12)", () => {
    const NOW = new Date("2026-05-22T10:00:00.000Z");
    const STAMP_EARLY = "2026-05-22T09:00:00.000Z";
    const STAMP_LATE = "2026-05-22T09:30:00.000Z";

    it("returns false when no row carries trashed_at", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.trashed).toBe(false);
    });

    it("returns true when every row carries trashed_at", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          trashed_at: STAMP_EARLY,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          trashed_at: STAMP_LATE,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.trashed).toBe(true);
    });

    it("wake-on-reply: a single unstamped row resurfaces the thread (auto-untrash)", () => {
      // Two rows trashed; a fresh inbound reply lands without trashed_at
      // (the trash fan-out happened before this row existed). The thread
      // must read as not trashed even though older rows are stamped.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          trashed_at: STAMP_EARLY,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          trashed_at: STAMP_LATE,
        }),
        row({
          internal_id: "01H0000000000000000000C",
          received_at: "2026-05-22T09:30:00.000Z",
          message_id: "<r2@example.com>",
          references: "<root@example.com>",
          trashed_at: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.trashed).toBe(false);
    });

    it("an outbound row without trashed_at also resurfaces the thread (operator replied)", () => {
      // The operator can reply to a trashed thread (shouldn't happen via UI
      // since trash hides it, but the rule is symmetric with snooze). Send
      // produces a fresh row with no trashed_at — same wake-on-reply rule.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          direction: "in",
          trashed_at: STAMP_EARLY,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<myreply@example.com>",
          references: "<root@example.com>",
          direction: "out",
          trashed_at: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.trashed).toBe(false);
      expect(out[0]!.hasOutbound).toBe(true);
    });

    it("a parse-failed singleton thread reads as not trashed (skeleton can't be trashed)", () => {
      const rows: InboxRow[] = [
        failed("01H0000000000000000000A", "2026-05-20T10:00:00.000Z"),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.trashed).toBe(false);
    });

    it("survives a partial-fanout state where only some rows carry trashed_at (every-row predicate is strict)", () => {
      // After trash_thread, a phantom row's conditional check failed and
      // didn't get stamped. The thread must NOT read as trashed — that's
      // what protects wake-on-reply: any unstamped row → not trashed.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          trashed_at: STAMP_EARLY,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          trashed_at: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.trashed).toBe(false);
    });
  });

  // ADR-0034 (slice 8.16). Thread.archived mirrors Thread.trashed —
  // every-row AND of archived_at. Independent attribute (not reused
  // trashed_at), so a thread can be archived without being trashed and
  // vice versa. Wake-on-reply is identical to trash.
  describe("Thread.archived aggregation (ADR-0034 / slice 8.16)", () => {
    const NOW = new Date("2026-05-22T10:00:00.000Z");
    const STAMP_EARLY = "2026-05-22T09:00:00.000Z";
    const STAMP_LATE = "2026-05-22T09:30:00.000Z";

    it("returns false when no row carries archived_at", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.archived).toBe(false);
    });

    it("returns true when every row carries archived_at", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          archived_at: STAMP_EARLY,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          archived_at: STAMP_LATE,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.archived).toBe(true);
    });

    it("wake-on-reply: a single unstamped row resurfaces the thread (auto-unarchive)", () => {
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          archived_at: STAMP_EARLY,
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<r1@example.com>",
          references: "<root@example.com>",
          archived_at: STAMP_LATE,
        }),
        row({
          internal_id: "01H0000000000000000000C",
          received_at: "2026-05-22T09:30:00.000Z",
          message_id: "<r2@example.com>",
          references: "<root@example.com>",
          archived_at: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.archived).toBe(false);
    });

    it("a parse-failed singleton thread reads as not archived (skeleton can't be archived)", () => {
      const rows: InboxRow[] = [
        failed("01H0000000000000000000A", "2026-05-20T10:00:00.000Z"),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.archived).toBe(false);
    });

    it("archive and trash are independent attributes on the same thread", () => {
      // A thread can be archived without being trashed. The two predicates
      // share shape but read different stamps — verify they don't confuse.
      const rows: InboxRow[] = [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<root@example.com>",
          archived_at: STAMP_EARLY,
          trashed_at: null,
        }),
      ];
      const out = groupIntoThreads(rows, NOW);
      expect(out[0]!.archived).toBe(true);
      expect(out[0]!.trashed).toBe(false);
    });
  });
});

describe("mergeThreadRows (ADR-0027 / slice 8.9)", () => {
  function ok<T>(value: T): RpcResult<T> {
    return { kind: "ok", value };
  }

  it("returns the in-window rows unchanged when the fetch is undefined", () => {
    const inWindow = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
      }),
    ];
    expect(mergeThreadRows(inWindow, undefined)).toEqual(inWindow);
  });

  it("returns the in-window rows unchanged when the fetch errored", () => {
    const inWindow = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
      }),
    ];
    const fetched: RpcResult<ListThreadMessagesResult> = {
      kind: "error",
      code: "internal",
      message: "boom",
    };
    expect(mergeThreadRows(inWindow, fetched)).toEqual(inWindow);
  });

  it("unions in-window and fetched rows by internal_id, newest first", () => {
    const inWindow = [
      row({
        internal_id: "01H0000000000000000000C",
        received_at: "2026-05-20T12:00:00.000Z",
        message_id: "<c@example.com>",
      }),
    ];
    const fetched = ok<ListThreadMessagesResult>({
      messages: [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<a@example.com>",
        }),
        row({
          internal_id: "01H0000000000000000000B",
          received_at: "2026-05-20T11:00:00.000Z",
          message_id: "<b@example.com>",
        }),
      ],
      next_cursor: null,
    });
    const out = mergeThreadRows(inWindow, fetched);
    expect(out.map((r) => r.internal_id)).toEqual([
      "01H0000000000000000000C",
      "01H0000000000000000000B",
      "01H0000000000000000000A",
    ]);
  });

  it("dedupes by internal_id and prefers the in-window row (fresher read_at)", () => {
    // Same internal_id, but the in-window row has a more recent inbox-poll
    // read_at than the GSI snapshot.
    const inWindow = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@example.com>",
        read_at: "2026-05-21T09:00:00.000Z",
      }),
    ];
    const fetched = ok<ListThreadMessagesResult>({
      messages: [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<a@example.com>",
          read_at: null,
        }),
      ],
      next_cursor: null,
    });
    const out = mergeThreadRows(inWindow, fetched);
    expect(out).toHaveLength(1);
    expect(out[0]!.read_at).toBe("2026-05-21T09:00:00.000Z");
  });

  it("drops parse_status=failed rows from the fetched page (the merged stack only carries ok rows)", () => {
    const inWindow: InboxRowOk[] = [];
    const fetched = ok<ListThreadMessagesResult>({
      messages: [
        row({
          internal_id: "01H0000000000000000000A",
          received_at: "2026-05-20T10:00:00.000Z",
          message_id: "<a@example.com>",
        }),
        failed(
          "01H0000000000000000000FAIL",
          "2026-05-20T11:00:00.000Z",
        ),
      ],
      next_cursor: null,
    });
    const out = mergeThreadRows(inWindow, fetched);
    expect(out).toHaveLength(1);
    expect(out[0]!.internal_id).toBe("01H0000000000000000000A");
  });
});
