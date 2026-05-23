// Search operator parser per ADR-0036 (slice 8.17).
//
// Tokenizes a query string into a flat AST. The grammar is intentionally
// small: closed key:value operator set, AND across keys, OR within a key,
// per-token negation with a leading `-`, and free-text fragments that
// AND-compose into the body fan-out. No parens, no boolean grouping, no
// regex. Out-of-grammar input returns a ParseError, never silently
// degrades to substring search.
//
// Hand-rolled per the in-tree-primitives policy — the grammar is small
// enough to fit on one screen and pinning it to a parser library would
// add a dependency for ~120 lines of code.

export type SearchAst = {
  free: string[];
  from: { include: string[]; exclude: string[] };
  to: { include: string[]; exclude: string[] };
  subject: { include: string[]; exclude: string[] };
  flags: {
    unread?: boolean;
    starred?: boolean;
    snoozed?: boolean;
    has_attachment?: boolean;
  };
  view: "trash" | "archive" | null;
};

export type ParseError = {
  field: "query";
  code: "invalid_value";
  message: string;
  position?: number;
};

export type ParseResult =
  | { ok: true; value: SearchAst }
  | { ok: false; error: ParseError };

const SUBSTRING_KEYS = new Set(["from", "to", "subject"]);
const IS_VALUES = new Set(["unread", "starred", "snoozed"]);
const IN_VALUES = new Set(["trash", "archive"]);
const HAS_VALUES = new Set(["attachment"]);

export function emptyAst(): SearchAst {
  return {
    free: [],
    from: { include: [], exclude: [] },
    to: { include: [], exclude: [] },
    subject: { include: [], exclude: [] },
    flags: {},
    view: null,
  };
}

export function parseSearchQuery(input: string): ParseResult {
  const tokens = tokenize(input);
  if (!tokens.ok) return { ok: false, error: tokens.error };

  const ast = emptyAst();
  for (const tok of tokens.value) {
    const r = applyToken(ast, tok);
    if (!r.ok) return r;
  }
  return { ok: true, value: ast };
}

type Token = {
  raw: string;
  position: number;
  negated: boolean;
  key: string | null;
  value: string;
};

type TokenizeResult =
  | { ok: true; value: Token[] }
  | { ok: false; error: ParseError };

// Whitespace-split honoring double-quoted segments. Quoted values may
// contain spaces; backslash escapes are not honored in v1 (a literal `"`
// inside a quoted value rejects). Bare tokens are split on the first
// `:` into key/value; tokens with no `:` are free-text fragments.
function tokenize(input: string): TokenizeResult {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && input[i] === " ") i += 1;
    if (i >= input.length) break;

    const start = i;
    let buf = "";
    let inQuote = false;
    let raw = "";
    while (i < input.length) {
      const ch = input[i];
      if (inQuote) {
        if (ch === '"') {
          inQuote = false;
          raw += ch;
          i += 1;
        } else {
          buf += ch;
          raw += ch;
          i += 1;
        }
      } else if (ch === '"') {
        inQuote = true;
        raw += ch;
        i += 1;
      } else if (ch === " ") {
        break;
      } else {
        buf += ch;
        raw += ch;
        i += 1;
      }
    }
    if (inQuote) {
      return {
        ok: false,
        error: {
          field: "query",
          code: "invalid_value",
          message: `unclosed quote in token: ${raw}`,
          position: start,
        },
      };
    }

    let body = buf;
    let negated = false;
    if (body.startsWith("-") && body.length > 1) {
      negated = true;
      body = body.slice(1);
    }

    const colon = body.indexOf(":");
    if (colon < 0 || colon === 0) {
      // free-text fragment: bare word, or a leading `:value` with no key
      // (treat the latter as free-text rather than a parse error since
      // it has no key for the closed-set check to fail against).
      out.push({
        raw,
        position: start,
        negated,
        key: null,
        value: negated ? `-${body}` : body,
      });
      continue;
    }

    const key = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1);
    out.push({ raw, position: start, negated, key, value });
  }
  return { ok: true, value: out };
}

function applyToken(ast: SearchAst, tok: Token): ParseResult {
  if (tok.key === null) {
    if (tok.value.length > 0) ast.free.push(tok.value);
    return { ok: true, value: ast };
  }

  if (SUBSTRING_KEYS.has(tok.key)) {
    if (tok.value.length === 0) {
      return invalid(
        `operator ${tok.key}: requires a non-empty value`,
        tok.position,
      );
    }
    const slot = ast[tok.key as "from" | "to" | "subject"];
    (tok.negated ? slot.exclude : slot.include).push(tok.value);
    return { ok: true, value: ast };
  }

  if (tok.key === "is") {
    if (!IS_VALUES.has(tok.value)) {
      return invalid(
        `unknown is: value: ${tok.value}`,
        tok.position,
      );
    }
    const flagKey = tok.value as "unread" | "starred" | "snoozed";
    ast.flags[flagKey] = !tok.negated;
    return { ok: true, value: ast };
  }

  if (tok.key === "in") {
    if (!IN_VALUES.has(tok.value)) {
      return invalid(
        `unknown in: value: ${tok.value}`,
        tok.position,
      );
    }
    if (tok.negated) {
      return invalid(
        `negation not supported on in: (use a different view)`,
        tok.position,
      );
    }
    const view = tok.value as "trash" | "archive";
    if (ast.view !== null && ast.view !== view) {
      return invalid(
        `cannot combine in:trash and in:archive in one query`,
        tok.position,
      );
    }
    ast.view = view;
    return { ok: true, value: ast };
  }

  if (tok.key === "has") {
    if (!HAS_VALUES.has(tok.value)) {
      return invalid(
        `unknown has: value: ${tok.value}`,
        tok.position,
      );
    }
    ast.flags.has_attachment = !tok.negated;
    return { ok: true, value: ast };
  }

  return invalid(`unknown operator: ${tok.key}:`, tok.position);
}

function invalid(message: string, position: number): ParseResult {
  return {
    ok: false,
    error: { field: "query", code: "invalid_value", message, position },
  };
}

// Merge a legacy top-level `from`/`to`/`subject` field into the AST as
// if the caller had typed `from:<v>`. Used by parseSearchEmailInput to
// preserve back-compat for the slice-7 wire shape (ADR-0021).
export function mergeLegacyField(
  ast: SearchAst,
  key: "from" | "to" | "subject",
  value: string,
): void {
  if (value.length === 0) return;
  ast[key].include.push(value);
}
