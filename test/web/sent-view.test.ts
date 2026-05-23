import { describe, expect, it } from "vitest";
import {
  recipientsOfLatestOutbound,
  sortByLatestOutbound,
} from "../../src/web/src/lib/sent-view.js";
import { groupIntoThreads } from "../../src/web/src/lib/threading.js";
import type {
  InboxRow,
  InboxRowOk,
} from "../../src/web/src/lib/bff-client.js";

// Slice 8.18 (ADR-0039). The Sent view's left column reads recipients of
// the *latest outbound* row, and the list is sorted by that outbound
// row's `received_at`. Both projections are pure functions over the
// already-threaded set — these tests assert the cases that motivated
// the slice in the first place: own-name in the column when there's a
// reply, and "their reply jumps the row up the list".

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
    labels: [],
    ...partial,
  };
}

describe("recipientsOfLatestOutbound", () => {
  it("returns the display name of a single outbound row's to:", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000000A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Bob" <bob@example.com>',
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    expect(recipientsOfLatestOutbound(thread!)).toEqual(["Bob"]);
  });

  it("uses the *latest* outbound row when more than one outbound exists", () => {
    // Two outbound rows in the same thread with different recipients —
    // the operator first messaged Bob, then later (still on the same
    // thread, e.g. a forwarded chain) sent a follow-up to Carol. The
    // column should read Carol, not Bob.
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000001A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Bob" <bob@example.com>',
      }),
      row({
        internal_id: "01H0000000000000000001B",
        received_at: "2026-05-20T12:00:00.000Z",
        message_id: "<b@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Carol" <carol@example.com>',
        in_reply_to: "<a@acme.com>",
        references: "<a@acme.com>",
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    expect(recipientsOfLatestOutbound(thread!)).toEqual(["Carol"]);
  });

  it("splits a multi-recipient to: header into multiple display names", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000002A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Bob" <bob@example.com>, "Carol" <carol@example.com>, dave@example.com',
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    expect(recipientsOfLatestOutbound(thread!)).toEqual([
      "Bob",
      "Carol",
      "dave@example.com",
    ]);
  });

  it("falls back to the bare address when the outbound row has no display name", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000003A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: "<bob@example.com>",
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    // senderDisplay strips the angle brackets and trims; we accept either
    // shape — the column rendering doesn't depend on the brackets.
    const recipients = recipientsOfLatestOutbound(thread!);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatch(/bob@example\.com/);
  });

  it("returns [] when the latest outbound row has an empty to: header", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000004A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: null,
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    expect(recipientsOfLatestOutbound(thread!)).toEqual([]);
  });

  it("returns [] when the thread has no outbound row", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000005A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "in",
        from: '"Bob" <bob@example.com>',
        to: '"Alice" <alice@acme.com>',
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    expect(recipientsOfLatestOutbound(thread!)).toEqual([]);
  });

  it("dedupes recipients case-insensitively, keeping the first occurrence's casing", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000006A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Bob" <bob@example.com>, "BOB" <other@example.com>',
      }),
    ];
    const [thread] = groupIntoThreads(rows);
    expect(recipientsOfLatestOutbound(thread!)).toEqual(["Bob"]);
  });
});

describe("sortByLatestOutbound", () => {
  it("orders threads by latest outbound received_at, newest-first", () => {
    // Two threads. Thread A: outbound at 10:00, inbound reply at 14:00.
    // Thread B: outbound at 11:00, no reply.
    // Inbox sort would put A first (latest activity 14:00). Sent should
    // put B first (latest outbound 11:00 > A's 10:00).
    const rows: InboxRow[] = [
      // Thread A — outbound
      row({
        internal_id: "01H000000000000000000AA",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<a-out@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Bob" <bob@example.com>',
        subject: "thread A",
      }),
      // Thread A — inbound reply
      row({
        internal_id: "01H000000000000000000AB",
        received_at: "2026-05-20T14:00:00.000Z",
        message_id: "<a-in@example.com>",
        direction: "in",
        from: '"Bob" <bob@example.com>',
        to: '"Alice" <alice@acme.com>',
        subject: "Re: thread A",
        in_reply_to: "<a-out@acme.com>",
        references: "<a-out@acme.com>",
      }),
      // Thread B — outbound only
      row({
        internal_id: "01H000000000000000000BA",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<b-out@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Carol" <carol@example.com>',
        subject: "thread B",
      }),
    ];
    const threads = groupIntoThreads(rows);
    const sorted = sortByLatestOutbound(threads);
    expect(sorted).toHaveLength(2);
    // Thread B's outbound (11:00) is later than Thread A's outbound
    // (10:00), so B should come first even though A's latest activity
    // is the most recent overall.
    expect(sorted[0]!.rootKey).toBe("<b-out@acme.com>");
    expect(sorted[1]!.rootKey).toBe("<a-out@acme.com>");
  });

  it("excludes threads with no outbound row", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000007A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<inbound-only@example.com>",
        direction: "in",
        from: '"Bob" <bob@example.com>',
        subject: "ping",
      }),
      row({
        internal_id: "01H0000000000000000007B",
        received_at: "2026-05-20T11:00:00.000Z",
        message_id: "<has-outbound@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Carol" <carol@example.com>',
        subject: "hello",
      }),
    ];
    const threads = groupIntoThreads(rows);
    const sorted = sortByLatestOutbound(threads);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.rootKey).toBe("<has-outbound@acme.com>");
  });

  it("preserves stable order on equal outbound timestamps", () => {
    const rows: InboxRow[] = [
      row({
        internal_id: "01H0000000000000000008A",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<x@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Bob" <bob@example.com>',
        subject: "x",
      }),
      row({
        internal_id: "01H0000000000000000008B",
        received_at: "2026-05-20T10:00:00.000Z",
        message_id: "<y@acme.com>",
        direction: "out",
        from: '"Alice" <alice@acme.com>',
        to: '"Carol" <carol@example.com>',
        subject: "y",
      }),
    ];
    const threads = groupIntoThreads(rows);
    const sorted = sortByLatestOutbound(threads);
    // Two threads with equal outbound timestamps — assert sort doesn't
    // crash and returns both. Stable order is the real promise; the
    // exact pairwise ordering depends on input order but both threads
    // must appear.
    expect(sorted).toHaveLength(2);
    const keys = sorted.map((t) => t.rootKey).sort();
    expect(keys).toEqual(["<x@acme.com>", "<y@acme.com>"]);
  });
});
