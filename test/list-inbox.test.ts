import { describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// read_inbox = paginated metadata listing keyed on PK=address (ADR-0007 +
// ADR-0013). One DDB Query; ScanIndexForward=false so newest internal_id
// comes first (internal_id is lexicographically time-sortable per ADR-0013).
// Cursor maps to DDB's LastEvaluatedKey — opaque to callers.

const TABLES = {
  messagesTable: "Messages-test",
  bodyChunksTable: "MessageBodyChunks-test",
  messageIdGsiName: "GSI1",
  threadIdGsiName: "ThreadIdGSI",
} as const;

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(
  responder: (cmd: unknown) => Promise<unknown>,
): StubClient {
  return { send: vi.fn(responder) };
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "alice@acme.com",
    internal_id: "01KS500000000000000000A001",
    parse_status: "ok",
    schema_v: "1",
    raw_s3_uri: "s3://bucket/k1",
    received_at: "2026-05-19T14:23:10.901Z",
    message_id: "<msg-1@example.com>",
    headers_blob: "From: ...\r\n",
    subject: "Re: Q2 invoice",
    from_raw: "Sender <sender@example.com>",
    to_raw: "alice@acme.com",
    date_raw: "Tue, 19 May 2026 14:23:10 +0000",
    in_reply_to: null,
    references_raw: null,
    auto_submitted: "no",
    list_id: null,
    snippet: "Re: Q2 invoice — first 200 chars of body…",
    ...over,
  };
}

describe("DynamoMessageReader.listInbox thread_id projection (ADR-0026)", () => {
  it("projects thread_id to the inbox row when the attribute is present", async () => {
    const client = makeStubClient(async () => ({
      Items: [row({ thread_id: "<root@example.com>" })],
      Count: 1,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });
    const m = result.messages[0]!;
    if (m.parse_status !== "ok") throw new Error("expected ok row");
    expect(m.thread_id).toBe("<root@example.com>");
  });

  it("collapses attribute-absent thread_id to null on read (legacy / sparse rows)", async () => {
    // Rows written before slice 8.8 have no thread_id attribute. The reader
    // must surface them as null so the client knows to fall through to JWZ.
    const client = makeStubClient(async () => ({
      Items: [row()],
      Count: 1,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });
    const m = result.messages[0]!;
    if (m.parse_status !== "ok") throw new Error("expected ok row");
    expect(m.thread_id).toBeNull();
  });
});

describe("DynamoMessageReader.listInbox reply_to projection (ADR-0022)", () => {
  it("projects reply_to_raw to inbox row reply_to field when present", async () => {
    const client = makeStubClient(async () => ({
      Items: [row({ reply_to_raw: "list-replies@example.com" })],
      Count: 1,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });
    const m = result.messages[0]!;
    if (m.parse_status !== "ok") throw new Error("expected ok row");
    expect(m.reply_to).toBe("list-replies@example.com");
  });
});

describe("DynamoMessageReader.listInbox", () => {
  it("queries Messages by PK=address, newest first, with the requested limit", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [], Count: 0 };
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.listInbox({ address: "alice@acme.com", limit: 25 });

    const queries = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand);
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.input.TableName).toBe(TABLES.messagesTable);
    // No GSI — base table query on PK=address.
    expect(q.input.IndexName).toBeUndefined();
    expect(q.input.ExpressionAttributeValues).toMatchObject({
      ":addr": "alice@acme.com",
    });
    // Newest first per ADR-0013 (ScanIndexForward=false).
    expect(q.input.ScanIndexForward).toBe(false);
    expect(q.input.Limit).toBe(25);
  });

  it("returns the projected inbox-row shape — metadata + snippet, no body chunks", async () => {
    const client = makeStubClient(async () => ({
      Items: [row()],
      Count: 1,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });

    expect(result.messages).toHaveLength(1);
    const m = result.messages[0]!;
    if (m.parse_status !== "ok") throw new Error("expected ok row");
    expect(m.address).toBe("alice@acme.com");
    expect(m.internal_id).toBe("01KS500000000000000000A001");
    expect(m.subject).toBe("Re: Q2 invoice");
    expect(m.from).toBe("Sender <sender@example.com>");
    expect(m.received_at).toBe("2026-05-19T14:23:10.901Z");
    expect(m.snippet).toBe("Re: Q2 invoice — first 200 chars of body…");
    expect(m.message_id).toBe("<msg-1@example.com>");
    // ADR-0022 tail-add: rows without reply_to_raw collapse to null on read.
    expect(m.reply_to).toBeNull();
    // No body chunks query was issued (the assertion is implicit: the stub
    // would have thrown — but we check explicitly to keep the contract loud).
    const queries = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand);
    expect(
      queries.find((q) => q.input.TableName === TABLES.bodyChunksTable),
    ).toBeUndefined();
  });

  it("propagates DDB's LastEvaluatedKey as next_cursor (opaque to callers)", async () => {
    const lek = {
      address: "alice@acme.com",
      internal_id: "01KS500000000000000000A001",
    };
    const client = makeStubClient(async () => ({
      Items: [row()],
      Count: 1,
      LastEvaluatedKey: lek,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 1,
    });

    // ADR-0007: cursor is opaque (server-defined). We round-trip the JSON
    // shape so the caller can pass it back; we don't promise its internals.
    expect(result.next_cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(result.next_cursor!, "base64").toString("utf-8"),
    );
    expect(decoded).toEqual(lek);
  });

  it("returns next_cursor=null when DDB has no more pages", async () => {
    const client = makeStubClient(async () => ({
      Items: [row()],
      Count: 1,
      // No LastEvaluatedKey → end of result set.
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });

    expect(result.next_cursor).toBeNull();
  });

  it("forwards a caller-supplied cursor as ExclusiveStartKey", async () => {
    const lek = {
      address: "alice@acme.com",
      internal_id: "01KS500000000000000000A001",
    };
    const cursor = Buffer.from(JSON.stringify(lek), "utf-8").toString("base64");

    const client = makeStubClient(async () => ({ Items: [], Count: 0 }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
      cursor,
    });

    const q = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand)[0]!;
    expect(q.input.ExclusiveStartKey).toEqual(lek);
  });

  it("filters newest-first by `since` using a KeyConditionExpression on internal_id", async () => {
    // ADR-0013: internal_id is lexicographically time-sortable. Per ADR-0007
    // `since` is a sync-style timestamp, distinct from cursor pagination.
    // We pass it through as a Begins/After bound on internal_id by deriving
    // a lower bound from the timestamp; for the v1 test we just assert the
    // shape — the bound is the ULID-equivalent of `since`.
    const client = makeStubClient(async () => ({ Items: [], Count: 0 }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
      since: "2026-05-19T00:00:00.000Z",
    });

    const q = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand)[0]!;
    // The Query should constrain SK to "internal_id > :since_id" so DDB
    // does the filtering (not us in app code).
    expect(q.input.KeyConditionExpression).toMatch(/internal_id\s*>\s*:since/);
    expect(q.input.ExpressionAttributeValues).toMatchObject({
      ":addr": "alice@acme.com",
    });
    expect(
      typeof (q.input.ExpressionAttributeValues as Record<string, unknown>)[
        ":since"
      ],
    ).toBe("string");
  });

  it("projects direction='in' when the row predates slice 3 (attribute absent)", async () => {
    // ADR-0017 back-compat: any Messages row written before this slice has
    // no `direction` attribute. The reader collapses attribute-absent to
    // "in" so the inbox keeps its meaning for inbound-only deployments.
    const client = makeStubClient(async () => ({
      Items: [row()],
      Count: 1,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });
    const m = result.messages[0]!;
    if (m.parse_status !== "ok") throw new Error("expected ok row");
    expect(m.direction).toBe("in");
  });

  it("projects direction='out' when the row carries it (slice 3 outbound copy)", async () => {
    const outboundRow = row({
      address: "test@nille.net",
      direction: "out",
      message_id: "<ses-msgid-000000@eu-north-1.amazonses.com>",
    });
    const client = makeStubClient(async () => ({
      Items: [outboundRow],
      Count: 1,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "test@nille.net",
      limit: 25,
    });
    const m = result.messages[0]!;
    if (m.parse_status !== "ok") throw new Error("expected ok row");
    expect(m.direction).toBe("out");
  });

  it("surfaces parse_status=failed rows in the inbox listing (skeleton rows are addressable)", async () => {
    // Skeleton rows must appear in the inbox so an operator can see what
    // failed and trigger replay. Parse_error replaces snippet — we don't
    // synthesize a fake snippet from a row that has no body.
    const skeleton = {
      address: "alice@acme.com",
      internal_id: "01KS500000000000000000FAIL",
      parse_status: "failed",
      parse_error: "multipart Content-Type missing boundary parameter",
      schema_v: "1",
      raw_s3_uri: "s3://bucket/bad",
      received_at: "2026-05-19T14:23:10.901Z",
    };
    const client = makeStubClient(async () => ({
      Items: [row(), skeleton],
      Count: 2,
    }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
    });

    expect(result.messages).toHaveLength(2);
    const failed = result.messages.find((m) => m.parse_status === "failed");
    if (!failed || failed.parse_status !== "failed") {
      throw new Error("expected one parse_status=failed row");
    }
    expect(failed.parse_error).toBe(
      "multipart Content-Type missing boundary parameter",
    );
    expect(failed.received_at).toBe(skeleton.received_at);
  });
});

describe("DynamoMessageReader.listThreadMessages (ADR-0027)", () => {
  it("queries ThreadIdGSI by thread_id ascending and returns inbox-row shape", async () => {
    // ScanIndexForward=true — the reader stack renders oldest-first.
    let captured: { input: Record<string, unknown> } | null = null;
    const client = makeStubClient(async (cmd) => {
      const c = cmd as { input: Record<string, unknown> } & { constructor: { name: string } };
      if (c.constructor.name === "QueryCommand") {
        captured = { input: c.input };
        return {
          Items: [
            row({
              internal_id: "01KS500000000000000000A001",
              thread_id: "<root@example.com>",
            }),
            row({
              internal_id: "01KS500000000000000000A002",
              thread_id: "<root@example.com>",
              message_id: "<msg-2@example.com>",
            }),
          ],
          Count: 2,
        };
      }
      throw new Error(`unexpected command ${c.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listThreadMessages({
      thread_id: "<root@example.com>",
      limit: 50,
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    const sent = captured!.input;
    expect(sent["TableName"]).toBe(TABLES.messagesTable);
    expect(sent["IndexName"]).toBe(TABLES.threadIdGsiName);
    expect(sent["KeyConditionExpression"]).toBe("thread_id = :tid");
    expect(sent["ExpressionAttributeValues"]).toEqual({
      ":tid": "<root@example.com>",
    });
    expect(sent["ScanIndexForward"]).toBe(true);
    expect(sent["Limit"]).toBe(50);
    expect(sent["ExclusiveStartKey"]).toBeUndefined();

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.parse_status).toBe("ok");
    if (result.messages[0]!.parse_status !== "ok") {
      throw new Error("expected ok row");
    }
    expect(result.messages[0]!.thread_id).toBe("<root@example.com>");
    expect(result.messages[0]!.subject).toBe("Re: Q2 invoice");
  });

  it("decodes the cursor on input and re-encodes LastEvaluatedKey on output", async () => {
    // Cursor is opaque base64-encoded LastEvaluatedKey — same shape as
    // listInbox / searchEmail.
    const lek = {
      thread_id: "<root@example.com>",
      internal_id: "01KS500000000000000000A009",
      address: "alice@acme.com",
    };
    const cursor = Buffer.from(JSON.stringify(lek), "utf-8").toString("base64");
    let captured: { input: Record<string, unknown> } | null = null;
    const client = makeStubClient(async (cmd) => {
      const c = cmd as { input: Record<string, unknown> } & { constructor: { name: string } };
      if (c.constructor.name === "QueryCommand") {
        captured = { input: c.input };
        return {
          Items: [],
          LastEvaluatedKey: {
            thread_id: "<root@example.com>",
            internal_id: "01KS500000000000000000A019",
            address: "alice@acme.com",
          },
        };
      }
      throw new Error(`unexpected command ${c.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listThreadMessages({
      thread_id: "<root@example.com>",
      limit: 10,
      cursor,
    });

    expect(captured).not.toBeNull();
    expect(captured!.input["ExclusiveStartKey"]).toEqual(lek);
    expect(result.next_cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(result.next_cursor as string, "base64").toString("utf-8"),
    );
    expect(decoded["internal_id"]).toBe("01KS500000000000000000A019");
  });

  it("returns null next_cursor when there is no LastEvaluatedKey", async () => {
    const client = makeStubClient(async () => ({ Items: [row()], Count: 1 }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.listThreadMessages({
      thread_id: "<root@example.com>",
      limit: 50,
    });
    expect(result.next_cursor).toBeNull();
  });
});
