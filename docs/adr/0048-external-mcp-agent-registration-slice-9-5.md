# External MCP via OAuth client_credentials + agent self-registration, slice 9.5

ADR-0047 (slice 9.4) gave the MCP server an HTTP entry, but only
AWS-internal callers can reach it (SigV4 from the BFF Lambda's role,
or the operator's local AWS creds via the CLI in MCP mode). This
slice opens the second of ADR-0005's two issuance paths: external
agents — Claude Desktop, custom MCP clients, third-party automation
— authenticate via OAuth `client_credentials`, the MCP server
validates the JWT, and the same Grant-table machinery (slice 9.2)
gates per-tool capability.

The slice has two halves: **agent registration** (creating an OAuth
app client + a Grant for an agent) and **agent invocation** (the
agent calls MCP with a Cognito-issued JWT). The registration half
is admin-facing — `create_agent`, `delete_agent`, `list_agents` per
ADR-0007. The invocation half is the MCP server's existing
`/mcp/tools/call` endpoint growing a second auth middleware
(JWT-Bearer) alongside the SigV4 one.

## What this slice ships

1. Three admin RPCs — `create_agent`, `list_agents`, `delete_agent`
   — gated by `admin:agents` (already in the Grant capability set
   per ADR-0045).
2. A Cognito-side flow: `create_agent` provisions a User Pool app
   client with `client_credentials` grant enabled, returns the
   `client_id` and `client_secret` *exactly once*, stores the
   client metadata in a new `Agents` DynamoDB table.
3. `JwtBearerMiddleware` on the MCP server. Validates inbound
   `Authorization: Bearer <jwt>` against the User Pool's JWKS,
   extracts the `client_id` from the access token, maps it to a
   Cognito `sub` (the User Pool's app-client identity), attaches
   `c.var.principal = { kind: "cognito", sub: <client-sub> }`.
4. Tool advertisement filtering: `mcpServer.list(principal)`
   returns only tools the principal's Grant covers. Used by the
   slice-9.6 `tools/list` endpoint and by the agent-facing UX
   (a Claude Desktop / Inspector connection sees a filtered tool
   list).
5. `human_principal` propagation in audit rows — when a human
   invokes the BFF and the BFF invokes MCP on their behalf, the
   audit row carries both the agent principal (the BFF role) and
   the human principal (the Cognito sub from the session cookie).
6. CLI affordance for an operator: `opensesame agents create
   --display-name "Claude Desktop"` runs the same `create_agent`
   tool, prints the credentials (instructions for the operator to
   paste into the agent's config).

## What this slice does *not* ship

- **No CDK changes for the agent path.** Agents reach the MCP
  server's existing endpoint; no new resource. Slice 9.6 is the
  CDK slice.
- **No multi-tenancy across operators.** ADR-0006: multi-user is
  many humans + many agents on **one** operator's deployment. An
  agent registered in Operator A's deployment cannot reach
  Operator B's deployment; the User Pool, the Grants table, and
  the MCP server are all per-deployment.
- **No agent-managed Grants.** An agent cannot call
  `create_grant` even if it has `admin:grants` (and it shouldn't —
  the `create_agent` flow doesn't grant `admin:grants`). The
  capability set on a freshly-created agent is empty by default;
  the operator pairs it with one or more `create_grant` calls
  per address.
- **No autonomy-mode escalation.** A Grant's `autonomy_mode`
  (`interactive` | `autonomous`) is set at `create_grant` time and
  immutable. To change it, revoke and re-create.
- **No MCP `tools/list` JSON-RPC handshake yet.** Slice 9.5 ships
  the *filtering* logic but the wire-side `tools/list` endpoint is
  consumed only by slice 9.6's CDK-deployed Inspector / Claude
  Desktop verification. The internal callers from 9.4 don't use
  it.
- **No webmail UI for agent management.** CLI + `create_agent` /
  `revoke_agent` RPCs only. A "manage agents" surface in the
  webmail is a follow-up.

## Decision

### `Agents` table

```ts
type StoredAgent = {
  schema_v: "1";
  agent_id: string;        // PK — slug, e.g. "claude-desktop"
  display_name: string;
  cognito_client_id: string;     // Cognito app client id
  cognito_sub: string;     // The app client's principal sub
  created_at: string;
  created_by: string;      // principal SK of the admin who created it
};
```

```text
TableName: opensesame-agents-<env>
PK: agent_id (S)
GSI: AgentsByCognitoSub
  PK: cognito_sub (S)
  Projection: ALL
```

The GSI answers the JWT-middleware lookup: "given a `cognito_sub`,
which agent is this?". Stored on the agent record so `list_agents`
can render the full set without joining tables.

`cognito_client_secret` is **not** stored — Cognito holds it and
returns it once at app-client creation. If the operator loses it,
they must `delete_agent` and `create_agent` again.

### `create_agent` flow

```ts
// Input
{
  agent_id: string;        // operator-chosen slug; unique
  display_name: string;
}

// Output (returned exactly once — never queryable later)
{
  agent_id: string;
  cognito_client_id: string;
  cognito_client_secret: string;
  cognito_token_url: string;       // Hosted UI's /oauth2/token
  cognito_scope: string;           // "<resource-server>/<scope>"
}
```

Server-side:

1. Verify the caller's Grant carries `admin:agents`. (Middleware.)
2. Check `agent_id` is unique against the `Agents` table.
3. Call Cognito `CreateUserPoolClient` with:
   - `AllowedOAuthFlows: ["client_credentials"]`
   - `AllowedOAuthScopes: ["<resource-server-id>/mcp:invoke"]` —
     the User Pool has one resource server (`opensesame-mcp`) with
     one scope (`mcp:invoke`). Defined at User Pool creation in
     slice 9.1.
   - `GenerateSecret: true`
   - `ClientName: "agent:<agent_id>"` — convention for the audit
     trail and Cognito console readability.
4. Add the new client to the `agents` Cognito group via custom
   attribute, *not* via group membership — Cognito groups don't
   apply to app clients. Instead, the `JwtBearerMiddleware` infers
   `cognito:groups: ["agents"]` from the absence of a Hosted-UI
   user (the `client_credentials` grant has no associated user).
5. Compute the `cognito_sub` for the app client:
   `client_credentials` access tokens carry the app client's id as
   the `sub` claim (Cognito convention). Cache that here so the
   GSI lookup in middleware is by-sub.
6. Write the `Agents` row.
7. Return the credentials. The dispatcher does not log them; the
   admin caller is responsible for handing them to the operator.

### `delete_agent` flow

1. Read the `Agents` row to get the `cognito_client_id`.
2. Call Cognito `DeleteUserPoolClient`.
3. Cascade-revoke every Grant where `agent_id == <agent_id>`:
   `Query` the Grants `GrantsByPrincipal` GSI (slice 9.2) for
   `principal: cognito#<sub>`, batch-delete the result.
4. Delete the `Agents` row.

Order matters: Cognito client deleted first stops the agent from
issuing new tokens; existing tokens have a max 1-hour lifetime
(Cognito access-token default), after which they fail JWT
validation. Grant rows deleted after — even if a token is still
valid, the Grant lookup returns empty and the call 403s.

### `list_agents`

Returns `{ agents: StoredAgent[] }` minus the unguessable
secret-bearing fields. The output schema:

```ts
{
  agents: Array<{
    agent_id: string;
    display_name: string;
    cognito_client_id: string;     // OK to surface
    cognito_sub: string;
    created_at: string;
    grants_summary: Array<{ address: string; capabilities: Capability[] }>;
  }>;
}
```

`grants_summary` is computed by GSI-querying Grants per agent. The
admin caller sees what each agent can do without a separate
`list_grants` call.

### `JwtBearerMiddleware`

```ts
// src/mcp/jwt-middleware.ts
type CognitoJwtPayload = {
  sub: string;
  client_id?: string;       // present on client_credentials tokens
  scope?: string;           // " "-separated; we expect "opensesame-mcp/mcp:invoke"
  token_use: "access";
  exp: number;
  iss: string;
};

requireBearerToken(c: Context, next: Next): Promise<Response>
```

On every `/mcp/tools/call`:

1. If `Authorization: AWS4-HMAC-SHA256 ...` → defer to SigV4
   middleware (slice 9.4). The two are mutually exclusive based on
   the auth scheme prefix.
2. If `Authorization: Bearer <token>`:
   - Verify against the User Pool's JWKS (cached, slice 9.1
     pattern).
   - Validate `iss`, `exp`, `token_use === "access"`, `scope`
     contains `opensesame-mcp/mcp:invoke`.
   - Extract `sub`. Set `c.var.principal = { kind: "cognito", sub }`.
3. Otherwise: 401 `auth_failed`.

The middleware does **not** Query the `Agents` table to confirm the
sub maps to a registered agent — that's the job of the downstream
Grant lookup. A token issued before `delete_agent` whose Cognito
client has been deleted will fail JWKS validation (Cognito stops
signing for deleted clients); a token issued after a Grant revoke
will simply find no Grant and 403.

### Tool advertisement filtering

`mcpServer.list(principal)` (slice 9.3 stub returns `allTools`)
becomes:

```ts
list(principal: Principal): Tool<any, any>[] {
  const grants = grantPort.listByPrincipal(principal);  // GSI query
  const capabilities = new Set(grants.flatMap((g) => g.capabilities));
  return allTools.filter((t) => capabilities.has(t.capability));
}
```

Slice 9.6's `tools/list` JSON-RPC endpoint consumes this. An agent
with `read` capability sees `read_inbox`, `get_message`,
`search_email`, etc. but not `send_email` (capability `send` not
on the Grant) and not `create_grant` (capability `admin:grants`
not on the Grant).

A principal with no Grants on any address sees zero tools — and the
`tools/call` would 403 anyway. This is the right shape: a
freshly-registered agent that hasn't been granted access to any
mailbox is functionally inert.

### Audit row attribution: the `human_principal` field

ADR-0001 commits to attributing every send to a human (or to
"autonomous" with explicit consent). Today the audit row records
the `principal` of the caller. When the BFF (a server-side
intermediary) calls MCP, the principal is the BFF Lambda's IAM
role — an **agent**, not the human.

Slice 9.5 grows the audit row with a `human_principal` field:

```ts
type AuditRow = {
  // ... existing fields
  principal: string;                   // the caller of MCP — agent or human
  human_principal: string | null;      // the human who initiated the request, or null
  // ...
};
```

How `human_principal` is populated:

- BFF → MCP: the BFF passes `X-OpenSesame-Human-Principal: cognito#<sub>`
  in the HTTP headers when it calls MCP. The MCP server's
  audit-write site records it.
- External agent → MCP: no `X-OpenSesame-Human-Principal` header.
  The audit row's `human_principal` is `null`. Combined with the
  agent's `autonomy_mode` from the Grant (slice 9.2), this is the
  ADR-0001 "autonomous" attribution path.
- CLI in MCP mode → MCP: the CLI sets the header to the operator's
  IAM role ARN (`iam#<role-arn>`) — **technically not a human**, but
  the same auditable identity as the operator's local creds. The
  CLI's MCP-mode user is by definition the operator, who *is* the
  authority in solo-* shapes.
- Solo-direct (CLI direct mode): no MCP, no audit record changes.

The header is **not authenticated** — a malicious internal caller
could set it to any value. That's fine: SigV4 still authenticates
the *caller* (the BFF role); the human-principal field is
informational, recorded alongside the authenticated principal, not
in place of it. The Grant gate runs against the authenticated
principal. Misattribution would require a BFF compromise, which is
already game-over for that operator's deployment.

### Cognito User Pool config additions (slice 9.1 retrofit)

Slice 9.1 created the User Pool. Slice 9.5 needs:

- A **resource server** named `opensesame-mcp` with one scope
  `mcp:invoke`. Created in CDK at slice-9.1 deploy time so 9.5
  doesn't need to revisit the pool.
- The `humans` Cognito group as before; agents are **not** members
  of a group (they're app clients, not users).

Operators redeploying to slice 9.5 from a 9.1-vintage stack: CDK's
stable construct IDs (ADR-0011) keep the User Pool intact; the
resource-server addition is a non-breaking append.

## Inherits from

- **ADR-0001** — `human_principal` field on the audit row;
  autonomy-mode / disclosure-mode are populated from the agent's
  Grant.
- **ADR-0005** — second issuance path (Cognito client_credentials)
  lights up here.
- **ADR-0006** — multi-user shape becomes operationally complete
  after this slice + slice 9.6.
- **ADR-0007** — `create_agent`, `list_agents`, `delete_agent`
  surface area.
- **ADR-0008** — pre-send audit row gains `human_principal`; the
  send-with-audit pipeline is updated to populate it.
- **ADR-0044** — User Pool resource server + scope are CDK
  additions to the stack 9.1 deploys.
- **ADR-0045** — `admin:agents` and `admin:grants` capabilities;
  `agent_id` field on Grant rows finally has a population story
  (it's the `agent_id` slug from the `Agents` table).
- **ADR-0046** — tool registry's `list` method is the basis for
  filtering.
- **ADR-0047** — JWT middleware sits next to SigV4 middleware on
  `/mcp/tools/call`.

## Files

| Layer | File | Change |
|---|---|---|
| Core types | `src/core/agents.ts` | New: `StoredAgent`, `CreateAgentInput`, `CreateAgentResult` |
| Reader | `src/aws/dynamodb-agents.ts` | New: `makeDynamoAgentPort` — create, list, delete, lookupBySub |
| MCP | `src/mcp/jwt-middleware.ts` | New: Bearer-token verification, JWKS cache, principal extraction |
| MCP | `src/mcp/server.ts` | `list(principal)` filtering; `serveHttp` mounts JWT middleware alongside SigV4 |
| MCP tools | `src/mcp/tools/create-agent.ts` | New |
| MCP tools | `src/mcp/tools/list-agents.ts` | New |
| MCP tools | `src/mcp/tools/delete-agent.ts` | New |
| MCP tools | `src/mcp/tools/index.ts` | Add the three new tools |
| Cognito | `src/aws/cognito-agents.ts` | New: `CreateUserPoolClient`, `DeleteUserPoolClient` wrappers; resource-server scope literals |
| BFF | `src/bff/dispatcher.ts` | When calling MCP HTTP, set `X-OpenSesame-Human-Principal` from `c.var.principal` |
| MCP | `src/mcp/audit-context.ts` | New: read `X-OpenSesame-Human-Principal` header into `ctx.human_principal` |
| Audit | `src/core/send-with-audit.ts` | Persist `human_principal` field |
| CLI | `src/bin/opensesame.ts` | New `agents create / list / delete` subcommands |
| CDK | `src/cdk/auth-stack.ts` | Add Cognito resource server `opensesame-mcp` + scope `mcp:invoke` (slice-9.1 retrofit) |
| CDK | `src/cdk/data-plane-stack.ts` | New `Agents` table + `AgentsByCognitoSub` GSI |
| Tests | `test/agents.test.ts` | Reader: create-list-delete, GSI lookup |
| Tests | `test/mcp-jwt-middleware.test.ts` | JWKS verify, expired token, wrong scope, malformed Bearer |
| Tests | `test/mcp-tool-list-filtering.test.ts` | `list(principal)` returns the right subset for each capability set |
| Tests | `test/audit-human-principal.test.ts` | Header parsed, propagated to audit row, null when absent |
| Tests | `test/bff-integration.test.ts` | Add an agent-flavored variant: register agent, sign with Cognito client_credentials, call MCP |

## Verification

1. As the operator, `opensesame agents create --display-name "Claude
   Desktop" --agent-id claude-desktop`. Receive `cognito_client_id`,
   `cognito_client_secret`, `cognito_token_url`, `cognito_scope`.
2. `opensesame grants create --address alice@acme.com --principal
   cognito#<claude-desktop-sub> --capabilities read,draft,send,send-on-behalf-of
   --autonomy-mode interactive --disclosure-mode send-on-behalf-of`.
3. From a separate machine simulating the agent, fetch a token:
   ```
   curl -X POST $TOKEN_URL \
     -d 'grant_type=client_credentials&scope=opensesame-mcp/mcp:invoke' \
     -u "$CLIENT_ID:$CLIENT_SECRET"
   ```
   Receive an `access_token`.
4. Call MCP with the token:
   ```
   curl -X POST $MCP_URL \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"tool":"read_inbox","input":{"address":"alice@acme.com"}}'
   ```
   Returns 200 with the inbox.
5. Same call against `tool: "delete_agent"` returns 403 (the agent's
   Grant doesn't include `admin:agents`).
6. Operator runs `opensesame agents delete --agent-id claude-desktop`.
   Wait for the JWKS cache to refresh on the MCP side, then the
   agent's previous token's next call returns 401 (the Cognito
   client is gone).
7. Send a message *as the agent* (`send_email` with a body, the
   agent's grant is `send-on-behalf-of`). The recipient's mail
   client shows `Sender: claude-desktop@<agent-domain>` (per
   ADR-0001). The audit row records `principal:
   cognito#<claude-desktop-sub>`, `human_principal: null`,
   `autonomy_mode: interactive`, `disclosure_mode:
   send-on-behalf-of`.
8. From the webmail UI (acting as a human), trigger a send via the
   composer. The audit row records `principal:
   iam#<bff-role-arn>`, `human_principal: cognito#<human-sub>`,
   `autonomy_mode: interactive`. Both forms of attribution are
   present.

## Trade-offs accepted

- **Cognito app clients aren't group members.** We work around it
  by treating "the absence of a `cognito:username` claim" as the
  agent signal and "the presence of `cognito:groups: humans`" as
  the human signal. Slightly fragile but the alternative
  (a separate User Pool per principal type) doubles the deploy
  cost.
- **`create_agent` returns a secret in the response body.** This is
  the standard OAuth client-credentials shape (Cognito's own
  console does the same). The admin RPC is invoked over HTTPS via
  the MCP server's HTTP transport (slice 9.4); the secret never
  hits a log line. Mitigation depends on the operator: rotate by
  delete + recreate.
- **The JWKS cache on the MCP server adds a `delete_agent`-to-
  invalidation lag.** A 1-hour cache means a deleted agent can
  keep calling for up to an hour. We pick 5 minutes for the JWKS
  cache (vs 1 hour for the Cognito JWKS publication cadence) —
  the cost is one extra JWKS fetch every 5 minutes per MCP
  process; the benefit is bounded compromise window.
- **`human_principal` is informational, not authenticated.**
  A compromised BFF could spoof the field for an audit row. We
  accept it: the authenticated principal is still the BFF role,
  and the audit row can be reconstructed from request logs if
  spoofing is suspected.
- **Operator UX for paste-the-secret-into-the-agent is rough.**
  No QR code, no copy-button, no provisioning helper. v1 ships
  the credentials in CLI stdout; agent-side config is the
  operator's job. Better UX is a follow-up.
- **No multi-tenancy across operator deployments.** Solving that
  is a different product (a hosted Open Sesame). The single-
  operator model is what ADR-0006 commits to.
