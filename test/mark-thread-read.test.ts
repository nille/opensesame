import { describe, expect, it, vi } from "vitest";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// mark_thread_read (ADR-0031) is a fan-out write: Query ThreadIdGSI for every
// row in the thread, filter to inbound-only, then per-row conditional
// UpdateItem to SET/REMOVE read_at. Outbound rows are skipped server-side
// (operator can't be "unread" on a message they sent), so the
// ProjectionExpression must include `direction` and a row predicate is
// applied before the fan-out.

const TABLES = {
  messagesTable: "Messages-test",
  bodyChunksTable: "MessageBodyChunks-test",
  messageIdGsiName: "MessageIdGSI",
  threadIdGsiName: "ThreadIdGSI",
} as const;

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(
  responder: (cmd: unknown) => Promise<unknown>,
): StubClient {
  return { send: vi.fn(responder) };
}

const NOW = new Date("2026-05-22T10:00:00.000Z");

describe("DynamoMessageReader.markThreadRead (ADR-0031)", () => {
  it("queries ThreadIdGSI projecting direction and stamps read_at on every inbound row", async () => {
    const updates: UpdateCommand[] = [];
    let queryInput: Record<string, unknown> | null = null;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queryInput = cmd.input as Record<string, unknown>;
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A001",
              direction: "in",
            },
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A002",
              direction: "in",
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return {};
      }
      throw new Error(
        `unexpected: ${(cmd as { constructor: { name: string } }).constructor.name}`,
      );
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markThreadRead(
      { thread_id: "<root@example.com>", read: true },
      NOW,
    );

    expect(queryInput).not.toBeNull();
    expect(queryInput!["TableName"]).toBe(TABLES.messagesTable);
    expect(queryInput!["IndexName"]).toBe(TABLES.threadIdGsiName);
    expect(queryInput!["KeyConditionExpression"]).toBe("thread_id = :tid");
    expect(queryInput!["ExpressionAttributeValues"]).toEqual({
      ":tid": "<root@example.com>",
    });
    // Direction needs to come back from the GSI so we can filter inbound-only
    // before fanning out UpdateItems.
    expect(queryInput!["ProjectionExpression"]).toContain("direction");

    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.input.TableName).toBe(TABLES.messagesTable);
      expect(u.input.UpdateExpression).toBe("SET #attr = :val");
      expect(u.input.ConditionExpression).toBe("attribute_exists(#addr)");
      expect(u.input.ExpressionAttributeNames).toEqual({
        "#addr": "address",
        "#attr": "read_at",
      });
      expect(u.input.ExpressionAttributeValues).toEqual({
        ":val": "2026-05-22T10:00:00.000Z",
      });
    }
    expect(result).toEqual({
      thread_id: "<root@example.com>",
      read: true,
      read_at: "2026-05-22T10:00:00.000Z",
      updated_count: 2,
    });
  });

  it("issues REMOVE read_at on every inbound row when marking unread", async () => {
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A001",
              direction: "in",
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markThreadRead(
      { thread_id: "<root@example.com>", read: false },
      NOW,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.UpdateExpression).toBe("REMOVE #attr");
    expect(updates[0]!.input.ConditionExpression).toBe(
      "attribute_exists(#addr)",
    );
    expect(updates[0]!.input.ExpressionAttributeNames).toEqual({
      "#addr": "address",
      "#attr": "read_at",
    });
    expect(updates[0]!.input.ExpressionAttributeValues).toBeUndefined();
    expect(result).toEqual({
      thread_id: "<root@example.com>",
      read: false,
      read_at: null,
      updated_count: 1,
    });
  });

  it("skips outbound rows: only inbound rows receive an UpdateItem", async () => {
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A001",
              direction: "in",
            },
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A002",
              direction: "out",
            },
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A003",
              direction: "in",
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markThreadRead(
      { thread_id: "<root@example.com>", read: true },
      NOW,
    );

    expect(updates).toHaveLength(2);
    const ids = updates.map((u) => u.input.Key?.["internal_id"]).sort();
    expect(ids).toEqual([
      "01KS500000000000000000A001",
      "01KS500000000000000000A003",
    ]);
    expect(result.updated_count).toBe(2);
  });

  it("returns updated_count: 0 when the thread is outbound-only (no fan-out)", async () => {
    let updateCount = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A001",
              direction: "out",
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        updateCount += 1;
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markThreadRead(
      { thread_id: "<sent-only@example.com>", read: true },
      NOW,
    );

    expect(updateCount).toBe(0);
    expect(result).toEqual({
      thread_id: "<sent-only@example.com>",
      read: true,
      read_at: "2026-05-22T10:00:00.000Z",
      updated_count: 0,
    });
  });

  it("returns updated_count: 0 when ThreadIdGSI yields no rows (empty thread)", async () => {
    let updateCount = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [] };
      if (cmd instanceof UpdateCommand) {
        updateCount += 1;
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markThreadRead(
      { thread_id: "<orphan@example.com>", read: true },
      NOW,
    );

    expect(updateCount).toBe(0);
    expect(result.updated_count).toBe(0);
  });

  it("caps the GSI query at MAX_THREAD_LIMIT (200) — bounded write cost", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        captured = cmd.input as Record<string, unknown>;
        return { Items: [] };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    await reader.markThreadRead(
      { thread_id: "<huge@example.com>", read: true },
      NOW,
    );
    expect(captured).not.toBeNull();
    expect(captured!["Limit"]).toBe(200);
  });

  it("tolerates per-row ConditionalCheckFailed (phantom row) but counts the survivors", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A001",
              direction: "in",
            },
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A002",
              direction: "in",
            },
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A003",
              direction: "in",
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        if (cmd.input.Key?.["internal_id"] === "01KS500000000000000000A002") {
          throw new ConditionalCheckFailedException({
            $metadata: {},
            message: "row gone",
          });
        }
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.markThreadRead(
      { thread_id: "<root@example.com>", read: true },
      NOW,
    );

    expect(result.updated_count).toBe(2);
    expect(result.read_at).toBe("2026-05-22T10:00:00.000Z");
  });

  it("propagates non-conditional errors (e.g. throttling) instead of swallowing them", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "01KS500000000000000000A001",
              direction: "in",
            },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        throw new Error("ProvisionedThroughputExceeded");
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await expect(
      reader.markThreadRead(
        { thread_id: "<root@example.com>", read: true },
        NOW,
      ),
    ).rejects.toThrow("ProvisionedThroughputExceeded");
  });
});
