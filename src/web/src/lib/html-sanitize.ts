/// <reference lib="dom" />
import DOMPurify from "dompurify";

// ADR-0042 (slice 8.21). Pure HTML sanitizer for the reader pane. Lives
// in /lib/ (not the .tsx component) so it can be unit-tested without
// React or JSX, while the HtmlBody component just imports + renders the
// result inside its shadow root.

const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "cite",
  "code",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

const ALLOWED_ATTR = [
  "href",
  "title",
  "alt",
  "src",
  "width",
  "height",
  "colspan",
  "rowspan",
  "align",
  "valign",
  "lang",
  "dir",
];

// Schemes that survive sanitization. javascript:, vbscript:, file:, ftp:
// fall outside this list and are dropped by DOMPurify when ALLOWED_URI_REGEXP
// matches against href/src.
const SAFE_URL_RE =
  /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i;

export const REMOTE_IMG_PLACEHOLDER = "data-os-remote-img";

export interface SanitizedDoc {
  html: string;
  remoteCount: number;
}

// Pure: turns raw HTML into the (sanitized + image-rewritten) HTML that
// gets injected into the shadow root. When `loadRemote === false`, remote
// `<img>` tags are replaced with a placeholder element; the original src
// is preserved on a data attribute so the same input produces the loaded
// variant on re-render.
export function sanitizeForReader(
  html: string,
  loadRemote: boolean,
): SanitizedDoc {
  let remoteCount = 0;

  // Hook fires for every element after default sanitization. We use it
  // to rewrite remote images and to harden anchors.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();

    if (tag === "a") {
      // Open in a new tab; never reach back to the host via window.opener.
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      const href = node.getAttribute("href") ?? "";
      if (href.length > 0 && !SAFE_URL_RE.test(href)) {
        node.removeAttribute("href");
      }
      return;
    }

    if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      const isInline = src.startsWith("cid:") || src.startsWith("data:image/");
      if (isInline) return;
      if (!SAFE_URL_RE.test(src)) {
        node.removeAttribute("src");
        return;
      }
      remoteCount += 1;
      if (loadRemote) return;
      // Hook the placeholder via a data attribute (which survives the
      // DOMPurify allow-list); the shadow CSS targets `[data-os-remote-img]`.
      const ph = node.ownerDocument!.createElement("span");
      ph.setAttribute(REMOTE_IMG_PLACEHOLDER, src);
      const alt = node.getAttribute("alt");
      if (alt !== null && alt.length > 0) ph.setAttribute("title", alt);
      ph.textContent = alt && alt.length > 0 ? alt : "remote image";
      node.parentNode?.replaceChild(ph, node);
    }
  });

  const cleaned = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_URL_RE,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base"],
    FORBID_ATTR: ["style", "srcset"],
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as string;

  DOMPurify.removeAllHooks();

  return { html: cleaned, remoteCount };
}
