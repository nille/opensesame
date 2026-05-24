# Production deploy shape, slice 9.6

ADR-0044 through ADR-0048 (slices 9.1–9.5) shipped Cognito, the
Grant table, the in-process MCP server, the SigV4 transport, and the
external agent path — all locally verified against `127.0.0.1`. Two
loopback bind guards still refuse non-loopback startup: one in
`src/bin/webmail-bff.ts` (ADR-0021's), one in `src/bin/mcp-server.ts`
(ADR-0047's). This slice deploys both behind real DNS + TLS, lifts
the guards, and ends slice 9.

The slice is mostly CDK. The only runtime code change is removing
the loopback refusal on the two binaries and adding a Lambda entry
adapter (Hono → APIGatewayProxyResultV2). Every contract pinned in
9.1–9.5 is honored as-is; this slice is the *deployment* of the
shape those slices designed.

## What this slice ships

1. A new **`AuthStack`** owning the Cognito User Pool + app client +
   resource server + `humans` / `agents` groups + the bootstrap-Grant
   PutItem (slice 9.2's CDK-time row). The User Pool moved here from
   ADR-0044's earlier hand-wave because Hosted UI domain certs need
   to live in the same stack as the User Pool, and the BFF Lambda's
   client-secret reference is cleaner across stacks via `CfnOutput`
   than across stack files.
2. A new **`WebmailComputeStack`** owning the BFF Lambda, the MCP
   server Lambda, two API Gateway HTTP APIs (one per Lambda), the
   Route 53 alias records into the operator's hosted zone, and the
   ACM cert. `OPENSESAME_BFF_URL` and `OPENSESAME_MCP_URL` are
   `CfnOutput`s.
3. **Both binaries lose their loopback bind guards.** The guards
   relied on a "no auth → must be loopback" property that no longer
   holds. Binding 0.0.0.0 in 9.6 is correct — the Lambda runtime
   binds for us anyway, and local-dev `pnpm tsx` against the same
   code paths still defaults to 127.0.0.1 via the `--host` flag, so
   accidental local exposure stays gated behind an explicit operator
   choice.
4. A **Hosted UI custom domain**, `auth.<webmail-host>` — deferred
   from ADR-0044's `<pool-id>.auth.<region>.amazoncognito.com`
   default. The certificate goes in the same Route 53 zone the BFF
   uses; ACM in `us-east-1` is required for CloudFront-fronted
   Hosted UI domains, so the auth stack creates a `us-east-1` cert
   alongside the main-region one. Operator pays for one DNS name;
   we get HSTS-clean redirects.
5. A **smoke harness** (`smoke/slice-9-6/`) that runs against the
   *deployed* stack and exercises: human login → `read_inbox`,
   external-agent token → `read_inbox`, `create_agent` → token →
   call → `delete_agent` → 401 cycle, BFF→MCP `human_principal`
   propagation. Distinct from the integration harness (slice 8
   recap, ADR-0042 era) which boots the apps in-process; this one
   is HTTPS-only, real Lambda, real Cognito.
6. The CDK output set grows so `pnpm opensesame configure` (the
   operator's local-dev configuration step) writes a `.env.local`
   with `OPENSESAME_BFF_URL`, `OPENSESAME_MCP_URL`,
   `OPENSESAME_USER_POOL_ID`, `OPENSESAME_USER_POOL_CLIENT_ID`,
   `OPENSESAME_USER_POOL_DOMAIN`, and the `OPENSESAME_BOOTSTRAP_PRINCIPAL`
   the operator should pass on first deploy.

## What this slice does *not* ship

- **No multi-region.** ADR-0009 / ADR-0011 pin region posture
  (eu-north-1 today). The auth stack is single-region; the
  `us-east-1` cert is the only cross-region resource and exists
  solely because Hosted UI requires it.
- **No WAF.** API Gateway HTTP APIs do not natively support WAF;
  WAFv2 attaches to the Lambda function URL or the REST API
  variant, neither of which we use. ADR-0005's threat model
  (operator-deployed, single-tenant) does not require WAF in v1;
  rate limiting is left to API Gateway's per-route throttling and
  Cognito's built-in advanced security.
- **No observability stack changes.** CloudWatch logs + the existing
  ingestDlq metric alarms (ComputePlaneStack) cover the new
  Lambdas. ADR-0050 (post-slice-9 hardening) is where structured
  log aggregation + alarms across the BFF + MCP Lambdas land.
- **No CDK-managed secret rotation.** `OPENSESAME_SESSION_SECRET`
  (slice 9.1) lives in Secrets Manager but the rotation Lambda is
  out — operator rotates by re-deploying with a new value, same
  posture as 9.1 envisioned.
- **No staging environment.** Operators run one CDK stack per
  deployment per ADR-0011. A second `cdk deploy` against a
  different account/region is the staging story; this slice
  doesn't carve a "staging vs prod" parameter into the stack.
- **No CloudFront in front of API Gateway.** API Gateway HTTP API
  ships with TLS termination + a regional edge. CloudFront would
  add latency in front of a single-region operator deployment for
  no clear gain; revisit if multi-region happens.

## Decision

### Stack composition

The CDK app grows from 4 to 6 stacks:

```text
DataPlaneStack         (ADR-0011, unchanged) — RETAIN tables, bus, S3
ComputePlaneStack      (ADR-0012, unchanged) — SES Lambda → ingest
SesIngressStack        (ADR-0013, unchanged) — receipt rule set, MX/DKIM
BounceHandlerStack     (ADR-0018, unchanged) — bounce/complaint
AuthStack              (NEW)                 — User Pool, Hosted UI, IAM roles
WebmailComputeStack    (NEW)                 — BFF Lambda, MCP Lambda, API GW
```

The split between `Auth` and `WebmailCompute` follows the
DataPlane/ComputePlane split (ADR-0011): `Auth` is RETAIN (the User
Pool is stateful — deleting it loses every user's password reset
and MFA secrets); `WebmailCompute` is REPLACE (Lambdas + API
Gateway are stateless redeployable artifacts).

The `Auth` stack also owns the Agents DynamoDB table (slice 9.5)
because the agent records are stateful: an operator who recreates
the Webmail compute should not lose agent registrations. The
Grants table from slice 9.2 lives in `DataPlane` for the same
reason — Grants survive compute churn.

### Stack dependencies and outputs

```text
AuthStack
├─ exports: userPoolId, userPoolClientId, userPoolDomain,
│           bffLambdaRoleArn, mcpLambdaRoleArn,
│           agentsTable
│
WebmailComputeStack
├─ imports: userPool*, agentsTable, *LambdaRoleArn  (from AuthStack)
│           messagesTable, suppressionsTable, rawMimeBucket,
│           eventBus, grantsTable                    (from DataPlaneStack)
└─ exports: bffUrl, mcpUrl, bffCustomDomain, mcpCustomDomain
```

CDK's cross-stack reference machinery handles the wiring. The
import is by the construct's stable ID (ADR-0011), which means a
stack rename would break references — the rename is exactly the
thing CDK's stable IDs prevent, so the cost is "remember to use
the same construct IDs across all stacks", which the codebase
already does.

### `AuthStack` shape

```ts
export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly userPoolDomain: UserPoolDomain;       // auth.<webmail-host>
  readonly resourceServer: UserPoolResourceServer; // opensesame-mcp / mcp:invoke
  readonly bffLambdaRole: Role;
  readonly mcpLambdaRole: Role;
  readonly agentsTable: Table;
  readonly grantsTable: Table; // moved from DataPlane in slice 9.2

  constructor(scope: Construct, id: string, props: AuthStackProps) { ... }
}
```

Three IAM roles created here, not in `WebmailCompute`:

1. **`bffLambdaRole`** — execution role for the BFF Lambda. Permissions:
   - DynamoDB `Query`/`GetItem`/`PutItem`/`UpdateItem` on Messages,
     Drafts, Suppressions, Grants, Agents (write to Drafts +
     Suppressions + Audit + Grants + Agents only — read on the
     others).
   - S3 `GetObject`/`PutObject` on `rawMimeBucket` (PutObject is
     for `stage_attachment`).
   - SES `SendEmail` for the configured From: addresses (per
     ADR-0008's IAM backstop).
   - Cognito `cognito-idp:AdminInitiateAuth`, `RevokeToken`,
     `CreateUserPoolClient`, `DeleteUserPoolClient` (the last two
     are for `create_agent` / `delete_agent` — admin RPCs).
   - Secrets Manager `GetSecretValue` for `OPENSESAME_SESSION_SECRET`.
   - `lambda:InvokeFunction` on the MCP Lambda is **not** here —
     the BFF reaches MCP via API Gateway, not direct Lambda
     invoke, because the SigV4 verification path is the same
     across "BFF Lambda calls MCP" and "external CLI calls MCP",
     and a direct `lambda:Invoke` would skip API Gateway's
     throttling.

2. **`mcpLambdaRole`** — execution role for the MCP Lambda. Permissions:
   - DynamoDB read/write on the same tables as the BFF — the BFF
     today does the work, post-9.6 the MCP Lambda does it. Both
     roles need it during the migration window when an operator
     redeploys.
   - S3, SES, Cognito as above.
   - `sts:GetCallerIdentity` for the SigV4-verifier path (slice
     9.4). This is implicit on every IAM principal, but we add an
     explicit `Allow sts:GetCallerIdentity Resource: *` to make
     the policy auditable.

3. **A bootstrap-Grant Lambda + custom resource** — slice 9.2's
   Grant bootstrap is a CDK-time `PutItem`. A `AwsCustomResource`
   with `onCreate` + `onUpdate` runs the PutItem against the
   Grants table; the resource's physical ID is the principal SK so
   re-deploys are idempotent.

`AuthStack`'s `RemovalPolicy` is `RETAIN` for the User Pool, the
Agents table, and the Grants table. CDK destroy-then-recreate of
these is the user-data-loss path; the retain policy means a
careless `cdk destroy` survives.

### `WebmailComputeStack` shape

Two `NodejsFunction`s and two `HttpApi`s. The BFF Lambda's handler
is a thin Hono → API-Gateway adapter; the same `buildBffApp(deps)`
factory from slice 8.18's refactor (`src/bff/build-app.ts`) is
called by both `src/bin/webmail-bff.ts` (local dev) and
`src/lambda/webmail-bff.handler.ts` (Lambda). The MCP server has
the same shape: `buildMcpApp(deps)` is called from
`src/bin/mcp-server.ts` and `src/lambda/mcp-server.handler.ts`.

```ts
// src/lambda/webmail-bff.handler.ts (new)
import { handle } from "hono/aws-lambda";
import { buildBffApp } from "../bff/build-app.js";
import { resolveDeps } from "./bff-deps.js"; // reads env, builds AWS clients

const app = buildBffApp(await resolveDeps());
export const handler = handle(app);
```

`hono/aws-lambda` is the official Hono adapter; it speaks
APIGatewayProxyEventV2 / APIGatewayProxyResultV2 and respects
Hono's middleware chain (sessions, CORS, requireGrant). One file,
~10 lines.

The Lambda's environment block:

```text
NODE_OPTIONS                       --enable-source-maps
OPENSESAME_AWS_REGION              <stack region>
OPENSESAME_DEPLOYMENT_ID           <from CDK context>
OPENSESAME_BOOTSTRAP_PRINCIPAL     <CDK context, default empty>
OPENSESAME_USER_POOL_ID            <from AuthStack>
OPENSESAME_USER_POOL_CLIENT_ID     <from AuthStack>
OPENSESAME_USER_POOL_DOMAIN        <from AuthStack>
OPENSESAME_SESSION_SECRET_ARN      <Secrets Manager ARN>
OPENSESAME_MCP_URL                 <https://mcp.<webmail-host>/mcp/tools/call>
OPENSESAME_RAW_MIME_BUCKET         <from DataPlaneStack>
OPENSESAME_GRANTS_TABLE            <from AuthStack>
OPENSESAME_AGENTS_TABLE            <from AuthStack>
... (the existing DDB table names for Messages, Drafts, etc.)
```

`OPENSESAME_SESSION_SECRET_ARN` is the ARN; `resolveDeps` does one
`GetSecretValue` at cold start and caches in module scope. Lambda
warm invocations don't re-fetch.

### API Gateway HTTP APIs

**BFF API:**

```text
HttpApi:           opensesame-webmail
DomainName:        webmail.<hosted-zone-name>
DefaultStage:      $default (auto-deploy)
DefaultIntegration: HttpLambdaIntegration(bffLambda)
CORS:               allowOrigins: [https://webmail.<host>], allowCredentials: true
Throttle:           burstLimit 100, rateLimit 50  (per-route default)
```

The CORS allowlist is intentionally **only** the production
webmail origin. Local dev is `http://localhost:5173` against
`http://127.0.0.1:3000` — that runs against a non-deployed BFF
(`pnpm tsx src/bin/webmail-bff.ts`), so the CDK's CORS posture
doesn't apply.

**MCP API:**

```text
HttpApi:           opensesame-mcp
DomainName:        mcp.<hosted-zone-name>
DefaultStage:      $default (auto-deploy)
DefaultIntegration: HttpLambdaIntegration(mcpLambda)
CORS:               disabled (MCP callers don't run in browsers)
Throttle:           burstLimit 200, rateLimit 100  (agent traffic > human)
```

Two API Gateways instead of one with two paths because:

- Different CORS postures — the webmail UI fetches `/rpc/*` from a
  browser; MCP callers (Claude Desktop, Inspector, the CLI) never
  do, and locking MCP behind no-CORS prevents accidental browser
  exposure.
- Different throttle profiles — agent traffic is bursty and
  scripted; human traffic is interactive.
- Independent scaling — an agent storming MCP shouldn't degrade
  webmail latency for the operator.
- Different DNS subdomains map cleanly: `webmail.<host>` for
  humans, `mcp.<host>` for agents. Operator can put one behind a
  VPN and not the other if they want to.

The operator pays for two API Gateway resources. HTTP API pricing
is $1.00 / million requests (us-east-1; eu-north-1 ≈ same), so
two resources is "two flat rates" not "double the cost".

### Lambda function URLs vs API Gateway

Function URLs (`AuthType: NONE`, since the MCP server does its own
SigV4 verification per ADR-0047) are cheaper — $0 for the URL
itself, only Lambda invocation cost. We chose API Gateway HTTP API
anyway, for two reasons:

1. **Custom domains.** Function URLs do not support custom
   domains; only `<id>.lambda-url.<region>.on.aws`. The operator's
   webmail at `webmail.<host>` is non-negotiable for TLS-cert UX
   (Hosted UI redirects, browser bookmarks) — Function URL forces
   a CloudFront distribution in front anyway, which costs more
   than HTTP API.
2. **Per-route throttling.** Function URL has one throttle for
   the whole Lambda; HTTP API can throttle `/rpc/send_email`
   tighter than `/rpc/read_inbox` if needed (not yet, but the
   ability is free). Useful as a tactical lever post-9.6.

The cost difference at idle is ~$0/month (API Gateway HTTP API
has no per-hour charge). Under load, the per-million-requests fee
is $1.00; for an operator's mailbox volume (tens to hundreds of
calls per day) the ledger reads "essentially free".

### Custom domain + ACM cert

The hosted zone (`OPENSESAME_HOSTED_ZONE_*`) is the same one
`SesIngressStack` already imports. We import it again in
`WebmailComputeStack`:

- `webmail.<zone-name>` → API Gateway HTTP API custom domain
- `mcp.<zone-name>` → API Gateway HTTP API custom domain
- `auth.<zone-name>` → Cognito User Pool custom domain

ACM certs:

- One regional cert for `webmail.<zone-name>` and
  `mcp.<zone-name>` in the stack's region (eu-north-1).
- One `us-east-1` cert for `auth.<zone-name>` because Cognito's
  custom domain runs on CloudFront.

A SAN cert on the regional cert covers both subdomains; one
ACM resource, two API Gateway domain names. The DNS validation
record goes into the same hosted zone the operator already owns.

### Removing the loopback bind guards

`src/bin/webmail-bff.ts` (slice 7) and `src/bin/mcp-server.ts`
(slice 9.4) both refuse to start unless bound to a loopback
interface. The guard is at the top of the boot sequence:

```ts
const bind = process.env.OPENSESAME_BFF_BIND ?? "127.0.0.1";
if (!isLoopback(bind)) {
  throw new Error(
    `OPENSESAME_BFF_BIND=${bind} is not loopback. Refusing to start.`,
  );
}
```

In Lambda, the runtime owns the bind; this code path doesn't run.
But the *binary* still has the check, and a developer running
`OPENSESAME_BFF_BIND=0.0.0.0 pnpm tsx ...` locally would hit it.

Slice 9.6 deletes the check from both binaries. The replacement is
**no check** — the dev default of `127.0.0.1` is preserved; an
operator who explicitly sets `OPENSESAME_BFF_BIND=0.0.0.0`
locally is doing it deliberately, and the auth front door (slice
9.1) is the meaningful guard against unauthorized access.

A regression test for "the local dev default is 127.0.0.1" lives
in `test/bin-defaults.test.ts` (new). The test imports the bin
and asserts the default. The previous "refuses to start" test
goes away.

### Smoke harness

`smoke/slice-9-6/` is a separate package — not part of the
in-process integration harness from slice 8 — that runs against
the *deployed* stack. It reads the same `.env` an operator's
local dev would use:

```text
OPENSESAME_BFF_URL=https://webmail.<zone>/
OPENSESAME_MCP_URL=https://mcp.<zone>/mcp/tools/call
OPENSESAME_USER_POOL_ID=...
OPENSESAME_USER_POOL_CLIENT_ID=...
OPENSESAME_USER_POOL_DOMAIN=auth.<zone>
OPENSESAME_TEST_USER_EMAIL=...
OPENSESAME_TEST_USER_PASSWORD=...   (one operator-managed test user)
```

Three suites:

1. **`human-flow.smoke.ts`** — drive the BFF as a human:
   - `POST /auth/login` (programmatic — the test reads the Hosted
     UI's `/oauth2/authorize` redirect, completes the form via
     Cognito's `AdminInitiateAuth` for the test user, posts the
     code to `/auth/callback`).
   - `POST /rpc/read_inbox` returns 200.
   - `POST /rpc/send_email` returns 200; the audit row in DynamoDB
     carries the test user's `human_principal: cognito#<sub>`.
   - `POST /auth/logout` → 302; subsequent `read_inbox` returns 401.

2. **`agent-flow.smoke.ts`** — drive MCP as an agent:
   - Pre-condition: the operator has run `opensesame agents
     create --display-name smoke-agent --agent-id smoke-agent`
     once and saved the secret.
   - `POST` to Cognito `/oauth2/token` with `client_credentials`,
     receive an access token.
   - `POST $MCP_URL` with `Authorization: Bearer ...` and
     `tool: "read_inbox"`. Returns 200 with the seeded-mailbox
     contents.
   - `tool: "delete_agent"` → 403 (the agent's Grant doesn't
     include `admin:agents`).

3. **`agent-lifecycle.smoke.ts`** — full register/use/delete cycle:
   - As the operator (IAM creds, signing SigV4), call MCP
     `create_agent` → receive credentials.
   - Use those credentials per `agent-flow.smoke.ts`.
   - Call MCP `delete_agent`. Wait 30s for JWKS cache. Call MCP
     with the now-stale token → 401.

The smoke harness runs in CI on every push to main, gated on a
`SMOKE_TESTS=enabled` env flag, against a long-lived staging
account the maintainers own. Operator deployments don't re-run
this — they verify their own deploy interactively (see
"Verification" below).

### CDK cost ceiling — Open Question 3 from the PRD

ADR-0011 commits to operator-runs-the-CDK posture; the operator
should know what they're signing up for. Idle-state cost ceiling
for the slice 9.6 stack (per AWS public pricing as of 2026-04, in
USD, at eu-north-1 rates):

| Resource | Idle cost / month | Active cost driver |
|---|---|---|
| Cognito User Pool | $0 (free tier 50k MAU) | $0.0055 / MAU above 50k |
| Cognito advanced security | $0 | optional, $0.05 / MAU |
| API Gateway HTTP API × 2 | $0 (no per-hour charge) | $1.00 / million requests |
| Lambda BFF + MCP | $0 (idle) | $0.20 / million requests + $0.0000167 / GB-second |
| DynamoDB Messages, Drafts, Suppressions, Grants, Agents | $1.25 / GB-month storage; ~$0 idle | $1.25 / million write requests, $0.25 / read |
| S3 raw-mime bucket | $0.023 / GB-month | $0.005 / 1k PUT |
| Secrets Manager session-secret + cognito-client-secret | $0.80 (2 secrets × $0.40) | $0.05 / 10k API calls |
| Route 53 hosted zone | $0.50 (already owned) | $0.40 / million queries |
| ACM certs | $0 (free for AWS-managed) | — |
| CloudWatch Logs (BFF + MCP + ingest) | $0.50 / GB ingested; ~$1 idle for low-volume logs | $0.50 / GB |
| **Total idle** | **~$3 / month** | — |

Active cost for an operator with one human + a few agents
sending and receiving ~100 emails/day: dominated by S3 storage
(raw MIME) and DynamoDB storage, both growing linearly with
mailbox size. A 10 GB mailbox costs ~$0.45/month in S3 + ~$12/month
in DynamoDB storage = ~$15/month total; a 1 GB mailbox is closer
to $5/month total.

The operator-facing line is: **"~$3/month idle, scales linearly
with mailbox volume; 1 GB mailbox is ~$5/month, 10 GB is ~$15/month."**
This is captured in the README's "What it costs" section, which
slice 9.6 also updates.

The cost ceiling is *not* a Cognito problem. The dominant variable
cost is DynamoDB storage of normalized message bodies (slice
8.10's body_chunks table). If an operator's mailbox grows beyond
~50 GB, DynamoDB storage cost is the lever to optimize — moving
old chunks to S3 Standard-IA is the obvious move. ADR-0050 is
where that lands; not 9.6.

### Operator UX for first deploy

The operator runs:

```bash
git clone https://github.com/<them>/opensesame
cd opensesame
pnpm install
pnpm opensesame configure   # interactive: AWS profile, region, hosted zone
cdk deploy --all --context bootstrapPrincipal=cognito#<their-cognito-sub>
```

`pnpm opensesame configure` is the slice-9.6 update to the
existing configure command:

- Walks the operator through AWS profile selection.
- Asks for `OPENSESAME_HOSTED_ZONE_ID` + `OPENSESAME_HOSTED_ZONE_NAME`.
- Asks for `OPENSESAME_INITIAL_RECIPIENTS` (still required for
  SES ingress — slice 7).
- Asks for the operator's email address; on first deploy, after
  the User Pool exists, the operator runs `pnpm opensesame humans
  create --email <them>` to create their Cognito user and gets
  back the bootstrap principal SK to pass to `cdk deploy`.

The chicken-and-egg between "create the User Pool" and "create
the bootstrap principal" is handled by a two-phase deploy:

1. `cdk deploy AuthStack` (no `bootstrapPrincipal` context) — User
   Pool exists, no bootstrap Grant.
2. `pnpm opensesame humans create --email <them>` — creates the
   Cognito user, prints the `cognito#<sub>` SK.
3. `cdk deploy --all --context bootstrapPrincipal=cognito#<sub>` —
   bootstrap Grant lands; full deploy.

A single-phase deploy is possible if the operator already knows
their Cognito sub from a prior deploy. The two-phase is the
greenfield path.

### Local dev posture, post-9.6

Operators (and contributors) still want a fast local loop. After
9.6, local dev runs the BFF and MCP server as long-running tsx
processes against the **deployed** Cognito + DynamoDB:

```bash
# Terminal 1
pnpm tsx src/bin/mcp-server.ts
# bind: 127.0.0.1:3001 (default), reads .env.local

# Terminal 2
pnpm tsx src/bin/webmail-bff.ts
# bind: 127.0.0.1:3000, OPENSESAME_MCP_URL=http://127.0.0.1:3001/mcp/tools/call

# Terminal 3
pnpm dev:web
# Vite, 127.0.0.1:5173, talks to BFF on :3000
```

`.env.local` carries the deployed `OPENSESAME_USER_POOL_ID` etc.,
so login redirects to the **production** Hosted UI and lands back
on `http://127.0.0.1:3000/auth/callback` (which Cognito allows
because slice 9.1's app-client config lists both URLs). Local
DynamoDB is not used; the dev shape reads/writes the production
tables of the operator's account. Acceptable for solo-direct;
multi-user operators wanting an isolated dev account are
encouraged to deploy a second AWS account.

The integration harness (in-process, slice 8.18) keeps working —
it boots its own stub Cognito + DDB and is unaffected by 9.6's
deploy story.

## Inherits from

- **ADR-0005** — production deploy is when the auth posture leaves
  the dev driver and becomes the actual front door. Both issuance
  paths (Cognito for humans/agents, IAM SigV4 for AWS-internal)
  are now in production code paths.
- **ADR-0006** — solo-with-MCP and multi-user shapes both light up
  with this slice. Solo-direct still works (CLI without `--mcp`).
- **ADR-0011** — operator-runs-CDK; the new stacks honor stable
  construct IDs and RemovalPolicy.RETAIN on stateful resources.
- **ADR-0021** — wire format unchanged; the loopback bind guard is
  retired here because the auth layer (slice 9.1) is the
  meaningful guard now.
- **ADR-0044** — User Pool moved to `AuthStack` (slice 9.1
  hand-waved the stack location); resource server stays.
- **ADR-0045** — Grants table moves to `AuthStack` for RemovalPolicy
  consistency; bootstrap-Grant becomes a CDK custom resource.
- **ADR-0046** — `buildBffApp(deps)` factory used by both the
  binary (local) and the Lambda handler (prod); same shape.
- **ADR-0047** — MCP server gets a real custom domain
  (`mcp.<host>`); SigV4 verification path stays unchanged.
- **ADR-0048** — agent registration's `cognito_token_url`,
  `cognito_scope` outputs all stabilize on the deployed Hosted UI
  domain (`auth.<host>`).

## Files

| Layer | File | Change |
|---|---|---|
| CDK | `src/cdk/auth-stack.ts` | New — User Pool, app client, resource server, Hosted UI domain (regional + us-east-1 cert), groups, IAM roles, Agents table, Grants table, bootstrap-Grant custom resource |
| CDK | `src/cdk/webmail-compute-stack.ts` | New — BFF Lambda, MCP Lambda, two HTTP APIs, custom domains, ACM cert, Route 53 alias records |
| CDK | `src/cdk/data-plane-stack.ts` | Remove Grants table (moved to AuthStack); add CfnOutputs for Messages, Drafts, Suppressions tables for cross-stack import |
| CDK | `src/cdk/app.ts` | Wire AuthStack + WebmailComputeStack into the app |
| CDK | `src/cdk/bootstrap-grant.ts` | New — `AwsCustomResource` PutItem on Grants |
| Lambda | `src/lambda/webmail-bff.handler.ts` | New — `hono/aws-lambda` adapter |
| Lambda | `src/lambda/mcp-server.handler.ts` | New — same adapter for MCP |
| Lambda | `src/lambda/bff-deps.ts` | New — env + Secrets Manager → BffRuntimeDeps |
| Lambda | `src/lambda/mcp-deps.ts` | New — env + Secrets Manager → McpServerRuntimeDeps |
| BFF | `src/bin/webmail-bff.ts` | Remove loopback bind guard |
| MCP | `src/bin/mcp-server.ts` | Remove loopback bind guard |
| CLI | `src/bin/opensesame.ts` | New `humans create / list / delete` subcommands; `configure` reads CDK outputs into `.env.local` |
| Smoke | `smoke/slice-9-6/human-flow.smoke.ts` | New |
| Smoke | `smoke/slice-9-6/agent-flow.smoke.ts` | New |
| Smoke | `smoke/slice-9-6/agent-lifecycle.smoke.ts` | New |
| Smoke | `smoke/slice-9-6/package.json` | New — `pnpm smoke` runs all three |
| Tests | `test/cdk-auth-stack.test.ts` | CDK assertions: User Pool exists, groups, resource server, custom domain, retain policies |
| Tests | `test/cdk-webmail-compute-stack.test.ts` | CDK assertions: 2 Lambdas, 2 HTTP APIs, env wiring, IAM-role grants from AuthStack |
| Tests | `test/bin-defaults.test.ts` | New — local-dev default bind is 127.0.0.1 (regression for the removed guard) |
| Tests | `test/lambda-handler.test.ts` | New — `hono/aws-lambda` round-trip for one BFF route + one MCP route |
| Docs | `README.md` | "What it costs" section (~$3/month idle); two-phase first-deploy; local-dev-against-prod-tables posture |
| Docs | `docs/agents/deploy.md` | New — end-to-end first-deploy walkthrough |

## Verification

1. Operator runs `pnpm opensesame configure`. `.env.local` populates
   with hosted-zone vars + AWS profile.
2. `cdk deploy AuthStack`. The stack synthesizes; deploy completes
   in ~3 minutes. Cognito User Pool, Agents table, Grants table all
   exist.
3. `pnpm opensesame humans create --email me@<host>`. Receive the
   Cognito sub. Cognito sends a temporary password to the email.
4. `cdk deploy --all --context bootstrapPrincipal=cognito#<sub>`.
   The full set of stacks deploys; `bffUrl` and `mcpUrl` outputs
   print. Total deploy time ~7 minutes.
5. Visit `https://webmail.<host>/auth/login`. Hosted UI loads at
   `https://auth.<host>/`. Sign in with the temp password; Cognito
   forces a reset; land on `https://webmail.<host>/`.
6. The webmail UI loads. `read_inbox` returns the operator's
   inbox (whatever's been seeded by SES ingress; an empty inbox
   for first deploy). The composer sends a test email to the
   operator's own address; SES delivers it; the message appears in
   the inbox. The audit row records `principal: iam#<bff-role>`,
   `human_principal: cognito#<operator-sub>`.
7. From a second machine: `opensesame --mcp send ...` (CLI in MCP
   mode) using the operator's local AWS creds. SigV4-signed
   request hits `mcp.<host>`. The MCP Lambda verifies, dispatches.
   Audit row records `principal: iam#<operator-role>`,
   `human_principal: iam#<operator-role>`.
8. `opensesame agents create --display-name "Smoke Test" --agent-id
   smoke-test`. Receive credentials. Hand them to a Claude Desktop
   instance configured to point at `mcp.<host>`. Claude Desktop
   completes the OAuth dance, lists tools (filtered by the agent's
   Grant), calls `read_inbox`, returns the inbox.
9. `opensesame agents delete --agent-id smoke-test`. Wait 5
   minutes (JWKS cache). Claude Desktop's next call returns 401.
10. Smoke harness in CI: `pnpm --filter smoke-9-6 test` passes
    against the deployed stack. Three suites green.

## Trade-offs accepted

- **Two API Gateways instead of one.** Two CORS postures, two
  throttle profiles, two custom domains. The cost is "two CDK
  resources to maintain"; the alternative is a single API
  Gateway with `/webmail/*` and `/mcp/*` paths and conditional
  CORS — uglier for both readers, no clear win.
- **No CloudFront.** API Gateway HTTP API has regional latency
  but no global edge. For an operator serving themselves + a
  handful of agents from one region, the latency is fine. Adding
  CloudFront is a one-line CDK change if measurement says
  otherwise; we don't pre-emptively add it.
- **No WAF.** ADR-0005's threat model is single-operator,
  single-tenant. Cognito's advanced-security feature (free until
  100 MAU, then $0.05/MAU) covers most credential-stuffing risk;
  API Gateway's per-route throttle covers brute-force RPC abuse.
  WAF is a YAGNI in v1.
- **Custom domain at `webmail.<host>` requires the operator owns
  the hosted zone.** ADR-0011 already requires this for SES
  ingress, so no new operator-onboarding cost. Operators without a
  domain can use the API Gateway's default `*.execute-api.<region>.amazonaws.com`
  URL; less polished but works (Cognito callback URL adds the
  default URL alongside the custom one).
- **Bootstrap-Grant is a custom resource, not native CDK.** CDK's
  `aws_dynamodb.TableV2` doesn't have a `seedData` property; an
  `AwsCustomResource` is the standard escape hatch. The
  alternative — a one-shot Lambda that runs `PutItem` and tears
  itself down — is more code for the same effect. Custom resource
  it is.
- **`AuthStack`'s `RemovalPolicy: RETAIN` means `cdk destroy`
  leaks resources by design.** Recreating them after destroy is
  manual (the operator deletes the orphaned User Pool / tables in
  the AWS Console first, then re-deploys). Acceptable: destroy is
  rare, and accidental destroy of the User Pool or Grants table is
  the user-data-loss path we want to make hard.
- **Hosted UI custom domain pulls in `us-east-1`.** A second
  region for one ACM cert. CDK supports cross-region certs via
  `DnsValidatedCertificate`; the cost is "the operator's CDK
  bootstrap stack must exist in `us-east-1` too". One-time
  `cdk bootstrap aws://<acct>/us-east-1` at first deploy. Captured
  in `docs/agents/deploy.md`.
- **Local dev points at production DynamoDB / Cognito.** This is
  the most surprising local-dev posture in the codebase. The
  alternative — local DynamoDB + a local Cognito stub — was
  considered and rejected: maintaining a Cognito stub that's
  faithful enough to develop against is a project. Solo-direct
  operators who want an isolated dev environment can deploy a
  second AWS account; that's what ADR-0011 envisions.
- **Smoke harness needs a long-lived test user.** The maintainers
  manage one; operator deployments don't run the harness in CI
  themselves. This is the standard "verify-once-on-deploy"
  posture; alternative is a self-tearing-down test user provisioned
  by the harness, which adds Cognito admin permissions to the
  CI role. Not worth it for v1.
