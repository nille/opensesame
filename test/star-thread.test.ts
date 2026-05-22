import { describe, expect, it, vi } from "vitest";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// star_thread (ADR-0028) is a fan-out write: Query ThreadIdGSI for every row
// in the thread, then per-row conditional UpdateItem to SET/REMOVE starred_at.
// The conditional `attribute_exists(#addr)` guards against phantom rows from
// stale GSI projections; ConditionalCheckFailed is tolerated per-row.

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

describe("DynamoMessageReader.starThread (ADR-0028)", () => {
  it("queries ThreadIdGSI and stamps starred_at on every row in the thread", async () => {
    const updates: UpdateCommand[] = [];
    let queryInput: Record<string, unknown> | null = null;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queryInput = cmd.input as Record<string, unknown>;
        return {
          Items: [
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A001" },
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A002" },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return {};
      }
      throw new Error(`unexpected: ${(cmd as { constructor: { name: string } }).constructor.name}`);
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.starThread(
      { thread_id: "<root@example.com>", starred: true },
      NOW,
    );

    expect(queryInput).not.toBeNull();
    expect(queryInput!["TableName"]).toBe(TABLES.messagesTable);
    expect(queryInput!["IndexName"]).toBe(TABLES.threadIdGsiName);
    expect(queryInput!["KeyConditionExpression"]).toBe("thread_id = :tid");
    expect(queryInput!["ExpressionAttributeValues"]).toEqual({
      ":tid": "<root@example.com>",
    });
    expect(queryInput!["ProjectionExpression"]).toBe("address, internal_id");

    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.input.TableName).toBe(TABLES.messagesTable);
      expect(u.input.UpdateExpression).toBe("SET starred_at = :now");
      expect(u.input.ConditionExpression).toBe("attribute_exists(#addr)");
      expect(u.input.ExpressionAttributeNames).toEqual({ "#addr": "address" });
      expect(u.input.ExpressionAttributeValues).toEqual({
        ":now": "2026-05-22T10:00:00.000Z",
      });
    }
    expect(result).toEqual({
      thread_id: "<root@example.com>",
      starred: true,
      starred_at: "2026-05-22T10:00:00.000Z",
      updated_count: 2,
    });
  });

  it("issues REMOVE starred_at on every row when unstarring", async () => {
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A001" },
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

    const result = await reader.starThread(
      { thread_id: "<root@example.com>", starred: false },
      NOW,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.UpdateExpression).toBe("REMOVE starred_at");
    expect(updates[0]!.input.ConditionExpression).toBe(
      "attribute_exists(#addr)",
    );
    // No :now binding for REMOVE.
    expect(updates[0]!.input.ExpressionAttributeValues).toBeUndefined();
    expect(result).toEqual({
      thread_id: "<root@example.com>",
      starred: false,
      starred_at: null,
      updated_count: 1,
    });
  });

  it("returns updated_count: 0 when ThreadIdGSI yields no rows (empty thread)", async () => {
    // Stale inbox-window rollups can call star on a thread whose only row was
    // deleted. The dispatcher returns 200 with 0 — UI can swallow as no-op.
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

    const result = await reader.starThread(
      { thread_id: "<orphan@example.com>", starred: true },
      NOW,
    );

    expect(updateCount).toBe(0);
    expect(result).toEqual({
      thread_id: "<orphan@example.com>",
      starred: true,
      starred_at: "2026-05-22T10:00:00.000Z",
      updated_count: 0,
    });
  });

  it("caps the GSI query at MAX_STAR_FAN_OUT (200) — bounded write cost", async () => {
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
    await reader.starThread(
      { thread_id: "<huge@example.com>", starred: true },
      NOW,
    );
    expect(captured).not.toBeNull();
    expect(captured!["Limit"]).toBe(200);
  });

  it("tolerates per-row ConditionalCheckFailed (phantom row) but counts the survivors", async () => {
    // Stale GSI projection can include a row that's been deleted out from
    // under us. attribute_exists(#addr) makes the conditional fail; the
    // adapter swallows that one row and finishes the rest.
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A001" },
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A002" },
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A003" },
          ],
        };
      }
      if (cmd instanceof UpdateCommand) {
        // Second row is the phantom — fail the conditional only there.
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

    const result = await reader.starThread(
      { thread_id: "<root@example.com>", starred: true },
      NOW,
    );

    expect(result.updated_count).toBe(2);
    expect(result.starred_at).toBe("2026-05-22T10:00:00.000Z");
  });

  it("propagates non-conditional errors (e.g. throttling) instead of swallowing them", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A001" },
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
      reader.starThread(
        { thread_id: "<root@example.com>", starred: true },
        NOW,
      ),
    ).rejects.toThrow("ProvisionedThroughputExceeded");
  });
});
