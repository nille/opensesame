import { describe, expect, it } from "vitest";
import { computeRange } from "../../src/web/src/lib/selection.js";
import type { Thread } from "../../src/web/src/lib/threading.js";

// ADR-0032 (slice 8.14). Pure helper unit tests for the bulk-select
// range walk. The helper is the only place where view-order index math
// lives, so we test it directly and let the rest of the bulk pipeline
// (App.tsx state + bff fan-out) be covered by integration / manual.

function thread(rootKey: string): Thread {
  // Minimal Thread shape — computeRange only reads `rootKey`, so the
  // rest can be skeletal. Keep this in sync with threading.ts if the
  // helper grows new dependencies.
  return {
    rootKey,
    rows: [],
    failedRows: [],
    latestReceivedAt: "2026-05-22T00:00:00.000Z",
    senders: [],
    unread: false,
    hasOutbound: false,
    starred: false,
    snoozedUntil: null,
    trashed: false,
    count: 0,
  };
}

const T = [
  thread("<a@x>"),
  thread("<b@x>"),
  thread("<c@x>"),
  thread("subj:2026-05:foo"), // subject-fallback rollup, must be skipped
  thread("<d@x>"),
  thread("<e@x>"),
];

describe("computeRange", () => {
  it("returns a single key when anchor and target are the same row", () => {
    expect(computeRange(T, "<b@x>", "<b@x>")).toEqual(["<b@x>"]);
  });

  it("walks forward from anchor to target inclusive", () => {
    expect(computeRange(T, "<a@x>", "<c@x>")).toEqual([
      "<a@x>",
      "<b@x>",
      "<c@x>",
    ]);
  });

  it("walks backward from anchor to target inclusive (range is order-free)", () => {
    expect(computeRange(T, "<c@x>", "<a@x>")).toEqual([
      "<a@x>",
      "<b@x>",
      "<c@x>",
    ]);
  });

  it("skips subject-fallback rollups inside the range", () => {
    // <a@x> .. <e@x> spans the rollup at index 3 — it must be silently
    // dropped, same gate as the per-thread annotation buttons.
    expect(computeRange(T, "<a@x>", "<e@x>")).toEqual([
      "<a@x>",
      "<b@x>",
      "<c@x>",
      "<d@x>",
      "<e@x>",
    ]);
  });

  it("returns empty when anchor is missing from the view", () => {
    expect(computeRange(T, "<missing@x>", "<b@x>")).toEqual([]);
  });

  it("returns empty when target is missing from the view", () => {
    expect(computeRange(T, "<a@x>", "<missing@x>")).toEqual([]);
  });

  it("returns empty when both anchor and target are missing", () => {
    expect(computeRange(T, "<x@x>", "<y@x>")).toEqual([]);
  });

  it("returns empty for an empty thread list", () => {
    expect(computeRange([], "<a@x>", "<b@x>")).toEqual([]);
  });

  it("does not include rollups even when they are the anchor or target", () => {
    // Subject-fallback rootKey is the anchor — findIndex still locates
    // it, but it's filtered out of the walk. Range is the surrounding
    // threadable rows only.
    expect(computeRange(T, "subj:2026-05:foo", "<e@x>")).toEqual([
      "<d@x>",
      "<e@x>",
    ]);
  });
});
