import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  makeInternalIdLowerBound,
  makeInternalIdUpperBound,
} from "../core/internal-id.js";
import { assembleBody, type StoredChunk } from "../core/reader.js";
import {
  emptyAst,
  parseSearchQuery,
  type SearchAst,
} from "../core/search-operators.js";
import type {
  AddThreadLabelInput,
  ArchiveThreadInput,
  ArchiveThreadResult,
  CreateLabelInput,
  DeleteDraftInput,
  DeleteDraftResult,
  DeleteLabelInput,
  DeleteLabelResult,
  GetDraftInput,
  InboxRow,
  InboxRowFailed,
  InboxRowOk,
  LabelCatalogEntry,
  ListDraftsInput,
  ListDraftsResult,
  ListInboxInput,
  ListInboxResult,
  ListLabelsInput,
  ListLabelsResult,
  ListThreadMessagesInput,
  ListThreadMessagesResult,
  MarkReadResult,
  MarkThreadReadInput,
  MarkThreadReadResult,
  MessageDirection,
  MessageReader,
  ReadMessage,
  ReadMessageFailed,
  ReadMessageOk,
  RemoveThreadLabelInput,
  RenameLabelInput,
  RenameLabelResult,
  SaveDraftInput,
  SaveDraftResult,
  SearchEmailInput,
  SearchEmailResult,
  SnoozeThreadInput,
  SnoozeThreadResult,
  StarThreadInput,
  StarThreadResult,
  StoredAttachment,
  StoredDraft,
  StoredMessageHeaders,
  ThreadLabelResult,
  TrashThreadInput,
  TrashThreadResult,
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
  // ADR-0035 (slice 8.17): ULID factory for save_draft's first-write path.
  // Optional so existing callers (and tests) that don't exercise drafts
  // don't need to wire it; saveDraft throws when called without one.
  makeUlid?: () => string;
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
    starThread: (input, now) => starThread(deps, input, now),
    snoozeThread: (input, now) => snoozeThread(deps, input, now),
    trashThread: (input, now) => trashThread(deps, input, now),
    markThreadRead: (input, now) => markThreadRead(deps, input, now),
    archiveThread: (input, now) => archiveThread(deps, input, now),
    saveDraft: (input, now) => saveDraft(deps, input, now),
    listDrafts: (input) => listDrafts(deps, input),
    getDraft: (input) => getDraft(deps, input),
    deleteDraft: (input) => deleteDraft(deps, input),
    addThreadLabel: (input, now) => addThreadLabel(deps, input, now),
    removeThreadLabel: (input, now) => removeThreadLabel(deps, input, now),
    listLabels: (input) => listLabels(deps, input),
    createLabel: (input, now) => createLabel(deps, input, now),
    deleteLabel: (input) => deleteLabel(deps, input),
    renameLabel: (input, now) => renameLabel(deps, input, now),
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
    // ADR-0042 (slice 8.21): the dispatcher fills body_html via a re-parse
    // of raw_s3_uri; the reader returns null here so direct callers (CLI,
    // tests) see the same shape as the dispatcher's pre-rehydrate state.
    body_html: null,
    direction: readDirection(row),
    attachments: readAttachments(row),
    read_at: nullableString(row["read_at"]),
    thread_id: nullableString(row["thread_id"]),
    starred_at: nullableString(row["starred_at"]),
    snoozed_until: nullableString(row["snoozed_until"]),
    trashed_at: nullableString(row["trashed_at"]),
    archived_at: nullableString(row["archived_at"]),
    labels: stringSetToArray(row["labels"]),
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

// ADR-0037 (slice 8.17). Project the DDB String Set `labels` attribute back
// to a sorted array on the wire. Always returns an array — attribute-absent
// rows collapse to `[]`. Sort is lexicographic case-insensitive so the same
// set of labels renders identically across browsers and refetches.
//
// lib-dynamodb returns a String Set as an Array (or a Set in some marshall
// configurations); accept either. Anything else collapses to `[]` so a
// single corrupt row doesn't break list_inbox / get_message.
function stringSetToArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .filter((s): s is string => typeof s === "string")
      .slice()
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }
  if (v instanceof Set) {
    const arr: string[] = [];
    for (const s of v) {
      if (typeof s === "string") arr.push(s);
    }
    return arr.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }
  return [];
}

// ULID timestamps span 48 bits, so the leading Crockford char is always
// 0–7. `7ZZZ...` is therefore the lex-largest possible message internal_id
// and `0000...` the lex-smallest, while DRAFT# (`D…`) and LABEL# (`L…`)
// sort strictly above `7Z…`. Used as KeyCondition bounds to scope queries
// to the message-row band without needing a FilterExpression on the
// primary key (which DDB rejects).
const MESSAGE_SK_LOWER_BOUND = "0".repeat(26);
const MESSAGE_SK_UPPER_BOUND = "7" + "Z".repeat(25);

async function listInbox(
  deps: DynamoMessageReaderDeps,
  input: ListInboxInput,
): Promise<ListInboxResult> {
  // DDB rejects FilterExpressions on primary key attributes ("Filter
  // Expression can only contain non-primary key attributes"). Push the
  // DRAFT#/LABEL# exclusion into the KeyCondition instead: real message
  // SKs are ULIDs whose first Crockford char is 0–7 (48-bit time fits in
  // 4 bits of the leading char), while DRAFT# starts with 'D' and LABEL#
  // with 'L'. A BETWEEN over [MESSAGE_SK_LOWER, MESSAGE_SK_UPPER] therefore
  // covers every plausible message id and excludes both catalog ranges.
  const exprValues: Record<string, unknown> = { ":addr": input.address };
  const lowerBound = input.since
    ? makeInternalIdLowerBound(input.since)
    : MESSAGE_SK_LOWER_BOUND;
  exprValues[":sk_lo"] = lowerBound;
  exprValues[":sk_hi"] = MESSAGE_SK_UPPER_BOUND;
  const keyCond = "address = :addr AND internal_id BETWEEN :sk_lo AND :sk_hi";

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
    starred_at: nullableString(row["starred_at"]),
    snoozed_until: nullableString(row["snoozed_until"]),
    trashed_at: nullableString(row["trashed_at"]),
    archived_at: nullableString(row["archived_at"]),
    labels: stringSetToArray(row["labels"]),
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
  // Same DDB constraint as listInbox: primary key attributes (`internal_id`)
  // cannot appear in a FilterExpression. The DRAFT#/LABEL# exclusion folds
  // into the BETWEEN bounds so the catalog rows never enter the candidate
  // window. since/until tighten the lower/upper end when the operator
  // narrows by date.
  const exprValues: Record<string, unknown> = { ":addr": input.address };
  exprValues[":since"] = input.since
    ? makeInternalIdLowerBound(input.since)
    : MESSAGE_SK_LOWER_BOUND;
  exprValues[":until"] = input.until
    ? makeInternalIdUpperBound(input.until)
    : MESSAGE_SK_UPPER_BOUND;
  const keyCond =
    "address = :addr AND internal_id BETWEEN :since AND :until";

  // ADR-0036 (slice 8.17). Operator AST drives the structured filter
  // assembly. Legacy top-level from/to/subject fold into the AST; if the
  // dispatcher already pre-parsed, it passes input.ast through and the
  // reader skips re-parsing. Direct callers (CLI tests, future MCP) may
  // pass query without an AST — we parse here so every caller gets the
  // same behavior.
  const ast = resolveAst(input);
  const compiled = compileAstToFilter(ast);
  const filters = compiled.filterClauses;
  const exprNames = compiled.names;
  for (const [k, v] of Object.entries(compiled.values)) {
    exprValues[k] = v;
  }
  // ADR-0035 + ADR-0037: drafts (DRAFT#) and label catalog rows (LABEL#)
  // share the partition; both ranges sort outside the message ULID band
  // (0–7), so the BETWEEN bounds set on keyCond above already exclude
  // them. No FilterExpression clause needed (DDB rejects filters on the
  // primary key anyway).
  // Don't push the free-text fragments into FilterExpression. DDB
  // `contains` is case-sensitive and we want case-insensitive UX; metadata
  // matching is repeated in app code below alongside the body fan-out,
  // with a single case-folded path.

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
  // No free-text fragments → metadata filters already ran in DDB; project
  // the candidates straight through. Operator-only queries
  // (`from:alice is:unread`) take this path.
  if (ast.free.length === 0) {
    return { messages: candidates.map(projectInboxRow), next_cursor };
  }

  const fragments = ast.free.map((f) => f.toLowerCase());
  const matched: InboxRow[] = [];
  let bodyFanOut = 0;
  for (const row of candidates) {
    if (rowMatchesOnMetadataAll(row, fragments)) {
      matched.push(projectInboxRow(row));
      continue;
    }
    if (row["parse_status"] === "failed") continue;
    if (bodyFanOut >= FAN_OUT_CAP) continue;
    bodyFanOut += 1;
    const internalId = String(row["internal_id"]);
    const hit = await chunkMatchesAll(deps, internalId, fragments);
    if (hit) {
      matched.push(projectInboxRow(row));
    }
  }
  return { messages: matched, next_cursor };
}

function resolveAst(input: SearchEmailInput): SearchAst {
  let ast: SearchAst;
  if (input.ast) {
    ast = input.ast;
  } else {
    const parsed = parseSearchQuery(input.query ?? "");
    // Direct callers that pass invalid grammar see the result as if no
    // operators were typed — we never throw here. The dispatcher path
    // surfaces a 400 before reaching the reader.
    ast = parsed.ok ? parsed.value : emptyAst();
  }
  // Fold legacy top-level fields. Mutates the AST in place; safe because
  // we own a fresh copy when called via the parse fallback, and the
  // dispatcher passes a fresh AST per request.
  if (input.from) ast.from.include.push(input.from);
  if (input.to) ast.to.include.push(input.to);
  if (input.subject) ast.subject.include.push(input.subject);
  return ast;
}

type CompiledFilter = {
  filterClauses: string[];
  names: Record<string, string>;
  values: Record<string, unknown>;
};

// Compiles a SearchAst into FilterExpression fragments. Substring keys
// (from/to/subject) emit `contains(#x, :v)` clauses with OR within a key
// and AND-NOT for excludes. Flags map to attribute_exists /
// attribute_not_exists. The view scope (in:trash / in:archive) emits
// attribute_exists on the matching annotation column.
function compileAstToFilter(ast: SearchAst): CompiledFilter {
  const filterClauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let valueCounter = 0;
  const nextValueRef = () => `:v${valueCounter++}`;

  // from / subject: single-attribute substring.
  for (const k of ["from", "subject"] as const) {
    const slot = ast[k];
    if (slot.include.length === 0 && slot.exclude.length === 0) continue;
    const nameRef = `#${k}`;
    names[nameRef] = k === "from" ? "from_raw" : "subject";
    if (slot.include.length > 0) {
      const ors = slot.include.map((v) => {
        const ref = nextValueRef();
        values[ref] = v;
        return `contains(${nameRef}, ${ref})`;
      });
      filterClauses.push(ors.length === 1 ? ors[0]! : `(${ors.join(" OR ")})`);
    }
    for (const v of slot.exclude) {
      const ref = nextValueRef();
      values[ref] = v;
      filterClauses.push(`NOT contains(${nameRef}, ${ref})`);
    }
  }

  // to: ORs across to_raw and cc_raw so an operator typing `to:alice`
  // finds threads where they were CC'd. BCC is not searchable inbound.
  if (ast.to.include.length > 0 || ast.to.exclude.length > 0) {
    names["#to"] = "to_raw";
    names["#cc"] = "cc_raw";
    if (ast.to.include.length > 0) {
      const ors: string[] = [];
      for (const v of ast.to.include) {
        const ref = nextValueRef();
        values[ref] = v;
        ors.push(`contains(#to, ${ref}) OR contains(#cc, ${ref})`);
      }
      filterClauses.push(`(${ors.join(" OR ")})`);
    }
    for (const v of ast.to.exclude) {
      const ref = nextValueRef();
      values[ref] = v;
      filterClauses.push(
        `NOT contains(#to, ${ref}) AND NOT contains(#cc, ${ref})`,
      );
    }
  }

  // Flags. Each maps to attribute_exists or attribute_not_exists on a
  // sparse annotation column shipped by ADR-0028…0034.
  const flagAttrs = {
    unread: "read_at",
    starred: "starred_at",
    snoozed: "snoozed_until",
    has_attachment: "attachments",
  } as const;
  // is:unread is the inverse of read_at being present — it flips the
  // sense for `unread` only.
  for (const [flag, attr] of Object.entries(flagAttrs) as [
    keyof typeof flagAttrs,
    string,
  ][]) {
    const want = ast.flags[flag];
    if (want === undefined) continue;
    const nameRef = `#fa_${flag}`;
    names[nameRef] = attr;
    const exists = `attribute_exists(${nameRef})`;
    const notExists = `attribute_not_exists(${nameRef})`;
    // unread: want=true → read_at must NOT exist.
    // others: want=true → attribute must exist.
    if (flag === "unread") {
      filterClauses.push(want ? notExists : exists);
    } else {
      filterClauses.push(want ? exists : notExists);
    }
  }

  // View scope. Default behaviour (no in: operator) excludes both trash
  // and archive — readers always treated those as hidden views. With
  // in:trash or in:archive set, scope INTO that view via attribute_exists.
  if (ast.view === "trash") {
    names["#trashed"] = "trashed_at";
    filterClauses.push("attribute_exists(#trashed)");
  } else if (ast.view === "archive") {
    names["#archived"] = "archived_at";
    filterClauses.push("attribute_exists(#archived)");
  }

  return { filterClauses, names, values };
}

// Case-insensitive substring check across the metadata attributes the UI
// renders. `headers_blob` is included so header search per ADR-0004 still
// works for headers we don't promote into a typed attribute (Received chains,
// X-* customs, ARC signatures). All inputs lowercase-folded.
//
// `allOf` semantics per ADR-0036: every fragment must appear somewhere in
// the row's metadata. A single fragment finding any matching attr keeps the
// existing single-fragment behavior — searching `invoice` still hits if
// `invoice` appears in subject XOR body.
function rowMatchesOnMetadataAll(
  row: Record<string, unknown>,
  fragments: string[],
): boolean {
  if (fragments.length === 0) return true;
  const attrs = ["from_raw", "to_raw", "cc_raw", "subject", "snippet", "headers_blob"];
  outer: for (const frag of fragments) {
    for (const attr of attrs) {
      const v = row[attr];
      if (typeof v === "string" && v.toLowerCase().includes(frag)) {
        continue outer;
      }
    }
    return false;
  }
  return true;
}

// Per-message body fan-out. Returns true when every fragment appears in
// the row's body OR in the metadata (caller already checked metadata).
// FilterExpression `contains` is case-sensitive, so we don't push the
// query down — we Query the chunks and fold case in app code instead.
// Acceptable per ADR-0004's latency budget at v1 mailbox sizes; the
// future SQLite-FTS upgrade path replaces this entirely.
//
// allOf semantics per ADR-0036: each fragment must be present in either
// the metadata (already-checked by the caller) or the body. We accumulate
// per-fragment "found in metadata" hits from the row and only fail the row
// if a chunk match for the remaining fragments doesn't land.
async function chunkMatchesAll(
  deps: DynamoMessageReaderDeps,
  internalId: string,
  fragments: string[],
): Promise<boolean> {
  if (fragments.length === 0) return true;
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.bodyChunksTable,
      KeyConditionExpression: "internal_id = :id",
      ExpressionAttributeValues: { ":id": internalId },
      ProjectionExpression: "#text",
      ExpressionAttributeNames: { "#text": "text" },
    }),
  );
  const remaining = new Set(fragments);
  for (const item of out.Items ?? []) {
    const t = item["text"];
    if (typeof t !== "string") continue;
    const text = t.toLowerCase();
    for (const frag of [...remaining]) {
      if (text.includes(frag)) remaining.delete(frag);
    }
    if (remaining.size === 0) return true;
  }
  return remaining.size === 0;
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

// Per-thread sparse-attribute fan-out, shared by starThread (ADR-0028),
// snoozeThread (ADR-0029), and trashThread (ADR-0030). Resolves every
// primary key in the thread via ThreadIdGSI, then fans out one conditional
// UpdateItem per row: SET when `value` is a string, REMOVE when null.
//
// The attribute_exists(address) guard prevents UpdateItem from creating a
// phantom row when the GSI projection is stale; ConditionalCheckFailed is
// tolerated silently per-row (the row may have been deleted between Query
// and Update — the operator's "toggle this thread" intent still holds for
// the rest). Cap the fan-out at MAX_THREAD_LIMIT to bound write cost on
// pathological mailing-list threads; the dispatcher echoes that ceiling.
const MAX_THREAD_LIMIT = 200;

// Optional row predicate — when present, only rows for which it returns
// `true` are fanned out. The Query projection extension lets the caller
// pull additional attributes (e.g. `direction`) needed to evaluate it.
//
// ADR-0037 (slice 8.17). `setOp` extends the helper from boolean SET/REMOVE
// to multi-valued set add/delete. Existing callers (star, snooze, trash,
// archive, mark_thread_read) pass `setOp: undefined` and stay on the
// SET/REMOVE path. When `setOp: "add"`, the UpdateExpression is
// `ADD #attr :val` with `:val = new Set([value])`; when `setOp: "delete"`,
// it's `DELETE #attr :val` with the same. DDB drops the attribute when the
// last set value is removed via DELETE.
type FanOutOptions = {
  projectionExtras?: readonly string[];
  rowFilter?: (row: Record<string, unknown>) => boolean;
  setOp?: "add" | "delete";
};

async function fanOutThreadAttribute(
  deps: DynamoMessageReaderDeps,
  threadId: string,
  attributeName: string,
  value: string | null,
  opts: FanOutOptions = {},
): Promise<number> {
  const projection = ["address", "internal_id", ...(opts.projectionExtras ?? [])]
    .join(", ");
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      IndexName: deps.threadIdGsiName,
      KeyConditionExpression: "thread_id = :tid",
      ExpressionAttributeValues: { ":tid": threadId },
      ProjectionExpression: projection,
      Limit: MAX_THREAD_LIMIT,
    }),
  );
  const allRows = out.Items ?? [];
  const rows = opts.rowFilter ? allRows.filter(opts.rowFilter) : allRows;
  if (rows.length === 0) return 0;

  const results = await Promise.all(
    rows.map(async (r) => {
      const address = String(r["address"]);
      const internalId = String(r["internal_id"]);
      const cmd = buildFanOutUpdate(
        deps.messagesTable,
        address,
        internalId,
        attributeName,
        value,
        opts.setOp,
      );
      try {
        await deps.client.send(cmd);
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    }),
  );
  return results.filter(Boolean).length;
}

// Build the per-row UpdateCommand for fanOutThreadAttribute. Split out to
// keep the four code paths (SET / REMOVE / ADD-set / DELETE-set) readable.
// `value` semantics:
//   - setOp: undefined, value: string  → SET #attr = :val
//   - setOp: undefined, value: null    → REMOVE #attr
//   - setOp: "add",     value: string  → ADD #attr :val (SS{value})
//   - setOp: "delete",  value: string  → DELETE #attr :val (SS{value})
//
// `value: null` with setOp set is rejected by callers (the wrapper RPCs
// always pass a label string in those cases), so it's not a code path here.
function buildFanOutUpdate(
  tableName: string,
  address: string,
  internalId: string,
  attributeName: string,
  value: string | null,
  setOp: "add" | "delete" | undefined,
): UpdateCommand {
  const Key = { address, internal_id: internalId };
  const ConditionExpression = "attribute_exists(#addr)";
  const baseNames = { "#addr": "address", "#attr": attributeName };

  if (setOp === "add" || setOp === "delete") {
    if (value === null) {
      throw new Error(
        `fanOutThreadAttribute: setOp=${setOp} requires a non-null value`,
      );
    }
    const verb = setOp === "add" ? "ADD" : "DELETE";
    return new UpdateCommand({
      TableName: tableName,
      Key,
      UpdateExpression: `${verb} #attr :val`,
      ConditionExpression,
      ExpressionAttributeNames: baseNames,
      // lib-dynamodb marshalls a JS Set<string> to a DDB String Set.
      ExpressionAttributeValues: { ":val": new Set([value]) },
    });
  }

  if (value !== null) {
    return new UpdateCommand({
      TableName: tableName,
      Key,
      UpdateExpression: `SET #attr = :val`,
      ConditionExpression,
      ExpressionAttributeNames: baseNames,
      ExpressionAttributeValues: { ":val": value },
    });
  }
  return new UpdateCommand({
    TableName: tableName,
    Key,
    UpdateExpression: `REMOVE #attr`,
    ConditionExpression,
    ExpressionAttributeNames: baseNames,
  });
}

// ADR-0028 (slice 8.10). Per-thread star toggle. Re-star overwrites the
// timestamp (UI toggle, not first-event semantics).
async function starThread(
  deps: DynamoMessageReaderDeps,
  input: StarThreadInput,
  now: Date,
): Promise<StarThreadResult> {
  const isoNow = now.toISOString();
  const value = input.starred ? isoNow : null;
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "starred_at",
    value,
  );
  return {
    thread_id: input.thread_id,
    starred: input.starred,
    starred_at: input.starred ? isoNow : null,
    updated_count,
  };
}

// ADR-0029 (slice 8.11). Past-time validation lives in the BFF schema —
// by the time the reader is called, `snoozed_until` is null (unsnooze) or
// a future ISO string.
async function snoozeThread(
  deps: DynamoMessageReaderDeps,
  input: SnoozeThreadInput,
  _now: Date,
): Promise<SnoozeThreadResult> {
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "snoozed_until",
    input.snoozed_until,
  );
  return {
    thread_id: input.thread_id,
    snoozed_until: input.snoozed_until,
    updated_count,
  };
}

// ADR-0030 (slice 8.12). Boolean wire shape (matches star, not snooze);
// when trashing, stamp `trashed_at = now`, when untrashing, REMOVE.
async function trashThread(
  deps: DynamoMessageReaderDeps,
  input: TrashThreadInput,
  now: Date,
): Promise<TrashThreadResult> {
  const isoNow = now.toISOString();
  const value = input.trashed ? isoNow : null;
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "trashed_at",
    value,
  );
  return {
    thread_id: input.thread_id,
    trashed: input.trashed,
    trashed_at: input.trashed ? isoNow : null,
    updated_count,
  };
}

// ADR-0034 (slice 8.16). Per-thread archive toggle. Boolean wire shape
// matches trash; when archiving, stamp `archived_at = now`, when
// unarchiving, REMOVE. Independent attribute from `trashed_at` — archive
// and trash are distinct operator intents (see ADR-0034 "Considered and
// rejected" for why).
async function archiveThread(
  deps: DynamoMessageReaderDeps,
  input: ArchiveThreadInput,
  now: Date,
): Promise<ArchiveThreadResult> {
  const isoNow = now.toISOString();
  const value = input.archived ? isoNow : null;
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "archived_at",
    value,
  );
  return {
    thread_id: input.thread_id,
    archived: input.archived,
    archived_at: input.archived ? isoNow : null,
    updated_count,
  };
}

// ADR-0031 (slice 8.13). Per-thread read/unread toggle. Boolean wire
// shape (matches star/trash). Last-write-wins on the per-row `read_at`
// timestamp — distinct from the slice-8.2 per-row markRead which is
// first-write-wins. Fan-out is filtered to inbound rows only; outbound
// rows are never "unread" in any UI sense.
async function markThreadRead(
  deps: DynamoMessageReaderDeps,
  input: MarkThreadReadInput,
  now: Date,
): Promise<MarkThreadReadResult> {
  const isoNow = now.toISOString();
  const value = input.read ? isoNow : null;
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "read_at",
    value,
    {
      projectionExtras: ["direction"],
      rowFilter: (r) => r["direction"] === "in",
    },
  );
  return {
    thread_id: input.thread_id,
    read: input.read,
    read_at: input.read ? isoNow : null,
    updated_count,
  };
}

// ADR-0035 (slice 8.17). Drafts live in the same Messages table partition
// (`address`) as that mailbox's inbound/outbound mail, distinguished by the
// SK prefix `DRAFT#<ulid>` and an explicit `kind: "draft"` row attribute.
// Upsert-by-id: first save (`draft_id: null`) mints a fresh ULID and writes
// with `attribute_not_exists(SK)` to prevent a (vanishingly unlikely)
// collision; subsequent saves are conditional UpdateItems guarded by
// `attribute_exists(address) AND #kind = :draft` so a stale primary key
// cannot create a phantom draft and a draft deleted from another tab cannot
// be silently revived. ConditionalCheckFailed → null → 404 from the
// dispatcher.
const DRAFT_SK_PREFIX = "DRAFT#";

async function saveDraft(
  deps: DynamoMessageReaderDeps,
  input: SaveDraftInput,
  now: Date,
): Promise<SaveDraftResult | null> {
  const isoNow = now.toISOString();

  if (input.draft_id === null) {
    if (!deps.makeUlid) {
      throw new Error(
        "saveDraft: makeUlid dependency is required for first-save (draft_id=null)",
      );
    }
    const ulid = deps.makeUlid();
    const sk = DRAFT_SK_PREFIX + ulid;
    const row: StoredDraft & Record<string, unknown> = {
      schema_v: "1",
      kind: "draft",
      address: input.address,
      draft_id: ulid,
      body_text: input.body_text,
      // ADR-0042 (slice 8.21). Tail-add nullable column. First-save
      // collapses absent input.body_html to null — the operator hasn't
      // formatted anything yet, or formatting was structurally trivial.
      body_html: input.body_html ?? null,
      to: input.to ?? null,
      cc: input.cc ?? null,
      subject: input.subject ?? null,
      in_reply_to: input.in_reply_to ?? null,
      references: input.references ?? null,
      created_at: isoNow,
      updated_at: isoNow,
    };
    // Address PK + DRAFT# SK; ULID monotonicity makes a real collision
    // implausible, but the conditional write protects against it cheaply.
    try {
      await deps.client.send(
        new PutCommand({
          TableName: deps.messagesTable,
          Item: { ...row, internal_id: sk },
          ConditionExpression: "attribute_not_exists(internal_id)",
        }),
      );
      return {
        draft_id: ulid,
        created_at: isoNow,
        updated_at: isoNow,
      };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // ULID collision against an existing row in the same ms with the
        // same random tail — vanishingly unlikely. Per ADR, retry once.
        const retryUlid = deps.makeUlid();
        const retrySk = DRAFT_SK_PREFIX + retryUlid;
        await deps.client.send(
          new PutCommand({
            TableName: deps.messagesTable,
            Item: { ...row, internal_id: retrySk, draft_id: retryUlid },
            ConditionExpression: "attribute_not_exists(internal_id)",
          }),
        );
        return {
          draft_id: retryUlid,
          created_at: isoNow,
          updated_at: isoNow,
        };
      }
      throw err;
    }
  }

  // Subsequent save. Conditional UpdateItem — only land if the row exists
  // and is in fact a draft. Stale ids (deleted-from-another-tab) surface
  // as ConditionalCheckFailed → null. The composer responds by minting a
  // new draft on its next save; the local text buffer is preserved.
  const sk = DRAFT_SK_PREFIX + input.draft_id;
  const setExpr: string[] = [
    "body_text = :body_text",
    "updated_at = :updated_at",
  ];
  const exprValues: Record<string, unknown> = {
    ":body_text": input.body_text,
    ":updated_at": isoNow,
    ":draft": "draft",
  };
  const exprNames: Record<string, string> = {
    "#kind": "kind",
  };
  // Only patch fields the caller passed; an absent key on the wire means
  // "leave alone", a present null means "clear". Both round-trip identically
  // through DDB because StoredDraft's recipient slots are nullable strings.
  const optionalFields: ReadonlyArray<keyof SaveDraftInput> = [
    "body_html",
    "to",
    "cc",
    "subject",
    "in_reply_to",
    "references",
  ];
  for (const f of optionalFields) {
    if (f in input) {
      const ref = `:${String(f)}`;
      const nameRef = `#${String(f)}`;
      exprNames[nameRef] = String(f);
      setExpr.push(`${nameRef} = ${ref}`);
      exprValues[ref] = input[f] ?? null;
    }
  }

  try {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.messagesTable,
        Key: { address: input.address, internal_id: sk },
        UpdateExpression: `SET ${setExpr.join(", ")}`,
        ConditionExpression:
          "attribute_exists(address) AND #kind = :draft",
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return null;
    }
    throw err;
  }

  // We need created_at to round-trip in the result, but the conditional
  // UPDATE above didn't include it in the response shape we care about
  // (ALL_NEW would, but we don't read .Attributes here to keep the diff
  // tight). Read it back via a tiny Get; it costs one RCU and matches the
  // archive_thread echoing posture. For a v1 composer firing every 1.5s
  // this is fine.
  const out = await deps.client.send(
    new GetCommand({
      TableName: deps.messagesTable,
      Key: { address: input.address, internal_id: sk },
      ProjectionExpression: "created_at",
    }),
  );
  const createdAt =
    typeof out.Item?.["created_at"] === "string"
      ? (out.Item["created_at"] as string)
      : isoNow;
  return {
    draft_id: input.draft_id,
    created_at: createdAt,
    updated_at: isoNow,
  };
}

async function listDrafts(
  deps: DynamoMessageReaderDeps,
  input: ListDraftsInput,
): Promise<ListDraftsResult> {
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      KeyConditionExpression:
        "address = :addr AND begins_with(internal_id, :pfx)",
      ExpressionAttributeValues: {
        ":addr": input.address,
        ":pfx": DRAFT_SK_PREFIX,
      },
      ScanIndexForward: false,
      Limit: input.limit,
      ExclusiveStartKey: input.cursor ? decodeCursor(input.cursor) : undefined,
    }),
  );

  const drafts = (out.Items ?? [])
    .map(projectDraftRow)
    .filter((d): d is StoredDraft => d !== null);

  const next_cursor = out.LastEvaluatedKey
    ? encodeCursor(out.LastEvaluatedKey)
    : null;

  return { drafts, next_cursor };
}

async function getDraft(
  deps: DynamoMessageReaderDeps,
  input: GetDraftInput,
): Promise<StoredDraft | null> {
  const sk = DRAFT_SK_PREFIX + input.draft_id;
  const out = await deps.client.send(
    new GetCommand({
      TableName: deps.messagesTable,
      Key: { address: input.address, internal_id: sk },
    }),
  );
  if (!out.Item) return null;
  return projectDraftRow(out.Item);
}

async function deleteDraft(
  deps: DynamoMessageReaderDeps,
  input: DeleteDraftInput,
): Promise<DeleteDraftResult> {
  const sk = DRAFT_SK_PREFIX + input.draft_id;
  // Probe-then-delete keeps `deleted: false` distinguishable from a delete
  // on a row that's actually a non-draft message at the same SK (which
  // can't happen by construction, but the ConditionExpression guards against
  // a stray API caller writing a non-draft row at DRAFT#... by accident).
  const probe = await deps.client.send(
    new GetCommand({
      TableName: deps.messagesTable,
      Key: { address: input.address, internal_id: sk },
      ProjectionExpression: "#kind",
      ExpressionAttributeNames: { "#kind": "kind" },
    }),
  );
  if (!probe.Item || probe.Item["kind"] !== "draft") {
    return { draft_id: input.draft_id, deleted: false };
  }
  await deps.client.send(
    new DeleteCommand({
      TableName: deps.messagesTable,
      Key: { address: input.address, internal_id: sk },
      ConditionExpression: "#kind = :draft",
      ExpressionAttributeNames: { "#kind": "kind" },
      ExpressionAttributeValues: { ":draft": "draft" },
    }),
  );
  return { draft_id: input.draft_id, deleted: true };
}

// ADR-0037 (slice 8.17). Catalog SK prefix and rename / delete fan-out cap.
// MAX_RENAME_FANOUT bounds the worst case (every row in the mailbox carries
// the label) and is surfaced in the result's `incomplete` flag so the
// operator can re-call until convergence. Per-row idempotence (set add /
// delete is idempotent at the value level) makes resume safe.
const LABEL_SK_PREFIX = "LABEL#";
const MAX_RENAME_FANOUT = 1000;

// ADR-0037 (slice 8.17). Lowercase the operator-supplied label for catalog
// identity; the original casing rides on `display_name`. Whitespace trim
// happens in the BFF schema so by the time we get here the value is the
// already-validated form. Locale-independent toLowerCase keeps "İ" and
// similar boundary chars from inflating the catalog.
function labelKey(label: string): string {
  return label.toLowerCase();
}

async function addThreadLabel(
  deps: DynamoMessageReaderDeps,
  input: AddThreadLabelInput,
  _now: Date,
): Promise<ThreadLabelResult> {
  const value = labelKey(input.label);
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "labels",
    value,
    { setOp: "add" },
  );
  // Read back the lead row's labels so the optimistic UI gets the
  // post-state without a refetch. When the thread has zero rows
  // (already-deleted thread or stale id), `labels` is just the singleton.
  const labels = await readLeadRowLabels(deps, input.thread_id, value);
  return {
    thread_id: input.thread_id,
    label: value,
    labels,
    updated_count,
  };
}

async function removeThreadLabel(
  deps: DynamoMessageReaderDeps,
  input: RemoveThreadLabelInput,
  _now: Date,
): Promise<ThreadLabelResult> {
  const value = labelKey(input.label);
  const updated_count = await fanOutThreadAttribute(
    deps,
    input.thread_id,
    "labels",
    value,
    { setOp: "delete" },
  );
  const labels = await readLeadRowLabels(deps, input.thread_id, null);
  return {
    thread_id: input.thread_id,
    label: value,
    labels,
    updated_count,
  };
}

// Read the labels set off the first row in the thread. Used post-fan-out
// so the wire result echoes the operator's lead row's post-state. Empty
// thread → fall back to `[fallbackValue]` (for add) or `[]` (for remove).
async function readLeadRowLabels(
  deps: DynamoMessageReaderDeps,
  threadId: string,
  fallbackValue: string | null,
): Promise<string[]> {
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      IndexName: deps.threadIdGsiName,
      KeyConditionExpression: "thread_id = :tid",
      ExpressionAttributeValues: { ":tid": threadId },
      ProjectionExpression: "address, internal_id",
      Limit: 1,
    }),
  );
  const hit = out.Items?.[0];
  if (!hit) return fallbackValue !== null ? [fallbackValue] : [];
  const lead = await deps.client.send(
    new GetCommand({
      TableName: deps.messagesTable,
      Key: {
        address: String(hit["address"]),
        internal_id: String(hit["internal_id"]),
      },
      ProjectionExpression: "labels",
    }),
  );
  return stringSetToArray(lead.Item?.["labels"]);
}

async function listLabels(
  deps: DynamoMessageReaderDeps,
  input: ListLabelsInput,
): Promise<ListLabelsResult> {
  const out = await deps.client.send(
    new QueryCommand({
      TableName: deps.messagesTable,
      KeyConditionExpression:
        "address = :addr AND begins_with(internal_id, :pfx)",
      ExpressionAttributeValues: {
        ":addr": input.address,
        ":pfx": LABEL_SK_PREFIX,
      },
    }),
  );
  const labels = (out.Items ?? [])
    .map(projectLabelRow)
    .filter((e): e is LabelCatalogEntry => e !== null)
    .sort((a, b) =>
      a.display_name
        .toLowerCase()
        .localeCompare(b.display_name.toLowerCase()),
    );
  return { labels };
}

async function createLabel(
  deps: DynamoMessageReaderDeps,
  input: CreateLabelInput,
  now: Date,
): Promise<LabelCatalogEntry | null> {
  const isoNow = now.toISOString();
  const key = labelKey(input.label);
  const sk = LABEL_SK_PREFIX + key;
  try {
    await deps.client.send(
      new PutCommand({
        TableName: deps.messagesTable,
        Item: {
          address: input.address,
          internal_id: sk,
          schema_v: "1",
          kind: "label",
          label: key,
          display_name: input.label,
          created_at: isoNow,
        },
        ConditionExpression: "attribute_not_exists(internal_id)",
      }),
    );
    return {
      label: key,
      display_name: input.label,
      created_at: isoNow,
    };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return null;
    throw err;
  }
}

async function deleteLabel(
  deps: DynamoMessageReaderDeps,
  input: DeleteLabelInput,
): Promise<DeleteLabelResult> {
  const key = labelKey(input.label);
  const sk = LABEL_SK_PREFIX + key;
  // Idempotent: a missing catalog row is a 200 no-op. The bulk strip still
  // runs against whatever rows happen to carry the value — the operator's
  // intent is "this label is gone everywhere," not "this catalog row is
  // gone." Same posture as star_thread returning updated_count: 0 on an
  // empty thread.
  await deps.client
    .send(
      new DeleteCommand({
        TableName: deps.messagesTable,
        Key: { address: input.address, internal_id: sk },
        ConditionExpression: "attribute_exists(internal_id)",
      }),
    )
    .catch((err) => {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    });
  const strip = await stripLabelAcrossRows(deps, input.address, key, null);
  return {
    label: key,
    updated_row_count: strip.updated_row_count,
    incomplete: strip.incomplete,
  };
}

async function renameLabel(
  deps: DynamoMessageReaderDeps,
  input: RenameLabelInput,
  now: Date,
): Promise<RenameLabelResult | null> {
  const fromKey = labelKey(input.from);
  const toKey = labelKey(input.to);
  // Same-key rename is a 400 in the BFF schema, but defensive here too.
  if (fromKey === toKey) {
    return {
      from: fromKey,
      to: toKey,
      updated_row_count: 0,
      incomplete: false,
    };
  }
  const isoNow = now.toISOString();
  const toSk = LABEL_SK_PREFIX + toKey;
  // Conditional Put on the new catalog row first; conflict → null → 409.
  try {
    await deps.client.send(
      new PutCommand({
        TableName: deps.messagesTable,
        Item: {
          address: input.address,
          internal_id: toSk,
          schema_v: "1",
          kind: "label",
          label: toKey,
          display_name: input.to,
          created_at: isoNow,
        },
        ConditionExpression: "attribute_not_exists(internal_id)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return null;
    throw err;
  }
  // Best-effort delete on the old catalog row. Already-missing is fine —
  // a renamed-to-missing produces ghost rows in the strip below, but the
  // strip handles that as "no rows to update."
  const fromSk = LABEL_SK_PREFIX + fromKey;
  await deps.client
    .send(
      new DeleteCommand({
        TableName: deps.messagesTable,
        Key: { address: input.address, internal_id: fromSk },
      }),
    )
    .catch(() => undefined);
  const strip = await stripLabelAcrossRows(deps, input.address, fromKey, toKey);
  return {
    from: fromKey,
    to: toKey,
    updated_row_count: strip.updated_row_count,
    incomplete: strip.incomplete,
  };
}

// ADR-0037 (slice 8.17). Bulk strip across the address partition for delete
// and rename. `replacement` null = pure delete; otherwise the row gets
// `DELETE labels :old, ADD labels :new` in a single UpdateItem so the row
// transitions atomically. No GSI for "rows-with-label-X" (ADR-0011); we
// scan the address partition with FilterExpression: contains(labels, :old)
// and accept the filter-after-scan cost. v1 mailboxes make this a one-page
// Query in practice; the cap is MAX_RENAME_FANOUT.
async function stripLabelAcrossRows(
  deps: DynamoMessageReaderDeps,
  address: string,
  oldValue: string,
  replacement: string | null,
): Promise<{ updated_row_count: number; incomplete: boolean }> {
  let updated_row_count = 0;
  let incomplete = false;
  let cursor: Record<string, unknown> | undefined = undefined;
  let scanned = 0;
  // contains() against an SS in DDB matches when the set has the value.
  while (scanned < MAX_RENAME_FANOUT) {
    const out: QueryCommandOutput = await deps.client.send(
      new QueryCommand({
        TableName: deps.messagesTable,
        KeyConditionExpression: "address = :addr",
        FilterExpression: "contains(#labels, :old)",
        ExpressionAttributeNames: { "#labels": "labels" },
        ExpressionAttributeValues: {
          ":addr": address,
          ":old": oldValue,
        },
        ProjectionExpression: "address, internal_id",
        Limit: Math.min(MAX_RENAME_FANOUT - scanned, 100),
        ExclusiveStartKey: cursor,
      }),
    );
    const items = out.Items ?? [];
    scanned += items.length;
    if (items.length > 0) {
      const results = await Promise.all(
        items.map(async (r: Record<string, unknown>) => {
          const cmd =
            replacement !== null
              ? new UpdateCommand({
                  TableName: deps.messagesTable,
                  Key: {
                    address: String(r["address"]),
                    internal_id: String(r["internal_id"]),
                  },
                  UpdateExpression: "DELETE #labels :old ADD #labels :new",
                  ConditionExpression: "attribute_exists(address)",
                  ExpressionAttributeNames: { "#labels": "labels" },
                  ExpressionAttributeValues: {
                    ":old": new Set([oldValue]),
                    ":new": new Set([replacement]),
                  },
                })
              : new UpdateCommand({
                  TableName: deps.messagesTable,
                  Key: {
                    address: String(r["address"]),
                    internal_id: String(r["internal_id"]),
                  },
                  UpdateExpression: "DELETE #labels :old",
                  ConditionExpression: "attribute_exists(address)",
                  ExpressionAttributeNames: { "#labels": "labels" },
                  ExpressionAttributeValues: { ":old": new Set([oldValue]) },
                });
          try {
            await deps.client.send(cmd);
            return true;
          } catch (err) {
            if (err instanceof ConditionalCheckFailedException) return false;
            throw err;
          }
        }),
      );
      updated_row_count += results.filter(Boolean).length;
    }
    const lek: Record<string, unknown> | undefined = out.LastEvaluatedKey;
    if (!lek) {
      incomplete = false;
      return { updated_row_count, incomplete };
    }
    cursor = lek;
    if (scanned >= MAX_RENAME_FANOUT) {
      incomplete = true;
    }
  }
  return { updated_row_count, incomplete };
}

function projectLabelRow(row: Record<string, unknown>): LabelCatalogEntry | null {
  if (row["kind"] !== "label") return null;
  const label = row["label"];
  const createdAt = row["created_at"];
  if (typeof label !== "string" || typeof createdAt !== "string") return null;
  const displayName =
    typeof row["display_name"] === "string"
      ? (row["display_name"] as string)
      : label;
  return { label, display_name: displayName, created_at: createdAt };
}

// Project a DDB draft row back to the StoredDraft wire shape. Returns null
// for rows that look corrupt (missing required fields) — the row is
// silently dropped from list_drafts so a single malformed write doesn't
// break the whole view.
function projectDraftRow(row: Record<string, unknown>): StoredDraft | null {
  if (row["kind"] !== "draft") return null;
  const address = row["address"];
  const draftId = row["draft_id"];
  const bodyText = row["body_text"];
  const createdAt = row["created_at"];
  const updatedAt = row["updated_at"];
  if (
    typeof address !== "string" ||
    typeof draftId !== "string" ||
    typeof bodyText !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  return {
    schema_v: "1",
    kind: "draft",
    address,
    draft_id: draftId,
    body_text: bodyText,
    // ADR-0042 (slice 8.21). Tail-add: pre-existing rows lack the
    // attribute and surface as null, which the composer treats as
    // "no formatting" and falls back to body_text paragraphs.
    body_html: nullableString(row["body_html"]),
    to: nullableString(row["to"]),
    cc: nullableString(row["cc"]),
    subject: nullableString(row["subject"]),
    in_reply_to: nullableString(row["in_reply_to"]),
    references: nullableString(row["references"]),
    created_at: createdAt,
    updated_at: updatedAt,
  };
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
