# Rich text reading + composing, slice 8.21

For 20 slices Open Sesame's webmail has rendered every body as
`text/plain`. That was deliberate (DESIGN.md: "Sandboxed HTML lands
when we trust the parser more") and aligned with the operator-grade
positioning: triage-fast reading, terminal-comfort composing, no
Word-toolbar feature density. Two pressures push us off that
position now:

1. **Most non-personal mail is HTML-only.** Marketing, transactional,
   even ordinary calendar invites ship a `multipart/alternative` with
   a stub `text/plain` ("View this email in your browser") and the
   real content in `text/html`. The text-only reader degrades these
   to a wall of >quoted markup or a one-line link. The operator's
   triage time is spent on senders who actually wrote prose; the
   marketing flotsam wastes it disproportionately.
2. **Replies want emphasis.** A long-form reply that wants `**bold**`
   or `> quote` or `[link](url)` either shows up as literal asterisks
   on the recipient's side, or ships only `text/plain` and the
   recipient's HTML-first client renders it without any structure.
   Composing rich-text isn't about decoration; it's about not
   stripping signal that the recipient's client expects.

This slice adds **reading** and **writing** rich text together,
deliberately scoped:

- **Reading**: when a received message has a `text/html` part, render
  it in the reader pane instead of the text/plain fallback.
  Sanitize aggressively, isolate via shadow DOM, block remote images
  by default. Provide `view source` to drop to text/plain.
- **Writing**: replace the composer's `<textarea>` with a TipTap
  editor wired to a six-control mono-labeled toolbar (`B / I / link
  / 1. / • / "`). Output `multipart/alternative` with both parts.
  Closed list of marks/nodes; the toolbar is the spec.

The constraints of the operator-grade positioning hold: no font
picker, no color picker, no alignment, no image-in-body, no slash
commands, no AI assistant. PRODUCT.md and DESIGN.md were updated
ahead of this slice to reflect the new posture explicitly: rich
text exists, but minimally.

## Decision

### Reading: re-parse from raw S3 on read

The MIME parser already extracts `bodyHtml` (parser.ts:196).
The storage layer never persisted it (store.ts:69 comment from slice 3:
"bodyHtml and attachments are absent today"). Two paths to fix:

| Option | Cost |
|---|---|
| Chunk `body_html` alongside `body_text` in DynamoDB | New table or new chunk_kind, write-side migration, schema_v bump. Touches 6+ files. |
| Re-parse from raw S3 on read | The raw MIME is already in S3 with `raw_s3_uri` on every row. Read-side fetches the raw, re-parses, returns `body_html`. Zero storage migration. ~1 extra S3 GET per `get_message` (cached at the CDN/region; raw is typically <100KB). |

We pick **re-parse on read**. Storage is the long-term shape; reads
are cheap to optimize later if latency budgets pinch. The ~30ms
extra on `get_message` is acceptable for the operator workload
(reads are interactive, not batched, and one-at-a-time).

The BFF's `handleGetMessage` becomes:

1. Resolve the row from DDB (existing, gives us `body_text`,
   metadata, attachments, **and** `raw_s3_uri`).
2. If the row's stored `parse_status === "ok"` and the request
   doesn't opt out, fetch `raw_s3_uri` and run `parseMime`. Take
   `parsed.bodyHtml` and pass it through.
3. The response shape gains `body_html: string | null`. null means
   "no HTML part in this message"; the reader falls back to
   `body_text`.

The re-parse is best-effort: if S3 fetch fails or the parser throws,
log and return `body_html: null`. The text-only render still works.

### Reading: shadow DOM + DOMPurify + remote-image block

Three threats with HTML mail:

1. **CSS pollution** — email `<style>` rules with broad selectors
   (`* { font: ... }`) bleed into the host app.
2. **Script execution** — `<script>`, inline `onclick`, `javascript:`
   URLs, `<iframe>` running cross-origin code.
3. **Tracking** — `<img src="https://tracker.example.com/pixel?id=...">`
   firing on render, before the operator chose to engage with the
   sender.

The defense-in-depth:

```
sanitize (DOMPurify) → mount in shadow root → host CSS reset → render
```

**DOMPurify** is the standard. Vetted, ~22KB gzipped, no native
dependencies. The sanitizer config:

- Drop: `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
  `<input>`, `<button>`, `<link>`, `<meta>`, `<base>`
- Drop attributes: all `on*` event handlers, `style` references to
  `url(...)`, `srcset` with remote URLs (block-pass treatment)
- URL schemes: keep `https:`, `mailto:`, `cid:`, `tel:`. Drop
  `javascript:`, `data:` (except `data:image/...`).
- Replace remote `<img>` with a stub element + counter (see
  "remote images" below).

**Shadow DOM** (open mode) hosts the sanitized HTML. The shadow
boundary stops external CSS from reaching either direction:

- Email's `<style>` and `<link rel="stylesheet">` are dropped by
  the sanitizer, but defense-in-depth means even if one slipped
  through, it would only style content inside the shadow.
- Host page's `app.css` doesn't bleed into email content, so an
  email styled with `font-family: Arial` doesn't get overridden by
  the host's `--font-sans`. The email looks like *itself*.

We pick open mode (not closed) because:
- We need to programmatically `attachShadow({ mode: "open" })` and
  re-mount on prop change (the React component owns the DOM ref).
- Closed mode prevents `element.shadowRoot` from being readable,
  which complicates re-render. The threat model isn't "host code
  reading the email's DOM" — that's our own code.

The `:host` selector establishes baseline tokens inside the shadow
so the email feels like the host page until its own styling
overrides:

```css
:host {
  display: block;
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: var(--t-lg);
  line-height: 1.6;
}
* { max-width: 100%; }
img { max-width: 100%; height: auto; }
a { color: var(--accent); text-decoration: underline; }
blockquote { border-left: 2px solid var(--rule); padding-left: 1rem; }
```

Custom properties cross the shadow boundary by inheritance, so
`--ink`, `--accent`, etc. resolve correctly when day/night flips.

### Reading: remote images blocked, per-message reload

The default `DOMPurify` config keeps `<img>`. We **post-process**
after sanitization:

1. Find every `<img>` in the sanitized DOM.
2. If `src` is `cid:...`, leave it (inline images already in S3 via
   the attachment writer; resolved via `get_attachment`).
3. If `src` is `data:image/...` (small inline base64), leave it.
4. Otherwise (remote `https:` or any other scheme): replace with
   a placeholder `<span class="img-blocked">` and increment a
   counter. Stash the original `<img>` HTML in a hidden attribute
   so a "load remote images" click can swap it back in.

A strip above the body shows the count: `· remote images blocked
· load (N) ·`. Click flips a `loaded` flag on the component;
`useEffect` re-renders the shadow with the originals restored.

The "load" gesture is **per-message**, not per-sender. No
"always allow this sender" persistence. The operator gestures
once per message, and the resulting browser caches the images
(so re-opening the same message later via the back button doesn't
re-block). This is the simplest behavior that defeats tracking
pixels on the open without inventing a sender allow-list system.

`cid:` images render eagerly because they're already in S3 via
the existing attachment writer; loading them doesn't reach the
external network.

### Reading: view source toggle

A small `view source` link sits in the metadata block next to
`message-id`. Clicking it flips a state — the reader renders the
text/plain body in the existing pre-styled box and the HTML view
disappears. Click again, HTML returns. No persistence; per-open.

This is the escape hatch for messages where the HTML render is
broken or the operator wants to debug the raw text part.

### Writing: TipTap, six controls, mono labels

The composer's `<textarea>` is replaced with a TipTap editor.
Why TipTap:

- **Schema-first.** TipTap (ProseMirror under the hood) requires us
  to declare every mark and node. There's no "the user pasted
  Word HTML and got a `<font>` tag" — paste goes through the
  schema, which only knows about `bold`, `italic`, `link`,
  `bulletList`, `orderedList`, `blockquote`, `paragraph`, `text`.
  Anything else is normalized away. This **is** the closed-list
  policy at the implementation layer.
- **Small.** Core ~30KB gzipped, six extensions ~5KB more. Cheaper
  than Lexical (~80KB+) or hand-rolling contenteditable paste
  handling.
- **Used at scale.** Linear, GitLab, Notion-class clients all use
  ProseMirror; battle-tested across browsers and IME systems.

The toolbar extends the existing composer chrome (above the body
textarea). One row, mono glyphs as labels, six positions:

```
B  I  link  1.  •  "
```

- `B` → bold (⌘B)
- `I` → italic (⌘I)
- `link` → toggle link (⌘K opens an inline prompt)
- `1.` → ordered list
- `•` → unordered list
- `"` → blockquote

State vocabulary follows the existing button vocab:

| State | Treatment |
|---|---|
| inactive | `--ink-muted`, transparent border |
| hover | `--ink`, `--rule` border |
| active (caret in formatted text) | `--accent`, `--accent` border |
| focus-visible | `--accent` border + 2px outset shadow |
| disabled (e.g. blockquote inside list) | `--ink-faint`, no border |

Tooltips on hover surface the keybind. The `?` cheat sheet gets
two new lines for `⌘B` / `⌘I` and a note that `⌘K` opens the
link prompt.

The toolbar is a render of TipTap's editor state via
`useEditorState`. No imperative DOM manipulation. The toolbar's
buttons call `editor.chain().focus().toggleBold().run()` etc.

### Writing: HTML output → multipart/alternative

The composer maintains two values:

- `bodyHtml` — TipTap's `editor.getHTML()`, the full document
  serialized with our six marks/nodes.
- `bodyText` — auto-derived from the same editor state via
  `editor.getText({ blockSeparator: "\n\n" })`. Lists become
  `1. ` / `- ` prefixed lines; blockquote becomes `> ` prefixed.
  Bold/italic shed their formatting (no `**`/`*` markdown
  insertion — the recipient's plain-text view should look natural,
  not markdown source).

On send, both go to the BFF as `body_text` (existing) plus
`body_html` (existing schema field, plumbed since slice 8.17 for
the reply path but never exercised from the composer until now).

The composer.ts core already handles `body_html` and emits
multipart/alternative. We don't touch core or BFF schemas — only
the composer UI populates `body_html` now.

### Writing: drafts, reply, plain-text fallback

Drafts gain a `body_html` field on the wire schema. When resuming a
draft that has both, TipTap loads the HTML (its `setContent`
handles our schema). Drafts that only have `body_text` (older
ones, including all drafts to date) load into TipTap as
plain-text paragraphs and the operator decides whether to add
formatting.

Replies built via `replyToEmail` already accept `body_html` per
ADR-0035. The reply path passes the operator's TipTap output
through unchanged; the quoted parent body is appended as
text/plain only (per ADR-0035 §"v1 always plain text"). A future
slice may render rich quoted blocks; this slice doesn't.

When the operator types into TipTap but the resulting `bodyHtml`
is structurally identical to its plain-text counterpart (no marks,
no list, no quote), the composer skips the `body_html` field on
send. This avoids needlessly multipart-ing trivial mail.

### Where it lives

| Layer | Files | Notes |
|---|---|---|
| BFF read path | `src/bff/dispatcher.ts`, `src/aws/s3-raw-store.ts` | `handleGetMessage` re-parses raw on success; fail-open to `body_html: null` |
| Wire schema | `src/core/store.ts` | `ReadMessageOk.body_html: string \| null` (tail-add, no migration) |
| Reader pane | `src/web/src/components/Reader.tsx`, new `HtmlBody.tsx` | Shadow root mount, DOMPurify, image post-process |
| Composer | `src/web/src/components/Composer.tsx`, new `RichEditor.tsx` | TipTap + toolbar |
| CSS | `src/web/src/components/app.css` | Toolbar rules, blocked-images strip, html-isolate host |
| Cheat sheet | `src/web/src/components/HelpOverlay.tsx` | Add ⌘B / ⌘I / ⌘K rows |
| Tests | `test/bff-get-message-html.test.ts`, `test/web/html-sanitize.test.ts` | Re-parse path, sanitizer policy |

### Failure modes

| Case | Outcome |
|---|---|
| S3 fetch for raw fails (network, missing object) | `body_html: null`, log warning, text/plain renders normally |
| Re-parse throws (corrupt MIME) | Same as above |
| HTML body is empty after sanitization (everything stripped) | `body_html: null` returned; reader falls back to text/plain |
| HTML body has `<style>` / external font | Stripped by sanitizer policy |
| Email styles itself with absolute pixel widths | The host card's `max-width: 68ch` clamps the layout box; `* { max-width: 100% }` inside the shadow prevents horizontal scroll |
| Operator pastes Word HTML into the composer | TipTap's schema normalizes it; only the closed mark/node set survives |
| Operator pastes a screenshot into the composer | TipTap drops images on paste (no `Image` extension loaded); a chip appears via the existing attachment path if dragged onto the chip strip |
| Recipient mail client renders text/plain only | The auto-derived plain-text version is what they see; no asterisks for bold |
| Reduced-motion user | No animations on the toolbar buttons or shadow mount; existing prefers-reduced-motion handling already covers the composer |
| TipTap fails to instantiate (unlikely; library bug) | Composer falls back to a plain `<textarea>` with the existing behavior; banner notes "rich text unavailable" |

### What we're not doing

- **No "always show images for sender X" allow-list.** Per-message
  load is the entire UX. Persistence opens design questions
  (per-account? per-installation? syncs?) that aren't this slice.
- **No CSP changes.** The shadow root + sanitizer is the policy.
  We don't tighten host-page CSP just because some emails have
  remote `https:` images; those become explicit clicks instead.
- **No image upload to body.** Composer attachments stay on the
  chip strip (slice 8.19). Inline `<img>` paste is dropped.
- **No font / size / color / alignment / indent / table / emoji
  picker / GIF picker / slash command / AI assistant.** The
  toolbar is the closed list.
- **No rich-text quoted reply.** The quoted parent body in a reply
  is text/plain (per ADR-0035). The operator's reply prose is
  rich-text; the quote isn't.
- **No view-source-but-pretty.** `view source` shows the
  `text/plain` part as it already renders. No syntax highlighting,
  no header dump. Use `raw_s3_uri` for the full RFC 5322 bytes.
- **No tracking-pixel allow list.** A blocked image is blocked,
  and once loaded it's loaded for the open. No memory.
- **No HTML body on outbound when nothing's formatted.** The
  composer omits `body_html` if the editor's serialization is
  structurally trivial — saves a multipart/alternative wrapper
  for plain replies.

## Implementation

1. **`src/core/store.ts`** — extend `ReadMessageOk` with
   `body_html: string | null`. Tail-add to the projection; existing
   readers see the new field as optional in the wire shape.
2. **`src/bff/dispatcher.ts`** — `handleGetMessage` calls into a
   new `tryRehydrateHtml(raw_s3_uri)` helper that fetches the raw
   and re-parses. Wires `body_html` onto the response. Fail-open.
3. **`src/aws/s3-raw-store.ts`** — already has `getRawMime` (or
   adds one if missing) so the BFF can fetch raw bytes by URI.
4. **`src/web/src/components/Reader.tsx`** — when `body_html` is
   present and `view source` isn't toggled on, render
   `<HtmlBody html={msg.body_html} />` in place of the text-only
   `<pre>` body. Otherwise text-only.
5. **`src/web/src/components/HtmlBody.tsx`** — new file. Sanitizes
   via DOMPurify, post-processes images, mounts in shadow root,
   exposes `loaded` state for the "load remote images" gesture.
6. **`src/web/src/components/Composer.tsx`** — replaces the body
   `<textarea>` with `<RichEditor />`. Tracks both `bodyText` and
   `bodyHtml`, sends both.
7. **`src/web/src/components/RichEditor.tsx`** — new file. TipTap
   StarterKit minus extensions we don't allow + Link extension.
   Toolbar in same component (≤200 lines).
8. **`src/web/src/components/app.css`** — toolbar rules,
   `.reader__html-isolate`, `.reader__html-blocked` strip rules.
9. **`src/web/src/components/HelpOverlay.tsx`** — three new rows:
   `⌘B` bold, `⌘I` italic, `⌘K` add link. Plain-text shorthand
   `**bold** *italic*` is **not** a feature; the modal documents
   only what works.
10. **Dependencies** — add `dompurify`, `@tiptap/core`,
    `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`.
    Bundle delta: ~60KB gzipped (DOMPurify ~22, TipTap core ~30,
    extensions ~8). The web budget is 300KB; current gzipped JS
    is 89KB; we land ~150KB total.
11. **Tests**
    - `test/bff-get-message-html.test.ts` — re-parse path returns
      body_html when the raw has a text/html part; null when
      parser throws; null when the part is missing.
    - `test/web/html-sanitize.test.ts` — sanitizer drops
      `<script>`, inline `onclick`, `javascript:`/`data:` URLs,
      `<iframe>`; keeps `https:`/`mailto:`/`cid:`; strips remote
      images and counts them.
    - `test/web/rich-editor.test.ts` — TipTap → getHTML / getText
      round-trip for each toolbar control. Headless DOM via
      jsdom (new test-time dep).

## Considered and rejected

- **Iframe sandbox instead of shadow root.** Iframes are stricter
  isolation (cross-origin if we set the right src), but bring
  cross-origin paperwork (postMessage to bridge events,
  ResizeObserver to autosize, no inheritance of CSS variables).
  Shadow DOM is the right tool: same isolation goals, lighter.
- **Lexical / Slate / hand-rolled contenteditable.** TipTap's
  ProseMirror schema is the killer feature for the closed mark/
  node policy; the alternatives all let bad paste through more
  easily. Lexical is heavier; Slate has known cross-browser
  flakiness; hand-rolled means writing our own paste sanitizer.
- **Markdown shorthand instead of TipTap.** "Operator types `**bold**`,
  we transform on send." The user asked for a toolbar — and
  toolbars + markdown shorthand fight (which is the source of
  truth?). Reject the half-measure.
- **Per-sender remote-images allow-list.** Real persistence
  question: where does the list live (DDB? local storage?), how
  is it surfaced (inline? settings?), what about list-id
  matching for marketing senders? Not this slice.
- **Rich text in quoted reply blocks.** ADR-0035 explicitly chose
  text/plain quoting for v1; a richer reply quote earns its own
  slice if the prose-stripping ever feels lossy.
- **Persisting body_html in DDB chunks.** Cleaner long-term shape
  but a larger migration. Re-parse on read defers it without
  precluding it; if the read latency budget tightens later, we
  do the migration then.
- **Loading TipTap dynamically.** Lazy-load the rich editor on
  composer open instead of eagerly. ~30KB extra on the initial
  chunk vs. a one-time 100ms hitch on `c`. Eager is simpler;
  the budget has headroom.
