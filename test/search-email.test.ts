import { describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// search_email per ADR-0007 / ADR-0004. Two-phase strategy:
//   1. Address-partition Query, newest-first, with structured filters
//      (from/to/subject) pushed into FilterExpression and time bounds
//      pushed into the KeyCondition via internal_id ULID bounds.
//   2. For rows that didn't already match on metadata (case-folded, in app
//      code), fan out a per-row chunks Query to look at the body.
//
// The free-text `query` is intentionally NOT in FilterExpression — DDB
// `contains` is case-sensitive and we want case-insensitive UX.

const TABLES = {
  messagesTable: "Messages-test",
  bodyChunksTable: "MessageBodyChunks-test",
  messageIdGsiName: "GSI1",
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
    direction: "in",
    ...over,
  };
}

describe("DynamoMessageReader.searchEmail", () => {
  it("queries the address partition newest-first; the free-text query is NOT pushed into FilterExpression", async () => {
    const client = makeStubClient(async () => ({ Items: [], Count: 0 }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 25,
      cursor: null,
      since: null,
      until: null,
      from: null,
      to: null,
      subject: null,
    });

    const q = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand)[0]!;
    expect(q.input.TableName).toBe(TABLES.messagesTable);
    expect(q.input.IndexName).toBeUndefined();
    expect(q.input.ScanIndexForward).toBe(false);
    expect(q.input.KeyConditionExpression).toMatch(/address\s*=\s*:addr/);
    // FilterExpression is omitted entirely when there are no structured
    // filters; the free-text query is folded in app code.
    expect(q.input.FilterExpression).toBeUndefined();
    expect(
      JSON.stringify(q.input.ExpressionAttributeValues ?? {}),
    ).not.toContain("invoice");
  });

  it("structured filters (from/to/subject) push into FilterExpression with ExpressionAttributeNames for reserved words", async () => {
    const client = makeStubClient(async () => ({ Items: [], Count: 0 }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 25,
      cursor: null,
      since: null,
      until: null,
      from: "bob@example.com",
      to: "alice@acme.com",
      subject: "Q2",
    });

    const q = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand)[0]!;
    expect(q.input.FilterExpression).toMatch(/contains\(#from, :from\)/);
    expect(q.input.FilterExpression).toMatch(/contains\(#to, :to\)/);
    expect(q.input.FilterExpression).toMatch(/contains\(#subj, :subj\)/);
    expect(q.input.ExpressionAttributeNames).toMatchObject({
      "#from": "from_raw",
      "#to": "to_raw",
      "#subj": "subject",
    });
    expect(q.input.ExpressionAttributeValues).toMatchObject({
      ":from": "bob@example.com",
      ":to": "alice@acme.com",
      ":subj": "Q2",
    });
  });

  it("pushes since+until into the KeyCondition as a BETWEEN over internal_id", async () => {
    const client = makeStubClient(async () => ({ Items: [], Count: 0 }));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 25,
      cursor: null,
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-21T00:00:00Z",
      from: null,
      to: null,
      subject: null,
    });

    const q = client.send.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand)[0]!;
    expect(q.input.KeyConditionExpression).toMatch(
      /internal_id BETWEEN :since AND :until/,
    );
    const vals = q.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(typeof vals[":since"]).toBe("string");
    expect(typeof vals[":until"]).toBe("string");
    // ULID-encoded bounds: the same ms-prefix; lower tail < upper tail.
    expect((vals[":since"] as string) < (vals[":until"] as string)).toBe(true);
  });

  it("metadata match short-circuits the body fan-out (no per-row chunks query)", async () => {
    // The candidate row has 'invoice' inside subject — no need to scan body.
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.messagesTable) {
          return { Items: [row({ subject: "Re: Q2 invoice" })], Count: 1 };
        }
        // If we ever hit the chunks table here, the test should fail loudly.
        throw new Error("unexpected fan-out to body chunks");
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 25,
      cursor: null,
      since: null,
      until: null,
      from: null,
      to: null,
      subject: null,
    });
    expect(result.messages).toHaveLength(1);
    // Exactly one DDB call — the address Query — was issued.
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("metadata case-folds: query 'INVOICE' matches a row whose subject is 'invoice'", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return { Items: [row({ subject: "invoice for May" })], Count: 1 };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.searchEmail({
      address: "alice@acme.com",
      query: "INVOICE",
      limit: 25,
      cursor: null,
      since: null,
      until: null,
      from: null,
      to: null,
      subject: null,
    });
    expect(result.messages).toHaveLength(1);
  });

  it("falls through to the body fan-out when metadata misses, and a body chunk match promotes the row", async () => {
    // Subject/from/to/snippet/headers_blob all miss; the body chunks contain
    // the query string. The chunks Query is fired once for that row.
    const candidate = row({
      subject: "weekly digest",
      snippet: "weekly digest summary",
      headers_blob: "From: ...\r\n",
      from_raw: "no-reply@example.com",
      to_raw: "alice@acme.com",
    });
    let chunkCalls = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.messagesTable) {
          return { Items: [candidate], Count: 1 };
        }
        if (cmd.input.TableName === TABLES.bodyChunksTable) {
          chunkCalls += 1;
          return {
            Items: [{ text: "Hello — please find the INVOICE attached." }],
            Count: 1,
          };
        }
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 25,
      cursor: null,
      since: null,
      until: null,
      from: null,
      to: null,
      subject: null,
    });
    expect(result.messages).toHaveLength(1);
    expect(chunkCalls).toBe(1);
  });

  it("skeleton rows (parse_status=failed) skip the body fan-out — they have no chunks", async () => {
    const skeleton = {
      address: "alice@acme.com",
      internal_id: "01KS500000000000000000FAIL",
      parse_status: "failed",
      parse_error: "multipart Content-Type missing boundary parameter",
      schema_v: "1",
      raw_s3_uri: "s3://bucket/bad",
      received_at: "2026-05-19T14:23:10.901Z",
    };
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.messagesTable) {
          return { Items: [skeleton], Count: 1 };
        }
        // No chunks should be queried for a skeleton row.
        throw new Error("unexpected fan-out to body chunks for skeleton");
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 25,
      cursor: null,
      since: null,
      until: null,
      from: null,
      to: null,
      subject: null,
    });
    // Skeleton row didn't match on metadata, didn't get fan-out, dropped.
    expect(result.messages).toHaveLength(0);
  });

  it("propagates LastEvaluatedKey as next_cursor (opaque)", async () => {
    const lek = {
      address: "alice@acme.com",
      internal_id: "01KS500000000000000000A001",
    };
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        if (cmd.input.TableName === TABLES.messagesTable) {
          return {
            Items: [row({ subject: "Re: Q2 invoice" })],
            Count: 1,
            LastEvaluatedKey: lek,
          };
        }
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.searchEmail({
      address: "alice@acme.com",
      query: "invoice",
      limit: 1,
      cursor: null,
      since: null,
      until: null,
      from: null,
      to: null,
      subject: null,
    });
    expect(result.next_cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(result.next_cursor!, "base64").toString("utf-8"),
    );
    expect(decoded).toEqual(lek);
  });
});
