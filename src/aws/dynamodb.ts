import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { chunkBody, type Chunk } from "../core/chunking.js";
import type { ParsedHeaders } from "../core/parser.js";
import { makeSnippet } from "../core/snippet.js";
import type {
  MessageStore,
  SkeletonRow,
  StoredMessage,
} from "../core/store.js";

// DDB-backed implementation of the MessageStore port (ADR-0013). Two tables:
//   Messages           PK=address           SK=internal_id     (+ GSI1 on message_id)
//   MessageBodyChunks  PK=internal_id       SK=chunk_seq       (zero-padded)
//
// Chunks are written first, then the metadata row last (ADR-0013): a reader
// that finds the Messages row can trust the chunks exist; an interrupted
// write leaves orphaned chunks for the reconciliation job to sweep.

export type DynamoMessageStoreDeps = {
  client: DynamoDBDocumentClient;
  messagesTable: string;
  bodyChunksTable: string;
};

export function makeDynamoMessageStore(
  deps: DynamoMessageStoreDeps,
): MessageStore {
  return {
    writeMessage: (row) => writeMessage(deps, row),
    writeSkeleton: (row) => writeSkeleton(deps, row),
  };
}

async function writeMessage(
  deps: DynamoMessageStoreDeps,
  row: StoredMessage,
): Promise<void> {
  const chunks = chunkBody(row.parsed.bodyText);

  for (const chunk of chunks) {
    await deps.client.send(
      new PutCommand({
        TableName: deps.bodyChunksTable,
        Item: chunkItem(row.internal_id, chunk, row.schema_v),
      }),
    );
  }

  await deps.client.send(
    new PutCommand({
      TableName: deps.messagesTable,
      Item: messageItem(row),
    }),
  );
}

async function writeSkeleton(
  deps: DynamoMessageStoreDeps,
  row: SkeletonRow,
): Promise<void> {
  await deps.client.send(
    new PutCommand({
      TableName: deps.messagesTable,
      Item: skeletonItem(row),
    }),
  );
}

function messageItem(row: StoredMessage): Record<string, unknown> {
  const h = row.parsed.headers;
  // Build the item without ever assigning `undefined` — DocumentClient rejects
  // those unless removeUndefinedValues is set, and skeleton rows already
  // depend on attribute *absence* for sparse-GSI semantics.
  const item: Record<string, unknown> = {
    address: row.address,
    internal_id: row.internal_id,
    parse_status: "ok",
    schema_v: row.schema_v,
    raw_s3_uri: row.raw_s3_uri,
    received_at: row.received_at,
    headers_blob: row.parsed.headersBlob,
    subject: h.subject,
    in_reply_to: h.inReplyTo,
    references_raw: h.references,
    auto_submitted: h.autoSubmitted,
    list_id: h.listId,
    custom_headers: h.customHeaders,
    // Snippet persisted at write time so read_inbox is one DDB Query.
    // Empty body collapses to empty string — no DDB attribute pollution.
    snippet: makeSnippet(row.parsed.bodyText),
  };
  // ADR-0017: only emit `direction` when explicitly set. Inbound writers
  // omit it; readers default attribute-absent to "in" for back-compat.
  if (row.direction !== undefined) item.direction = row.direction;
  // GSI1 keys per ADR-0013. Only attached when the inbound RFC header was
  // present — a missing message_id keeps the row off GSI1, which matches the
  // skeleton-row treatment (sparse GSI).
  if (h.messageId !== null) item.message_id = h.messageId;
  copyHeaderIfPresent(item, "from_raw", h.from);
  copyHeaderIfPresent(item, "to_raw", h.to);
  copyHeaderIfPresent(item, "cc_raw", h.cc);
  copyHeaderIfPresent(item, "date_raw", h.date);
  if (h.customHeadersTruncated) item.custom_headers_truncated = true;
  return item;
}

function skeletonItem(row: SkeletonRow): Record<string, unknown> {
  return {
    address: row.address,
    internal_id: row.internal_id,
    parse_status: "failed",
    parse_error: row.parse_error,
    schema_v: row.schema_v,
    raw_s3_uri: row.raw_s3_uri,
    received_at: row.received_at,
  };
}

function chunkItem(
  internalId: string,
  chunk: Chunk,
  schemaV: "1",
): Record<string, unknown> {
  return {
    internal_id: internalId,
    chunk_seq: padSeq(chunk.index),
    text: chunk.text,
    start_byte: chunk.startByte,
    end_byte: chunk.endByte,
    schema_v: schemaV,
  };
}

function padSeq(n: number): string {
  // 4 digits = 10000 chunks = ~3 GB at the 300 KB default — comfortably above
  // SES's 25 MB inbound limit. Bump if the chunk size shrinks below ~3 KB.
  return n.toString().padStart(4, "0");
}

function copyHeaderIfPresent(
  item: Record<string, unknown>,
  key: string,
  value: ParsedHeaders[keyof ParsedHeaders],
): void {
  if (value !== null && value !== undefined && value !== "") {
    item[key] = value;
  }
}
