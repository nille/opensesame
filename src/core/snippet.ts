// Snippet: short single-line preview of body_text that the writer persists
// on the Messages row so read_inbox returns metadata + snippet in one Query
// (ADR-0007 + ADR-0013).
//
// Budget is in *codepoints*, not bytes — agents read characters, and a
// byte-budget would cut Swedish text mid-sequence. Whitespace runs (incl.
// newlines and tabs) collapse to single spaces so the snippet is one tight
// line; UI/agents that want layout will assemble it from body_text.

const DEFAULT_BUDGET = 200;
const ELLIPSIS = "…";

export function makeSnippet(text: string, budget: number = DEFAULT_BUDGET): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";

  // Iterate codepoints (not chars/units) so the boundary is never mid-surrogate.
  // We can't index into a JS string by codepoint cheaply; spread into an array.
  const codepoints = [...collapsed];
  if (codepoints.length <= budget) return collapsed;

  // Reserve one codepoint for the ellipsis.
  const sliced = codepoints.slice(0, budget - 1).join("");
  return sliced + ELLIPSIS;
}
