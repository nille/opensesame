import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  clampLimit,
  normalizeAuditRow,
  type AuditQueryEvent,
  type AuditQueryInput,
  type AuditQueryReader,
  type AuditQueryResult,
} from "../core/audit-query.js";
import { ulidBoundsForTimeRange } from "../core/ids.js";

// DDB-bound implementation of the AuditQueryReader port (ADR-0020).
//
// Query shape: `audit_id BETWEEN :lo AND :hi` on GSI1 ((principal,
// audit_id)). The `since`/`until` window collapses into a synthetic-ULID
// range — see ADR-0020 §"synthetic ULID over `audit_id`" and the helper in
// src/core/ids.ts. Filters for `agent_id` and `address` are
// FilterExpressions; the address filter spans `from`, `to`, `cc`, `bcc`
// (ADR-0020 §"FilterExpressions, not key conditions").
//
// `principal` is hard-coded to "iam:operator" until ADR-0008 Layer 1 lands.
// When real principals show up the deps will grow a `principal: string`
// param without changing the shape of this adapter.

const SOLO_DIRECT_PRINCIPAL = "iam:operator";

export type DynamoAuditQueryDeps = {
  client: DynamoDBDocumentClient;
  auditTable: string;
  // GSI on (principal, audit_id). Plumbed in for the same reason as
  // `messageIdGsiName` on dynamodb-bounce-log: the L2 CDK construct names
  // the index, so we shouldn't pin it in source.
  gsiName: string;
  // Override for tests / future callers; defaults to solo-direct.
  principal?: string;
};

export function makeDynamoAuditQueryReader(
  deps: DynamoAuditQueryDeps,
): AuditQueryReader {
  return {
    query: (input) => query(deps, input),
  };
}

async function query(
  deps: DynamoAuditQueryDeps,
  input: AuditQueryInput,
): Promise<AuditQueryResult> {
  const principal = deps.principal ?? SOLO_DIRECT_PRINCIPAL;
  const limit = clampLimit(input.limit);
  const { lo, hi } = ulidBoundsForTimeRange(input.since, input.until);

  // ExpressionAttributeNames for fields whose names collide with DDB
  // reserved words (`from`, `to`) or are otherwise easier to alias.
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":principal": principal,
    ":lo": lo,
    ":hi": hi,
  };

  const filters: string[] = [];
  if (input.agent_id !== undefined) {
    if (input.agent_id === null) {
      filters.push("agent_id = :null_agent_id");
      // DDB doc client serializes `null` as a NULL attribute — matches the
      // way attempt rows are written (agent_id: null in solo-direct).
      values[":null_agent_id"] = null;
    } else {
      filters.push("agent_id = :agent_id");
      values[":agent_id"] = input.agent_id;
    }
  }
  if (input.address !== undefined) {
    names["#from"] = "from";
    names["#to"] = "to";
    names["#cc"] = "cc";
    names["#bcc"] = "bcc";
    filters.push(
      "(#from = :addr OR contains(#to, :addr) OR contains(#cc, :addr) OR contains(#bcc, :addr))",
    );
    values[":addr"] = input.address;
  }

  // Decode the cursor before building the command so a malformed cursor
  // surfaces synchronously rather than as an opaque DDB error.
  const exclusiveStartKey = decodeCursor(input.cursor);

  const params: ConstructorParameters<typeof QueryCommand>[0] = {
    TableName: deps.auditTable,
    IndexName: deps.gsiName,
    KeyConditionExpression:
      "principal = :principal AND audit_id BETWEEN :lo AND :hi",
    ExpressionAttributeValues: values,
    Limit: limit,
  };
  if (Object.keys(names).length > 0) {
    params.ExpressionAttributeNames = names;
  }
  if (filters.length > 0) {
    params.FilterExpression = filters.join(" AND ");
  }
  if (exclusiveStartKey !== undefined) {
    params.ExclusiveStartKey = exclusiveStartKey;
  }

  const out = await deps.client.send(new QueryCommand(params));
  const items = out.Items ?? [];
  const events: AuditQueryEvent[] = [];
  for (const it of items) {
    const ev = normalizeAuditRow(it);
    if (ev !== null) events.push(ev);
  }

  const result: AuditQueryResult = { events };
  if (out.LastEvaluatedKey !== undefined) {
    result.next_cursor = encodeCursor(out.LastEvaluatedKey);
  }
  return result;
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("audit_query: cursor is malformed (not base64url JSON)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("audit_query: cursor must decode to a JSON object");
  }
  return parsed as Record<string, unknown>;
}
