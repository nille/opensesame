import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { sanitizeForReader } from "../lib/html-sanitize.ts";

// ADR-0042 (slice 8.21). Renders sanitized message HTML inside an open
// shadow root so the email's CSS can't bleed into the host app and the
// host's CSS doesn't override the email's intended look. Remote images
// are blocked by default and surfaced via a "load images" strip the
// operator clicks once per message-open. cid: and data:image/... images
// render eagerly because they're either already in S3 (inline) or
// inert.
//
// The sanitize policy lives in ../lib/html-sanitize.ts so it can be unit
// tested without React or JSX.

interface HtmlBodyProps {
  html: string;
}

const SHADOW_BASE_CSS = `
:host {
  display: block;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--t-lg);
  line-height: var(--lh-prose);
  word-wrap: break-word;
}
* { max-width: 100%; box-sizing: border-box; }
img { max-width: 100%; height: auto; }
a { color: var(--accent); text-decoration: underline; }
a:hover { text-decoration: none; }
blockquote {
  margin: 0 0 1em;
  padding-left: 1rem;
  border-left: 2px solid var(--rule);
  color: var(--ink-muted);
}
p, ul, ol, blockquote, pre { margin: 0 0 1em; }
ul, ol { padding-left: 1.5rem; }
pre, code, kbd, samp {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
pre {
  white-space: pre-wrap;
  background: var(--paper-2);
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
code { background: var(--paper-2); padding: 0 0.25rem; border-radius: 2px; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 1em 0; }
table {
  border-collapse: collapse;
  margin: 0 0 1em;
}
th, td {
  padding: 4px 8px;
  border: 1px solid var(--rule);
  text-align: left;
  vertical-align: top;
}
[data-os-remote-img] {
  display: inline-block;
  padding: 1px 6px;
  border: 1px dashed var(--rule-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-faint);
  font-family: var(--font-mono);
  font-size: var(--t-mono-sm);
}
`;

export function HtmlBody({ html }: HtmlBodyProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Re-sanitize on every prop change (rare — one per message open) and
  // on the loaded toggle. The remote count is what the strip displays.
  const sanitized = useMemo(
    () => sanitizeForReader(html, loaded),
    [html, loaded],
  );

  const mount = useCallback(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (shadowRef.current === null) {
      shadowRef.current = host.attachShadow({ mode: "open" });
    }
    const root = shadowRef.current;
    // Single string write — innerHTML inside a shadow root is safe because
    // the input is post-DOMPurify and our schema is closed.
    root.innerHTML = `<style>${SHADOW_BASE_CSS}</style>${sanitized.html}`;
  }, [sanitized.html]);

  useEffect(() => {
    mount();
  }, [mount]);

  const blockedCount = loaded ? 0 : sanitized.remoteCount;

  return (
    <div className="reader__html">
      {sanitized.remoteCount > 0 ? (
        <div className="reader__html-blocked mono" role="status">
          {loaded ? (
            <span className="faint">remote images loaded</span>
          ) : (
            <>
              <span className="faint">
                · remote images blocked · {blockedCount} ·
              </span>
              <button
                type="button"
                className="reader__html-blocked-btn"
                onClick={() => setLoaded(true)}
              >
                load
              </button>
            </>
          )}
        </div>
      ) : null}
      <div ref={hostRef} className="reader__html-isolate" />
    </div>
  );
}
