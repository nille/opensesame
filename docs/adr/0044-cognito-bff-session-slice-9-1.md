# Cognito User Pool, Hosted UI, and BFF session, slice 9.1

ADR-0021 (slice 7) shipped a localhost-only BFF that refuses to start
on a non-loopback bind: the dispatcher has no auth, no CORS beyond
`localhost:5173`, no session, no notion of a principal. Slice 9 lifts
all of that. This ADR pins the *first* of six slices that get the BFF
from "loopback dev driver" to "deployable multi-user shape" — the
auth front door.

The defining shape: humans authenticate against a Cognito User Pool
through the **Hosted UI**, the BFF terminates the OIDC handshake and
mints a same-site session cookie, and every authenticated user gets
**full operator authority** for the duration of this slice. Grants
land in slice 9.2 (ADR-0045); until then, "logged in" means "can do
anything an operator can do". This is intentional — separating the
auth front door from the per-RPC capability gate keeps each slice
small enough to verify in isolation.

This is a **transition slice**. After 9.1 ships, the BFF still calls
the core library directly post-login; nothing about the dispatcher
or the wire format changes from the human's perspective.

## What this slice ships

1. A Cognito User Pool with one app client, the Hosted UI configured
   for the operator's domain, and `cognito:groups` distinguishing
   `humans` (webmail users) from `agents` (slice 9.5+).
2. Three BFF routes: `/auth/login` (302 → Hosted UI),
   `/auth/callback` (exchange code → tokens → mint session cookie →
   302 → `/`), `/auth/logout` (revoke refresh token, clear cookie,
   302 → Hosted UI logout).
3. A signed session cookie that carries the user's Cognito `sub`,
   refresh token (encrypted at rest in the cookie), and an expiry.
4. Middleware on every `/rpc/*` that requires a valid session and
   surfaces `req.principal = { kind: "cognito", sub }` to the
   downstream dispatcher (which ignores it in 9.1; 9.2 starts using
   it).
5. A "log out" button in the rail. Webmail UI gains nothing else.

## What this slice does *not* ship

- **No Grants.** Every `cognito:groups: humans` member can read every
  mailbox the BFF Lambda's IAM role can reach. ADR-0045 is the next
  slice.
- **No CDK changes for the BFF deployment.** Slice 9.1 still runs on
  `pnpm tsx src/bin/webmail-bff.ts` against a User Pool created by
  `cdk deploy`. ADR-0049 (slice 9.6) lifts the BFF into Lambda + API
  Gateway. The bind guard in `webmail-bff.ts` stays — slice 9.6
  removes it.
- **No agent registration flow.** Empty `agents` group at deploy time.
  ADR-0048 (slice 9.5) handles that.
- **No solo-with-MCP support.** See "Open question: solo-with-MCP"
  below.
- **No multi-user UI.** The webmail still assumes one operator's
  point of view. The session cookie carries a Cognito `sub` but the
  rail doesn't show "logged in as alice@…" — that surfaces when
  Grants land and "alice can see these addresses" becomes
  meaningful.

## Decision

### Cognito User Pool: shape and groups

A single User Pool per deployment. One app client (the BFF), with:

- **Allowed OAuth flows**: Authorization Code Grant. Implicit is
  disabled.
- **Allowed scopes**: `openid email profile`. No custom scopes; the
  human's identity is the principal, capability scoping happens at
  the Grant layer (ADR-0045).
- **Callback URLs**: `https://<webmail-host>/auth/callback` plus
  (in dev) `http://127.0.0.1:3000/auth/callback`. The `http://`
  loopback URL is allowed only because Cognito permits localhost
  exemptions on Code flow; production is HTTPS-only.
- **Sign-out URLs**: `https://<webmail-host>/` plus
  `http://127.0.0.1:3000/`.
- **Token validity**: Cognito defaults — ID + access tokens 1 hour,
  refresh token 30 days. ADR-0005 deferred lifetime decisions; this
  ADR doesn't override that, it pins "use the defaults until we have
  a reason not to".
- **No client secret on the public app client?** The BFF is a
  confidential client (the Lambda runs in AWS, never in a browser),
  so the app client **does have a secret**. The Hosted UI
  redirect-back includes the auth code; the BFF's
  `/auth/callback` exchanges the code → tokens server-side using the
  client secret. The browser never sees a Cognito token.

Two `cognito:groups`:

- `humans` — webmail users. Slice 9.1's only populated group.
- `agents` — populated by slice 9.5's agent-registration flow. Empty
  at deploy time. Defined now so the User Pool's group set is stable
  across slices and reader code can switch on `cognito:groups`
  membership without a future schema change.

Group membership is the cheapest way to keep the slice-9.5 agent
flow from leaking into 9.1's middleware: a session cookie minted from
a `humans`-group user always passes the `humans`-only middleware that
9.1 installs; a future agent JWT (slice 9.5) goes through the IAM
SigV4 / OAuth client_credentials path and never produces a cookie.

### Hosted UI, not custom login

The User Pool's Hosted UI handles login + signup + password reset.
We do not build a login page in the webmail UI. Three reasons:

1. **Security surface.** Hosted UI runs on Cognito's domain, with
   AWS-maintained CSP, HSTS, and credential handling. A custom page
   in our webmail would inherit our (slice-9.6-specific) CSP posture
   and add a credential-handling code path to audit.
2. **MFA / password reset.** Hosted UI ships with TOTP and email-OTP
   MFA, password-reset email flow, and account-locked recovery —
   none of which we want to build.
3. **Operator onboarding.** ADR-0011's "operator runs CDK in their
   own account" model means the operator already provisions the
   User Pool. Hosted UI is the AWS-native way to use a User Pool
   for human login; bypassing it would be picking a fight with the
   service.

The custom-domain option for Hosted UI (`auth.<webmail-host>`) is
deferred to slice 9.6 — the default `<pool-id>.auth.<region>.amazoncognito.com`
domain works for slice 9.1's verification.

### `/auth/login`

```text
GET /auth/login → 302 Hosted UI authorize URL
```

The BFF generates a random **state** parameter (32 bytes,
base64url-encoded), stores it in a short-lived (10 min) httponly
cookie (`os_auth_state`), and redirects to:

```text
https://<pool-domain>/oauth2/authorize?
  client_id=<bff-client-id>&
  response_type=code&
  scope=openid+email+profile&
  redirect_uri=<bff-callback-url>&
  state=<state>
```

The state cookie is bound to `SameSite=Lax` and the BFF's domain;
it's the CSRF guard on `/auth/callback`.

### `/auth/callback`

```text
GET /auth/callback?code=<code>&state=<state>
```

The handler:

1. Reads `os_auth_state` cookie. If absent or doesn't match the query
   string `state`, return 400. Clear the cookie either way.
2. POST to `https://<pool-domain>/oauth2/token` with
   `grant_type=authorization_code`, the code, the BFF client id +
   secret (HTTP Basic), and the redirect URI. Receives `id_token`,
   `access_token`, `refresh_token`.
3. Verify the `id_token` JWT signature against the User Pool's JWKS
   (published at `https://cognito-idp.<region>.amazonaws.com/<pool-id>/.well-known/jwks.json`).
   Cache the JWKS in-memory for 1 hour (Cognito rotates rarely; a
   stale-JWK miss is a 401 the operator sees as "log in again",
   acceptable failure mode).
4. Verify `iss`, `aud`, `exp`, `token_use === "id"`, and that
   `cognito:groups` includes `"humans"`. A user not in `humans` (e.g.
   a misconfigured agent account) gets a 403 with a generic message.
5. Mint a **session cookie** (see below). The refresh token is
   AES-GCM encrypted under a BFF-side master key, stored inside the
   cookie payload, and used to mint fresh ID/access tokens when the
   current ID token expires.
6. 302 to `/` (the webmail root).

### Session cookie shape

Single httponly cookie, `os_session`. Payload is a signed
(HMAC-SHA-256) JSON envelope:

```json
{
  "v": 1,
  "sub": "<cognito-sub>",
  "email": "<verified-email>",
  "exp": 1234567890,
  "rt": "<aes-gcm-encrypted-refresh-token>"
}
```

Signing key + master encryption key both come from a single
`OPENSESAME_SESSION_SECRET` environment variable (derive two subkeys
via HKDF). The secret rotates by re-deploying with a new value;
all sessions invalidate at rotation.

Cookie attributes:

| attribute | value | why |
|---|---|---|
| `HttpOnly` | yes | XSS can't read it |
| `Secure` | yes | TLS-only (slice 9.1 dev exempts on localhost) |
| `SameSite` | `Lax` | top-nav GET works (Hosted UI redirect back); cross-site POST blocked |
| `Path` | `/` | covers `/auth/*` and `/rpc/*` |
| `Max-Age` | 30 days | matches refresh-token validity |
| `Domain` | not set | host-only cookie; subdomains can't read it |

### Why same-site cookie, not Bearer header

The browser stores the cookie automatically and submits it on every
fetch to the BFF — the SPA never touches the credential, which means
XSS can't exfiltrate it. A Bearer-token-in-localStorage approach
puts the credential in JavaScript's reach. CSRF is mitigated by
`SameSite=Lax` plus the fact that every state-changing call is a
JSON POST that browsers don't auto-submit cross-site (the CORS
preflight is the second guard).

We considered the JWT-in-localStorage / Bearer pattern (the AWS
Amplify default) and rejected it — Amplify's UX trades XSS exposure
for "easy to inspect in the network panel"; we prefer the
audit-friendlier cookie shape since the BFF is the only reader.

### `/auth/logout`

```text
POST /auth/logout
```

1. Read `os_session` cookie. Decrypt the refresh token.
2. Call Cognito's `RevokeToken` endpoint to invalidate the refresh
   token server-side.
3. Clear the `os_session` cookie (set `Max-Age=0`).
4. 302 to `https://<pool-domain>/logout?client_id=<id>&logout_uri=<webmail-host>/`
   so Hosted UI also clears its session.

POST not GET — logout is a state-changing operation and a GET
endpoint would be vulnerable to CSRF-driven forced logout. The rail
button submits a hidden form to `/auth/logout`.

### Refresh-token loop

A request to `/rpc/<tool>` with an expired ID token (the BFF's
session middleware checks `exp` from the cookie payload, not the
ID token JWT — the cookie payload is the source of truth for
"when does this session lapse") triggers a **transparent refresh**:

1. Decrypt the refresh token from the cookie payload.
2. POST to Cognito's `oauth2/token` with `grant_type=refresh_token`.
3. On success, mint a new session cookie (new `exp`, same refresh
   token), re-attach it to the response.
4. On failure (refresh token revoked, expired, Cognito unreachable),
   clear the cookie and return 401 with `{ code: "session_expired" }`.
   The webmail UI's fetch wrapper treats 401 as "redirect to
   `/auth/login`".

Cost: every RPC call past the ID-token-expiry mark adds one Cognito
HTTP call. Cheap (a few ms; Cognito is in the same region) and only
fires once per ID-token lifetime (1 hour). The alternative —
in-memory ID-token caching keyed by session — would be a stateful
BFF; cookie-only is simpler.

### Middleware: who can call `/rpc/*`

```ts
// src/bff/auth-middleware.ts (new)
type Principal = { kind: "cognito"; sub: string; email: string };
type AuthedRequest = HonoRequest & { principal: Principal };

requireSession(c: Context, next: Next): Promise<Response>
```

On every `/rpc/*`:

1. Read `os_session` cookie. Verify HMAC. If missing or invalid:
   401 `{ code: "no_session" }`.
2. Check `exp`. If expired: try refresh (above). If refresh fails:
   401 `{ code: "session_expired" }`.
3. Attach `c.var.principal = { kind: "cognito", sub, email }` to
   the request context.
4. Call `next()`.

The dispatcher's `dispatch(deps, path, body)` shape (ADR-0021)
gains an optional `principal` parameter; in slice 9.1 the
dispatcher ignores it. Slice 9.2 (ADR-0045) is when the dispatcher
starts threading it through to `requireGrant`.

### Bind guard relaxation: not yet

The dev driver still refuses non-loopback binds. Slice 9.1 runs on
`127.0.0.1:3000` and is verified locally — auth is in place but the
production deploy shape (Lambda + API Gateway, with auth as the
front door of the public-facing CDK stack) is slice 9.6's job.
Lifting the bind guard in 9.1 without 9.6's CDK posture would
produce a deployable BFF with no public DNS, no TLS termination,
and no rate limiting beyond the Lambda concurrency cap — worse than
where we started. The two slices ship in series; the guard lifts
exactly when the CDK stack appears.

### CSRF posture

The session cookie is `SameSite=Lax`. Top-nav GETs (Hosted UI
redirect back to `/auth/callback`) work; cross-site form POSTs
(the classic CSRF attack) don't carry the cookie. JSON POSTs to
`/rpc/*` from a malicious origin trigger a CORS preflight that
the BFF's existing CORS config (open to `localhost:5173` in dev,
`https://<webmail-host>` in prod) refuses.

The combination of `SameSite=Lax` + JSON-content-type CORS
preflight is the AWS-recommended posture for cookie-based session
auth on a same-origin SPA. We do **not** add a separate CSRF
token — `SameSite` plus content-type-triggered preflight is
already two independent layers, and a third would be cargo-cult.

## Open question: solo-with-MCP

The PRD asks: does the webmail support solo-with-MCP today? ADR-0006
says no — solo-with-MCP exposes the MCP server (slice 9.3+) to
external agents but the webmail BFF is a multi-user shape. ADR-0044
honors that: Cognito + Hosted UI is multi-user posture, and a
solo-direct operator who only uses the CLI never lights up Cognito.

A solo-with-MCP operator who *also* wants to use the webmail UI gets
two Cognito-flavored components (the User Pool for webmail login,
plus the same User Pool's `agents` group for MCP client_credentials)
and one BFF Lambda. That's the same shape multi-user has, with
exactly one human in the `humans` group. There's no separate
"solo-with-MCP webmail" deployment — the User Pool is the same
artifact whether one or many humans use it. CDK's slice-9.6 stack
parameterizes on `deployment_shape` (per ADR-0006 / ADR-0011) but
slice 9.1 deploys the User Pool the same way regardless.

The decision: **slice 9.1 produces a User Pool that supports
solo-with-MCP and multi-user identically.** The deployment-shape
parameter only affects whether the MCP server (slice 9.3) and the
agent-registration flow (slice 9.5) are deployed at all; the User
Pool itself is shape-agnostic.

## Inherits from

- **ADR-0005** — auth posture: OAuth via Cognito for external,
  IAM SigV4 for AWS-internal. This ADR is the OAuth/Cognito half
  for the human-into-webmail path. Token lifetimes and
  agent-registration flow stay deferred.
- **ADR-0006** — three deployment shapes; the User Pool is part of
  solo-with-MCP and multi-user, absent from solo-direct. The browser
  doesn't speak MCP.
- **ADR-0021** — wire format pinned. The session middleware is
  additive: it gates access to `/rpc/*` but doesn't change the body
  shape. Existing tools' inputs/outputs are unchanged.

## Files

| Layer | File | Change |
|---|---|---|
| BFF | `src/bff/auth-middleware.ts` | New: `requireSession` Hono middleware, cookie verify + refresh loop |
| BFF | `src/bff/auth-routes.ts` | New: `/auth/login`, `/auth/callback`, `/auth/logout` handlers |
| BFF | `src/bff/session-cookie.ts` | New: HMAC-sign / verify, AES-GCM encrypt / decrypt the refresh token, HKDF subkey derivation |
| BFF | `src/bff/cognito-client.ts` | New: token exchange, JWKS fetch + cache, JWT verify, RevokeToken, refresh-token POST |
| BFF | `src/bff/hono-app.ts` | Mount `requireSession` on `/rpc/*`; mount `/auth/*` routes ahead of it |
| BFF entry | `src/bin/webmail-bff.ts` | Read `OPENSESAME_USER_POOL_ID`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_DOMAIN`, `_SESSION_SECRET` from env; pass into deps |
| CDK | `src/cdk/auth-stack.ts` | New: User Pool + app client + Hosted UI domain + `humans` / `agents` groups |
| Web | `src/web/src/lib/bff-client.ts` | Treat 401 → redirect to `/auth/login`; logout button posts `/auth/logout` |
| Web | `src/web/src/components/Rail.tsx` | Logout button at the bottom of the rail |
| Tests | `test/auth-middleware.test.ts` | Cookie verify pass/fail, expiry, refresh loop happy + sad paths |
| Tests | `test/auth-routes.test.ts` | `/auth/login` state cookie, `/auth/callback` code exchange against a stub Cognito, `/auth/logout` revoke + clear |
| Tests | `test/session-cookie.test.ts` | HMAC tampering rejected, AES-GCM round-trip, HKDF stability |
| Tests | `test/bff-integration.test.ts` | Extend the existing harness to mint a stub session cookie and verify `/rpc/*` rejects without it |

## Verification

1. `cdk deploy` provisions the User Pool. Manually create one
   `humans`-group user via the AWS Console.
2. Boot the BFF locally with the new envs. Visit
   `http://127.0.0.1:3000/auth/login` → redirect to Hosted UI →
   sign in → land on `/`.
3. The webmail UI loads. `read_inbox` returns the operator's
   inbox. (The BFF Lambda's IAM role still has full DDB / S3 / SES
   reach; Grants come in slice 9.2.)
4. Wait for the ID-token TTL (or shorten it via env override). The
   next `/rpc/read_inbox` call transparently refreshes; the
   browser sees a fresh `Set-Cookie` header but no UI flicker.
5. Click "log out" in the rail. The session cookie clears, Cognito's
   refresh token is revoked, and the next page load redirects to
   Hosted UI's logged-out state.
6. Open a second incognito window without a session. Hit
   `http://127.0.0.1:3000/rpc/read_inbox` directly with `curl -X POST`.
   The BFF returns 401 `{ code: "no_session" }`. The slice-7-era
   "no auth" property is gone.

## Trade-offs accepted

- **Hosted UI is a redirect, not an embedded page.** A click on
  "log in" leaves the webmail tab briefly. Acceptable — the operator
  authenticates rarely (every 30 days, once the refresh token kicks
  in) and Hosted UI's security properties are worth the redirect.
- **Refresh tokens live inside the session cookie.** The cookie is
  larger (~1.5 KB). Browsers cap cookies at 4 KB per origin; we're
  well under. Alternative is a server-side session store, which adds
  a DynamoDB table and a refresh-token-rotation cycle for what is
  essentially "where do we put a 200-byte secret". Cookie is simpler.
- **The BFF is the trust boundary for the refresh token.** A BFF
  compromise leaks every active session's refresh token (decryptable
  with the master key). Mitigation is the standard one: minimize
  BFF attack surface, keep the master key in
  `OPENSESAME_SESSION_SECRET`, rotate on suspected compromise. ADR-0049
  (slice 9.6) tightens this further by running the BFF as a Lambda
  with the secret pulled from Secrets Manager rather than env.
- **Two-cookie auth scheme (`os_auth_state` for the OAuth handshake,
  `os_session` for the session itself).** Some implementations
  collapse these into one. We keep them separate because their
  lifetimes differ by three orders of magnitude (10 min vs. 30 days)
  and conflating them would mean every session-cookie invalidation
  also clears in-flight OAuth handshakes, which is the wrong
  product behavior.
- **The BFF still talks to the core library directly.** Every
  authenticated user has full operator authority. This is the
  *transition* property of slice 9.1; it goes away in slice 9.2 when
  `requireGrant` arrives and starts gating per-RPC capability.
