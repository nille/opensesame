import { describe, expect, it, vi } from "vitest";
import {
  BatchWriteCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { makeDynamoMessageStore } from "../src/aws/dynamodb.js";
import type { ParsedMessage } from "../src/core/parser.js";
import type { SkeletonRow, StoredMessage } from "../src/core/store.js";

// Stub of DynamoDBDocumentClient. The adapter only calls `.send(Command)`,
// so a recorder-shaped fake is enough — we read the command class + .input
// back to assert the schema ADR-0013 pins.
type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(): StubClient {
  return { send: vi.fn(async () => ({})) };
}

function commandsByType<T>(client: StubClient, ctor: new (...a: never[]) => T): T[] {
  return client.send.mock.calls
    .map((c) => c[0] as unknown)
    .filter((c): c is T => c instanceof ctor);
}

const TABLES = {
  messagesTable: "Messages-test",
  bodyChunksTable: "MessageBodyChunks-test",
} as const;

const PARSED: ParsedMessage = {
  headers: {
    from: "Sender <sender@example.com>",
    to: "alice@acme.com",
    cc: null,
    subject: "Re: Q2 invoice",
    date: "Tue, 19 May 2026 14:23:10 +0000",
    messageId: "<msg-1@example.com>",
    inReplyTo: null,
    references: null,
    autoSubmitted: "no",
    listId: null,
    customHeaders: {},
    customHeadersTruncated: false,
  },
  headersBlob: "From: Sender <sender@example.com>\r\nTo: alice@acme.com\r\n",
  bodyText: "hi",
  bodyHtml: null,
  attachments: [],
};

function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    parse_status: "ok",
    internal_id: "01HF7E0000000000000000DYNAMO",
    address: "alice@acme.com",
    received_at: "2026-05-19T14:23:10.901Z",
    raw_s3_uri: "s3://bucket/2026/05/19/msg.eml",
    schema_v: "1",
    parsed: PARSED,
    ...overrides,
  };
}

describe("DynamoMessageStore.writeMessage", () => {
  it("writes Messages row keyed by PK=address, SK=internal_id (ADR-0013)", async () => {
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    await store.writeMessage(makeStoredMessage());

    // Metadata write goes last (chunks-first ordering per ADR-0013), but the
    // PK/SK assertion holds regardless of ordering.
    const puts = commandsByType(client, PutCommand);
    const metaPut = puts.find(
      (p) => (p.input as { TableName?: string }).TableName === TABLES.messagesTable,
    );
    expect(metaPut).toBeDefined();
    const item = (metaPut!.input as { Item: Record<string, unknown> }).Item;
    expect(item.address).toBe("alice@acme.com");
    expect(item.internal_id).toBe("01HF7E0000000000000000DYNAMO");
    expect(item.parse_status).toBe("ok");
    expect(item.schema_v).toBe("1");
    // GSI1 keys per ADR-0013: message_id (RFC 5322 with brackets) + received_at.
    expect(item.message_id).toBe("<msg-1@example.com>");
    expect(item.received_at).toBe("2026-05-19T14:23:10.901Z");
    // headers_blob lives inline (ADR-0013).
    expect(item.headers_blob).toBe(PARSED.headersBlob);
  });

  it("writes body chunks under PK=internal_id with zero-padded chunk_seq", async () => {
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    // Force multiple chunks by passing a body larger than chunkSize. We do
    // this via a parsed message with a long bodyText — the adapter calls
    // chunkBody internally with defaults.
    const long = "a".repeat(700_000);
    await store.writeMessage(
      makeStoredMessage({ parsed: { ...PARSED, bodyText: long } }),
    );

    const puts = commandsByType(client, PutCommand);
    const chunkPuts = puts.filter(
      (p) =>
        (p.input as { TableName?: string }).TableName === TABLES.bodyChunksTable,
    );
    expect(chunkPuts.length).toBeGreaterThanOrEqual(2);

    const seqs = chunkPuts
      .map(
        (p) =>
          (p.input as unknown as { Item: { chunk_seq: string } }).Item
            .chunk_seq,
      )
      .sort();
    // Zero-padded so lex order matches numeric order; pinned for query
    // ordering when we later switch to BatchWriteItem.
    expect(seqs[0]).toBe("0000");
    expect(seqs[0]).toMatch(/^\d{4}$/);
    for (const cp of chunkPuts) {
      const item = (cp.input as { Item: Record<string, unknown> }).Item;
      expect(item.internal_id).toBe("01HF7E0000000000000000DYNAMO");
      expect(typeof item.text).toBe("string");
      expect(typeof item.start_byte).toBe("number");
      expect(typeof item.end_byte).toBe("number");
    }
  });

  it("writes chunks before the metadata row (ADR-0013 ordering)", async () => {
    // ADR-0013: "writes chunks first, then the metadata row last." A reader
    // that finds a Messages row can trust the chunks exist.
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    await store.writeMessage(makeStoredMessage());

    const calls = client.send.mock.calls;
    const metaIdx = calls.findIndex(
      (c) =>
        c[0] instanceof PutCommand &&
        (c[0].input as { TableName?: string }).TableName === TABLES.messagesTable,
    );
    expect(metaIdx).toBeGreaterThan(-1);

    // Every chunk write must precede the metadata write.
    for (let i = 0; i < metaIdx; i++) {
      const cmd = calls[i]![0];
      if (cmd instanceof PutCommand) {
        expect(
          (cmd.input as { TableName?: string }).TableName,
        ).toBe(TABLES.bodyChunksTable);
      }
    }
  });

  it("omits the `direction` attribute for inbound rows (back-compat default 'in')", async () => {
    // ADR-0017: inbound rows leave `direction` absent so anything written
    // before slice 3 stays byte-identical on rewrite. The reader projects
    // attribute-absent as direction='in'.
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    await store.writeMessage(makeStoredMessage());

    const puts = commandsByType(client, PutCommand);
    const metaPut = puts.find(
      (p) =>
        (p.input as { TableName?: string }).TableName === TABLES.messagesTable,
    )!;
    const item = (metaPut.input as { Item: Record<string, unknown> }).Item;
    expect(item.direction).toBeUndefined();
  });

  it("emits direction='out' on the wire when a StoredMessage carries it", async () => {
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    await store.writeMessage(makeStoredMessage({ direction: "out" }));

    const puts = commandsByType(client, PutCommand);
    const metaPut = puts.find(
      (p) =>
        (p.input as { TableName?: string }).TableName === TABLES.messagesTable,
    )!;
    const item = (metaPut.input as { Item: Record<string, unknown> }).Item;
    expect(item.direction).toBe("out");
  });

  it("emits no chunk row when bodyText is empty (chunkBody returns [])", async () => {
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    await store.writeMessage(
      makeStoredMessage({ parsed: { ...PARSED, bodyText: "" } }),
    );

    const puts = commandsByType(client, PutCommand);
    const chunkPuts = puts.filter(
      (p) =>
        (p.input as { TableName?: string }).TableName === TABLES.bodyChunksTable,
    );
    expect(chunkPuts).toHaveLength(0);
    // Metadata row still written.
    const metaPuts = puts.filter(
      (p) =>
        (p.input as { TableName?: string }).TableName === TABLES.messagesTable,
    );
    expect(metaPuts).toHaveLength(1);
  });

  it("propagates SDK errors verbatim", async () => {
    const boom = new Error("ProvisionedThroughputExceeded");
    const client: StubClient = {
      send: vi.fn(async () => {
        throw boom;
      }),
    };
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    await expect(store.writeMessage(makeStoredMessage())).rejects.toBe(boom);
  });

  it("does not write the metadata row when a chunk write fails", async () => {
    // Half-write recovery: an interrupted write leaves orphaned chunks for
    // the reconciliation job (ADR-0013), never an indexable metadata row
    // pointing at missing chunks.
    const client: StubClient = {
      send: vi.fn(async (cmd: unknown) => {
        if (
          cmd instanceof PutCommand &&
          (cmd.input as { TableName?: string }).TableName ===
            TABLES.bodyChunksTable
        ) {
          throw new Error("chunk write failed");
        }
        return {};
      }),
    };
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    const long = "a".repeat(700_000);
    await expect(
      store.writeMessage(
        makeStoredMessage({ parsed: { ...PARSED, bodyText: long } }),
      ),
    ).rejects.toThrow(/chunk write failed/);

    const puts = commandsByType(client, PutCommand);
    const metaPuts = puts.filter(
      (p) =>
        (p.input as { TableName?: string }).TableName === TABLES.messagesTable,
    );
    expect(metaPuts).toHaveLength(0);
  });
});

describe("DynamoMessageStore.writeSkeleton", () => {
  it("writes a single Messages row with parse_status=failed and no body chunks (ADR-0012/0013)", async () => {
    const client = makeStubClient();
    const store = makeDynamoMessageStore({ client: client as never, ...TABLES });

    const row: SkeletonRow = {
      parse_status: "failed",
      parse_error: "multipart Content-Type missing boundary parameter",
      internal_id: "01HF7E0000000000000000DYNAMO",
      address: "alice@acme.com",
      received_at: "2026-05-19T14:23:10.901Z",
      raw_s3_uri: "s3://bucket/2026/05/19/msg.eml",
      schema_v: "1",
    };

    await store.writeSkeleton(row);

    const puts = commandsByType(client, PutCommand);
    expect(puts).toHaveLength(1);
    const put = puts[0]!;
    expect((put.input as { TableName?: string }).TableName).toBe(
      TABLES.messagesTable,
    );
    const item = (put.input as { Item: Record<string, unknown> }).Item;
    expect(item.parse_status).toBe("failed");
    expect(item.parse_error).toBe(row.parse_error);
    expect(item.address).toBe(row.address);
    expect(item.internal_id).toBe(row.internal_id);
    expect(item.received_at).toBe(row.received_at);
    expect(item.raw_s3_uri).toBe(row.raw_s3_uri);
    expect(item.schema_v).toBe("1");
    // Skeleton rows have no message_id (parse never succeeded). GSI1 PK is
    // missing; the row simply isn't projected onto the index — which is
    // correct: get_message(message_id) shouldn't ever surface a skeleton.
    expect(item.message_id).toBeUndefined();
    // No headers_blob, no body chunk writes.
    expect(item.headers_blob).toBeUndefined();
  });
});

describe("DynamoMessageStore — unused command imports for type safety", () => {
  // The adapter currently uses PutCommand only. These imports exist to keep
  // BatchWriteCommand / TransactWriteCommand visible if/when the chunk-write
  // path consolidates onto BatchWriteItem (a follow-up optimization). Test is
  // a no-op assertion that keeps the imports live.
  it("references the SDK command types that may replace per-chunk PutCommand", () => {
    expect(typeof BatchWriteCommand).toBe("function");
    expect(typeof TransactWriteCommand).toBe("function");
  });
});
