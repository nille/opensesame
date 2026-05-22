import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  makeInternalIdLowerBound,
  makeInternalIdUpperBound,
} from "../core/internal-id.js";
import { assembleBody, type StoredChunk } from "../core/reader.js";
import type {
  InboxRow,
  InboxRowFailed,
  InboxRowOk,
  ListInboxInput,
  ListInboxResult,
  ListThreadMessagesInput,
  ListThreadMessagesResult,
  MarkReadResult,
  MessageDirection,
  MessageReader,
  ReadMessage,
  ReadMessageFailed,
  ReadMessageOk,
  SearchEmailInput,
  SearchEmailResult,
  StoredAttachment,
  StoredMessageHeaders,
} from "../core/store.js";

// DDB read-side adapter for ADR-0007's get_message.
//
// Two read paths:
//   - getByMessageId(<...>)         GSI1 hop → primary-key Get → chunks Query
//   - getByPrimaryKey(addr, id)     primary-key Get → chunks Query
//
// The chunks Query never runs for skeleton rows (parse_status: "failed").

export type DynamoMessageReaderDeps = {
  client: DynamoDBDocumentClient;
  messagesTable: string;
  bodyChunksTable: string;
  messageIdGsiName: string;
  // ADR-0027: ThreadIdGSI on the Messages table, PK=thread_id SK=internal_id.
  threadIdGsiName: string;
};

export function makeDynamoMessageReader(
  deps: DynamoMessageReaderDeps,
): MessageReader {
  return {
    getByMessageId: (messageId) => getByMessageId(deps, messageId),
    getByPrimaryKey: (address, internalId) =>
      getByPrimaryKey(deps, address, internalId),
    listInbox: (input) => listInbox(deps, input),
    markRead: (messageId, now) => markRead(deps, messageId, now),
    markReadByPrimaryKey: (address, internalId, now) =>
      markReadByPrimaryKey(deps, address, internalId, now),
    searchEmail: (input) => searchEmail(deps, input),
    listThreadMessages: (input) => listThreadMessages(deps, input),
  };
}

async function getByMessageId(
  deps: DynamoMessageReaderDeps,
  messageId: string,
): Promise<ReadMessage | null> {
  // ADR-0013: GSI1 PK is the raw RFC 5322 Message-ID (with brackets).
  const gsi = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      IndexName: deps.messageIdGsiName,
      KeyConditionExpression: "message_id = :mid",
      ExpressionAttributeValues: { ":mid": messageId },
      Limit: 1,
    }),
  );
  const hit = gsi.Items?.[0];
  if (!hit) return null;

  const address = String(hit["address"]);
  const internalId = String(hit["internal_id"]);
  return assembleFromMessageRow(deps, address, internalId, hit);
}

async function getByPrimaryKey(
  deps: DynamoMessageReaderDeps,
  address: string,
  internalId: string,
): Promise<ReadMessage | null> {
  const out = await deps.client.send(
    new GetCommand({
      TableName: deps.messagesTable,
      Key: { address, internal_id: internalId },
    }),
  );
  if (!out.Item) return null;
  return assembleFromMessageRow(deps, address, internalId, out.Item);
}

async function assembleFromMessageRow(
  deps: DynamoMessageReaderDeps,
  address: string,
  internalId: string,
  row: Record<string, unknown>,
): Promise<ReadMessage> {
  const parseStatus = row["parse_status"];
  if (parseStatus === "failed") {
    return projectFailed(address, internalId, row);
  }
  if (parseStatus !== "ok") {
    throw new Error(
      `unexpected parse_status=${String(parseStatus)} on Messages row (address=${address} internal_id=${internalId})`,
    );
  }

  const chunks = await deps.client.send(
    new QueryCommand({
      TableName: deps.bodyChunksTable,
      KeyConditionExpression: "internal_id = :id",
      ExpressionAttributeValues: { ":id": internalId },
      ScanIndexForward: true,
    }),
  );
  const storedChunks: StoredChunk[] = (chunks.Items ?? []).map((c) => ({
    internal_id: String(c["internal_id"]),
    chunk_seq: String(c["chunk_seq"]),
    text: String(c["text"]),
    start_byte: Number(c["start_byte"]),
    end_byte: Number(c["end_byte"]),
  }));

  return projectOk(address, internalId, row, assembleBody(storedChunks));
}

function projectOk(
  address: string,
  internalId: string,
  row: Record<string, unknown>,
  bodyText: string,
): ReadMessageOk {
  const headers: StoredMessageHeaders = {
    from: nullableString(row["from_raw"]),
    to: nullableString(row["to_raw"]),
    cc: nullableString(row["cc_raw"]),
    reply_to: nullableString(row["reply_to_raw"]),
    subject: nullableString(row["subject"]),
    date: nullableString(row["date_raw"]),
    message_id: nullableString(row["message_id"]),
    in_reply_to: nullableString(row["in_reply_to"]),
    references: nullableString(row["references_raw"]),
    auto_submitted:
      typeof row["auto_submitted"] === "string"
        ? (row["auto_submitted"] as string)
        : "no",
    list_id: nullableString(row["list_id"]),
  };
  return {
    parse_status: "ok",
    schema_v: "1",
    address,
    internal_id: internalId,
    received_at: String(row["received_at"]),
    raw_s3_uri: String(row["raw_s3_uri"]),
    headers,
    headers_blob:
      typeof row["headers_blob"] === "string"
        ? (row["headers_blob"] as string)
        : "",
    body_text: bodyText,
    direction: readDirection(row),
    attachments: readAttachments(row),
    read_at: nullableString(row["read_at"]),
    thread_id: nullableString(row["thread_id"]),
  };
}

// Project the DDB attachments list back to the wire shape. Attribute-absent
// (rows written before slice 8.1) collapses to an empty array — readers
// never see `undefined` here.
function readAttachments(row: Record<string, unknown>): StoredAttachment[] {
  const raw = row["attachments"];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      filename: typeof e["filename"] === "string" ? e["filename"] : null,
      content_type:
        typeof e["content_type"] === "string"
          ? e["content_type"]
          : "application/octet-stream",
      size_bytes: typeof e["size_bytes"] === "number" ? e["size_bytes"] : 0,
      content_id: typeof e["content_id"] === "string" ? e["content_id"] : null,
      part_index: typeof e["part_index"] === "number" ? e["part_index"] : 0,
      sha256: typeof e["sha256"] === "string" ? e["sha256"] : "",
    };
  });
}

// ADR-0017: rows written before slice 3 have no `direction` attribute;
// project them as "in". Anything other than "in" or "out" also collapses to
// "in" — DDB attribute corruption is silently safe for inbox reads.
function readDirection(row: Record<string, unknown>): MessageDirection {
  return row["direction"] === "out" ? "out" : "in";
}

function projectFailed(
  address: string,
  internalId: string,
  row: Record<string, unknown>,
): ReadMessageFailed {
  return {
    parse_status: "failed",
    schema_v: "1",
    address,
    internal_id: internalId,
    received_at: String(row["received_at"]),
    raw_s3_uri: String(row["raw_s3_uri"]),
    parse_error:
      typeof row["parse_error"] === "string"
        ? (row["parse_error"] as string)
        : "",
  };
}

function nullableString(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

async function listInbox(
  deps: DynamoMessageReaderDeps,
  input: ListInboxInput,
): Promise<ListInboxResult> {
  const exprValues: Record<string, unknown> = { ":addr": input.address };
  let keyCond = "address = :addr";
  if (input.since) {
    exprValues[":since"] = makeInternalIdLowerBound(input.since);
    keyCond = "address = :addr AND internal_id > :since";
  }

  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      KeyConditionExpression: keyCond,
      ExpressionAttributeValues: exprValues,
      ScanIndexForward: false,
      Limit: input.limit,
      ExclusiveStartKey: input.cursor ? decodeCursor(input.cursor) : undefined,
    }),
  );

  const messages = (out.Items ?? []).map(projectInboxRow);
  const next_cursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey)
    : null;

  return { messages, next_cursor };
}

function projectInboxRow(row: Record<string, unknown>): InboxRow {
  if (row["parse_status"] === "failed") {
    const failed: InboxRowFailed = {
      parse_status: "failed",
      schema_v: "1",
      address: String(row["address"]),
      internal_id: String(row["internal_id"]),
      received_at: String(row["received_at"]),
      raw_s3_uri: String(row["raw_s3_uri"]),
      parse_error:
        typeof row["parse_error"] === "string"
          ? (row["parse_error"] as string)
          : "",
    };
    return failed;
  }
  const ok: InboxRowOk = {
    parse_status: "ok",
    schema_v: "1",
    address: String(row["address"]),
    internal_id: String(row["internal_id"]),
    received_at: String(row["received_at"]),
    message_id: nullableString(row["message_id"]),
    from: nullableString(row["from_raw"]),
    to: nullableString(row["to_raw"]),
    cc: nullableString(row["cc_raw"]),
    reply_to: nullableString(row["reply_to_raw"]),
    subject: nullableString(row["subject"]),
    date: nullableString(row["date_raw"]),
    in_reply_to: nullableString(row["in_reply_to"]),
    references: nullableString(row["references_raw"]),
    auto_submitted:
      typeof row["auto_submitted"] === "string"
        ? (row["auto_submitted"] as string)
        : "no",
    list_id: nullableString(row["list_id"]),
    snippet: typeof row["snippet"] === "string" ? (row["snippet"] as string) : "",
    direction: readDirection(row),
    read_at: nullableString(row["read_at"]),
    thread_id: nullableString(row["thread_id"]),
  };
  return ok;
}

async function markRead(
  deps: DynamoMessageReaderDeps,
  messageId: string,
  now: Date,
): Promise<MarkReadResult> {
  // GSI1 hop to resolve the primary key. Project only what we need so the
  // lookup costs one RCU. attribute_not_exists guards the write so the
  // first-open timestamp wins; subsequent opens are a no-op without a write.
  const gsi = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      IndexName: deps.messageIdGsiName,
      KeyConditionExpression: "message_id = :mid",
      ExpressionAttributeValues: { ":mid": messageId },
      ProjectionExpression: "address, internal_id, read_at",
      Limit: 1,
    }),
  );
  const hit = gsi.Items?.[0];
  if (!hit) return { kind: "not_found" };

  return stampReadAt(
    deps,
    String(hit["address"]),
    String(hit["internal_id"]),
    now,
    nullableString(hit["read_at"]),
  );
}

async function markReadByPrimaryKey(
  deps: DynamoMessageReaderDeps,
  address: string,
  internalId: string,
  now: Date,
): Promise<MarkReadResult> {
  // No GSI hop needed — the caller already has the primary key. Skip the
  // pre-check Get; let the conditional UpdateItem be the existence probe,
  // and only Get on the already-read fallback path.
  return stampReadAt(deps, address, internalId, now, null);
}

// Shared write path. Returns "not_found" when the row doesn't exist on the
// already-read fallback Get. The address-existence guard in the condition
// prevents UpdateItem from creating a phantom row when the caller's primary
// key is stale.
async function stampReadAt(
  deps: DynamoMessageReaderDeps,
  address: string,
  internalId: string,
  now: Date,
  projectedReadAt: string | null,
): Promise<MarkReadResult> {
  const isoNow = now.toISOString();
  try {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.messagesTable,
        Key: { address, internal_id: internalId },
        UpdateExpression: "SET read_at = :now",
        // address-existence guard: UpdateItem on a missing key would otherwise
        // create a phantom row with just `read_at`. Pair with the
        // attribute_not_exists(read_at) idempotence guard.
        ConditionExpression:
          "attribute_exists(#addr) AND attribute_not_exists(read_at)",
        ExpressionAttributeNames: { "#addr": "address" },
        ExpressionAttributeValues: { ":now": isoNow },
      }),
    );
    return { kind: "marked", read_at: isoNow };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // One of: row missing, or read_at already set. Resolve which.
      if (projectedReadAt !== null) {
        return { kind: "already_read", read_at: projectedReadAt };
      }
      const out = await deps.client.send(
        new GetCommand({
          TableName: deps.messagesTable,
          Key: { address, internal_id: internalId },
          ProjectionExpression: "read_at",
        }),
      );
      if (!out.Item) return { kind: "not_found" };
      const stamped = nullableString(out.Item["read_at"]);
      if (stamped !== null) {
        return { kind: "already_read", read_at: stamped };
      }
      // Condition failed but row exists with no read_at — treat as a benign
      // race and report the requested timestamp rather than a 5xx.
      return { kind: "marked", read_at: isoNow };
    }
    throw err;
  }
}

// search_email per ADR-0007 / ADR-0004.
//
// Strategy:
//   1. Query the address partition newest-first, with KeyCondition narrowed
//      by since/until (pushed down via internal_id bounds — same trick as
//      listInbox(since)).
//   2. Apply structured filters (from/to/subject) in DDB FilterExpression so
//      they reduce network bytes; the substring `query` against the metadata
//      attributes goes there too. DDB `contains()` is case-sensitive, so we
//      lowercase both the query and the row attributes — but DDB has no
//      tolower() in expressions, which means metadata-side case folding has
//      to happen at write time. We don't have lowercased mirrors yet, so the
//      header substring path stays case-sensitive in v1; the body fan-out
//      below does its own case-folding in app code.
//   3. For rows that didn't already match on metadata, fan out a per-message
//      chunks Query with FilterExpression `contains(text, :q)`. A single
//      match on any chunk promotes the row.
//   4. Skeleton rows (parse_status=failed) cannot body-match (no chunks); they
//      pass only when the structured filters + headers match.
//   5. Cursor opacity matches listInbox — base64(LastEvaluatedKey).
//
// Latency budget per ADR-0004 is 3-10s. Body fan-out is the long pole; we
// run it sequentially to keep DDB throughput predictable. A per-page cap on
// fan-out (FAN_OUT_CAP) protects against pathological cases where every row
// in a page misses on metadata.
const FAN_OUT_CAP = 100;
async function searchEmail(
  deps: DynamoMessageReaderDeps,
  input: SearchEmailInput,
): Promise<SearchEmailResult> {
  const exprValues: Record<string, unknown> = { ":addr": input.address };
  let keyCond = "address = :addr";
  if (input.since && input.until) {
    exprValues[":since"] = makeInternalIdLowerBound(input.since);
    exprValues[":until"] = makeInternalIdUpperBound(input.until);
    keyCond = "address = :addr AND internal_id BETWEEN :since AND :until";
  } else if (input.since) {
    exprValues[":since"] = makeInternalIdLowerBound(input.since);
    keyCond = "address = :addr AND internal_id > :since";
  } else if (input.until) {
    exprValues[":until"] = makeInternalIdUpperBound(input.until);
    keyCond = "address = :addr AND internal_id < :until";
  }

  // Structured filters AND-compose; the free-text `query` ORs across the
  // header attributes (any one match wins on metadata). Both go in
  // FilterExpression.
  const filters: string[] = [];
  const exprNames: Record<string, string> = {};
  if (input.from) {
    exprValues[":from"] = input.from;
    exprNames["#from"] = "from_raw";
    filters.push("contains(#from, :from)");
  }
  if (input.to) {
    exprValues[":to"] = input.to;
    exprNames["#to"] = "to_raw";
    filters.push("contains(#to, :to)");
  }
  if (input.subject) {
    exprValues[":subj"] = input.subject;
    exprNames["#subj"] = "subject";
    filters.push("contains(#subj, :subj)");
  }
  // Don't push the free-text query into FilterExpression. DDB `contains`
  // is case-sensitive and we want case-insensitive UX; metadata matching
  // is repeated in app code below alongside the body fan-out, with a
  // single case-folded path.

  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      KeyConditionExpression: keyCond,
      ExpressionAttributeValues: exprValues,
      ExpressionAttributeNames:
        Object.keys(exprNames).length > 0 ? exprNames : undefined,
      FilterExpression: filters.length > 0 ? filters.join(" AND ") : undefined,
      ScanIndexForward: false,
      Limit: input.limit,
      ExclusiveStartKey: input.cursor ? decodeCursor(input.cursor) : undefined,
    }),
  );

  const candidates = out.Items ?? [];
  const next_cursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey)
    : null;
  if (input.query === "") {
    return { messages: candidates.map(projectInboxRow), next_cursor };
  }

  const q = input.query.toLowerCase();
  const matched: InboxRow[] = [];
  let bodyFanOut = 0;
  for (const row of candidates) {
    if (rowMatchesOnMetadata(row, q)) {
      matched.push(projectInboxRow(row));
      continue;
    }
    if (row["parse_status"] === "failed") continue;
    if (bodyFanOut >= FAN_OUT_CAP) continue;
    bodyFanOut += 1;
    const internalId = String(row["internal_id"]);
    const hit = await chunkMatches(deps, internalId, q);
    if (hit) {
      matched.push(projectInboxRow(row));
    }
  }
  return { messages: matched, next_cursor };
}

// Case-insensitive substring check across the metadata attributes the UI
// renders. `headers_blob` is included so header search per ADR-0004 still
// works for headers we don't promote into a typed attribute (Received chains,
// X-* customs, ARC signatures). All inputs lowercase-folded.
function rowMatchesOnMetadata(
  row: Record<string, unknown>,
  qLower: string,
): boolean {
  const attrs = ["from_raw", "to_raw", "cc_raw", "subject", "snippet", "headers_blob"];
  for (const attr of attrs) {
    const v = row[attr];
    if (typeof v === "string" && v.toLowerCase().includes(qLower)) {
      return true;
    }
  }
  return false;
}

// Per-message body fan-out. Returns true on the first chunk that matches.
// FilterExpression `contains` is case-sensitive, so we don't push the query
// down — we Query the chunks and fold case in app code instead. Acceptable
// per ADR-0004's latency budget at v1 mailbox sizes; the future SQLite-FTS
// upgrade path replaces this entirely.
async function chunkMatches(
  deps: DynamoMessageReaderDeps,
  internalId: string,
  qLower: string,
): Promise<boolean> {
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.bodyChunksTable,
      KeyConditionExpression: "internal_id = :id",
      ExpressionAttributeValues: { ":id": internalId },
      ProjectionExpression: "#text",
      ExpressionAttributeNames: { "#text": "text" },
    }),
  );
  for (const item of out.Items ?? []) {
    const t = item["text"];
    if (typeof t === "string" && t.toLowerCase().includes(qLower)) {
      return true;
    }
  }
  return false;
}

// ADR-0027 (slice 8.9). Single Query against ThreadIdGSI; ascending by
// internal_id so callers read in conversational order. The cursor is the
// same opaque base64-encoded LastEvaluatedKey shape as listInbox/searchEmail.
async function listThreadMessages(
  deps: DynamoMessageReaderDeps,
  input: ListThreadMessagesInput,
): Promise<ListThreadMessagesResult> {
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      IndexName: deps.threadIdGsiName,
      KeyConditionExpression: "thread_id = :tid",
      ExpressionAttributeValues: { ":tid": input.thread_id },
      ScanIndexForward: true,
      Limit: input.limit,
      ExclusiveStartKey: input.cursor ? decodeCursor(input.cursor) : undefined,
    }),
  );

  const messages = (out.Items ?? []).map(projectInboxRow);
  const next_cursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey)
    : null;

  return { messages, next_cursor };
}

function encodeCursor(lek: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lek), "utf-8").toString("base64");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor must decode to a plain object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid cursor: ${(err as Error).message}`);
  }
}
