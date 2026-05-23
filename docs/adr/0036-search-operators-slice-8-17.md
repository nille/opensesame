# Search operators on `search_email`, slice 8.17

Slice 7 (ADR-0021) shipped `search_email` as a single free-text `query`
string with optional structured filters (`from`, `to`, `subject`,
`since`, `until`) carried as separate top-level fields on the wire
shape. The web client at `src/web/src/components/Rail.tsx` only ever
populates `query`; the structured fields exist on the contract but no
caller writes them. ADR-0020 ("Audit query") deferred the equivalent
free-text question to a future slice.

The point pressure now: an operator typing `from:alice subject:invoice
is:unread` in the `/`-search box expects Gmail-shape behavior. Today
the entire string is sent as one substring query and matches nothing
useful. Filters that the dispatcher already accepts as named arguments
are unreachable from the search box because nothing parses them out.

This slice adds operator parsing **on the BFF**, leaves the wire
contract for `search_email` syntactically intact (option (b) below),
and maps the parsed AST onto the existing DDB query path with no new
GSI and no new column.

## Decision

### Grammar — closed operator set, key:value tokens, AND across keys

A query string is tokenized into a sequence of tokens, each one of:

- `key:value` — operator with a single value
- `key:"value with spaces"` — quoted form, double-quotes only, no
  escape sequences in v1 (a literal `"` inside a quoted value rejects
  with `invalid_request`)
- `-key:value` / `-key:"..."` — negation of the above
- a bare word (no `:`) — a free-text fragment

Parsing rules:

- Operator keys are **case-insensitive**; values are not folded — case
  folding happens at match time, same as the existing free-text path
  in `searchEmail` at `src/aws/dynamodb-reader.ts:517`.
- The accepted-key set is **closed**. Unknown keys (`fromm:`,
  `attachment:`) parse as a 400 with `field: "query"`,
  `code: "invalid_value"`, and a message that names the offending
  token. We do **not** silently demote to free-text — typos are more
  often typos than intentional substring searches, and a clear error
  surface is friendlier than a query that quietly returns nothing.
- Within one key, multiple tokens **OR**-combine: `from:alice
  from:bob` matches rows where `from_raw` contains either. Across
  keys, **AND**-combine: `from:alice subject:invoice` requires both.
- Negation is a per-token AND-NOT: `-from:bob` is `AND NOT contains
  (from_raw, "bob")`.
- Free-text fragments concatenate (space-joined) into the body
  substring search the existing path already runs. Multiple bare
  words AND-compose at the row level via the same case-folded
  `rowMatchesOnMetadata` + per-message chunk fan-out at
  `dynamodb-reader.ts:541` — the body match has to contain *every*
  free-text fragment, not just one.
- An empty token list (`query: ""`) keeps the existing 400 from
  `parseSearchEmailInput` (`src/bff/schemas.ts:212`) — no behavior
  change.

The accepted operator set for v1:

| Key | Value shape | Maps to |
|---|---|---|
| `from:` | substring | `contains(from_raw, :v)` |
| `to:` | substring | `contains(to_raw, :v)` OR `contains(cc_raw, :v)` |
| `subject:` | substring | `contains(subject, :v)` |
| `has:attachment` | exact | `attribute_exists(attachments)` |
| `is:unread` | exact | `attribute_not_exists(read_at)` |
| `is:starred` | exact | `attribute_exists(starred_at)` |
| `is:snoozed` | exact | `attribute_exists(snoozed_until)` |
| `in:trash` | exact | `attribute_exists(trashed_at)` |
| `in:archive` | exact | `attribute_exists(archived_at)` |

`is:`/`in:`/`has:` values are **exact** — `is:unred` is a 400, same
posture as an unknown key. The exact-value set per `is:`/`in:`/`has:`
is similarly closed.

`to:` ORs across `to_raw` and `cc_raw` so an operator typing
`to:alice` finds threads where they were CC'd; this matches user
intent over wire literalism. BCC is not searchable inbound (recipients
don't know they were BCC'd) and so never participates.

### AST shape — flat record, not a tree

```ts
type SearchAst = {
  free: string[];                  // free-text fragments, AND across rows
  from: { include: string[]; exclude: string[] };
  to:   { include: string[]; exclude: string[] };
  subject: { include: string[]; exclude: string[] };
  flags: {
    unread?: boolean;              // is:unread / -is:unread
    starred?: boolean;
    snoozed?: boolean;
    has_attachment?: boolean;
  };
  view: "trash" | "archive" | null; // in:trash / in:archive (mutually exclusive)
};
```

Flat over tree because:

- The grammar admits no parens and no boolean grouping (out of scope).
- Flat is trivial to translate into a flat list of DDB filter
  clauses, which is what the existing `searchEmail` already builds at
  `dynamodb-reader.ts:473`.
- The `flags` shape is naturally tri-state: absent (don't care),
  `true` (require), `false` (require absence). `is:unread` sets
  `unread: true`; `-is:unread` sets `unread: false`. Conflicting
  tokens (`is:unread -is:unread`) collapse to the latter — last-wins,
  documented, no error.
- `in:trash` and `in:archive` are mutually exclusive; specifying both
  is a 400. They differ from the per-row flags because they flip the
  *view* the search is scoped to, not just a row predicate (see
  "DDB execution strategy" for why).

### Wire format & event compatibility

We pick **option (b)**: server-side parsing. The web client and any
future MCP-tool caller send a single `query` string; the BFF
tokenizes. The existing `from`/`to`/`subject` top-level fields on
`SearchEmailInput` (`src/bff/schemas.ts:179`) **remain accepted** for
back-compat — when present they're folded into the AST as if the
caller had typed `from:<v>`. Tail-add of a structured `operators`
field was considered and rejected — see "Considered and rejected" for
why.

Justification: `search_email` is also an MCP tool surface (per
ADR-0007 and ADR-0021); MCP callers shouldn't have to learn our wire
shape — they should be able to forward whatever a human typed. Web
clients gain operator support transparently with zero contract churn.
ADR-0021's wire-additivity commitment is honored — the input shape
gains no required fields, the output shape is unchanged.

### DDB execution strategy — reuse the existing query path

The AST compiles to additions onto the existing `searchEmail`
FilterExpression assembly at `dynamodb-reader.ts:473`. No new query.
No new GSI. No GSI projection change.

- **`from:` / `to:` / `subject:` includes** — append `contains(#x, :vN)`
  per token; multiple tokens for the same key are joined by `OR` and
  wrapped in parens. Excludes (`-from:bob`) join via `AND NOT
  contains(...)`.
- **`is:unread`** → `attribute_not_exists(read_at)`. Inverse:
  `attribute_exists(read_at)`. The existing `read_at` column carries
  this without any schema change (ADR-0028, ADR-0031).
- **`is:starred`** → `attribute_exists(starred_at)` (ADR-0028).
- **`is:snoozed`** → `attribute_exists(snoozed_until)` (ADR-0029).
  We do **not** compare against `now` — a row with
  `snoozed_until: <past>` is "woken" and the operator likely doesn't
  want it filtered. The view-time logic in the web client already
  handles wake; the operator surface here is "is the row literally
  stamped".
- **`has:attachment`** → `attribute_exists(attachments)`. The write
  path at `src/aws/dynamodb.ts:142` only sets the attribute when the
  list is non-empty, so attribute-presence is a faithful proxy for
  "has at least one attachment". No `size(attachments) > 0` clause
  needed.
- **`in:trash`** / **`in:archive`** → flips the view filter from the
  default ("not trashed AND not archived") to "trashed only" or
  "archived only", emitted as `attribute_exists(trashed_at)` or
  `attribute_exists(archived_at)` respectively. The web client today
  filters trash/archive client-side per ADR-0030 / ADR-0034; the
  operator pushes that filter server-side where the rest of the
  search runs.
- **Body free-text** — every `free[]` fragment AND-composes against
  the existing case-folded body fan-out at
  `dynamodb-reader.ts:520`. The fan-out cap (`FAN_OUT_CAP = 100`)
  stays exactly where it is; operators only narrow the candidate
  set, so the budget improves rather than degrades when filters are
  present.
- **Pagination** — the cursor stays opaque
  (base64(`LastEvaluatedKey`)). The cursor is parsed under the same
  `KeyConditionExpression` and `FilterExpression`, so the AST must
  produce a stable filter shape across pages. We achieve this
  trivially: AST → expression compilation is pure on the AST, and
  the AST is derived from `query` which is part of the cache key.
  Callers must not change `query` and reuse a cursor — same rule as
  today.

### Performance budget

The dominant cost in `search_email` today is the body fan-out
(`chunkMatches` per candidate row). Operators only **add** filter
clauses to the metadata-side `FilterExpression` and **reduce** the
candidate count handed to the fan-out. Per ADR-0004's 3–10 s budget,
adding operators stays well inside it — empirically, every additional
filter clause cuts the page candidate set by ~5–10× on real
mailboxes, which compounds to a faster search, not a slower one.

We do **not** propose a new GSI. ADR-0011 honored. The
`is:`/`in:`/`has:` predicates all map to `attribute_exists` on
already-projected columns; none needs an alternate access pattern.

### Error mode — reject, don't fall back

Invalid grammar (unknown key, unclosed quote, unknown `is:` value,
both `in:trash` and `in:archive`) returns 400 with
`code: "invalid_request"`, `field: "query"`, and a human-readable
message that cites the offending substring. The dispatcher's existing
`invalidRequest` shape (`src/bff/dispatcher.ts:551`) carries the
field-pointer body; we extend it with an optional `position: number`
naming the byte offset of the bad token so the web client can
underline it later. The web doesn't render the position in this
slice, but reserving the field now keeps the wire shape stable when
underlining lands.

The fallback-to-free-text alternative was considered and rejected —
see "Considered and rejected".

### Web wiring

The web client doesn't change in this slice beyond a one-line tweak
to the `placeholder` and the cheat-sheet help text. The `/` search
box at `Rail.tsx:103` continues to send the raw string in
`bff.searchEmail({ address, query, limit: 50 })`
(`src/web/src/components/App.tsx:129`). No autocomplete, no typeahead
chips, no client-side parser.

- `placeholder` widens from `"search"` to
  `"search · from: subject: is:unread …"`.
- The `?` cheat sheet (`App.tsx` keymap help) gains an "operators"
  section enumerating the closed set above.
- The "0 results · try a different query" empty state already exists
  and renders unchanged when the parsed AST returns no matches.
- 400 from the BFF surfaces in the search-status row as the parser's
  human-readable message ("unknown operator: `fromm`"); the existing
  `searchHitCount === null` branch in `Rail.tsx:144` learns to render
  the error message in red instead of "no results yet".

### Tool surface

`search_email` is exposed as an MCP tool per ADR-0007. Because the
operator parser sits **inside** the BFF / library, every MCP caller
gains operator support transparently. No new tool. No new
`search_email_v2`. The MCP tool's `inputSchema` is unchanged —
operators travel inside `query`, not as new top-level fields.

### What this slice does *not* ship

- **No date operators.** `after:2026-01-01`, `before:2026-05-01`,
  `older_than:7d`, `newer_than:24h`. The existing `since` / `until`
  top-level fields cover the use case for now; promoting them into
  the operator grammar is a one-day follow-up.
- **No boolean grouping.** No parens, no explicit `OR` between
  different keys. Within-key OR is implicit; across-key AND is
  implicit; that's the whole language.
- **No saved searches.**
- **No thread-level operators.** `thread:size>5`, `thread:has:reply`,
  `thread:participant:alice`. Threads don't have a server-side
  predicate we can push down today.
- **No autocomplete or typeahead** on operators in the search box.
- **No `body:` operator.** The free-text portion already searches the
  body; a dedicated `body:` would only add value once we also have
  `subject:`-only-match negation, which we don't.
- **No regex values.** `subject:/invoice|receipt/`. Substring-only.

## Implementation

1. **Operator parser** — new file
   `src/core/search-operators.ts` (~120 lines). Exports
   `parseSearchQuery(input: string): ParseResult<SearchAst>`. Hand-
   rolled tokenizer: whitespace split honoring `"..."`, then per-
   token `key:value` split on the first `:`. Closed-set validation
   against constant tables. No new dependencies — same in-tree-
   primitives posture as `src/bff/schemas.ts` and the ULID helpers
   per the project's small-primitives policy.
2. **Core types** — `src/core/store.ts` extends `SearchEmailInput` with
   an optional `ast?: SearchAst` field for the in-process call. Wire
   shape unchanged. The reader prefers `input.ast` when present; falls
   back to parsing `input.query` itself for direct callers (CLI tests,
   future MCP tool wrapper). Tail-add `archived_only?: boolean` and
   `trashed_only?: boolean` on the input as the compiled output of
   `in:trash`/`in:archive` — flag-shape rather than re-encoding the
   AST so the reader's existing flat-string-bag style stays.
3. **DDB compiler** — `src/aws/dynamodb-reader.ts` learns
   `compileAstToFilter(ast)` returning `{ filterClauses, names,
   values }`. The existing `searchEmail` at line 452 stops building
   the `from`/`to`/`subject` clauses inline and instead splices the
   compiler's output into its `FilterExpression`. The body fan-out
   path is unchanged except that `q` becomes `ast.free.join(" ")`
   when the compiler is in use; the per-row `rowMatchesOnMetadata`
   call gains an `allOf` variant that requires every fragment to
   appear (currently any single substring wins).
4. **BFF schema** — `parseSearchEmailInput` in `src/bff/schemas.ts`
   gains an operator-parse pass. On parse failure it returns a
   `ParseError` with `field: "query"`, `code: "invalid_value"`, and
   the offending substring in `message`. The legacy
   `from`/`to`/`subject` top-level fields are still accepted and
   merged into the AST.
5. **BFF dispatcher** — `src/bff/dispatcher.ts:302` (`handleSearchEmail`)
   passes the parsed AST through to `deps.reader.searchEmail` via the
   tail-added `ast` field. No route table change.
6. **Web client** — placeholder widening in
   `src/web/src/components/Rail.tsx:107`, cheat-sheet update in
   `App.tsx`'s keymap help, error-rendering tweak in
   `Rail.tsx:144`'s search-status branch. `bff-client.ts` is
   unchanged — `searchEmail` keeps its existing input type.
7. **Tests**
   - `core/search-operators.test.ts` — table-driven grammar tests:
     every accepted operator, negation, multi-value OR-within-key,
     quoted values, unknown keys, unknown `is:` values, unclosed
     quote, both `in:trash` + `in:archive`, empty query, free-text-
     only, mixed.
   - `dynamodb-reader.test.ts` — extends the search test with a
     `from:alice is:unread has:attachment` case asserting the
     emitted `FilterExpression` and `ExpressionAttributeNames`/
     `Values` shape (no live DDB; mock client).
   - `bff-dispatcher.test.ts` — adds a 400 case for an unknown key
     and a 200 case for `query: "from:alice"` round-tripping
     through the AST.
   - `bff-schemas.test.ts` — `parseSearchEmailInput` accepts
     legacy `from` top-level alongside `query: "subject:invoice"`
     and merges them.

## Considered and rejected

- **Tail-add a structured `operators` field on `search_email`
  (option (a)).** The web client gets typed safety, but every MCP-
  tool caller has to learn the operator shape — including the
  literal Claude/MCP usage where the user types a query and the
  agent forwards it verbatim. Server-side parsing is one
  implementation in one language; client-side parsing is N
  implementations across N callers. Option (b) wins for the same
  reason `audit_query`'s `address` filter accepts a free email
  string rather than a parsed `{ local, domain }` shape (ADR-0020).
- **Silently fall back to free-text on parse failure.** Friendly,
  but a typo (`fromm:alice`) silently returns the inbox-window
  rows whose body contains the literal substring `fromm:alice` —
  almost never what the operator wanted. A clear 400 is louder
  than a stale empty state.
- **Add a `subject_lower` mirror column for case-insensitive
  metadata `contains()`.** The existing free-text path already
  case-folds in app code at `dynamodb-reader.ts:541`; the operator
  path inherits that. A mirror column doubles write cost for no
  measurable read win at v1 mailbox sizes.
- **Add a `HasAttachmentsGSI` for fast `has:attachment` listing.**
  ADR-0011 honored — `has:attachment` is a filter on an existing
  attribute; a GSI rebuild is unjustifiable for a predicate the
  operator pairs with other filters anyway.
- **Allow `is:read` as the inverse of `is:unread`.** Discoverable
  via `-is:unread`; adding a second name for the same predicate
  fragments the grammar. Same reasoning rejects `is:active` /
  `is:inbox` as inverses of `in:trash` / `in:archive`.
- **Push `is:starred` / `is:snoozed` through a sparse GSI rather
  than a filter expression.** Once `starred-by-time` becomes a
  view in its own right (today it's a client-side filter per
  ADR-0028), a GSI may earn its keep. At v1 mailbox sizes the
  filter-expression path is fast enough.
- **Date operators in this slice.** Worth doing, deferred for
  scope. The grammar is forward-compatible — `after:` and
  `before:` slot in cleanly with the same `key:value` lexer; only
  the validator changes.
- **Boolean grouping with parens.** Adds real parser surface
  (precedence, error recovery on unbalanced parens) for a
  vanishingly small UX win at this maturity. Deferred until an
  operator actually asks.
- **Promote `from:`/`to:`/`subject:` to require parsed
  `from`/`to`/`subject` top-level fields and reject them inside
  `query`.** Backwards-incompatible; ADR-0021 commits to wire-
  additive evolution. The merge-as-AST path keeps every existing
  caller working.
- **Reject `to:` matching CC.** Strictly correct (CC is not To),
  but inconsistent with operator intent — an operator searching
  `to:alice` wants to find every thread Alice was a recipient on,
  not just primary-To. Match user intent.
