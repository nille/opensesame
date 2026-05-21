# MCP server is the shared backend for untrusted callers; the core email library is the single source of truth

The webmail backend, the CLI, and external agents all reach email operations through one of two paths, which converge on the same logic:

- **MCP server** (running on AgentCore Runtime) — the choke point for callers we don't control. The webmail BFF Lambda, external MCP agents, and the CLI in **MCP mode** all go through it. The MCP server validates auth (OAuth via Cognito for external, IAM SigV4 for AWS-internal — see ADR-0005), enforces Grants, and calls into the **core email library**.
- **Core email library** — the shared in-process library that implements all email operations (parse, assemble, send, store, search, grant checks). Single source of truth. The MCP server is a thin tool-exposing wrapper around it. The CLI in **direct mode** consumes it directly.

This produces three valid deployment shapes:

- **solo-direct** — CLI + library + AWS only. No MCP server, no Cognito. Operator authenticates via local AWS credentials and has full operator authority by definition. Lowest infrastructure cost; suitable for one operator with no external agents.
- **solo-with-MCP** — adds the MCP server and Cognito so external MCP clients (Claude Desktop, custom agents) can connect. Still single-user, but agents are first-class.
- **multi-user** — adds the webmail BFF and Cognito Hosted UI; multiple humans and agents share the substrate, with Grants gating who can do what.

The browser does not speak MCP. The webmail BFF Lambda terminates the human's Cognito session, translates HTTP into MCP tool calls, and forwards a user-identity context to the MCP server using its own IAM role.

We considered and rejected:

- **MCP-server-always (single backend, no library exposed directly).** Forces solo operators to deploy and operate a Lambda + Cognito just to use a CLI on their own AWS account. Wastes the AWS-native pattern (`awscli` talks to AWS APIs directly without an intermediary) for trusted local callers.
- **Two equal adapters (REST for webmail, MCP for agents) on top of a library.** Allows webmail features to drift from the agent surface — e.g. shipping a new webmail endpoint without the matching MCP tool. The product's defining claim ("the same mailbox, agentically and humanly") becomes aspirational rather than structural.
- **Library only, no MCP server.** Closes the door on external agents — the entire point of "MCP-native" email.

Trade-offs accepted:

- The CLI carries two code paths (direct mode and MCP mode). Real but small — most CLI logic (arg parsing, output formatting) is shared; only the data-layer call differs.
- The core email library's API becomes a stable surface to maintain alongside the MCP tool surface. Two stable surfaces, not one.
- The CLI-direct path is not gated by Grants because there are no Grants in solo-direct; the operator's IAM principal *is* the authority. This is a deliberate property, not a bypass: solo-direct has no multi-tenant boundary to enforce.

The MCP tool surface (Q7, future ADR) is the *only* programmatic API for the multi-user shape. Every webmail feature must correspond to an MCP tool. This is intentional friction that prevents capability drift between humans and agents.
