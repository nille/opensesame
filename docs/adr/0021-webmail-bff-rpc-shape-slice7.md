# Webmail BFF: RPC envelope mirroring MCP, runtime-portable handlers, slice 7

ADR-0006 pinned the long-term wire path: webmail UI → BFF → MCP server → core library. The MCP server itself is not yet built (ADR-0020 §"slice scope" deferred it), and slices 1–6 produced a complete-enough core library to read an inbox, fetch a message, and send a tracked email. Slice 7 ships **a BFF and nothing else** so a webmail UI can be wired up in slice 8 against a stable contract — without waiting on Cognito, the MCP server, or grants.

The defining constraint: whatever shape the BFF speaks now must be the **same shape** it speaks after slice 9 swaps the library calls for MCP-client calls. If the wire format changes between slice 7 and slice 9, the UI rewrites along with it. We avoid that by mirroring the MCP tool envelope from day 1.

## Decision

### Wire format: RPC envelope under `/rpc/{tool_name}`

Every BFF endpoint is `POST /rpc/<tool_name>` with a JSON body that matches the corresponding MCP tool's `inputSchema`, and a JSON response that matches its `outputSchema`. The route is the only thing that distinguishes operations — there are no path params, no query strings on the data plane.

```text
POST /rpc/read_inbox
     { address, since?, limit?, cursor?, unread_only? }
  → 200 { messages: [...], next_cursor?: "..." }

POST /rpc/get_message
     { message_id }
  → 200 { headers, body_text, body_html?, attachments[] }

POST /rpc/send_email
     { from, to[], cc?[], bcc?[], subject, body_text, body_html?,
       in_reply_to?, references?[], attachments?[] }
  → 200 { message_id, sent_at }
```

The body shape is **literally** the MCP tool's input/output. When slice 9 introduces the MCP client, the BFF's per-route handler shrinks to one line: `return mcpClient.call("read_inbox", req.body)`. The UI doesn't notice.

Considered and rejected:

- **REST per resource** (`GET /inbox`, `GET /messages/:id`, `POST /send`). Reads natural for curl, but slice 9 would change *both* the dispatch (library → MCP) and the wire format simultaneously, forcing UI churn during the auth migration. RPC envelope localizes the slice-9 change to the dispatcher.
- **Single `/graphql` endpoint.** Powerful for the UI's selective field reads, but adds schema infra to maintain when the MCP tool surface is the schema we already maintain. Defers no real work and competes with MCP as a contract.

### Status codes are HTTP-native; bodies mirror MCP

MCP tool errors are *structured in-band* (`{result?, error?}` per ADR-0007). For a UI, that's hostile — every fetch site has to peek inside the body just to know if a call succeeded.

The BFF therefore lifts **transport-level outcomes** to HTTP status codes:

| HTTP | Meaning | Body |
|---|---|---|
| `200` | Tool returned a result | the MCP `result` shape |
| `400` | Invalid request body (schema mismatch, missing required field) | `{ code, message }` |
| `401` | Unauthenticated (slice 9+; absent in slice 7) | `{ code, message }` |
| `403` | Authenticated but no grant for the requested resource (slice 9+) | `{ code, message }` |
| `404` | Tool name unknown, or `get_message` for nonexistent id | `{ code, message }` |
| `409` | Send blocked by suppression list (per ADR-0019) | `{ code, message, blocked_recipients[] }` |
| `429` | SES rate-limited or app-level throttle | `{ code, message, retry_after_seconds? }` |
| `5xx` | Unexpected fault (DDB error, code bug) | `{ code, message }` |

Tool-level "expected failures" that don't have a clean HTTP analogue (e.g. a `send_email` with one valid recipient and one suppressed one — partial outcome) still surface as `200` with the MCP `error` field set, exactly as MCP describes. The rule is: **transport layer says yes/no, body says what happened.** UIs check status first; bodies are only inspected on `2xx`.

### Runtime: Hono, with framework-agnostic handlers

Handlers are written as pure async functions over a `BffDeps` object — no framework imports in the route logic itself. Hono is the *initial* dispatcher because:

- It has a [`hono/aws-lambda`](https://hono.dev/docs/getting-started/aws-lambda) adapter, so slice 9 mounts the same handlers behind API Gateway with one entry-point file change.
- Zero-config dev loop: `pnpm tsx src/bin/webmail-bff.ts` runs a localhost server, hot-reloadable with `tsx --watch`.
- Tiny dependency surface (single package, no plugin ecosystem we'd grow attached to).

Handler signature:

```ts
export type BffDeps = {
  reader: InboxReader;
  messageGetter: MessageGetter;
  sender: SendWithAuditFn;
  // …one port per tool
};
export type RpcHandler<I, O> = (deps: BffDeps, input: I) => Promise<O>;
```

Routes register handlers by name:

```ts
const routes: Record<string, RpcHandler<any, any>> = {
  read_inbox: handleReadInbox,
  get_message: handleGetMessage,
  send_email: handleSendEmail,
};
```

A single Hono dispatcher reads the path, validates the body against the tool's Zod schema (one schema per tool, generated alongside the handler), and calls the handler. **No code in the handler depends on Hono.** When slice 9 ports to Lambda, the dispatcher is reused via `hono/aws-lambda`; if we ever swap Hono out, only the dispatcher changes.

### Slice 7 has no auth

Per the slice plan, we defer auth to slice 9. The BFF binds to `127.0.0.1:3000` only — *not* `0.0.0.0` — and the dev driver refuses to start if `OPENSESAME_BFF_BIND` is not localhost. CORS is open to `http://localhost:5173` (Vite default for slice 8) and *only* localhost.

This is explicit: **the slice-7 BFF is unsafe for any non-loopback exposure.** The README and the dev driver's startup banner both say so. Slice 9 adds Cognito JWT validation as middleware before mounting the dispatcher.

### Schemas are the contract — hand-rolled, not Zod

Each tool gets one TypeScript `type` for input, one for output, plus a hand-rolled `parse<ToolName>Input(unknown): Input | ParseError` validator that walks the body and returns either the typed input or a structured error pointing at the first offending field. This matches the project's existing validation idiom (`normalizeAuditRow` in `src/core/audit-query.ts`) and the standing preference for small in-tree primitives over framework dependencies.

The dispatcher uses each parser for:

1. Request validation (400 on shape mismatch, with a field-pointer error body).
2. The shape the slice 9 MCP client will marshal to/from — the same `type` is the JSON schema for the MCP tool when the server lands.

If the parser turns out to grow legs (deep recursive shapes, optional intersections), we revisit Zod then. For three flat tools, hand-rolled is cheaper than the Zod dep.

### Slice scope

Three tools only: **`read_inbox`**, **`get_message`**, **`send_email`**. Enough for slice 8's UI to render an inbox, open a message, and reply with a fresh send. Other ADR-0007 tools (`search_email`, `reply_to_email`, `delete_message`, flag ops, threads) are deferred to slice 8 follow-ups *or* slice 10, depending on what the UI needs first.

## Slice plan

1. **Schemas + handler stubs** — `src/core/bff-schemas.ts` with Zod for `read_inbox`/`get_message`/`send_email`. `src/bff/handlers.ts` with thin handlers calling existing core ports (`reader`, `messageGetter`, `sendWithAudit`). Unit tests against mocked ports.
2. **Dispatcher** — `src/bff/dispatcher.ts` with the route table, schema validation, error→HTTP mapping. Framework-agnostic (takes `{path, body}`, returns `{status, body}`); no Hono imports here.
3. **Hono adapter** — `src/bff/hono-app.ts` exporting a Hono `app` that wraps the dispatcher. Includes CORS and the localhost-only bind check.
4. **Dev driver** — `src/bin/webmail-bff.ts` boots `serve(honoApp, {port: 3000, hostname: "127.0.0.1"})` and reads `OPENSESAME_*` env the same as the existing CLI drivers.
5. **Live verify** — curl each route against prod data: list inbox, fetch a real message, send a tracked email. Confirm shapes match what slice 8 will consume.

## Out of scope

- **Auth.** Slice 9 (Cognito JWT validation, ADR-0008 Layer 1).
- **MCP server.** Same slice (the BFF starts speaking to it instead of calling the library directly).
- **Other tools** (`search_email`, threads, flags, admin tools). Slice 8+ as the UI needs them.
- **Production deployment.** Localhost-only.
- **WebSocket / SSE** for new-mail push. Future; the UI will poll `read_inbox` with `since` for slice 8.

## Trade-offs accepted

- **RPC envelope is mildly less curl-friendly than REST.** Two extra characters per call (`-X POST -d '{}'`). Worth it to avoid the slice-9 wire-format rewrite.
- **HTTP status codes diverge slightly from MCP's "everything is `200` with `error` field".** Intentional: HTTP transport semantics are what the UI's `fetch` consumer expects, and the body still mirrors MCP exactly. The BFF translates one direction (MCP → HTTP); the slice-9 MCP client translates the other (HTTP → MCP) — a thin and obvious conversion.
- **Hono is a new dependency.** Tiny one (~15 KB). The handlers are framework-agnostic so we can swap if it ever stops being the right call.
- **Localhost-only is a hard constraint we have to remember.** The dev driver refuses non-loopback binds; the slice-9 work explicitly removes that guard alongside adding auth. If both halves of that swap don't happen together, we have a documented unsafe-exposure path and the README and startup banner both flag it.
