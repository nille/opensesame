# Open Sesame

An AWS-native email platform that exposes mailbox operations as MCP tools, so external agents can send, receive, and manage email through a standard protocol — alongside humans using a webmail UI or CLI.

## Language

**Agent**:
An external MCP client that consumes email tools (send, read, search, reply). Agents live outside Open Sesame and connect inbound. Open Sesame does not run LLM-powered agents itself; it only serves them. Every Agent has its own first-class email address on a managed domain.
_Avoid_: Bot, assistant, internal agent, hosted agent

**Grant**:
An authorization given by a Human (or admin) to an Agent that scopes which Addresses the agent can read from and send from, with what capabilities (`send-on-behalf-of`, `send-as`, `interactive`, `autonomous`). A Grant binds an Agent to a **principal** — either a Cognito user-pool identity (for OAuth-authenticated callers) or an IAM role ARN (for SigV4-authenticated AWS-internal callers). One Grant model, two issuance paths.
_Avoid_: Permission, role, ACL entry

**Principal**:
The authenticated identity making a request, resolved to one of two forms: a Cognito `sub` claim (from a validated JWT) or an IAM role ARN (from a validated SigV4 signature). The MCP server resolves either form to the same Grant lookup.
_Avoid_: Caller, identity, user (overloaded)

**Core email library**:
The shared in-process library that implements all email operations — parse, assemble, send, store, search, grant checks. Single source of truth for email logic. Consumed by the **MCP server** (which exposes it as MCP tools) and by the **CLI in direct mode** (which calls it locally using operator AWS credentials). The webmail BFF always reaches the library through the MCP server.
_Avoid_: Engine, kernel, core service

**CLI direct mode**:
A deployment option in which the CLI uses the operator's local AWS credentials (`aws configure`) to call the **core email library** directly against DynamoDB / S3 / SES, bypassing the MCP server. Valid for **solo deployments with no external MCP clients**. Authority is defined by the operator's IAM permissions, not by Grants. The CLI also supports an **MCP mode** (default for shared/multi-user deployments) that calls the MCP server over OAuth or SigV4.
_Avoid_: Local mode, offline mode, standalone mode

**Deployment shape**:
One of three valid configurations: **solo-direct** (CLI + library + AWS, no MCP server, no Cognito), **solo-with-MCP** (adds MCP server + Cognito for external MCP clients), **multi-user** (adds webmail BFF + Cognito Hosted UI for human accounts and Grants between Humans and Agents). Each is a valid product configuration; the MCP server is required only when callers we don't control need access.
_Avoid_: Tier, edition, mode

**Tool surface**:
The set of MCP tools the server exposes — the only programmatic API for the multi-user shape. Tool advertisements are filtered per principal: mail-only agents see only mail tools; admin callers see admin tools too. The surface mirrors functions on the **core email library** one-to-one; every webmail feature must correspond to a tool in this surface.
_Avoid_: API, endpoints, tools (overloaded)

**Cursor**:
An opaque, server-defined pagination token returned by list-style tools (`read_inbox`, `search_email`, `list_threads`, `audit_query`) and passed back as the `after` argument to fetch the next page. Distinct from the **`since` timestamp** parameter, which is used for sync-style polling ("everything newer than time T") rather than within-result pagination.
_Avoid_: Token (overloaded), offset, page

**Send-on-behalf-of**:
A Grant capability that authorizes an Agent to send under a Human's `From:` address **with disclosure** — Open Sesame populates `Sender:` with the agent's address (RFC 5322), so MUAs render a "via" badge. Analogous to Microsoft Exchange's "Send on Behalf" permission.
_Avoid_: OBO, on-behalf-of (use the full term to disambiguate from send-as)

**Send-as**:
A Grant capability that authorizes an Agent to send under a Human's `From:` address **without disclosure** — no `Sender:` header, no `Generated-By:` header, wire-level indistinguishable from the human sending directly. Analogous to Microsoft Exchange's "Send As" permission. Strictly more powerful than send-on-behalf-of and granted explicitly.
_Avoid_: Impersonation, masquerade, ghostwriter mode

**Autonomy mode**:
An orthogonal Grant property indicating whether the Agent must obtain per-message human approval (`interactive`) or may send unattended (`autonomous`). Determines whether `Auto-Submitted: auto-generated` is emitted (autonomous → yes; interactive → omitted, per RFC 3834). Independent of disclosure mode.
_Avoid_: Approval mode, supervised mode

**Address**:
A single deliverable mailbox endpoint on a managed domain (e.g. `alice@acme.com`, `billing-agent@acme.com`). The unit of inbound ownership: every received message belongs to exactly one Address (the recipient). Humans and Agents each have at least one Address.
_Avoid_: Mailbox (ambiguous between address and inbox view), email account

**Inbox**:
A view over one or more Addresses that a principal (Human or Agent) is granted to read. An inbox is not stored — it is computed from grants at query time.
_Avoid_: Mailbox, folder

**Thread**:
A best-effort grouping of messages by RFC 5322 `Message-ID` / `In-Reply-To` / `References`. Used as a **filter and presentation layer**, not as an ownership primitive — inbound ownership is by Address, not by thread. Threads degrade gracefully when senders strip threading headers.
_Avoid_: Conversation (reserve for the UI-facing term if/when it appears), discussion

**Raw MIME archive**:
The canonical S3 storage of every received message in its full original RFC 5322 / MIME form. Written once by SES on receipt, never modified. Source of truth for replay, audit, attachment serving, and rebuild of any derived data.
_Avoid_: Mail store, blob store

**body_text**:
The extracted plain-text body of a message (from `text/plain` parts, or HTML→text conversion of `text/html` parts). Stored in DynamoDB as one or more **body chunks** and searched via `contains`. Distinct from attachments — attachment binary content stays only in the raw MIME archive and is not searchable in v1, matching the IMAP `BODY` search baseline.
_Avoid_: Body, content, message text

**Body chunk**:
A ~300 KB slice of `body_text` stored as its own DynamoDB item under the message's partition. Adjacent chunks overlap by 256 bytes so any search term up to 256 bytes long is fully contained within at least one chunk. Match results are deduplicated by `message_id`. Chunking removes the 400 KB DynamoDB item-size limit as a constraint on body searchability.
_Avoid_: Body part, body fragment

**headers_blob**:
A DynamoDB attribute containing the raw concatenated headers of the message, used to support `HEADER <field> <value>` search across arbitrary header fields (not just the well-known `From`/`To`/`Subject`). Sized in low-tens of KB per message.
_Avoid_: Header dump, raw headers

**MailIngested event**:
The internal event emitted to EventBridge when the ingest Lambda has finished processing a newly-received message (parsed, stored, indexed). The integration point operators use to trigger downstream behavior (auto-responders, notifications, custom workflows) outside of Open Sesame itself.
_Avoid_: Inbox event, new mail signal

**Origin headers**:
The set of headers Open Sesame emits to disclose authorship: `From:`, `Sender:`, `Auto-Submitted:`, and `Generated-By:` (Open Sesame–specific, informational). Which of these appear is determined by the Grant's disclosure and autonomy modes. Note: there is no widely-adopted "AI-generated" header today; `Generated-By:` is documentation, not a signal recipients render.
_Avoid_: AI headers, provenance headers

**Managed hosted zone**:
The Route 53 hosted zone that Open Sesame provisions and owns inside the operator's AWS account for the configured `domain`. Open Sesame writes all email-related records (SES verification TXT, DKIM CNAMEs, MAIL FROM, DMARC) into this zone automatically. The operator delegates the name to the zone by setting NS records at their registrar — a one-time step. The operator may add their own records (web `A`/`AAAA`, non-SES MX, etc.) alongside; Open Sesame only manages the records it created.
_Avoid_: DNS zone, operator zone

**Forward**:
A property of an Address (future feature, not in v1) that re-emits inbound mail to one or more external destinations. Forwarding requires SRS rewriting at send time to keep SPF intact; the ingest Lambda is the natural place for this re-emission since it already parses every inbound message.
_Avoid_: Redirect, alias (alias has different RFC semantics), relay

**Skeleton row**:
A minimal DynamoDB row written for an inbound message whose MIME the ingest Lambda could not parse. Carries `parse_status: "failed"`, the error reason, and a pointer to the raw S3 object. Renders in the inbox as `[Could not parse — raw available]` so users see that something arrived; the message also lands in the DLQ for operator triage. Exists to prevent silent gaps from the user's point of view.
_Avoid_: Stub row, placeholder

**Durability contract**:
The single promise the system makes about inbound mail: if a message reaches the raw-MIME S3 bucket, it will eventually be in DynamoDB and a `MailIngested` event will fire. Not "atomic across S3 and DynamoDB"; not zero-latency. A bounded inconsistency window exists between S3 write and DynamoDB visibility, and this is documented rather than denied.
_Avoid_: SLA, guarantee (overloaded)
