# ADR-0021 retrospective

ADR-0021 (slice 7, dated 2026-02) shipped the BFF dispatcher as
"the eventual MCP wire shape" and made one explicit, falsifiable
prediction: every per-tool handler would shrink to one line —
`return mcpClient.call(tool, body)` — once the MCP client landed.
This document is the slice-9 PRD's required retrospective on that
prediction. Findings drive the design of ADR-0046 (slice 9.3).

The retrospective is intentionally short. The full design response
to its findings lives in ADR-0046.

## What ADR-0021 predicted

Quoting ADR-0021 directly:

> Each handler's job in the eventual MCP world is unchanged: parse
> the body, call the tool, translate the result. The dispatcher's
> body is essentially `mcpClient.call(tool_name, body)` plus the
> error-translation table. Slice 7's per-handler shape collapses
> to one line per tool when MCP arrives.

Two implicit claims:

1. **Transport claim.** The BFF's wire shape (`POST /rpc/<tool>`)
   maps cleanly onto an MCP `tools/call` shape; the BFF becomes a
   thin HTTP-to-MCP translator.
2. **Implementation locus claim.** The per-tool work the BFF does
   today (parse, validate, orchestrate, error-translate) is itself
   thin — once `mcpClient` exists, the BFF's per-handler function
   collapses.

## What actually happened

### Transport claim: confirmed

The BFF's `POST /rpc/<tool>` envelope and the MCP wire's `tools/call`
envelope are isomorphic at the body level: tool name + input → tool
result or structured error. The translation layer between them is
the error-status mapping (which `kind` → which HTTP code) and
nothing else. ADR-0046's `mcpToHttp` function is the entire delta;
roughly 30 lines of switch-on-error-kind.

This is what ADR-0021 was right about. The wire format was a sound
investment.

### Implementation locus claim: did not hold

The slice-7 dispatcher was 30-line per-handler functions. The
slice-8.22 dispatcher's per-handler functions are still 30 lines;
some are larger (the send-email handler in
`src/bin/webmail-bff.ts:135-228` is 90+ lines including the
attachment-decoding orchestration).

The handlers did not shrink because **the per-tool work is the
tool**: compose-input shaping, attachment-decoding, SES dep wiring,
`persistOutbound` orchestration, suppression-list lookup,
audit-row writing. None of that disappears when MCP "arrives" — it
*is* the tool's implementation. ADR-0021 implicitly assumed the
tool's implementation lived behind a yet-to-exist `mcpClient`; in
practice it lived in front of the dispatcher all along, and the
`mcpClient` of ADR-0021's vision didn't have anything left to do.

### Schema layer: leaked

The PRD's hypothesis was that `parseSaveDraftInput` and friends
need to live next to either the BFF *or* the MCP server, not both,
and ADR-0021 didn't account for it.

Confirmed by reading `src/bff/schemas.ts`. Every parser is a
hand-rolled `unknown → Result<Input, ParseError>` walker that
produces both:

- the typed input the handler consumes, and
- the 400-pointer error body the BFF returns to the webmail UI on
  malformed input.

The 400-pointer is HTTP-specific. The typed input is tool-specific.
ADR-0021's wire-format design didn't anticipate that the parser
would carry both responsibilities, and as a result the parsers grew
HTTP coupling that doesn't belong in the eventual MCP-server tool
files.

## Findings, ranked by impact

1. **The BFF dispatcher should not be the implementation locus.**
   The per-tool work belongs in MCP's tool registry. The BFF's job
   is "translate HTTP to tool-call, translate tool-call result to
   HTTP" — *that's* the one-line shape ADR-0021 was reaching for,
   but on the dispatcher level, not the per-handler level.
2. **Schemas live next to tool implementations.** Each tool exports
   its parser; the BFF imports the parser; the parser produces
   typed input or a structured (HTTP-agnostic) error; the BFF
   maps the structured error to HTTP 400.
3. **The wire format was correct.** The BFF's `/rpc/<tool>` shape
   and the MCP `tools/call` shape are isomorphic at the body
   level. ADR-0046 keeps the wire and changes only what's behind
   it.

## How ADR-0046 acts on this

- The dispatcher shrinks to a 5-line `dispatch()` that calls
  `mcpClient.call(tool, body, ctx)` and runs `mcpToHttp` on the
  result. Per-handler functions are deleted.
- `src/bff/schemas.ts` is deleted; each parser moves to
  `src/mcp/tools/<tool>.ts` and is re-exported through
  `src/mcp/tools/index.ts`.
- The MCP server's tool registry holds parser + handler +
  capability + I/O types per tool. The BFF imports `McpClient`
  and nothing tool-specific.
- The HTTP-translation layer is one file (~30 lines):
  `src/bff/mcp-http-translation.ts`.

ADR-0046 is the design response. This retrospective records what
was learned to motivate it.

## What this changes about how we write predictive ADRs

ADR-0021 made a falsifiable prediction. That's the right shape for
an ADR; it's the property that made this retrospective possible
9 months later. The lesson is not "don't predict" — it's "predict
the layer that's actually load-bearing".

ADR-0021's load-bearing claim was about *the wire*. It got wrapped
in a co-claim about *the dispatcher's per-handler shape*, which
was a less defensible inference from the same wire-format design
choice. Future ADRs that pin a wire format should explicitly
*not* commit to where the implementation behind that wire lives;
that's a separate decision the implementation experience teaches.

The take-home, for the next ADR that pins a wire format:

> Pin the envelope. Note that "where the work happens behind the
> envelope" is a separate decision the implementation experience
> will teach. Resist the urge to predict both at once.

## Inherits from

- **ADR-0021** — the predictions this retrospective evaluates.
- **ADR-0046** — the slice that consumes these findings.
