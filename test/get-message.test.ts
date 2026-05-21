import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// DDB read-side adapter for ADR-0007's get_message. Resolves a Message-ID
// (RFC 5322 with brackets) → (address, internal_id) via GSI1, then loads the
// Messages row and assembles the body from MessageBodyChunks.
//
// The adapter is intentionally narrow: getByMessageId(messageId) only. A
// later slice will add getByPrimaryKey(address, internalId) for callers that
// already know both halves of the PK (e.g. an inbox listing handing rows to
// get_message). Splitting them keeps the GSI1 hop out of the hot path.

const TABLES = {
  messagesTable: "Messages-test",
  bodyChunksTable: "MessageBodyChunks-test",
  messageIdGsiName: "MessageIdGSI",
} as const;

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(
  responder: (cmd: unknown) => Promise<unknown>,
): StubClient {
  return { send: vi.fn(responder) };
}

const HEADERS_BLOB =
  "From: Sender <sender@example.com>\r\nTo: alice@acme.com\r\nSubject: Re: Q2 invoice\r\n";

const FOUND_MESSAGE_ROW = {
  address: "alice@acme.com",
  internal_id: "01HF7E0000000000000000DYNAMO",
  parse_status: "ok",
  schema_v: "1",
  raw_s3_uri: "s3://bucket/2026/05/19/msg.eml",
  received_at: "2026-05-19T14:23:10.901Z",
  message_id: "<msg-1@example.com>",
  headers_blob: HEADERS_BLOB,
  subject: "Re: Q2 invoice",
  from_raw: "Sender <sender@example.com>",
  to_raw: "alice@acme.com",
  date_raw: "Tue, 19 May 2026 14:23:10 +0000",
  in_reply_to: null,
  references_raw: null,
  auto_submitted: "no",
  list_id: null,
  custom_headers: {},
};

describe("DynamoMessageReader.getByMessageId", () => {
  it("returns null when GSI1 lookup finds no row (expected for unknown message_id)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [], Count: 0 };
      throw new Error(`unexpected command: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.getByMessageId("<missing@example.com>");
    expect(result).toBeNull();
  });

  it("queries GSI1 with the bracketed message_id verbatim (ADR-0013)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [], Count: 0 };
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.getByMessageId("<msg-1@example.com>");

    const queryCalls = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const q = queryCalls[0]!;
    expect(q.input.TableName).toBe(TABLES.messagesTable);
    expect(q.input.IndexName).toBe(TABLES.messageIdGsiName);
    // ADR-0013 says the GSI PK is the raw RFC 5322 Message-ID with brackets.
    expect(q.input.ExpressionAttributeValues).toMatchObject({
      ":mid": "<msg-1@example.com>",
    });
  });

  it("returns the assembled message when parse_status=ok with a single chunk", async () => {
    const bodyText = "hi bob\n";
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.messagesTable) {
          return { Items: [FOUND_MESSAGE_ROW], Count: 1 };
        }
        if (cmd.input.TableName === TABLES.bodyChunksTable) {
          return {
            Items: [
              {
                internal_id: FOUND_MESSAGE_ROW.internal_id,
                chunk_seq: "0000",
                text: bodyText,
                start_byte: 0,
                end_byte: new TextEncoder().encode(bodyText).length,
              },
            ],
            Count: 1,
          };
        }
      }
      throw new Error(`unexpected: ${JSON.stringify(cmd)}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.getByMessageId("<msg-1@example.com>");

    expect(result).not.toBeNull();
    if (result === null || result.parse_status !== "ok") {
      throw new Error("expected parse_status=ok ReadMessage");
    }
    expect(result.address).toBe("alice@acme.com");
    expect(result.internal_id).toBe("01HF7E0000000000000000DYNAMO");
    expect(result.body_text).toBe(bodyText);
    expect(result.headers).toEqual({
      from: "Sender <sender@example.com>",
      to: "alice@acme.com",
      cc: null,
      subject: "Re: Q2 invoice",
      date: "Tue, 19 May 2026 14:23:10 +0000",
      message_id: "<msg-1@example.com>",
      in_reply_to: null,
      references: null,
      auto_submitted: "no",
      list_id: null,
    });
    expect(result.headers_blob).toBe(HEADERS_BLOB);
    expect(result.received_at).toBe("2026-05-19T14:23:10.901Z");
    expect(result.raw_s3_uri).toBe("s3://bucket/2026/05/19/msg.eml");
  });

  it("queries body chunks with ScanIndexForward=true so chunk_seq returns ascending (ADR-0013)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.messagesTable) {
          return { Items: [FOUND_MESSAGE_ROW], Count: 1 };
        }
        return { Items: [], Count: 0 };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.getByMessageId("<msg-1@example.com>");

    const chunkQuery = client.send.mock.calls
      .map((c) => c[0])
      .filter(
        (c): c is QueryCommand =>
          c instanceof QueryCommand &&
          c.input.TableName === TABLES.bodyChunksTable,
      )[0];
    expect(chunkQuery).toBeDefined();
    // assembleBody (src/core/reader.ts) trusts ascending chunk_seq order.
    // ScanIndexForward must be true (or undefined, the default).
    expect(chunkQuery!.input.ScanIndexForward ?? true).toBe(true);
    expect(chunkQuery!.input.ExpressionAttributeValues).toMatchObject({
      ":id": "01HF7E0000000000000000DYNAMO",
    });
  });

  it("returns parse_status=failed for skeleton rows without touching MessageBodyChunks", async () => {
    // ADR-0012/0013: skeleton rows have no chunks. Issuing the chunks query
    // would still return [] but it's a wasted RTT — readers branch on
    // parse_status before fetching chunks.
    const skeletonRow = {
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000FAILED",
      parse_status: "failed",
      parse_error: "multipart Content-Type missing boundary parameter",
      schema_v: "1",
      raw_s3_uri: "s3://bucket/2026/05/19/bad.eml",
      received_at: "2026-05-19T14:23:10.901Z",
    };
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) {
        // getByPrimaryKey hits the Messages row directly.
        return { Item: skeletonRow };
      }
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.bodyChunksTable) {
          throw new Error(
            "should not query body chunks for parse_status=failed rows",
          );
        }
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    // Skeleton rows are addressable by message_id only when the parser
    // managed to extract one before failing — in practice they're addressed
    // by primary key (address, internal_id). We exercise that via the
    // not-yet-built getByPrimaryKey path here so the skeleton-row contract
    // still gets exercised through the same adapter.
    const result = await reader.getByPrimaryKey(
      skeletonRow.address,
      skeletonRow.internal_id,
    );
    expect(result).not.toBeNull();
    if (result === null || result.parse_status !== "failed") {
      throw new Error("expected parse_status=failed ReadMessage");
    }
    expect(result.parse_error).toBe(skeletonRow.parse_error);
    expect(result.raw_s3_uri).toBe(skeletonRow.raw_s3_uri);
  });

  it("returns null on getByPrimaryKey when the row is missing (delete + race)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) return { Item: undefined };
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.getByPrimaryKey(
      "alice@acme.com",
      "01HF7E0000000000000000MISSING",
    );
    expect(result).toBeNull();
  });
});
