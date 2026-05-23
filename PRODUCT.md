# Open Sesame — webmail product context

## What this is

Open Sesame is a personal AWS-native email platform. The webmail (slice 8 onward) is the operator-facing UI for that platform: a single-user mail client that talks to the slice-7 BFF (ADR-0021) on `localhost:3000`. It is **not** a SaaS, **not** multi-tenant, **not** for end users to sign up to.

## Register

product

The webmail is a tool the operator lives in. Design serves the task. Familiarity is a feature. The bar is *earned familiarity, with one or two intentional choices that signal this is a personal tool, not a generic shell*.

## Users

One user — the operator running the platform. Comfortable with terminals, ADRs, and reading raw RFC 5322 headers. Triages email between coding sessions. Sends from `test@nille.net` today; the active mailbox is configured per deploy, not picked in-product.

## Product purpose

Mirroring the BFF's RPC surface. The set has grown across slice 8 — labels, drafts, trash, archive, snooze, attachments, search — but the operations stay tool-shaped, not app-shaped:

- **read_inbox** / **search_email** — list newest-first, paginate, optionally filter; search supports `from:`, `subject:`, `to:`, `is:unread`, `is:starred`, `is:snoozed`, `has:attachment`, `in:trash`, `in:archive`, quoted phrases, and negation
- **get_message** — open one, display headers + body (text/plain or sanitized text/html), see the `raw_s3_uri` if curious, download attachments
- **send_email** — compose new or reply, with attachments, optionally rich-text — surface the BFF's 409 (suppression) and 500 inline

What it is NOT, ever:

- a SaaS marketing surface, or a multi-tenant signup product
- a thing that hides the underlying infrastructure (raw addresses, message-ids, ULIDs, raw S3 URIs are first-class content, not debug info)
- a feature-marketing chrome wrapped around mail (no "Compose with AI" buttons, no upsell tiles in empty states, no growth loops)
- a Gmail clone with avatar circles and card-grid density

## Tone

Quiet, infrastructural, intentional. Information-first copy: empty states are *information* (`0 messages · last polled 14:22:08`), not encouragement (`All caught up!`). Mono type carries metadata; sans carries content. The interface trusts the reader.

## Anti-references

- Default Tailwind/shadcn templates with card-grid hierarchy
- Gmail's chrome density and avatar circles
- Webmail products with feature-marketing language inside the app
- Spinners over real content; toasts for state changes that have a place to live inline
- Modals for things that have a pane
- Rich-text toolbars that look like a Word toolbar (font family, font size, color picker, alignment, indent, bullet variants, emoji, GIF). Rich text exists in this product — it ships *minimal*: bold, italic, link, ordered list, unordered list, blockquote. Anything beyond that is feature-marketing density, not operator value.
- HTML-email rendering that lets the email's CSS style the rest of the app. Received HTML renders inside an isolation boundary; remote images are blocked by default.

## Strategic principles

- **Earned familiarity:** keyboard-fluent like Linear; reading-first like HEY; metadata visible like a terminal.
- **Two felt rooms:** day (warm paper, ink-blue accent) and night (cool ink, amber accent). Same bones, different room. Not an inverted CSS filter.
- **Triage-fast as the default mode.** Reading happens in the right pane without opening a modal. `j`/`k` move, `enter` opens, `r` replies, `c` composes.
- **Server truth wins over optimistic UI.** Sent mail appears at the top of the inbox via the next `read_inbox` poll, not via local injection — diverging from the server is a worse failure than a 30s wait.
- **No invented affordances.** If a standard pattern exists for inbox/reader/compose, use it. The intentional choices are register-shifting (mono metadata, hue-aware theme switch), not affordance-reinventing.
