# MCP `resources/subscribe` is out of scope for v1; realtime fan-out goes through EventBridge

The MCP spec defines `resources/subscribe` and `notifications/resources/updated`, and Open Sesame's "agentic email" framing makes realtime reactivity tempting to expose through MCP. We are deliberately not doing that in v1.

Instead:

- The MCP server exposes **polling tools** (`read_inbox(address, since=cursor)`, `search_email`, etc.) as the universal mechanism for agents to discover new mail. Every MCP client — regardless of whether it implements subscriptions — works against this.
- The ingest Lambda publishes a **`MailIngested` event to EventBridge** for every successfully processed inbound message. Operators wire their own realtime reactions (auto-responder Lambdas, agent-runtime invocations, analytics) via EventBridge rules. Open Sesame stays out of how those reactions are implemented.

Reasons we held back from MCP subscriptions in v1:

1. **MCP client adoption of subscriptions is uneven.** Major clients (Claude Desktop, Claude Code) tend to refetch resources on demand rather than consume subscription notifications. Building subscription infrastructure for a feature most clients ignore is speculative.
2. **Avoids holding distributed state we don't need yet.** Subscription support requires per-client connection tracking, per-Address subscription tables, replay cursors for reconnects, and graceful degradation on disconnect — a substantial chunk of stateful plumbing.
3. **Aligns with the AWS-native posture.** Operators on AWS already trust EventBridge + Lambda for event fan-out. Forcing them to learn an Open-Sesame-specific subscription model when they have native tools is the wrong default.
4. **Forward-compatible.** Adding `resources/subscribe` later is purely additive: the ingest Lambda already publishes the canonical event, and a future subscribe-forwarder can consume the same EventBridge channel.

Trade-off accepted: agents whose runtimes can hold long MCP connections do not get push-style notifications from Open Sesame in v1. Their operators wire EventBridge → their runtime instead, then the runtime polls via MCP. We will reconsider if real demand for direct MCP subscriptions emerges from clients that meaningfully consume them.
