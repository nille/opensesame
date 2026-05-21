import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { makeInternalIdLowerBound } from "../core/internal-id.js";
import { assembleBody, type StoredChunk } from "../core/reader.js";
import type {
  InboxRow,
  InboxRowFailed,
  InboxRowOk,
  ListInboxInput,
  ListInboxResult,
  MessageDirection,
  MessageReader,
  ReadMessage,
  ReadMessageFailed,
  ReadMessageOk,
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
};

export function makeDynamoMessageReader(
  deps: DynamoMessageReaderDeps,
): MessageReader {
  return {
    getByMessageId: (messageId) => getByMessageId(deps, messageId),
    getByPrimaryKey: (address, internalId) =>
      getByPrimaryKey(deps, address, internalId),
    listInbox: (input) => listInbox(deps, input),
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
  };
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
  };
  return ok;
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
