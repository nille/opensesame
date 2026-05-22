import { describe, expect, it } from "vitest";
import {
  groupIntoThreads,
  mergeThreadRows,
} from "../../src/web/src/lib/threading.js";
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
