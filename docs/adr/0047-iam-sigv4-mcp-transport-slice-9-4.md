# IAM SigV4 transport for the MCP server, slice 9.4

ADR-0046 (slice 9.3) moved every tool implementation into the MCP
server's tool registry, with the BFF reaching MCP through an
in-process `mcpClient.call(tool, input, ctx)` port. This slice
gives the MCP server an HTTP entry and a real wire — `mcpClient`
keeps the same port surface but its production implementation
becomes "send a SigV4-signed POST to the MCP server's URL".

The slice is deliberately scoped to the **internal** caller path:
the BFF Lambda's IAM role calling MCP. ADR-0048 (slice 9.5) adds
the external OAuth path for agents. ADR-0005's "two issuance paths,
one Grant model" promise lands in two halves; this is the first
half.

## What this slice ships

1. `mcpServer.serveHttp()` — a Hono app that mounts the same tool
   registry behind an `/mcp/tools/call` endpoint, with SigV4
   verification middleware.
2. A SigV4 verifier that parses the inbound request's
   `Authorization` header, derives the caller's role ARN, and
   constructs a `ToolContext` with `principal: { kind: "iam",
   roleArn }`.
3. The HTTP `McpClient` implementation — `sendSigV4Request(...)` —
   that signs outbound requests with the caller's AWS creds.
4. Two `mcpClient` factories on the BFF: `makeInProcessMcpClient`
   (slice 9.3 default; still used by the integration harness and
   solo-direct-with-MCP) and `makeHttpMcpClient` (the production
   default once slice 9.6 deploys MCP separately).
5. The CLI gains MCP mode: `opensesame --mcp` flips the
   `mcpClient` factory and the same library code reaches MCP over
   HTTP+SigV4. ADR-0006's promise of "one CLI, two modes" pays off.
6. Grant rows for IAM principals start being written. The
   bootstrap step (slice 9.2) now optionally takes an
   `iam#<role-arn>` for a CDK-deploy-time Grant on the BFF Lambda's
   role; an admin caller can also `create_grant` for any IAM role.

## What this slice does *not* ship

- **No agent OAuth path.** External agents (Claude Desktop, custom
  clients) still cannot reach MCP. That's slice 9.5 (ADR-0048).
- **No tool-advertisement filtering.** The BFF has full
  `admin:grants` reach; the CLI in MCP mode has the operator's IAM
  role's reach. Filtering is meaningful when external agents
  arrive.
- **No MCP wire-protocol JSON-RPC envelope.** `/mcp/tools/call`
  takes a flat JSON body — `{ tool, input }` — and returns the
  tool result or a structured error. The full MCP `initialize` /
  `tools/list` / `tools/call` JSON-RPC handshake comes when the
  external clients arrive (slice 9.5+); the internal-only shape
  doesn't need the negotiation step.
- **No MCP-server CDK stack.** Slice 9.4 still runs the MCP server
  in the same process as the BFF for local verification (just over
  loopback HTTP, with SigV4-signed loopback requests). Slice 9.6
  splits them into separate Lambdas.
- **No mTLS, no IP allow-listing, no API Gateway resource policies.**
  SigV4 is the auth, period. AWS-internal callers reach MCP over
  the regional VPC endpoint or public DNS depending on slice 9.6's
  CDK posture; the auth shape doesn't change.

## Decision

### HTTP shape

```text
POST /mcp/tools/call
  Authorization: AWS4-HMAC-SHA256 ...   (SigV4)
  X-Amz-Date: ...
  X-Amz-Content-Sha256: ...
  Content-Type: application/json
  Body: { "tool": "send_email", "input": { ... } }

→ 200 { "result": { ... } }
→ 400 { "error": { "kind": "invalid_input", "field": "...", "reason": "..." } }
→ 401 { "error": { "kind": "auth_failed", "message": "..." } }
→ 403 { "error": { "kind": "grant_denied", "message": "..." } }
→ 404 { "error": { "kind": "tool_not_found", "tool": "..." } }
→ 500 { "error": { "kind": "domain_error", "code": "...", "message": "..." } }
```

The wire envelope is intentionally **flatter** than the BFF's
`POST /rpc/<tool>` shape: tool name lives in the body, not the
URL. Reasons:

- One HTTP path means SigV4's `canonical_uri` is constant. Easier
  to debug a signature mismatch.
- The MCP wire protocol (slice 9.5+) is JSON-RPC over a single
  endpoint — every tool call goes to `/mcp` with `method:
  "tools/call"`. The internal shape we ship here is one step
  removed from that target shape (rather than two), which makes
  slice 9.5's migration smaller.
- IAM policies that allow specific tools are awkward when tool name
  is part of the path (`Resource: arn:.../mcp/tools/call/*`); much
  cleaner with a single path and capability-scoped Grants doing the
  per-tool gating.

### SigV4 verification

`X-Amz-Date` + `Authorization: AWS4-HMAC-SHA256 Credential=...,
SignedHeaders=..., Signature=...` is the standard SigV4 envelope.
The verifier:

1. Reads the headers. Reject if missing or malformed.
2. Extracts the **access key** from the `Credential` field.
3. Calls AWS STS `GetCallerIdentity` with the inbound request's
   signature — this is the [aws-sigv4-verifier](https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html)
   pattern: STS validates the signature server-side and returns
   the caller's role ARN. Cached by access-key for 5 minutes.
4. Maps the role ARN to a principal: `{ kind: "iam", roleArn:
   "arn:aws:iam::<acct>:role/<role-name>" }`. Sessions
   (`sts:AssumeRole` followed by signing under the assumed-role's
   credentials) flatten to the underlying role ARN — the
   session-name suffix is dropped because Grants apply to the role,
   not the session.

`STS GetCallerIdentity` is rate-limited (1000 TPS per account, more
than enough). The 5-minute caching is keyed by access key; a
revoked credential continues to validate for up to 5 minutes after
revocation. Acceptable for the threat model — a revoked role is the
operator's deliberate action and 5 minutes is the same lag the
Grant cache (slice 9.2) already accepts.

### Why SigV4 over IAM auth via API Gateway

API Gateway's IAM auth does this same SigV4 verification, baked in.
We could use it and skip the verifier code. We don't, for two
reasons:

1. **The MCP server's HTTP entry needs to be runnable outside API
   Gateway** — the integration test harness boots `serveHttp()` in
   process and signs loopback requests; AWS Lambda Function URLs
   with `AuthType: AWS_IAM` are an option but not for local dev.
   A self-hosted verifier works in every shape (loopback, Lambda,
   API Gateway, EC2).
2. **The CLI in MCP mode needs to sign requests against whatever
   URL the operator points it at.** API Gateway-only would mean the
   CLI hard-codes API Gateway's region/host pattern; a generic
   verifier means the CLI signs against the URL the operator
   configures.

We *use* API Gateway in slice 9.6 — but as a passthrough, not as
the auth boundary. Auth is the MCP server's job.

### Role → principal → Grant lookup

`requireGrant` (slice 9.2) keys Grants by `principal` SK:
`cognito#<sub>` for human / agent OAuth callers, `iam#<role-arn>`
for SigV4 callers. Slice 9.4 starts producing the second form.

The Grant cache (per-process, 60s TTL, slice 9.2) shares a single
namespace; lookups by `iam#<role-arn>` slot in alongside Cognito
ones with no schema change.

### `mcpClient` factories

```ts
// src/mcp/client.ts
export type McpClient = {
  call(tool: string, input: unknown, ctx: ClientContext): Promise<McpCallResult>;
};

// In-process. Used by the integration harness, by solo-direct-with-MCP.
export function makeInProcessMcpClient(server: McpServer): McpClient;

// HTTP+SigV4. Used by the BFF in production, by the CLI in MCP mode.
export type HttpMcpClientDeps = {
  url: string;             // https://<mcp-host>/mcp/tools/call
  awsRegion: string;
  awsCredentials: AwsCredentialIdentityProvider;  // from @aws-sdk
  fetch?: typeof fetch;    // injected for tests
};
export function makeHttpMcpClient(deps: HttpMcpClientDeps): McpClient;
```

`ClientContext` is the *outbound* equivalent of `ToolContext`: the
caller-supplied principal + grant. For `makeInProcessMcpClient`,
the context flows through unchanged. For `makeHttpMcpClient`, the
client *ignores* the inbound context (the server constructs its own
from the SigV4-verified caller identity) — but it logs a warning if
the caller passed a Cognito principal: an HTTP MCP client signing
with IAM creds shouldn't be impersonating a Cognito principal.

### BFF Lambda's role: how does it sign?

The BFF Lambda runs with an IAM execution role. The
`makeHttpMcpClient` factory uses `defaultProvider()` from
`@aws-sdk/credential-providers`, which resolves to the Lambda role's
temporary credentials at runtime. No secrets in env, no key
rotation surface; AWS handles the credential lifecycle.

The BFF Lambda's role has one Grant, written at deploy time:

```ts
{
  address: "*",  // see below
  principal: "iam#arn:aws:iam::<acct>:role/opensesame-bff-lambda-<env>",
  capabilities: ["read", "write", "draft", "send", "send-on-behalf-of",
                 "admin:grants", "admin:agents"],
  ...
}
```

But `address: "*"` is **not** a Grant value the slice-9.2 lookup
supports. Two options:

- **Per-address Grants for the BFF role.** One Grant row per
  address in `OPENSESAME_INITIAL_RECIPIENTS`. The CDK bootstrap
  step writes them. Adding an address means redeploying CDK,
  which is consistent with ADR-0011's deploy-is-the-update
  posture.
- **A wildcard SK.** `iam#<role-arn>` SK plus a special PK value
  (`__GLOBAL__` or similar) that the middleware checks
  *additionally* on every lookup miss.

We pick the first. The wildcard option leaks complexity into every
`requireGrant` call and the operator only deploys with a known
address list anyway. The redeploy cost is acceptable.

### CLI in MCP mode

```text
opensesame --mcp send --from alice@acme.com --to bob@example.com ...
```

The flag flips:

- The CLI's bootstrap reads `OPENSESAME_MCP_URL` from env (set when
  CDK deploys the MCP server, also overridable for dev).
- `mcpClient` is `makeHttpMcpClient` with creds from the AWS SDK
  default provider chain (env vars, profile, EC2 metadata).
- Every CLI subcommand routes through `mcpClient.call(tool, input,
  ctx)`. The CLI is now a thin shell over MCP.

Without `--mcp` the CLI runs in direct mode: imports the core
library, builds `MessageReader` directly. Same shape it has today.
Both modes produce the same output for any operation the operator
has authority for.

### Solo-direct-with-MCP at runtime

ADR-0006 names a deployment shape between solo-direct and
multi-user: solo-with-MCP. After slice 9.4:

- The operator can run the MCP server locally
  (`pnpm tsx src/bin/mcp-server.ts`) on loopback.
- Use the CLI in MCP mode against that loopback URL with their
  local AWS creds.
- External agents reach MCP through Cognito (slice 9.5).

That's solo-with-MCP. Slice 9.4 doesn't ship the deploy shape —
slice 9.6's CDK does — but the *runtime* path lights up here.

### Loopback bind guard: lifted on the MCP server, kept on the BFF

ADR-0044 (slice 9.1) kept the BFF's loopback-only bind guard until
slice 9.6 deploys it behind real DNS + TLS. The MCP server gets
the *same* guard until slice 9.6. Both refuse non-loopback binds
in 9.4.

The trio of slices (9.4 + 9.5 + 9.6) deliberately ship locally
first: SigV4 plus OAuth plus the agent registration flow can all
be verified against loopback URLs before any of it is exposed to
the public internet. ADR-0021's "the bind guard exists so we
remember to lift it deliberately" property is preserved.

### MCP server entry point: separate binary

`src/bin/mcp-server.ts` (new). Not a route added to `webmail-bff.ts`.
The two binaries:

- `src/bin/webmail-bff.ts` — boots Hono with `/auth/*` + `/rpc/*`,
  constructs `mcpClient` (in-process for dev, HTTP for prod via
  env), passes it into the dispatcher. Owns the session-cookie
  middleware.
- `src/bin/mcp-server.ts` — boots Hono with `/mcp/tools/call`,
  constructs the tool registry directly, owns the SigV4 middleware.
  No session-cookie middleware. No `/auth/*`.

Slice 9.6 deploys them as separate Lambdas. Slice 9.4 supports
either running both in the same process (the integration test
harness) or in two processes (the operator's local dev shape).

The `BffRuntimeDeps` factory (slice 8 / our last refactor in
`webmail-bff.ts`) splits into two factories: `BffRuntimeDeps` keeps
the BFF's deps (session secret, Cognito config, MCP URL),
`McpServerRuntimeDeps` carries the MCP server's deps (the full
`ToolDeps` from slice 9.3 plus AWS region for SigV4 verification).

## Inherits from

- **ADR-0005** — IAM SigV4 for AWS-internal callers; this slice is
  that side of the dual auth path.
- **ADR-0006** — solo-with-MCP runtime is now deployable;
  multi-user is closer (still needs slice 9.5 + 9.6).
- **ADR-0011** — `OPENSESAME_MCP_URL`, `OPENSESAME_BFF_URL`, and
  related deploy outputs land in the CDK output set; operator
  picks them up by re-running `pnpm opensesame configure`.
- **ADR-0021** — wire format. The BFF's `/rpc/<tool>` envelope is
  unchanged; `/mcp/tools/call` is a separate envelope with one
  hop's worth of translation (the BFF's HTTP client converts
  between them).
- **ADR-0044** — session middleware unchanged; it now produces a
  `principal` that the BFF passes to `mcpClient` *informationally*
  in the in-process shape, and is **discarded** in the HTTP shape
  (the MCP server reconstructs principal from SigV4).
- **ADR-0045** — `iam#<role-arn>` Grant principals; the CDK
  bootstrap step grows an IAM-role bootstrap variant.
- **ADR-0046** — the in-process MCP server registry is the basis;
  this slice exposes it over HTTP.

## Files

| Layer | File | Change |
|---|---|---|
| MCP | `src/mcp/server.ts` | Add `serveHttp(): Hono` method that wraps the registry |
| MCP | `src/mcp/sigv4-middleware.ts` | New: parse Authorization header, verify with STS, attach `c.var.principal` |
| MCP | `src/mcp/sigv4-verifier.ts` | New: STS GetCallerIdentity wrapper, 5-minute access-key cache |
| MCP | `src/mcp/client.ts` | Add `makeHttpMcpClient`; existing `makeInProcessMcpClient` unchanged |
| MCP entry | `src/bin/mcp-server.ts` | New: separate binary; reads `OPENSESAME_MCP_*` envs; loopback bind guard |
| BFF entry | `src/bin/webmail-bff.ts` | Read `OPENSESAME_MCP_URL`; pick `makeHttpMcpClient` over `makeInProcessMcpClient` when set |
| CLI | `src/bin/opensesame.ts` | New `--mcp` flag; routes through `makeHttpMcpClient` |
| CDK | `src/cdk/auth-stack.ts` | Add IAM role for the MCP server Lambda (slice 9.6 will mount it) |
| CDK | `src/cdk/bootstrap-grant.ts` | Optional `iam#<role-arn>` bootstrap variant |
| Tests | `test/mcp-sigv4-middleware.test.ts` | New: header parsing, STS stub, cache hit/miss, malformed-auth 401 |
| Tests | `test/mcp-http-transport.test.ts` | New: end-to-end loopback — sign request, verify, dispatch, translate result |
| Tests | `test/cli-mcp-mode.test.ts` | New: `--mcp` routes through HTTP client; default routes through library |
| Tests | `test/bff-integration.test.ts` | Add a "BFF over HTTP MCP" variant that boots both Hono apps in the same process and points the BFF's MCP client at the loopback MCP URL |

## Verification

1. Boot the MCP server locally: `pnpm tsx src/bin/mcp-server.ts`.
   Boot the BFF in a second terminal with
   `OPENSESAME_MCP_URL=http://127.0.0.1:3001/mcp/tools/call`.
   Webmail UI works exactly as before; latency adds ~5–10ms per call.
2. From a third terminal, `opensesame --mcp send --from alice@acme.com
   --to bob@example.com --subject test --body hi`. Send succeeds.
   The audit log carries the BFF Lambda's role-derived principal.
3. Wait. Manually delete the BFF Lambda's role's Grant for one
   address. Within the cache TTL, `read_inbox` for that address
   returns 403. The BFF's logs show the Grant denial; the MCP
   server's logs show the SigV4 verification succeeded but the
   Grant lookup failed.
4. Strip the `Authorization` header from a request to MCP. The
   server returns 401 `auth_failed` and never invokes a tool.
5. Replay an old SigV4-signed request (the `X-Amz-Date` is
   90 minutes ago). The verifier rejects with 401 (the standard
   SigV4 freshness window is 15 minutes; STS enforces it).
6. The integration harness's "BFF over HTTP MCP" variant boots both
   Hono apps in-process and runs the same 6 regression tests; all
   pass.

## Trade-offs accepted

- **STS GetCallerIdentity round-trip per access-key.** ~50ms cold,
  cached for 5 minutes. The alternative — verifying the SigV4
  signature ourselves with the access key's secret — requires
  storing the secret, which AWS does not let us do for assumed-role
  credentials. STS-based verification is the only correct path.
- **Two HTTP envelopes.** The BFF speaks `/rpc/<tool>` (ADR-0021);
  MCP speaks `/mcp/tools/call`. The translation layer is in
  `mcpClient`. Worth it: the BFF's URL shape is what the webmail
  UI consumes (`fetch("/rpc/read_inbox", ...)`); the MCP shape is
  what slice 9.5's external agents will consume (close to JSON-RPC).
  Two clients with different URL conventions is cheaper than one
  shared envelope that compromises both.
- **Loopback-only in 9.4.** Same trade-off ADR-0021 made for the
  BFF: the auth is correct, but exposure is deliberately deferred
  to the slice that ships CDK + DNS + TLS. Slice 9.6.
- **IAM-only in 9.4.** External agents can't reach MCP. That's
  intentional — slice 9.5's OAuth + agent-registration is non-trivial
  and shipping it stacked on top of an unverified SigV4 path is
  worse than shipping them separately.
- **CLI-in-MCP-mode is the test bed for SigV4.** A second user of
  the SigV4 client surface (besides the BFF Lambda) is the only way
  to catch "the BFF works because it's running in the same process
  as MCP" failure modes. The CLI is the cheap second user.
- **The audit log records the role ARN, not the human.** When a
  human invokes the BFF and the BFF then invokes MCP, the audit
  row records the BFF's IAM role as the principal. ADR-0001 wants
  the *human* attributed; that's slice 9.5's job (the BFF will
  pass `human_principal` in a custom header that MCP records as
  metadata on the audit row).
