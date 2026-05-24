# Grant table + per-RPC middleware, slice 9.2

ADR-0044 (slice 9.1) shipped Cognito + Hosted UI + a session cookie:
every authenticated user gets full operator authority, because the
dispatcher ignores `req.principal`. This slice closes that gap. The
BFF dispatcher gains a `requireGrant(address, capability)` middleware
that every `/rpc/*` handler routes through. A principal without a
matching Grant for the addressed mailbox + the requested capability
gets a 403 with a structured body.

The Grant model is the one ADR-0005 pinned: a single table, two
principal types (Cognito `sub` for human / agent OAuth callers, IAM
role ARN for AWS-internal SigV4 callers), one capability surface.
Slice 9.2 implements the **lookup + middleware**; the IAM SigV4
issuance path lands in slice 9.4 (ADR-0047), and the agent
self-registration flow lands in slice 9.5 (ADR-0048).

## What this slice ships

1. A `Grants` DynamoDB table with one item per `(address, principal)`
   pair, storing capabilities and autonomy mode.
2. A `requireGrant(address, capability)` middleware on every
   `/rpc/*` route. The route handler declares which capability it
   needs; the middleware reads the principal off the session-cookie
   middleware (slice 9.1's `c.var.principal`), looks up the Grant,
   and 403s on miss.
3. A small in-memory cache (TTL 60s) on Grant lookups so
   per-keystroke autosaves don't beat a hot DDB partition.
4. Three new admin RPCs — `list_grants`, `create_grant`,
   `revoke_grant` — implementing ADR-0007's Grant management surface.
   Available only to principals whose Grant carries the new
   `admin:grants` capability.

## What this slice does *not* ship

- **No SigV4 verification.** Cognito principals only. Slice 9.4 wires
  IAM-role-ARN principals through. The Grant table's schema already
  supports both via the `principal` SK shape, so when 9.4 lands no
  table change is needed.
- **No agent registration.** The `agents` Cognito group exists
  (slice 9.1) but has no members. ADR-0048 (slice 9.5) ships the
  registration flow.
- **No `Auto-Submitted` / `Sender:` enforcement at send time.**
  ADR-0008 / ADR-0001 already pin those headers when a Grant
  carries `send-on-behalf-of` or `send-as`. This ADR threads the
  Grant through to the send-with-audit pipeline; the existing
  composer code consumes the disclosure / autonomy flags as it
  already does for direct-mode ops.
- **No Grant UI in the webmail.** Grants are managed via the new
  admin RPCs; an admin-facing UI is a follow-up. The first deploy's
  bootstrap Grant is created by `cdk deploy` (see "Bootstrap
  Grant" below).

## Decision

### Grant row shape

```ts
type StoredGrant = {
  schema_v: "1";
  address: string;          // PK — operator's mailbox
  principal: string;        // SK — "cognito#<sub>" or "iam#<role-arn>"
  grant_id: string;         // ULID; stable identity for revocation
  capabilities: Capability[];
  autonomy_mode: "interactive" | "autonomous";
  disclosure_mode: "send-on-behalf-of" | "send-as";
  acknowledgement_text: string | null;  // required if capabilities includes "send-as"
  created_at: string;       // ISO-8601
  created_by: string;       // principal SK of whoever called create_grant
  agent_id: string | null;  // populated for agent principals; null for humans
};

type Capability =
  | "read"          // read_inbox, get_message, list_threads, search_email, get_thread, get_attachment
  | "write"         // mark_read, mark_flagged, set_keywords, archive, snooze, trash, star, label
  | "draft"         // save_draft, list_drafts, get_draft, delete_draft, stage_attachment
  | "send"          // send_email, reply_to_email — composer-driven sends
  | "send-on-behalf-of"  // adds Sender: header (ADR-0001)
  | "send-as"            // omits Sender: header (ADR-0001) — requires acknowledgement_text
  | "admin:grants"  // list_grants, create_grant, revoke_grant
  | "admin:agents"; // list_agents, create_agent, delete_agent (slice 9.5)
```

### Why these capabilities

The medium-grained set above is a deliberate compression of
ADR-0007's per-tool surface: instead of one capability per tool
(40+), we group tools by *operator mental model*:

- "this principal can **read** mail" → all 6 read tools
- "this principal can **manage** mail state" → all 7 annotation
  tools
- "this principal can **draft** outbound mail" → all 5 draft tools
- "this principal can **send** mail" → 2 send tools
- "this principal can **send as** a different identity" → adds the
  ADR-0001 disclosure modes

Trade-off: a future tool that doesn't fit cleanly into one of these
buckets needs an explicit decision (extend an existing capability or
mint a new one). That decision is a small ADR. The alternative —
fine-grained per-tool capabilities — is a Grant row that no human
can read and a `create_grant` UX that's a 40-checkbox form. Rejected.

`send-on-behalf-of` and `send-as` are **separate** capabilities, not
flags on `send`. ADR-0001 commits the project to "Sender: header
or no Sender: header" being a *Grant-level* semantic, not a
per-message one. A Grant without `send-on-behalf-of` or `send-as`
cannot send at all under that mailbox; a Grant with `send` plus
`send-on-behalf-of` sends with a `Sender:` header set to the agent's
own address; a Grant with `send` plus `send-as` requires
non-empty `acknowledgement_text` (the consent string the operator
typed to authorize the agent to impersonate).

### Capability coverage of every existing RPC

| RPC | Capability |
|---|---|
| `read_inbox` | `read` |
| `get_message` | `read` |
| `search_email` | `read` |
| `list_threads` | `read` |
| `get_thread` | `read` |
| `list_thread_messages` | `read` |
| `get_attachment` | `read` |
| `mark_read` | `write` |
| `mark_flagged` | `write` |
| `archive_thread` | `write` |
| `snooze_thread` | `write` |
| `trash_thread` | `write` |
| `star_thread` | `write` |
| `set_keywords` / labels | `write` |
| `save_draft` | `draft` |
| `list_drafts` | `draft` |
| `get_draft` | `draft` |
| `delete_draft` | `draft` |
| `stage_attachment` | `draft` |
| `send_email` | `send` + (`send-on-behalf-of` OR `send-as`) |
| `reply_to_email` | `send` + (`send-on-behalf-of` OR `send-as`) |
| `list_grants` | `admin:grants` |
| `create_grant` | `admin:grants` |
| `revoke_grant` | `admin:grants` |
| `list_addresses` | none — derived from Grant set (see below) |
| `whoami` | none — self-introspection |

The middleware doesn't make `read` and `write` exclusive — a Grant
can carry both. A read-only viewer Grant (`["read"]`) is a real
use case (an executive assistant who can read but not annotate);
the current human operator Grant carries
`["read", "write", "draft", "send", "send-on-behalf-of"]`.

### Table schema and CDK

```text
TableName: opensesame-grants-<env>
PK: address (S)
SK: principal (S)
Attributes:
  schema_v, grant_id, capabilities (SS), autonomy_mode,
  disclosure_mode, acknowledgement_text, created_at, created_by,
  agent_id
GSI: GrantsByPrincipal
  PK: principal (S)
  SK: address (S)
  Projection: ALL
```

The base table answers "who can do what to this mailbox" — the
common middleware lookup. The GSI answers "what can this
principal touch" — for `whoami` and `list_addresses`.

`capabilities` is stored as a DynamoDB **String Set** (`SS`), not
a list, because membership tests are the only operation the
middleware does and `SS` makes that an O(1) presence check.

`schema_v` ties into ADR-0011's versioned-items posture; the
reader handles future versions, writers always write the latest.

### Middleware: `requireGrant(address, capability)`

```ts
// src/bff/grant-middleware.ts (new)
type GrantPort = {
  lookup(address: string, principal: string): Promise<StoredGrant | null>;
  // ...slice 9.5+ adds list/create/revoke
};

export function requireGrant(
  capability: Capability,
): MiddlewareHandler<{ Variables: { principal: Principal; grant: StoredGrant } }> {
  return async (c, next) => {
    const principal = c.var.principal;
    const address = readAddressFromBody(c);  // see "Address resolution" below
    const principalSK = encodePrincipal(principal);
    const grant = await grantCache.lookup(address, principalSK);
    if (grant === null) {
      return c.json(
        { code: "grant_denied", message: "no grant for this address" },
        403,
      );
    }
    if (!grant.capabilities.includes(capability)) {
      return c.json(
        { code: "grant_denied", message: `missing capability: ${capability}` },
        403,
      );
    }
    c.set("grant", grant);
    await next();
  };
}
```

Each route registers its capability:

```ts
app.post("/rpc/read_inbox", requireGrant("read"), handleReadInbox);
app.post("/rpc/save_draft", requireGrant("draft"), handleSaveDraft);
app.post("/rpc/send_email",
  requireGrant("send"),
  requireOneOf("send-on-behalf-of", "send-as"),
  handleSendEmail,
);
```

`requireOneOf` is a small variant: passes if any of the listed
capabilities is on the Grant. Used only by send tools.

### Address resolution: where does the middleware get the address?

Every existing RPC carries the address in its body — `read_inbox`
takes `{ address, ... }`, `save_draft` takes `{ address, ... }`,
`send_email` takes `{ from, ... }` (the `from` IS the addressed
mailbox). The middleware reads the address from a per-route
extractor:

```ts
type AddressExtractor = (body: unknown) => string | null;

const addressByTool: Record<string, AddressExtractor> = {
  read_inbox: (b) => (b as { address?: string })?.address ?? null,
  send_email: (b) => (b as { from?: string })?.from ?? null,
  // ... one entry per tool
};
```

A missing or malformed address in the body short-circuits to a
400 (the schema parser already enforces this; the middleware's
extractor is defensive against the edge case where the
middleware runs before the parser).

`get_message`, `get_attachment`, and a handful of message-id-keyed
tools don't carry an explicit address. The middleware first
*resolves* the message-id to its owning address via the existing
`messageIdGsiName` lookup, then runs the Grant check against
that resolved address. This is one extra DDB read per call to
those tools; the same lookup `get_message` already does, so the
cost is bounded but the *per-request* shape changes (the
middleware must run after the GSI lookup is cached, or do its
own). We pick: middleware does its own GSI lookup and caches
the resolution in `c.var.resolvedAddress` so the handler
doesn't repeat it. Net cost: zero extra reads, one extra
context-variable hop.

### Grant cache

A per-Lambda-invocation in-memory map keyed by
`<address>|<principal>`, TTL 60s. Cache entries are
`{ grant: StoredGrant | null, expiresAt: number }` — *negative*
results cache too, so a denied principal hammering `/rpc/read_inbox`
doesn't burn DDB RCU on every call. 60s is long enough to absorb
keystroke-cadence calls (a draft autosave fires every 1.5s); short
enough that a `revoke_grant` propagates within a minute.

The cache is per-process. In slice 9.6 the BFF runs as a Lambda
behind API Gateway with `provisionedConcurrency = 0` and a warm pool
of N instances; each instance has its own cache. A `revoke_grant`
that needs immediate effect bumps a per-table version-counter row
that the cache consults on read; for v1 we accept the 60s lag.

### `whoami` returns the Grant set

```ts
GET /rpc/whoami → 200 {
  principal_kind: "cognito",
  principal_id: "<sub>",
  email: "<email>",
  addresses: ["alice@acme.com", "ops@acme.com"],
  capabilities_summary: {
    "alice@acme.com": ["read", "write", "draft", "send", "send-on-behalf-of"],
    "ops@acme.com": ["read"]
  }
}
```

Implemented as a GSI Query against `GrantsByPrincipal` for the
session-cookie principal. No `requireGrant` on `whoami` — every
authenticated principal can introspect its own Grants. A
session-cookie-less caller still gets a 401 from the upstream
`requireSession` middleware.

`list_addresses` is the trimmed version: just `addresses[]`.

### Admin RPCs

`list_grants`, `create_grant`, `revoke_grant` per ADR-0007. All
gated by `admin:grants`. `create_grant` enforces:

- `acknowledgement_text` non-empty if capabilities include
  `send-as` (per ADR-0001).
- The principal being granted exists — for Cognito principals,
  the User Pool's `AdminGetUser`; for IAM principals, a static
  validation (slice 9.4 elaborates).
- The caller's own Grant carries `admin:grants` (the middleware
  enforces this; the handler doesn't re-check).

### Bootstrap Grant: how does the first human get `admin:grants`?

A chicken-and-egg problem: `create_grant` requires `admin:grants`,
but a fresh deployment has no Grants. Solution: `cdk deploy`
provisions one **bootstrap Grant** for the operator who runs the
deploy:

- The CDK stack reads `OPENSESAME_BOOTSTRAP_PRINCIPAL` from the
  deploy environment. Required env var for slice 9.2+.
- Format: `cognito#<sub>` if the operator pre-created their User
  Pool user before deploying; or a placeholder
  `iam#<role-arn>` for a CDK-deployment-time Grant under the
  AWS account's bootstrap role (slice 9.4 makes this useful).
- For each address in `OPENSESAME_INITIAL_RECIPIENTS` (existing
  env, ADR-0009), a Grant is written with
  `capabilities: ["read", "write", "draft", "send", "send-on-behalf-of", "admin:grants", "admin:agents"]`.

The CDK construct calls `PutItem` directly during `cdk deploy`. It
does *not* go through the BFF. This is the only pre-Grant write
path; once it lands, every other Grant write is by an existing
admin caller.

A redeploy with a different `OPENSESAME_BOOTSTRAP_PRINCIPAL` does
**not** revoke the previous bootstrap — it adds another. Stale
bootstrap Grants are revoked manually via `revoke_grant`. The
operator typically only deploys once with this env set; subsequent
deploys leave it unset and the construct skips the bootstrap step.

### Solo-direct mode is unchanged

Per ADR-0008 §"Solo-direct mode": in solo-direct (CLI + library +
AWS, no Cognito, no MCP server), the operator's IAM principal *is*
the authority. The library detects deployment shape and skips the
Grant check. Slice 9.2 doesn't change that detection — it adds the
Grant check to the **BFF** dispatcher only. A solo-direct CLI run
continues to bypass the Grants table entirely.

## Inherits from

- **ADR-0001** — `Auto-Submitted` and `Sender:` are Grant-level
  semantics, not per-message ones. The capabilities
  `send-on-behalf-of` and `send-as` are this ADR's encoding of that
  decision; `acknowledgement_text` makes `send-as` consent-required.
- **ADR-0005** — One Grant model, two principal types (Cognito sub,
  IAM role ARN). The SK shape `cognito#<sub>` / `iam#<role-arn>`
  is the encoding.
- **ADR-0007** — Capability surface; `list_grants` / `create_grant`
  / `revoke_grant` are the admin tools described there.
- **ADR-0008** — Pre-send audit row (`send_attempted`) records the
  Grant id; this ADR makes the Grant id available on the wire so
  the existing audit-write site can reference it.
- **ADR-0011** — Stable construct ID for the new `Grants` table.
  `schema_v: "1"` on every row.
- **ADR-0021** — Wire-additive: the middleware is a new layer on the
  existing dispatcher; no body shape changes for existing tools.
- **ADR-0044** — `c.var.principal` from the session-cookie middleware
  is what `requireGrant` consumes.

## Files

| Layer | File | Change |
|---|---|---|
| Core types | `src/core/grants.ts` | New: `StoredGrant`, `Capability`, `GrantPort` interface |
| Reader | `src/aws/dynamodb-grants.ts` | New: `makeDynamoGrantPort` — `lookup`, `list`, `create`, `revoke` |
| BFF | `src/bff/grant-middleware.ts` | New: `requireGrant`, `requireOneOf`, in-memory cache |
| BFF | `src/bff/principal-encoding.ts` | New: `encodePrincipal({ kind, sub or roleArn })` → SK string |
| BFF | `src/bff/dispatcher.ts` | Each route declares its capability via the new middleware; `whoami`, `list_addresses`, three admin RPCs added |
| BFF | `src/bff/schemas.ts` | New parsers for `list_grants` / `create_grant` / `revoke_grant` / `whoami` |
| BFF entry | `src/bin/webmail-bff.ts` | Wire `GrantPort` into `BffDeps`; read `OPENSESAME_GRANTS_TABLE` env |
| CDK | `src/cdk/data-plane-stack.ts` | New: `Grants` table + `GrantsByPrincipal` GSI |
| CDK | `src/cdk/bootstrap-grant.ts` | New: `cdk deploy`-time PutItem for `OPENSESAME_BOOTSTRAP_PRINCIPAL` |
| Audit | `src/core/send-with-audit.ts` | Audit row already carries `grant_id`; this ADR populates it from `c.var.grant.grant_id` |
| Tests | `test/grant-middleware.test.ts` | Cache hit/miss, negative cache, capability mismatch 403, missing-grant 403, address extraction edge cases |
| Tests | `test/dynamodb-grants.test.ts` | Lookup, list-by-address, list-by-principal (GSI), create, revoke |
| Tests | `test/bff-integration.test.ts` | Extend harness to seed Grants and verify each tool's gating |

## Verification

1. `cdk deploy` provisions the `Grants` table; the bootstrap step
   writes one Grant for the operator's Cognito sub on every address
   in `OPENSESAME_INITIAL_RECIPIENTS`.
2. Boot the BFF, log in (slice 9.1), call `/rpc/whoami` →
   200 with the operator's address list.
3. Manually delete the operator's Grant for one address. Call
   `/rpc/read_inbox` for that address → 403 `grant_denied`. Call
   for a still-granted address → 200.
4. Use the AWS Console to create a second Cognito user and add them
   to `humans`. Sign in as them. Call any `/rpc/*` → 403 (no
   Grant). Have the operator call `/rpc/create_grant` with the
   second user's sub + capabilities `["read"]`. Re-call
   `/rpc/read_inbox` as the second user → 200.
5. Have the second user call `/rpc/send_email` → 403 (capability
   `send` missing). Confirm the audit log records nothing — the
   Grant denial is upstream of the send-attempted write.
6. Revoke the second user's Grant. Within 60s (cache TTL), the
   second user's `/rpc/read_inbox` returns 403 again.

## Trade-offs accepted

- **60-second cache lag on revocation.** A revoked Grant might
  succeed for up to a minute. For the threat model (insider /
  former-employee revocation) this is fine; the operator who
  needs *immediate* revocation can deploy a force-flush by
  bumping a CDK-deployed cache-version env. The alternative —
  zero-lag — means a DDB read on every RPC call, which is ~10ms
  added latency per call against an inbox-style workload. Not
  worth it.
- **Cognito-only in this slice.** SigV4 / IAM-role principals are
  encoded in the SK shape (`iam#<role-arn>`) but no path actually
  produces them yet. Slice 9.4 lights that path; the table doesn't
  change.
- **Capability set is fixed.** A new capability needs an ADR. This
  is intentional — the capability surface is the project's main
  user-facing security contract, and additions deserve scrutiny.
- **`acknowledgement_text` is a string, not a structured artifact.**
  ADR-0001's "consent string" doesn't define a parseable shape; we
  store whatever the operator typed when creating the Grant. Audit
  rows reference the Grant by id; replaying the consent surface
  in a UI later doesn't need a re-parse.
- **No grant-by-domain or wildcard addresses.** `address` is a
  literal email address; `*@acme.com` isn't supported. Adding it
  later is a Grant-row schema change (a new SK shape
  `addr_pattern#*@acme.com`), not a structural rebuild — the
  middleware grows a fall-through pattern lookup. Defer until
  there's a real use case.
- **Bootstrap Grant runs from `cdk deploy`.** That's a
  deployment-time write to the data plane, which sits awkwardly
  with ADR-0011's "CDK provisions infrastructure, not data". The
  alternative is an out-of-band setup script (`opensesame
  bootstrap-grant`), which adds a step to the operator's
  first-deploy ritual. We pick the in-CDK shape because the
  bootstrap Grant is *infrastructure-shaped* (one row per address,
  written exactly once per deployment) and forcing operators to
  remember a separate command is the wrong default. The CDK
  construct's idempotence guarantee — re-running `cdk deploy` is
  a no-op for already-existing bootstrap Grants — preserves
  ADR-0011's deploy-is-the-update property.
