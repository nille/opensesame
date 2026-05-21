# MCP tool surface v1: medium-grained, administratively complete, with structured pagination/errors

The MCP server exposes the following tools in v1, grouped by concern. Every tool is a thin wrapper around a function on the **core email library**; the same function is callable directly by the CLI in direct mode. Tool advertisements are filtered per principal — agents granted only mail access see only mail tools; admin callers see admin tools too.

## Mail operations
- `send_email(from, to[], cc[]?, bcc[]?, subject, body_text, body_html?, in_reply_to?, references[]?, attachments[]?)` → `{message_id, sent_at}`
- `read_inbox(address, since?, limit?, unread_only?)` → `{messages[], next_cursor}` — returns metadata + snippet, not full body
- `get_message(message_id)` → `{headers, body_text, body_html?, attachments[]}` — body assembled from chunks, attachments fetched lazily from S3
- `search_email(address, query, since?, until?, from?, to?, subject?, limit?)` → `{messages[], next_cursor}` — `contains` over body chunks composed with structured filters; 3–10 s per ADR-0004
- `reply_to_email(message_id, body_text, body_html?, reply_all?, attachments[]?)` → `{message_id, sent_at}` — encapsulates correct `In-Reply-To`/`References` handling
- `delete_message(message_id)` → `{deleted: true}` — soft delete; raw MIME stays in S3 for audit

## Flag operations (bulk-shaped)
- `mark_read(message_id[], read: bool)` → `{updated_count}`
- `mark_flagged(message_id[], flagged: bool)` → `{updated_count}`
- `set_keywords(message_id, keywords[])` → `{message_id}` — IMAP `KEYWORD` semantics

## Thread operations
- `list_threads(address, since?, limit?)` → `{threads[], next_cursor}`
- `get_thread(thread_id)` → `{messages[]}`

## Address & identity (read-only)
- `list_addresses()` → `{addresses[]}` — Addresses the principal can see
- `whoami()` → `{principal_kind, principal_id, agent_id?, addresses[], capabilities_summary}` — self-introspection

## Grant management (admin)
- `list_grants(agent_id?, address?)` → `{grants[]}`
- `create_grant(agent_id, address, capabilities[], acknowledgement_text?)` → `{grant_id}` — `send-as` requires non-empty `acknowledgement_text` per ADR-0001
- `revoke_grant(grant_id)` → `{revoked: true}`

## Agent registration (admin)
- `list_agents()` → `{agents[]}`
- `create_agent(agent_id, display_name, address?)` → `{agent_id, oauth_client_id, oauth_client_secret}` — secrets returned exactly once
- `delete_agent(agent_id)` → `{deleted: true}` — cascades grant revocation

## Audit (read-only)
- `audit_query(agent_id?, address?, since?, until?, limit?)` → `{events[], next_cursor}`

## Cross-cutting decisions

**Attachments in v1: inline base64.** Agents pass `{filename, content_type, data_base64}` directly in `send_email` / `reply_to_email`. Considered and deferred a pre-upload-handle path (`upload_attachment` returning a temporary handle) — token-efficient but adds a round trip and a temp-storage lifecycle. Inline is right for v1; upload-handle is a future addition for attachment-heavy workflows.

**Pagination: opaque cursor + separate `since` for sync polling.** List-style tools return `next_cursor` (opaque, server-defined, maps onto DynamoDB's `LastEvaluatedKey`). The `since=<timestamp>` parameter is a *separate* concern for sync-style polling ("give me everything newer than T"). Considered and rejected offset/limit (doesn't compose with DynamoDB pagination cleanly).

**Errors: structured in-band for expected failures, protocol-level for faults.** Expected failures (grant denied, message not found, rate-limited) return `{error: {code, message, retriable}}` as part of the tool result so agents can reason about outcomes without crashing the conversation. Protocol-level errors are reserved for unexpected faults (server bug, infra failure).

## Out of v1 scope (documented gaps)
- Scheduled sends, drafts (future: `schedule_email`, `save_draft`, `list_drafts`, `send_draft`)
- Templates and signatures
- MCP `resources/subscribe` (per ADR-0003)
- IMAP `MODSEQ` / CONDSTORE (per ADR-0004 — only relevant if an IMAP wire-protocol front-end is added)
- Attachment search via OCR/text extraction (per ADR-0004)

## Trade-offs accepted

`send_email` is intentionally fat (many optional fields) rather than split into variants — splitting one operation into N narrow tools is worse for agent reasoning than a single tool with optionality. `reply_to_email` is convenience over capability (an agent could compose a reply with `send_email`); the dedicated tool exists because mis-setting `In-Reply-To`/`References` is the most common error in agent-composed replies. Admin tools live alongside mail tools but are filtered out of advertisements for principals without admin capability — surface remains medium-grained without confusing limited-permission callers.
