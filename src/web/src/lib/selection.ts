// ADR-0032 (slice 8.14). Bulk multi-select range computation. Pure
// helper, kept out of App.tsx so we can unit-test the index walk
// without rendering React. The `threads` argument is the inbox view's
// current ordering — view switches and search transitions clear the
// selection so the anchor is always meaningful relative to whatever
// list is on screen.

import type { Thread } from "./threading.ts";

// Inclusive range from anchor to target in current view order. Returns
// [] when either rootKey is missing from the view; the caller falls
// back to a plain toggle in that case.
export function computeRange(
  threads: readonly Thread[],
  anchorRootKey: string,
  targetRootKey: string,
): readonly string[] {
  const anchorIdx = threads.findIndex((t) => t.rootKey === anchorRootKey);
  const targetIdx = threads.findIndex((t) => t.rootKey === targetRootKey);
  if (anchorIdx === -1 || targetIdx === -1) return [];
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  const out: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const t = threads[i];
    // Subject-fallback rollups can't be selected — same gate as the
    // per-thread annotation buttons. Range expansion silently skips
    // them rather than including them and producing confusing
    // disabled-checkbox state.
    if (t !== undefined && t.rootKey.startsWith("<")) {
      out.push(t.rootKey);
    }
  }
  return out;
}
