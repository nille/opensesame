# Open Sesame — webmail product context

## What this is

Open Sesame is a personal AWS-native email platform. The webmail (slice 8 onward) is the operator-facing UI for that platform: a single-user mail client that talks to the slice-7 BFF (ADR-0021) on `localhost:3000`. It is **not** a SaaS, **not** multi-tenant, **not** for end users to sign up to.

## Register

product

The webmail is a tool the operator lives in. Design serves the task. Familiarity is a feature. The bar is *earned familiarity, with one or two intentional choices that signal this is a personal tool, not a generic shell*.

## Users

One user — the operator running the platform. Comfortable with terminals, ADRs, and reading raw RFC 5322 headers. Triages email between coding sessions. Sends from `test@nille.net` today; the active mailbox is configured per deploy, not picked in-product.

## Product purpose

Three operations, mirrored from the BFF's RPC surface:

- **read_inbox** — list newest-first, paginate, optionally filter `since`
- **get_message** — open one, display headers + body, see the `raw_s3_uri` if curious
- **send_email** — compose new or reply, surface the BFF's 409 (suppression) and 500 inline

What it is NOT, ever:

- a generic webmail clone with rich formatting toolbars and folders
- a thing that hides the underlying infrastructure (raw addresses, message-ids, ULIDs are first-class content, not debug info)
- a SaaS marketing surface

## Tone

Quiet, infrastructural, intentional. Information-first copy: empty states are *information* (`0 messages · last polled 14:22:08`), not encouragement (`All caught up!`). Mono type carries metadata; sans carries content. The interface trusts the reader.

## Anti-references

- Default Tailwind/shadcn templates with card-grid hierarchy
- Gmail's chrome density and avatar circles
- Webmail products with feature-marketing language inside the app
- Spinners over real content; toasts for state changes that have a place to live inline
- Modals for things that have a pane

## Strategic principles

- **Earned familiarity:** keyboard-fluent like Linear; reading-first like HEY; metadata visible like a terminal.
- **Two felt rooms:** day (warm paper, ink-blue accent) and night (cool ink, amber accent). Same bones, different room. Not an inverted CSS filter.
- **Triage-fast as the default mode.** Reading happens in the right pane without opening a modal. `j`/`k` move, `enter` opens, `r` replies, `c` composes.
- **Server truth wins over optimistic UI.** Sent mail appears at the top of the inbox via the next `read_inbox` poll, not via local injection — diverging from the server is a worse failure than a 30s wait.
- **No invented affordances.** If a standard pattern exists for inbox/reader/compose, use it. The intentional choices are register-shifting (mono metadata, hue-aware theme switch), not affordance-reinventing.
