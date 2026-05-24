# MCP server skeleton (in-process), slice 9.3

ADR-0021 (slice 7) shipped the BFF dispatcher with one explicit
prediction: every per-tool handler would shrink to one line —
`return mcpClient.call(tool, body)` — once the MCP server lands. That
line has been the project's load-bearing claim about why the wire
format is what it is. This slice tests it.

The minimum viable MCP server is a **tool registry that exposes the
same dispatch the BFF does today**, with the BFF dispatcher rewired
to call into it through a thin port. The "wire" between BFF and MCP
is **in-process** for this slice — no HTTP, no MCP transport, no
SigV4, no JWT. That comes in slice 9.4 (ADR-0047).

The point of doing it in-process first is to **decouple two
migrations** that ADR-0021 implicitly assumed would happen together:

1. *Where* the tool logic lives (BFF dispatcher → MCP server).
2. *How* the BFF reaches it (function call → HTTP+SigV4).

Slice 9.3 does only the first. Slice 9.4 does only the second. If
we discovered both at once that ADR-0021's prediction was wrong and
the BFF dispatcher *can't* shrink to one line — the schema layer
needs to live next to the MCP server too — we'd be paying the
SigV4-debugging cost to discover it. Splitting the slices is
cheaper.

## Inheritance + a retrospective

This ADR also folds in the **ADR-0021 retrospective** the slice-9
PRD asks for. The retrospective lives in `docs/adr/0021-retrospective.md`
as a separate doc; this ADR consumes its findings and pins the
shape we're shipping based on what actually happened to the BFF
dispatcher between slices 7 and 8.22.

### The one-line prediction did not hold

ADR-0021 predicted handlers would shrink to:

```ts
async function handleSendEmail(deps, body) {
  return mcpClient.call("send_email", body);
}
```

In practice, after slice 8.22 the dispatcher's send-email handler
is roughly 30 lines of compose-input shaping, attachment decoding,
SES dep wiring, and `persistOutbound` orchestration (see
`src/bin/webmail-bff.ts:135-228`). That logic doesn't disappear when
MCP arrives — it *is* the tool implementation. ADR-0021 was right
about the *transport* (the BFF and MCP speak the same wire shape)
but wrong about the *implementation locus* (the per-tool work does
not live in the BFF; it should live in the MCP server's tool
registry).

Slice 9.3 takes that finding seriously: the per-tool work moves
into MCP, and the BFF dispatcher's job becomes "translate HTTP to
tool-call, translate tool-call result to HTTP". *That* is the
one-line shape, just not the one ADR-0021 named.

### The schema layer leaks

The PRD's hypothesis: schemas (`parseSaveDraftInput` etc.) need to
live next to either the BFF *or* the MCP server, not both. Confirmed
by reading `src/bff/schemas.ts` — every parser is a hand-rolled
`unknown → Result<Input, ParseError>` walker that produces both the
typed input *and* the 400-pointer error body. The 400-pointer is
HTTP-specific; the typed input is tool-specific.

The fix is the obvious one: schemas live next to the **tool
implementations** (in `src/mcp/tools/<tool>.ts`), each tool exports
its parser. The BFF dispatcher calls the tool's parser, gets either
a typed input or a structured error, and translates the error to
HTTP 400 itself. The parser's structured error is HTTP-agnostic;
the HTTP mapping is one function in the BFF.

When slice 9.4 puts the MCP server behind HTTP, the same parser
runs server-side; the BFF runs the parser too (early-rejection, so
a malformed call doesn't burn a SigV4 round-trip). Two parser
invocations per call sounds wasteful but the parsers are O(1) per
field and the early-rejection property is worth the small cost.

## What this slice ships

1. A `src/mcp/server.ts` module exposing `mcpServer.call(tool, input,
   ctx)` — the in-process equivalent of an MCP `tools/call` request.
2. A tool registry (`src/mcp/tools/*.ts`) with one file per tool. Each
   file exports `{ name, parseInput, parseOutput, handler, capability }`.
3. A `McpClient` port (`src/mcp/client.ts`) the BFF depends on. Its
   in-process implementation calls `mcpServer.call` directly. Slice
   9.4 swaps the implementation for an HTTP+SigV4 client; the port
   doesn't move.
4. The BFF dispatcher (`src/bff/dispatcher.ts`) shrinks: every
   `handle<Tool>` becomes parse-then-dispatch-then-translate. The
   tool-specific work (compose shaping, SES wiring, etc.) leaves the
   BFF.
5. `src/bin/webmail-bff.ts` constructs the in-process MCP server +
   client + tool registry, passes the `McpClient` into the dispatcher.
6. The integration harness (`test/bff-integration.test.ts`)
   continues to pass, unchanged. The existing tool unit tests
   (`test/bff-dispatcher.test.ts`, `test/drafts.test.ts`, etc.)
   migrate alongside the tool's move.

## What this slice does *not* ship

- **No HTTP transport.** The MCP server has no `serveHttp()` method.
  The single entry point is `mcpServer.call(...)`. ADR-0047 adds the
  HTTP transport.
- **No agent principals.** The `ctx` argument carries the principal
  the BFF received from its session middleware (slice 9.1) plus the
  Grant (slice 9.2). MCP uses both for capability gating but does
  **not** authenticate them — the BFF is still the authenticator.
  That changes in 9.4.
- **No tool advertisement filtering.** Per ADR-0007, MCP filters its
  tool list per principal (an agent without admin sees no admin
  tools). Slice 9.5 (ADR-0048) needs this; slice 9.3 returns the
  full tool list because every caller is the operator.
- **No MCP wire protocol.** No `initialize`, `tools/list`,
  `tools/call` JSON-RPC envelopes — those are slice 9.4. The
  in-process client passes the tool name and input as positional
  arguments; the response is the typed result or a structured error.
- **No CLI MCP-mode rewire.** ADR-0006 has the CLI in two modes
  (direct + MCP). The CLI today runs in direct mode; slice 9.3
  doesn't change that. Slice 9.4 adds MCP mode (the CLI calls the
  MCP server over HTTP+SigV4) once the transport exists.

## Decision

### Tool registry shape

```ts
// src/mcp/tools/types.ts
export type ToolHandler<I, O> = (
  ctx: ToolContext,
  input: I,
) => Promise<O>;

export type ToolContext = {
  deps: ToolDeps;          // reader, sendEmail, presigner, etc. — see below
  principal: Principal;    // from the BFF's session-cookie middleware (slice 9.1)
  grant: StoredGrant;      // from the BFF's requireGrant middleware (slice 9.2)
  now: () => Date;
  logger: BffLogger;
};

export type Tool<I, O> = {
  name: string;            // "read_inbox", "send_email", etc.
  capability: Capability;  // ADR-0045 — the Grant gate
  parseInput: (raw: unknown) => Result<I, ParseError>;
  // parseOutput is informational at v1 (we trust handlers), but we keep
  // it on the tool record so the slice-9.4 HTTP layer can validate
  // outbound responses and so future codegen can use it.
  parseOutput: (raw: unknown) => Result<O, ParseError>;
  handler: ToolHandler<I, O>;
};
```

### Tool-file layout

```text
src/mcp/
  server.ts        — registry + dispatch
  client.ts        — McpClient port + in-process impl
  tools/
    types.ts       — Tool, ToolContext, ToolDeps, ToolHandler
    read-inbox.ts
    get-message.ts
    send-email.ts
    save-draft.ts
    ...
    index.ts       — { allTools: Tool<any, any>[] }
```

Each tool file moves the per-tool parser (out of `src/bff/schemas.ts`),
the per-tool handler (out of `src/bff/dispatcher.ts`), and the
per-tool input/output types (out of `src/core/store.ts` *if* they
were duplicated; the core types stay). The result is one
self-contained file per tool.

### `mcpServer.call` shape

```ts
// src/mcp/server.ts
export type McpServer = {
  call(tool: string, input: unknown, ctx: ToolContext): Promise<McpCallResult>;
  list(): Tool<any, any>[];  // for slice 9.5 advertisement filtering
};

export type McpCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: McpError };

export type McpError =
  | { kind: "tool_not_found"; tool: string }
  | { kind: "invalid_input"; field: string; reason: string }
  | { kind: "domain_error"; code: string; message: string; meta?: unknown };
```

`domain_error` is the MCP-side encoding of the existing dispatcher
errors (`message_not_found`, `suppression_blocked`, `parse_error`,
etc.). The BFF's HTTP-translation layer maps `kind` to status codes:

| MCP error kind | HTTP status |
|---|---|
| `tool_not_found` | 404 |
| `invalid_input` | 400 |
| `domain_error` w/ `code: "message_not_found"` | 404 |
| `domain_error` w/ `code: "suppression_blocked"` | 409 |
| `domain_error` w/ `code: "rate_limited"` | 429 |
| any other `domain_error` | 500 |

The mapping table lives in `src/bff/mcp-http-translation.ts` and is
the only HTTP-aware code in the dispatcher's new shape.

### BFF dispatcher: from 30 lines per tool to 5

Slice 7 dispatcher (per-tool handler):

```ts
async function handleSendEmail(deps, body) {
  const parsed = parseSendEmailInput(body);
  if (!parsed.ok) return invalidRequest(parsed.error);
  try {
    const result = await deps.sendEmail(parsed.value);
    return ok(result);
  } catch (err) {
    if (err instanceof SuppressionBlockError) return suppression(err);
    return internalError(err);
  }
}
```

Slice 9.3 dispatcher:

```ts
async function dispatch(deps, ctx, path, body) {
  const tool = tool_name_from_path(path);
  const result = await deps.mcpClient.call(tool, body, ctx);
  return mcpToHttp(result);
}
```

That's the dispatcher. Every per-handler function moves to the tool
file. The `try/catch`, the parse error handling, the
`SuppressionBlockError` translation — all of that becomes one
shared function.

The BFF stops importing `parseSendEmailInput`, `parseSaveDraftInput`,
`parseReadInboxInput`, etc. directly. It imports `McpClient`. That's
the abstraction win ADR-0021 was reaching for.

### `ToolDeps`: where do the AWS clients live?

Today the BFF's `webmail-bff.ts` constructs:

- `MessageReader` (DDB)
- `sendEmail` closure (composer + SES + audit + persistOutbound)
- `AttachmentPresigner` (S3)
- `RawMessageReader` (S3)
- `AttachmentStager` (S3)

These all become `ToolDeps`:

```ts
export type ToolDeps = {
  reader: MessageReader;
  attachmentPresigner: AttachmentPresigner;
  attachmentBucket: string;
  rawReader: RawMessageReader;
  attachmentStager: AttachmentStager;
  // send-email's compose+ses+audit+persist orchestration is a tool-private
  // helper inside src/mcp/tools/send-email.ts; ToolDeps exposes the
  // primitives (sesClient, awsRegion, suppressionList, configurationSetName)
  // and the tool composes them.
  sesClient: SESv2Client;
  awsRegion: string;
  rawMimeBucket: string;
  configurationSetName: string | null;
  suppressionList: SuppressionList | null;
  store: MessageStore;            // for persistOutbound
  rawWriter: RawMessageWriter;
};
```

`webmail-bff.ts` constructs `ToolDeps` (the same dep wiring it does
today, just relocated) and passes it into the MCP server's
constructor. The MCP server passes it into each tool's `ctx.deps`.

### `ToolContext` carries the principal + grant

`ctx.principal` and `ctx.grant` come from the BFF's per-request
middleware (slice 9.1, slice 9.2). The MCP server itself does not
authenticate or authorize — it consumes the context the BFF
constructed. *In slice 9.4*, when the MCP server has its own HTTP
entry, it grows its own auth middleware and constructs its own
`ToolContext`; the tool-side shape doesn't change.

This separation keeps the MCP server's library-direct-call path
(slice 9.5+ for the CLI in MCP mode) from needing a fake principal:
the CLI in MCP mode constructs its own `ToolContext` from local AWS
creds, the same way the BFF does from its session cookie. Both
callers go through `mcpServer.call`.

### Wire-shape compatibility check

The wire format that slice-8 webmail consumes is `POST /rpc/<tool>`
with a JSON body matching the tool's input schema, response status
mapped by the table above, response body the tool's result or a
`{ code, message }` error. **Nothing on that wire changes in slice
9.3.** Verified by:

- The integration harness in `test/bff-integration.test.ts` runs
  unchanged. (Slice 9.1 added a session-cookie wrapper to the
  harness; that wrapper survives.)
- `test/bff-dispatcher.test.ts`'s 200/400/404/409 status-code
  expectations stay green — `mcpToHttp` reproduces the same
  mapping the per-handler `try/catch` blocks produced.

### Migration order: one tool at a time

The slice does not flip every tool at once. Order:

1. Build the registry skeleton with **`whoami`** as the first tool
   (smallest surface; slice 9.2 just shipped it).
2. Move **`read_inbox`** (one DDB call, one parser, no orchestration).
3. Move **`get_message`** (the rich-text rehydrate path tests the
   `rawReader` ToolDeps wiring).
4. Move the annotation tools in a batch (`mark_read`, `archive_thread`,
   etc. — they share the same `MessageReader` calls and one parser
   shape).
5. Move the draft tools (`save_draft`, `list_drafts`, `get_draft`,
   `delete_draft`, `stage_attachment`, `get_staged_attachment`).
6. Move **`send_email`** + **`reply_to_email`** last. These are the
   biggest tool-private orchestrations; verifying them in isolation
   needs every other tool to be stable.
7. Move the labels tools.
8. Move the admin tools (`list_grants`, `create_grant`,
   `revoke_grant`).

Each step is a green test suite: the dispatcher delegates that
tool to MCP, every other tool keeps its old per-handler code path.
The dispatcher's `case` table grows a "delegated to MCP" branch
that routes to `mcpClient.call(tool, body, ctx)` per migrated tool;
once every tool is migrated, the per-handler code is deleted in one
sweep and the `case` table collapses to the 5-line shape above.

### Tools shipped as a single sweep, not per-slice

This slice migrates *all* existing tools, in the order above. It
doesn't ship the registry with one tool migrated and call it done —
the partial state ("some tools live in MCP, others in the BFF") is
worse than either endpoint, and we don't want it in main for any
length of time. The verification step at the end of the slice is
"every tool is in MCP, every BFF handler is one line".

### Server-Sent Events / streaming: out

ADR-0007 hints at MCP `resources/subscribe`. Streaming
responses (e.g., `read_inbox` returning rows as they arrive) would
need a different `mcpServer.call` shape — `Promise<AsyncIterable>`
rather than `Promise<Result>`. The current tool surface has no
streaming, and adding that to the registry now is YAGNI. When it's
needed, the registry grows a `streaming: true` flag on the tool
record and a sibling `mcpServer.callStream`. Defer.

## Inherits from

- **ADR-0005** — auth posture; the principal types are the ones the
  Grant table already encodes.
- **ADR-0006** — MCP server is the choke point for untrusted
  callers; this slice puts the dispatch logic in that location even
  though the transport hasn't been added yet.
- **ADR-0007** — the tool surface that MCP advertises. Slice 9.3
  ships the in-process implementation of that surface; slice 9.4
  exposes it over HTTP; slice 9.5 adds advertisement filtering.
- **ADR-0021** — the wire format the BFF speaks. Unchanged. The
  retrospective companion to this ADR (`0021-retrospective.md`)
  documents which of ADR-0021's predictions held and which didn't.
- **ADR-0044** — `ctx.principal` source.
- **ADR-0045** — `ctx.grant` source; `Capability` enum used for tool
  registration.

## Files

| Layer | File | Change |
|---|---|---|
| MCP | `src/mcp/server.ts` | New: registry + `call` |
| MCP | `src/mcp/client.ts` | New: `McpClient` port + in-process implementation |
| MCP | `src/mcp/tools/types.ts` | New: `Tool`, `ToolContext`, `ToolDeps`, `ToolHandler` |
| MCP | `src/mcp/tools/<tool>.ts` × N | New: one per existing tool — parser + handler + capability |
| MCP | `src/mcp/tools/index.ts` | New: `allTools` registry |
| BFF | `src/bff/dispatcher.ts` | Replaced: 5-line dispatch + HTTP translation |
| BFF | `src/bff/mcp-http-translation.ts` | New: `McpCallResult → DispatchResult` mapping |
| BFF | `src/bff/schemas.ts` | Deleted (parsers moved into tool files) |
| BFF | `src/bin/webmail-bff.ts` | Construct `mcpServer`, `mcpClient`, pass into dispatcher deps |
| Tests | `test/mcp-server.test.ts` | New: registry lookup, `call` happy + sad paths, error shape |
| Tests | `test/mcp-tools/<tool>.test.ts` × N | Existing per-tool BFF tests rebased onto the tool's exported `handler` |
| Tests | `test/bff-dispatcher.test.ts` | Trimmed to the dispatcher's translation responsibilities |
| Tests | `test/bff-integration.test.ts` | Unchanged (the integration test is the migration's safety net) |

## Verification

1. The full test suite passes after every per-tool migration step.
   Mid-migration commits leave main green.
2. After the final sweep, the dispatcher is the 5-line shape above
   and `src/bff/schemas.ts` no longer exists.
3. The integration harness covers every tool's wire shape; it ran
   902 tests at the start of slice 9 and ends slice 9.3 with the
   same wire shape green.
4. `wc -l src/bff/dispatcher.ts` returns under 100 lines.
5. The send-email orchestration (compose + SES + audit +
   persistOutbound) lives entirely in `src/mcp/tools/send-email.ts`.
   The BFF entry constructs `ToolDeps`, no longer constructs the
   send-email closure.

## Trade-offs accepted

- **Mid-migration "case table" diff is large.** Each per-tool move
  changes a non-trivial chunk. We mitigate by per-tool commits
  with green tests at each step, not one big commit at the end.
- **Schemas live in MCP, not the BFF.** A future BFF that spoke a
  *different* wire format (REST per resource, GraphQL) would need
  its own translation layer — but it would still import the tool's
  parser. The BFF's job becomes "translate the BFF's wire to
  `mcpClient.call`"; the tool-specific shape is owned by MCP. We
  prefer this over the duplicate-parsers-per-transport shape that
  slice 8 had.
- **In-process MCP "isn't really MCP".** True. ADR-0021's
  prediction was about the *contract* shape, not the *transport*.
  Slice 9.4 adds the transport. The in-process form is what makes
  that addition incremental rather than risky.
- **The CLI direct-mode and the MCP server now have two paths into
  the core library.** Direct mode imports `MessageReader` etc.
  directly; MCP mode goes through `mcpServer.call`. ADR-0006
  endorses this — direct mode is for trusted local callers, MCP
  mode is for anyone else. The two paths share the same core
  library calls; the duplication is at the edge (one line of
  delegation per tool).
- **`ToolDeps` is wider than `BffDeps`.** It carries the SES client,
  AWS region, raw-mime bucket name, etc. that the per-tool
  orchestrations need. The BFF doesn't construct these as
  deps-of-deps; it constructs them as `ToolDeps` directly. Cleaner
  than a multi-layer dep tree.
- **Registry lookup is a switch statement on a string.** Could be a
  `Record<string, Tool>` or a `Map`. We pick a `Record` for
  type-safety (the literal-string keys give per-tool input/output
  type narrowing for the slice-9.5 tool-list filter).
