import { describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// mark_read is a write path: GSI1 hop on `message_id` to resolve (address,
// internal_id), then a conditional UpdateItem with attribute_not_exists
// (read_at) to stamp `read_at = now`. The conditional guard makes the call
// idempotent — first open wins, later opens are no-ops.

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

const NOW = new Date("2026-05-21T18:30:00.000Z");

describe("DynamoMessageReader.markRead", () => {
  it("returns not_found when no row matches the message_id on GSI1", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [] };
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markRead("<missing@example.com>", NOW);
    expect(result).toEqual({ kind: "not_found" });
  });

  it("issues a conditional UpdateItem on the resolved primary key and returns marked", async () => {
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01HF7E0000000000000000READ1",
              // attribute-absent: GSI1 projects whatever the table has; for an
              // unread row read_at is missing.
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return {};
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markRead("<msg-1@example.com>", NOW);

    expect(result).toEqual({
      kind: "marked",
      read_at: "2026-05-21T18:30:00.000Z",
    });
    expect(updates).toHaveLength(1);
    const u = updates[0]!;
    expect(u.input.TableName).toBe(TABLES.messagesTable);
    expect(u.input.Key).toEqual({
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000READ1",
    });
    expect(u.input.UpdateExpression).toBe("SET read_at = :now");
    // Two guards on the conditional:
    //   - attribute_exists(address) → don't create a phantom row when the PK
    //     is stale.
    //   - attribute_not_exists(read_at) → first-open wins; second open is a
    //     no-op.
    expect(u.input.ConditionExpression).toBe(
      "attribute_exists(#addr) AND attribute_not_exists(read_at)",
    );
    expect(u.input.ExpressionAttributeNames).toEqual({ "#addr": "address" });
    expect(u.input.ExpressionAttributeValues).toEqual({
      ":now": "2026-05-21T18:30:00.000Z",
    });
  });

  it("returns already_read using the GSI-projected read_at when the conditional fails", async () => {
    // The GSI1 projection includes read_at, so a row that was already stamped
    // can be reported without an extra Get.
    const existingReadAt = "2026-05-21T17:00:00.000Z";
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01HF7E0000000000000000READ2",
              read_at: existingReadAt,
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        });
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markRead("<msg-1@example.com>", NOW);
    expect(result).toEqual({ kind: "already_read", read_at: existingReadAt });
  });

  it("falls back to a Get when the conditional fails and the GSI projection is stale", async () => {
    // Eventually-consistent GSI: write happened, GSI hasn't caught up. Re-Get
    // the base row to surface the freshly-stamped read_at.
    const stampedAt = "2026-05-21T17:55:00.000Z";
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01HF7E0000000000000000READ3",
              // read_at attribute-absent on the stale GSI snapshot.
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        });
      }
      if (cmd instanceof GetCommand) {
        return { Item: { read_at: stampedAt } };
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markRead("<msg-1@example.com>", NOW);
    expect(result).toEqual({ kind: "already_read", read_at: stampedAt });
  });

  it("markReadByPrimaryKey: skips the GSI hop and writes the same conditional UpdateItem", async () => {
    const updates: UpdateCommand[] = [];
    const queries: QueryCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queries.push(cmd);
        return { Items: [] };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return {};
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markReadByPrimaryKey(
      "alice@acme.com",
      "01HF7E0000000000000000READ4",
      NOW,
    );

    expect(result).toEqual({
      kind: "marked",
      read_at: "2026-05-21T18:30:00.000Z",
    });
    expect(queries).toHaveLength(0);
    expect(updates).toHaveLength(1);
    const u = updates[0]!;
    expect(u.input.Key).toEqual({
      address: "alice@acme.com",
      internal_id: "01HF7E0000000000000000READ4",
    });
    expect(u.input.ConditionExpression).toBe(
      "attribute_exists(#addr) AND attribute_not_exists(read_at)",
    );
  });

  it("markReadByPrimaryKey: returns not_found when the conditional fails and the row is missing", async () => {
    // Stale PK from the inbox — the row was deleted between list and click.
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        });
      }
      if (cmd instanceof GetCommand) {
        return {}; // no Item
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markReadByPrimaryKey(
      "alice@acme.com",
      "01HF7E0000000000000000GONE0",
      NOW,
    );
    expect(result).toEqual({ kind: "not_found" });
  });

  it("markReadByPrimaryKey: returns already_read on second open without a write churn", async () => {
    const stampedAt = "2026-05-21T17:00:00.000Z";
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        });
      }
      if (cmd instanceof GetCommand) {
        return { Item: { read_at: stampedAt } };
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markReadByPrimaryKey(
      "alice@acme.com",
      "01HF7E0000000000000000READ5",
      NOW,
    );
    expect(result).toEqual({ kind: "already_read", read_at: stampedAt });
    expect(updates).toHaveLength(1);
  });

  it("queries the GSI by message_id verbatim and projects only fields markRead needs", async () => {
    const queries: QueryCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queries.push(cmd);
        return { Items: [] };
      }
      throw new Error(`unexpected: ${cmd?.constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.markRead("<msg-bracketed@example.com>", NOW);

    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.input.IndexName).toBe(TABLES.messageIdGsiName);
    expect(q.input.ExpressionAttributeValues).toEqual({
      ":mid": "<msg-bracketed@example.com>",
    });
    // Project only what the write+fallback paths need — keeps the GSI hop at
    // ~one RCU.
    expect(q.input.ProjectionExpression).toBe("address, internal_id, read_at");
    expect(q.input.Limit).toBe(1);
  });
});
