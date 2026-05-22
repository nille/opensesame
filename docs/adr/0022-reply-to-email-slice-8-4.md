# `reply_to_email`: parent-sourced threading in core, slice 8.4

ADR-0007 lists `reply_to_email` as a v1 mail tool with the rationale that "mis-setting `In-Reply-To`/`References` is the most common error in agent-composed replies." Slice 8 shipped reply through `send_email` with the UI passing parent's `message_id` through as `in_reply_to` and parent's stored `references` through as the new `references`. That works for trivial chains and silently degrades on every other case:

- The new `References` is supposed to be **parent's `References` + parent's `Message-ID`** — parent appended to its own chain. The current UI omits the append, so a reply to a reply has the same `References` as a reply to the original.
- Subject canonicalization (`Re: Re: Re:` collapse, locale-prefix normalization, idempotency) is the operator's job.
- `reply_all` recipient derivation (parent.From + parent.To + parent.Cc minus self minus dupes, taking `Reply-To` into account) doesn't exist.
- The parent-quoted body convention is the operator's job — paste-and-trim each time.

Slice 8.4 ships **`reply_to_email`** as ADR-0007 names it: a dedicated tool that takes a parent `message_id` plus a body and assembles a correctly-threaded outbound from it. Threading correctness moves from the UI into core, where it has unit tests.

## Decision

### Server-resolved parent. Caller passes `message_id`, never headers.

`reply_to_email(message_id, body_text, body_html?, reply_all?, attachments?)` — exactly the ADR-0007 signature. The dispatcher loads the parent via `reader.getByMessageId(message_id)` and refuses if:

- parent is `null` → **404 `parent_not_found`**
- parent is `parse_status: "failed"` (skeleton row) → **422 `parent_unrepliable`** with `reason: "skeleton"`
- parent has `headers.message_id === null` → **422 `parent_unrepliable`** with `reason: "no_message_id"` (parsed but RFC 5322 lacked one — chains anchor on Message-ID, no anchor → no chain)

The caller only knows a `message_id`. The UI does not pass `from`, `to`, `cc`, `subject`, `in_reply_to`, or `references` — all of those are derived. This is the whole point of having the tool.

### Threading: parent's References + parent's Message-ID

```text
new In-Reply-To := parent.headers.message_id
new References := (parent.headers.references ? split_msgids(parent.headers.references) : []) ++ [parent.headers.message_id]
```

Split-and-rejoin via whitespace per RFC 5322 §3.6.4 (`References = msg-id *("\s" msg-id)`). Duplicate suppression: if `parent.message_id` already appears in `parent.references`, do not append a second copy — pathological but real (some MUAs roll their own and double-stamp). Compare by raw bracketed form (`<a@b>`) — case-sensitive on the message-id text per RFC 5322 §3.6.4, even though domains are case-insensitive in practice; the conservative call is to byte-compare.

### References length: hard cap at 12 entries, oldest-trimmed

RFC 5322 §2.1.1 imposes 998-octet line lengths and §3.6.4 says "implementations SHOULD NOT cause References to exceed line-length limits, removing the second one (the oldest after the original)." Long chains get trimmed by **dropping entries from index 1 forward** (keeping the original at index 0 and the most recent N-1 at the tail). v1 cap is 12 — generous enough that an honest chain won't hit it, tight enough that runaway chains don't blow the line length. Document the constant and the trim rule; lift it later if it bites.

### `from` is derived from the parent's `address`

The address that received the parent message (`parent.address`) is the operator's mailbox for this thread. `reply_to_email` uses it as the new `from`. The caller does **not** supply `from`. Reasons:

- The webmail is single-mailbox (`PRODUCT.md` "active mailbox is configured per deploy"). For slice 8.4 there is one obvious `from` per reply.
- Multi-mailbox callers (future MCP agents with multiple Grants) still have one obvious `from` per reply: the address the parent landed on. If the agent wants to reply from a different identity, that's a new compose, not a reply.
- Forces ADR-0008 outbound `From:` enforcement to align with what the message-id-anchored audit chain already says: this thread is owned by `parent.address`.

### `reply_all` recipient derivation

`reply_all: false` (default):
```text
to := [reply_target(parent)]
cc := []
```

`reply_all: true`:
```text
to := [reply_target(parent)]
cc := dedup(parent.to_addrs ++ parent.cc_addrs) \ { parent.address }
```

Where `reply_target(parent)` is `parent.headers.reply_to ?? parent.headers.from`. We do not currently store `reply_to` on the read-side projection — slice 8.4 either:

a. Adds `reply_to` to `StoredMessageHeaders` and the parser/projection (small, fits the existing schema_v: "1" "additive attributes" rule per ADR-0011), or
b. Falls back to `from` for v1 and notes the limitation.

**Decision: (a).** The whole reason for `reply_to_email` to exist is correctness; falling back to `from` quietly misroutes every mailing-list reply. Add `reply_to: string | null` to `StoredMessageHeaders`, populate from the parsed `Reply-To:` header, default `null` when absent. Existing rows missing the attribute collapse to `null` on read.

Address normalization for the dedup + self-removal step:
- Parse each header value into addr-spec form (strip display name, lowercase the domain, leave the local-part case as-is per RFC 5321 §2.3.11).
- The address-list parser already exists for delivery (`src/core/address.ts`); reuse rather than write a third one.

### Subject: prepend `Re: ` exactly once

```text
new subject := canonicalize_re_prefix(parent.headers.subject ?? "")
```

Canonicalization rules (small and explicit):
- Match a leading run of `(?:\s*[Rr][Ee]\s*:\s*)+` and replace with a single `Re: `.
- Localized variants (`Sv:`, `Aw:`, `Antw:`, `Re[2]:`, `回复:`) are **not** normalized — they're left intact and a single `Re: ` is prepended in front. Reason: localized normalization is a footgun (German `Aw:` collapsing to `Re:` when replying to a German thread is rude); the conservative behavior is "don't translate, just don't double-stamp our own Re:".
- An empty subject yields `Re: ` (no parent subject text, just the canonical prefix).

### Body: top-posted operator text + quoted parent

```text
new body_text := operator_body + "\n\n" + attribution_line + "\n" + quoted_parent_body
```

Where:
- `attribution_line := "On {parent.headers.date}, {parent.headers.from} wrote:"` — best-effort, `date` falls back to `parent.received_at`, `from` falls back to `(unknown sender)`.
- `quoted_parent_body := parent.body_text` with each line prefixed `> `. Empty lines become `>` (no trailing space, matching what every MUA does).
- An operator who deletes the quote block before sending gets exactly that — `reply_to_email` builds a default; the caller can hand back a body without the quote and core honors it. **The convention is that v1 always builds the quote.** A future flag (`include_quote: boolean`, default `true`) can opt out, but slice 8.4 doesn't need it; the operator can edit the textarea.

`body_html` quoting is **not** built in v1. If the caller passes `body_html`, it is sent as-is — no auto-quote, no auto-attribution. Operators rarely send HTML from this UI; agents that pass HTML are responsible for their own quote. The composer always builds `body_text` and the multipart/alternative wrapping is already handled by `composeRawMime`.

### `from` enforcement and audit row

The reply goes through the same `sendWithAudit → persistOutbound` path as `send_email` (ADR-0008, ADR-0016, ADR-0017). No new SES path, no new audit shape. The audit row carries `rfc_message_id` of the **new** message; a `reply_to` field on the audit row would be useful but is **out of scope** for 8.4 — the threading is already inferable from `In-Reply-To` in the persisted outbound row, and a separate audit field would be a new attribute we'd then have to query on. Revisit if reply auditability becomes a question.

### Suppression behavior is unchanged

Suppression-list checks happen inside `sendWithAudit` as for any send. A reply with all recipients suppressed surfaces as **409 `suppressed`** with `blocked_recipients`. The webmail already handles 409 in compose; reply mode shares the path.

### HTTP status code mapping

| HTTP | Body code | Meaning |
|---|---|---|
| 200 | — | Reply sent; body mirrors `send_email` (`{message_id, sent_at}`) |
| 400 | `invalid_request` | Schema violation on the input |
| 404 | `parent_not_found` | `getByMessageId(parent)` returned `null` |
| 409 | `suppressed` | Suppression-list block; `blocked_recipients` |
| 422 | `parent_unrepliable` | Parent is a skeleton row, or has no Message-ID |
| 500 | `internal_error` | Unexpected fault |

422 is new for the BFF (existing tools are 400/404/409/500 only) but is the natural code: the request was well-formed and addressed an existing resource, but the resource cannot satisfy this operation.

## Slice plan

1. **Parser/projection: add `reply_to`.** `src/core/parser.ts` parses `Reply-To:`; `StoredMessageHeaders` and `InboxRowOk` carry `reply_to: string | null`. Existing `read_inbox` / `get_message` rows pass through unchanged on the wire — new attribute is a tail-add. Tests for parser + projection.
2. **Core: `replyToEmail` builder.** `src/core/reply-to-email.ts` exports `buildReplyComposeInput(parent: ReadMessageOk, body: { body_text, body_html? }, opts: { reply_all: boolean }): ComposeInput`. Pure function; no I/O. Unit tests cover threading, subject canonicalization, reply_all dedup, References trim, idempotent Re: prefix, parent-without-message-id rejection, parent-skeleton rejection (typed return; the dispatcher maps to 422).
3. **BFF: schema + dispatcher.** `parseReplyToEmailInput` in `src/bff/schemas.ts`; `handleReplyToEmail` in `src/bff/dispatcher.ts`. Reads parent via `deps.reader.getByMessageId`, runs builder, calls `deps.sendEmail`. Reuses 409 path from `send_email`.
4. **Webmail: reply mode.** `src/web/src/components/Composer.tsx` gains a "reply" mode flagged by a non-null `parent.message_id` seed. To/Cc/Subject become **derived** read-only mono lines (showing what the server will use, fetched once via a preview RPC or computed locally — see "preview" below). Body textarea pre-populated with the quoted-parent body the server will build. Send calls `bff.replyToEmail`. `r` key opens reply mode; `a` flips reply_all; existing `c` opens fresh compose.
5. **Live verify.** Reply against a real prod inbox row. Confirm threading lands (View → All headers in another MUA) and the audit row records.

### "Preview" and double-truth

The reply UI wants to **show** what's about to be sent (To, Subject, quoted body) before send. Two options:

- **Compute in the UI** with a small client-side mirror of the server logic. Keeps the user moving with no extra round-trip; risks UI/server divergence on edge cases.
- **Server preview RPC** (`reply_to_email_preview`) that returns the resolved fields without sending. Single source of truth; one extra round-trip on reply-mode entry.

**Decision for 8.4: compute in the UI for the immediately-visible fields (To, Subject), and source the quoted-parent body from `get_message` (already fetched for the reader pane).** The server is still the truth — it re-derives on send and a divergence becomes a 422 / mis-send rather than a silent corruption. A `reply_to_email_preview` RPC is a 8.5+ tightening if it bites.

## Considered and rejected

- **Caller passes `from`, `to`, `cc`, `subject`, `in_reply_to`, `references`** (the existing slice-8 path). Wire-level minimal but moves every threading bug into every caller. The whole rationale for ADR-0007 listing this tool separately is to centralize threading correctness.
- **Build References from the audit log instead of parent.headers.** The audit log records what we sent, not what we received; the chain anchor is the parent's view of the world, not ours.
- **Auto-translate localized Re: prefixes.** Footgun; the conservative behavior of "don't double-stamp our own `Re:`, leave others alone" is correct.
- **Compute `from` from a Grant lookup** (slice 9 territory). For 8.4 the parent's `address` is the only valid `from`; Grants enter when there's an authenticated principal and a per-call choice to make.
- **Auto-include the quoted parent in `body_html` too.** Quoting HTML correctly requires sanitizer-aware DOM rewriting; we can't do it well in v1, and "do it badly" is worse than "don't do it." Operators sending HTML keep responsibility for their own quote until the parser/sanitizer story matures.
- **A separate `reply_to_email_preview` RPC.** Defers actual machinery for slice 8.5 if needed. The existing `get_message` already gives the body we'd quote, and To/Subject are cheap to derive UI-side.

## Trade-offs accepted

- **`reply_to` is a tail-add to `StoredMessageHeaders`.** Existing rows missing the attribute collapse to `null` — mailing-list replies land in the wrong place for messages received before 8.4 ships. Not silently wrong: the dispatcher logs the path it took (`reply_target_source: "from" | "reply_to"`) so operator triage can see when a row's `reply_to` was missing.
- **References cap at 12 is arbitrary.** Long chains do exist in the wild; the alternative is folding header lines, which interacts with downstream MUAs in inconsistent ways. 12 covers ~95% of legitimate chains and the trim is documented in the audit row when triggered.
- **Localized prefixes accumulate.** A reply to a German `Aw: …` becomes `Re: Aw: …`. Two-language threads get visually noisier than a perfect normalizer would manage. We accept this in exchange for never accidentally translating.
- **No HTML-quote builder.** Operators who want to reply with rich quoted HTML have to build it themselves. Not a v1 product use case.
