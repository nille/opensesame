import StarterKit from "@tiptap/starter-kit";

// ADR-0042 (slice 8.21). The editor's closed mark/node policy lives
// here so the unit test can build a headless Editor with the same
// extensions the component renders. Six toolbar controls (B / I / link
// / 1. / • / quote) plus the implicit paragraph + text nodes; anything
// else is disabled or stripped on paste.

// Closed mark/node policy — the toolbar's six controls plus the
// implicit `paragraph` and `text` nodes. Anything outside this set is
// dropped at paste through TipTap's schema normalization. StarterKit v3
// already ships Link, so we configure it here rather than registering a
// second copy.
export function makeStarterKit(): ReturnType<typeof StarterKit.configure> {
  return StarterKit.configure({
    heading: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    underline: false,
    hardBreak: { keepMarks: false },
    dropcursor: false,
    trailingNode: false,
    link: {
      openOnClick: false,
      autolink: true,
      HTMLAttributes: {
        rel: "noopener noreferrer",
        target: "_blank",
      },
      protocols: ["http", "https", "mailto", "tel"],
    },
  });
}

// True when the document contains no marks, lists, or blockquotes — i.e.
// the recipient would see the same thing as the auto-derived plain-text.
// The composer uses this to skip body_html on send so trivial mail
// doesn't grow a multipart/alternative wrapper.
export function isStructurallyTrivial(html: string): boolean {
  if (html.length === 0) return true;
  // Only paragraphs + line breaks, no marks, no list/quote nodes.
  const stripped = html.replace(/<\/?(p|br)\s*\/?>/gi, "");
  return !/<[a-z]/i.test(stripped);
}
