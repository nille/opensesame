// In-process AWS SDK stubs for the BFF integration harness (PRD:
// bff-integration-harness). Hand-rolled per the PRD's "no @aws-sdk/client-mock"
// decision — the surface is small (3 clients, ~10 commands) and the stubs are
// versionless. They are NOT a full DynamoDB/S3/SES emulator: each stub
// implements just the command shapes the reader, audit log, attachment store,
// raw store, and SES mailer actually call.
//
// Each stub returns the same response shape the real SDK does so the adapters'
// parsing path runs unchanged.

import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";

// ------------------------------------------------------------ DynamoDB stub

type Row = Record<string, unknown>;

export type StubDynamoState = {
  // Map<table, Map<rowKey, Row>>. rowKey = `${pk}|${sk ?? ""}`. The keys are
  // discovered from the Key/Item shape on each command — the reader writes
  // both Messages (PK=address, SK=internal_id) and MessageBodyChunks
  // (PK=internal_id, SK=chunk_seq), and each row carries the attribute names
  // explicitly so the stub doesn't need a schema map.
  tables: Map<string, Map<string, Row>>;
  // Records every Command sent. Tests use this when they want to assert a
  // specific shape (e.g. an UpdateExpression).
  calls: Array<{ command: string; input: unknown }>;
};

export type StubDynamoClient = {
  client: DynamoDBDocumentClient;
  state: StubDynamoState;
  // Test helper: pre-seed a row directly without going through PutCommand.
  seed: (table: string, item: Row) => void;
  // Test helper: dump every row in a table (handy for debugging).
  dump: (table: string) => Row[];
};

// Best-effort PK/SK derivation. The Messages table uses (address, internal_id);
// MessageBodyChunks uses (internal_id, chunk_seq); the Audit table uses
// (audit_id) only. We accept whatever shape the caller passes and key on
// every attribute for a stable composite — the operator-of-the-day's
// schema choice doesn't matter as long as the same Item shape Round-trips.
function rowKey(item: Row): string {
  // Use the canonical key attributes when present, else fall back to the
  // sorted-attribute fingerprint so any single-attribute table (Audit) still
  // hashes uniquely.
  if (typeof item["address"] === "string" && "internal_id" in item) {
    return `${item["address"]}|${String(item["internal_id"])}`;
  }
  if ("internal_id" in item && "chunk_seq" in item) {
    return `${String(item["internal_id"])}|${String(item["chunk_seq"])}`;
  }
  if (typeof item["audit_id"] === "string") {
    return `audit|${item["audit_id"]}`;
  }
  // Fallback: stable serialization of all keys.
  return Object.entries(item)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .sort()
    .join("&");
}

function keyOnly(key: Row): string {
  return rowKey(key);
}

export function makeStubDynamoClient(): StubDynamoClient {
  const state: StubDynamoState = {
    tables: new Map(),
    calls: [],
  };

  function tableMap(name: string): Map<string, Row> {
    let t = state.tables.get(name);
    if (!t) {
      t = new Map();
      state.tables.set(name, t);
    }
    return t;
  }

  // The DynamoDBDocumentClient delegates to a plain DynamoDBClient under the
  // hood. We only need to satisfy the lib-dynamodb wrapper's `.send(command)`
  // surface — the production code never reaches into client internals.
  const fakeClient = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutCommand) {
        const input = command.input as {
          TableName: string;
          Item: Row;
          ConditionExpression?: string;
        };
        state.calls.push({ command: "PutCommand", input });
        const table = tableMap(input.TableName);
        const k = rowKey(input.Item);
        if (input.ConditionExpression?.includes("attribute_not_exists")) {
          if (table.has(k)) {
            throw new ConditionalCheckFailedException({
              $metadata: {},
              message: "stub: attribute_not_exists guard hit",
            });
          }
        }
        table.set(k, { ...input.Item });
        return {};
      }

      if (command instanceof GetCommand) {
        const input = command.input as { TableName: string; Key: Row };
        state.calls.push({ command: "GetCommand", input });
        const table = tableMap(input.TableName);
        const item = table.get(keyOnly(input.Key));
        return item === undefined ? {} : { Item: { ...item } };
      }

      if (command instanceof DeleteCommand) {
        const input = command.input as { TableName: string; Key: Row };
        state.calls.push({ command: "DeleteCommand", input });
        const table = tableMap(input.TableName);
        table.delete(keyOnly(input.Key));
        return {};
      }

      if (command instanceof UpdateCommand) {
        const input = command.input as {
          TableName: string;
          Key: Row;
          UpdateExpression: string;
          ConditionExpression?: string;
          ExpressionAttributeNames?: Record<string, string>;
          ExpressionAttributeValues?: Record<string, unknown>;
          ReturnValues?: string;
        };
        state.calls.push({ command: "UpdateCommand", input });
        const table = tableMap(input.TableName);
        const k = keyOnly(input.Key);
        const existing = table.get(k);
        // ConditionExpression: support attribute_exists(...) AND #kind = :draft
        // and the simpler attribute_exists(thread_id) pattern. If condition
        // names a missing row OR a missing attribute value, fail. Anything more
        // exotic falls back to "exists" check.
        if (input.ConditionExpression !== undefined) {
          if (existing === undefined) {
            throw new ConditionalCheckFailedException({
              $metadata: {},
              message: "stub: row missing for ConditionExpression",
            });
          }
          if (
            !evalSimpleConditionExpression(
              input.ConditionExpression,
              existing,
              input.ExpressionAttributeNames ?? {},
              input.ExpressionAttributeValues ?? {},
            )
          ) {
            throw new ConditionalCheckFailedException({
              $metadata: {},
              message: "stub: ConditionExpression failed",
            });
          }
        }
        const next: Row = existing ? { ...existing, ...input.Key } : { ...input.Key };
        applyUpdateExpression(
          input.UpdateExpression,
          next,
          input.ExpressionAttributeNames ?? {},
          input.ExpressionAttributeValues ?? {},
        );
        table.set(k, next);
        if (input.ReturnValues === "ALL_NEW") {
          return { Attributes: { ...next } };
        }
        return {};
      }

      if (command instanceof QueryCommand) {
        const input = command.input as {
          TableName: string;
          IndexName?: string;
          KeyConditionExpression: string;
          ExpressionAttributeValues?: Record<string, unknown>;
          ScanIndexForward?: boolean;
          Limit?: number;
        };
        state.calls.push({ command: "QueryCommand", input });
        const table = tableMap(input.TableName);
        const items = filterByKeyCondition(
          [...table.values()],
          input.KeyConditionExpression,
          input.ExpressionAttributeValues ?? {},
          input.IndexName,
        );
        const sortAttr = sortAttrFor(input.KeyConditionExpression, input.IndexName);
        if (sortAttr !== null) {
          items.sort((a, b) => {
            const av = String(a[sortAttr] ?? "");
            const bv = String(b[sortAttr] ?? "");
            return input.ScanIndexForward === false ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const limited = input.Limit ? items.slice(0, input.Limit) : items;
        return { Items: limited.map((i) => ({ ...i })) };
      }

      throw new Error(
        `stubDynamoClient: unsupported command ${command?.constructor?.name ?? typeof command}`,
      );
    },
  };

  // Tag the fake so the production code's instanceof DynamoDBDocumentClient
  // checks (none today) wouldn't trip. lib-dynamodb returns a class instance
  // but the production code only ever calls .send.
  return {
    client: fakeClient as unknown as DynamoDBDocumentClient,
    state,
    seed: (table, item) => tableMap(table).set(rowKey(item), { ...item }),
    dump: (table) => [...tableMap(table).values()],
  };
}

// Evaluate a tiny subset of ConditionExpression syntax — enough for the
// reader's drafts/threads paths:
//   attribute_exists(<name>) [AND <name|alias> = <value>]
//   attribute_not_exists(<name>) — handled inline at the call-site for Put
function evalSimpleConditionExpression(
  expr: string,
  row: Row,
  names: Record<string, string>,
  values: Record<string, unknown>,
): boolean {
  // Strip parens, normalize whitespace
  const norm = expr.replace(/\s+/g, " ").trim();
  const parts = norm.split(/\s+AND\s+/i);
  for (const p of parts) {
    const part = p.trim();
    const exists = /^attribute_exists\(([^)]+)\)$/i.exec(part);
    if (exists) {
      const attr = resolveName(exists[1]!.trim(), names);
      if (!(attr in row)) return false;
      continue;
    }
    const notExists = /^attribute_not_exists\(([^)]+)\)$/i.exec(part);
    if (notExists) {
      const attr = resolveName(notExists[1]!.trim(), names);
      if (attr in row) return false;
      continue;
    }
    const eq = /^([#:\w]+)\s*=\s*([#:\w]+)$/.exec(part);
    if (eq) {
      const lhs = resolveName(eq[1]!, names);
      const rhsRef = eq[2]!;
      const rhs = rhsRef.startsWith(":") ? values[rhsRef] : rhsRef;
      if (row[lhs] !== rhs) return false;
      continue;
    }
    // Unknown clause — fail closed so test errors are loud.
    throw new Error(`stubDynamo: unsupported condition clause: ${part}`);
  }
  return true;
}

function resolveName(token: string, names: Record<string, string>): string {
  return token.startsWith("#") ? names[token] ?? token : token;
}

// Apply a tiny subset of UpdateExpression: SET clauses with comma-separated
// `<name> = <value>` pairs. ADD/REMOVE/DELETE not supported (the reader's
// draft paths only emit SET; thread label paths use ADD/DELETE on String Sets
// — out of scope for the integration harness's drafts/inbox/get/send focus).
function applyUpdateExpression(
  expr: string,
  row: Row,
  names: Record<string, string>,
  values: Record<string, unknown>,
): void {
  const norm = expr.trim();
  const setMatch = /^SET\s+(.+?)(?:\s+REMOVE\s+|\s+ADD\s+|\s+DELETE\s+|$)/i.exec(norm);
  if (!setMatch) {
    throw new Error(`stubDynamo: only SET-prefix UpdateExpression supported, got: ${expr}`);
  }
  const setBody = setMatch[1]!;
  const clauses = splitTopLevelCommas(setBody);
  for (const clause of clauses) {
    const eq = /^\s*([#:\w]+)\s*=\s*(.+?)\s*$/.exec(clause);
    if (!eq) {
      throw new Error(`stubDynamo: cannot parse SET clause: ${clause}`);
    }
    const lhs = resolveName(eq[1]!, names);
    const rhsExpr = eq[2]!;
    // Only support a literal `:val` reference. No arithmetic.
    if (rhsExpr.startsWith(":")) {
      row[lhs] = values[rhsExpr];
      continue;
    }
    if (rhsExpr.startsWith("#")) {
      row[lhs] = row[resolveName(rhsExpr, names)];
      continue;
    }
    throw new Error(`stubDynamo: unsupported RHS in SET: ${rhsExpr}`);
  }
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

// Filter rows matching a tiny KeyConditionExpression dialect.
//   - "<pk> = :v"
//   - "<pk> = :v AND <sk> = :w"
//   - "<pk> = :v AND begins_with(<sk>, :pfx)"
//   - "<pk> = :v AND <sk> BETWEEN :lo AND :hi"
function filterByKeyCondition(
  rows: Row[],
  expr: string,
  values: Record<string, unknown>,
  indexName: string | undefined,
): Row[] {
  // Tests against the reader's MessageId GSI: it queries `message_id = :mid`.
  // Treat indexName == "GSI1" by selecting on `message_id` only.
  const norm = expr.replace(/\s+/g, " ").trim();
  // Split on AND, but skip the AND that's part of BETWEEN :lo AND :hi.
  // Easiest: tokenize and treat any AND that follows a `:`-prefixed value
  // and is followed by another `:`-prefixed value as the BETWEEN connective.
  const parts: string[] = [];
  const tokens = norm.split(/\s+/);
  let buf: string[] = [];
  let withinBetween = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.toUpperCase() === "BETWEEN") {
      withinBetween = true;
      buf.push(t);
      continue;
    }
    if (t.toUpperCase() === "AND") {
      if (withinBetween) {
        buf.push(t);
        withinBetween = false;
        continue;
      }
      parts.push(buf.join(" "));
      buf = [];
      continue;
    }
    buf.push(t);
  }
  if (buf.length > 0) parts.push(buf.join(" "));
  return rows.filter((row) => {
    for (const p of parts) {
      const part = p.trim();
      const eq = /^(\w+)\s*=\s*(:\w+)$/.exec(part);
      if (eq) {
        const attr = eq[1]!;
        const v = values[eq[2]!];
        if (row[attr] !== v) return false;
        continue;
      }
      const beginsWith = /^begins_with\((\w+),\s*(:\w+)\)$/i.exec(part);
      if (beginsWith) {
        const attr = beginsWith[1]!;
        const pfx = String(values[beginsWith[2]!] ?? "");
        if (typeof row[attr] !== "string" || !(row[attr] as string).startsWith(pfx)) {
          return false;
        }
        continue;
      }
      const between = /^(\w+)\s+BETWEEN\s+(:\w+)\s+AND\s+(:\w+)$/i.exec(part);
      if (between) {
        const attr = between[1]!;
        const lo = String(values[between[2]!] ?? "");
        const hi = String(values[between[3]!] ?? "");
        const got = String(row[attr] ?? "");
        if (got < lo || got > hi) return false;
        continue;
      }
      throw new Error(`stubDynamo: unsupported KeyCondition clause: ${part}`);
    }
    return true;
  });
}

// Heuristic: pick the sort attribute the test should sort on. For the
// MessageId GSI, we don't sort. For a base-table query keyed on
// `address = :addr AND internal_id …` the SK is internal_id; for
// MessageBodyChunks it's chunk_seq.
function sortAttrFor(expr: string, indexName: string | undefined): string | null {
  if (indexName !== undefined) return null;
  if (/internal_id/i.test(expr)) return "internal_id";
  if (/chunk_seq/i.test(expr)) return "chunk_seq";
  return null;
}

// --- Suppress the unused import warning. The DynamoDBClient symbol is
// kept around so future SDK changes that relocate the doc-client wrapper
// pick the right module without rebreaking the stub.
export type _UnusedDdb = DynamoDBClient;

// ------------------------------------------------------------ S3 stub

export type StubS3State = {
  // Map<bucket, Map<key, bytes>>.
  buckets: Map<string, Map<string, Uint8Array>>;
  // Per-object metadata captured on PutObject (ContentType, ContentDisposition).
  meta: Map<string, { contentType?: string; contentDisposition?: string }>;
  calls: Array<{ command: string; input: unknown }>;
};

export type StubS3Client = {
  client: S3Client;
  state: StubS3State;
  seed: (bucket: string, key: string, bytes: Uint8Array, meta?: { contentType?: string }) => void;
};

export function makeStubS3Client(): StubS3Client {
  const state: StubS3State = {
    buckets: new Map(),
    meta: new Map(),
    calls: [],
  };

  function bucketMap(name: string): Map<string, Uint8Array> {
    let b = state.buckets.get(name);
    if (!b) {
      b = new Map();
      state.buckets.set(name, b);
    }
    return b;
  }

  function metaKey(bucket: string, key: string): string {
    return `${bucket}|${key}`;
  }

  const fakeClient = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        const input = command.input as {
          Bucket: string;
          Key: string;
          Body: Uint8Array | Buffer | string;
          ContentType?: string;
          ContentDisposition?: string;
        };
        state.calls.push({ command: "PutObjectCommand", input });
        const bytes =
          typeof input.Body === "string"
            ? new TextEncoder().encode(input.Body)
            : input.Body instanceof Uint8Array
              ? input.Body
              : new Uint8Array(input.Body as Buffer);
        bucketMap(input.Bucket).set(input.Key, bytes);
        const m: { contentType?: string; contentDisposition?: string } = {};
        if (input.ContentType !== undefined) m.contentType = input.ContentType;
        if (input.ContentDisposition !== undefined) m.contentDisposition = input.ContentDisposition;
        state.meta.set(metaKey(input.Bucket, input.Key), m);
        return {};
      }

      if (command instanceof GetObjectCommand) {
        const input = command.input as { Bucket: string; Key: string };
        state.calls.push({ command: "GetObjectCommand", input });
        const bytes = bucketMap(input.Bucket).get(input.Key);
        if (bytes === undefined) {
          throw new NoSuchKey({
            $metadata: {},
            message: `stub: NoSuchKey ${input.Bucket}/${input.Key}`,
          });
        }
        const meta = state.meta.get(metaKey(input.Bucket, input.Key)) ?? {};
        return {
          Body: {
            transformToByteArray: async () => bytes,
          },
          ContentType: meta.contentType,
          ContentDisposition: meta.contentDisposition,
        };
      }

      if (command instanceof DeleteObjectCommand) {
        const input = command.input as { Bucket: string; Key: string };
        state.calls.push({ command: "DeleteObjectCommand", input });
        bucketMap(input.Bucket).delete(input.Key);
        return {};
      }

      throw new Error(
        `stubS3Client: unsupported command ${command?.constructor?.name ?? typeof command}`,
      );
    },
  };

  return {
    client: fakeClient as unknown as S3Client,
    state,
    seed: (bucket, key, bytes, meta) => {
      bucketMap(bucket).set(key, bytes);
      const m: { contentType?: string; contentDisposition?: string } = {};
      if (meta?.contentType !== undefined) m.contentType = meta.contentType;
      state.meta.set(metaKey(bucket, key), m);
    },
  };
}

// ------------------------------------------------------------ SES stub

export type StubSesState = {
  sends: Array<{
    fromEmailAddress?: string;
    destinationToAddresses?: string[];
    rawData?: Uint8Array;
    configurationSetName?: string;
  }>;
  // Test override: when set, SendEmailCommand throws this error so the test
  // can exercise the failure path (audit recordOutcome, suppression handling).
  nextError?: Error;
};

export type StubSesClient = {
  client: SESv2Client;
  state: StubSesState;
};

export function makeStubSesClient(): StubSesClient {
  const state: StubSesState = { sends: [] };

  let nextMessageIdCounter = 1;

  const fakeClient = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof SendEmailCommand) {
        if (state.nextError) {
          const err = state.nextError;
          delete state.nextError;
          throw err;
        }
        const input = command.input as {
          FromEmailAddress?: string;
          Destination?: { ToAddresses?: string[] };
          Content?: { Raw?: { Data?: Uint8Array } };
          ConfigurationSetName?: string;
        };
        const send: StubSesState["sends"][number] = {};
        if (input.FromEmailAddress !== undefined) send.fromEmailAddress = input.FromEmailAddress;
        if (input.Destination?.ToAddresses !== undefined) {
          send.destinationToAddresses = input.Destination.ToAddresses;
        }
        if (input.Content?.Raw?.Data !== undefined) send.rawData = input.Content.Raw.Data;
        if (input.ConfigurationSetName !== undefined) {
          send.configurationSetName = input.ConfigurationSetName;
        }
        state.sends.push(send);
        const id = `stub-ses-${String(nextMessageIdCounter++).padStart(6, "0")}`;
        return { MessageId: id };
      }
      throw new Error(
        `stubSesClient: unsupported command ${command?.constructor?.name ?? typeof command}`,
      );
    },
  };

  return {
    client: fakeClient as unknown as SESv2Client,
    state,
  };
}
