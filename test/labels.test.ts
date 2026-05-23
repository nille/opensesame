import { describe, expect, it, vi } from "vitest";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { makeDynamoMessageReader } from "../src/aws/dynamodb-reader.js";

// ADR-0037 (slice 8.17). Operator-defined labels.
//
// Catalog rows live under SK prefix "LABEL#<lowercased>" with kind: "label";
// row-level membership is a DynamoDB String Set on Messages rows. The
// reader exposes:
//   - addThreadLabel / removeThreadLabel: ThreadIdGSI fan-out, ADD/DELETE on SS
//   - listLabels: Query catalog SK prefix, project to LabelCatalogEntry[]
//   - createLabel / renameLabel: conditional Put → null on conflict (→ 409)
//   - deleteLabel: idempotent catalog Delete + bulk strip across rows
//
// The bulk strip (rename, delete) caps at MAX_RENAME_FANOUT (1000); past
// that, `incomplete: true` on the wire and the operator can re-call.

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

describe("DynamoMessageReader.addThreadLabel (ADR-0037)", () => {
  it("fans out ADD #labels :{value} on every row in the thread and echoes lead-row labels", async () => {
    const updates: UpdateCommand[] = [];
    let gsiQuery: QueryCommand | null = null;
    let leadGet: GetCommand | null = null;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        gsiQuery = cmd;
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
      if (cmd instanceof GetCommand) {
        leadGet = cmd;
        return { Item: { labels: ["important", "work"] } };
      }
      throw new Error(
        `unexpected: ${(cmd as { constructor: { name: string } }).constructor.name}`,
      );
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.addThreadLabel(
      { thread_id: "<root@example.com>", label: "Work" },
      NOW,
    );

    expect(gsiQuery).not.toBeNull();
    expect(gsiQuery!.input.IndexName).toBe(TABLES.threadIdGsiName);
    expect(gsiQuery!.input.KeyConditionExpression).toBe("thread_id = :tid");
    expect(gsiQuery!.input.ExpressionAttributeValues).toEqual({
      ":tid": "<root@example.com>",
    });

    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.input.TableName).toBe(TABLES.messagesTable);
      expect(u.input.UpdateExpression).toBe("ADD #attr :val");
      expect(u.input.ConditionExpression).toBe("attribute_exists(#addr)");
      expect(u.input.ExpressionAttributeNames).toEqual({
        "#addr": "address",
        "#attr": "labels",
      });
      const val = (u.input.ExpressionAttributeValues as Record<string, unknown>)[
        ":val"
      ];
      expect(val).toBeInstanceOf(Set);
      // Catalog identity is the lowercased form.
      expect(Array.from(val as Set<string>)).toEqual(["work"]);
    }

    expect(leadGet).not.toBeNull();
    expect(leadGet!.input.ProjectionExpression).toBe("labels");

    expect(result).toEqual({
      thread_id: "<root@example.com>",
      label: "work",
      labels: ["important", "work"],
      updated_count: 2,
    });
  });

  it("returns updated_count: 0 with [label] echo on an empty thread (no GSI rows)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [] };
      if (cmd instanceof UpdateCommand) {
        throw new Error("should not have written when GSI was empty");
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.addThreadLabel(
      { thread_id: "<orphan@example.com>", label: "todo" },
      NOW,
    );

    expect(result).toEqual({
      thread_id: "<orphan@example.com>",
      label: "todo",
      labels: ["todo"],
      updated_count: 0,
    });
  });

  it("survives per-row ConditionalCheckFailed (phantom row) and counts only successes", async () => {
    let queryCount = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queryCount += 1;
        if (queryCount === 1) {
          return {
            Items: [
              { address: "alice@acme.com", internal_id: "01KS500000000000000000A001" },
              { address: "alice@acme.com", internal_id: "01KS500000000000000000A002" },
              { address: "alice@acme.com", internal_id: "01KS500000000000000000A003" },
            ],
          };
        }
        // The second query is the lead-row read-back inside readLeadRowLabels.
        return {
          Items: [
            { address: "alice@acme.com", internal_id: "01KS500000000000000000A001" },
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
      if (cmd instanceof GetCommand) {
        return { Item: { labels: ["work"] } };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.addThreadLabel(
      { thread_id: "<root@example.com>", label: "work" },
      NOW,
    );

    expect(result.updated_count).toBe(2);
    expect(result.labels).toEqual(["work"]);
  });
});

describe("DynamoMessageReader.removeThreadLabel (ADR-0037)", () => {
  it("fans out DELETE #labels :{value} on every row and echoes lead-row post-state", async () => {
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
      if (cmd instanceof GetCommand) {
        return { Item: { labels: ["important"] } };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.removeThreadLabel(
      { thread_id: "<root@example.com>", label: "Work" },
      NOW,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.UpdateExpression).toBe("DELETE #attr :val");
    const val = (updates[0]!.input.ExpressionAttributeValues as Record<
      string,
      unknown
    >)[":val"];
    expect(Array.from(val as Set<string>)).toEqual(["work"]);

    expect(result).toEqual({
      thread_id: "<root@example.com>",
      label: "work",
      labels: ["important"],
      updated_count: 1,
    });
  });

  it("returns labels: [] on an empty thread (no fallback singleton)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [] };
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.removeThreadLabel(
      { thread_id: "<orphan@example.com>", label: "todo" },
      NOW,
    );
    expect(result).toEqual({
      thread_id: "<orphan@example.com>",
      label: "todo",
      labels: [],
      updated_count: 0,
    });
  });
});

describe("DynamoMessageReader.listLabels (ADR-0037)", () => {
  it("queries the address partition under LABEL# prefix and projects catalog rows sorted by display_name", async () => {
    let captured: QueryCommand | null = null;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        captured = cmd;
        return {
          Items: [
            {
              address: "alice@acme.com",
              internal_id: "LABEL#zeta",
              kind: "label",
              label: "zeta",
              display_name: "Zeta",
              created_at: "2026-05-20T00:00:00.000Z",
            },
            {
              address: "alice@acme.com",
              internal_id: "LABEL#alpha",
              kind: "label",
              label: "alpha",
              display_name: "Alpha",
              created_at: "2026-05-21T00:00:00.000Z",
            },
            // Non-label row that happens to leak into the page (defensive
            // — the SK prefix should already exclude this, but the
            // projector drops it regardless of the wire shape).
            {
              address: "alice@acme.com",
              internal_id: "DRAFT#01KS500000000000000000DR01",
              kind: "draft",
              draft_id: "01KS500000000000000000DR01",
            },
          ],
        };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listLabels({ address: "alice@acme.com" });

    expect(captured).not.toBeNull();
    expect(captured!.input.TableName).toBe(TABLES.messagesTable);
    expect(captured!.input.IndexName).toBeUndefined();
    expect(captured!.input.KeyConditionExpression).toBe(
      "address = :addr AND begins_with(internal_id, :pfx)",
    );
    expect(captured!.input.ExpressionAttributeValues).toEqual({
      ":addr": "alice@acme.com",
      ":pfx": "LABEL#",
    });

    expect(result).toEqual({
      labels: [
        {
          label: "alpha",
          display_name: "Alpha",
          created_at: "2026-05-21T00:00:00.000Z",
        },
        {
          label: "zeta",
          display_name: "Zeta",
          created_at: "2026-05-20T00:00:00.000Z",
        },
      ],
    });
  });

  it("returns empty when no catalog rows exist for the address", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [] };
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.listLabels({ address: "alice@acme.com" });
    expect(result).toEqual({ labels: [] });
  });

  it("falls back display_name → label when the row has no display_name", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              kind: "label",
              label: "todo",
              created_at: "2026-05-21T00:00:00.000Z",
            },
          ],
        };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.listLabels({ address: "alice@acme.com" });
    expect(result.labels[0]).toEqual({
      label: "todo",
      display_name: "todo",
      created_at: "2026-05-21T00:00:00.000Z",
    });
  });
});

describe("DynamoMessageReader.createLabel (ADR-0037)", () => {
  it("PUTs the catalog row with attribute_not_exists guard and lowercased label key", async () => {
    const puts: PutCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof PutCommand) {
        puts.push(cmd);
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.createLabel(
      { address: "alice@acme.com", label: "Work" },
      NOW,
    );

    expect(puts).toHaveLength(1);
    expect(puts[0]!.input.ConditionExpression).toBe(
      "attribute_not_exists(internal_id)",
    );
    expect(puts[0]!.input.Item).toEqual({
      address: "alice@acme.com",
      internal_id: "LABEL#work",
      schema_v: "1",
      kind: "label",
      label: "work",
      display_name: "Work",
      created_at: "2026-05-22T10:00:00.000Z",
    });

    expect(result).toEqual({
      label: "work",
      display_name: "Work",
      created_at: "2026-05-22T10:00:00.000Z",
    });
  });

  it("returns null when the catalog row already exists (ConditionalCheckFailed → 409 in dispatcher)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof PutCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "exists",
        });
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.createLabel(
      { address: "alice@acme.com", label: "Work" },
      NOW,
    );

    expect(result).toBeNull();
  });
});

describe("DynamoMessageReader.deleteLabel (ADR-0037)", () => {
  it("deletes the catalog row and strips the label off every row that carried it", async () => {
    const deletes: DeleteCommand[] = [];
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof DeleteCommand) {
        deletes.push(cmd);
        return {};
      }
      if (cmd instanceof QueryCommand) {
        // Bulk strip query — paged scan over address partition.
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
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.deleteLabel({
      address: "alice@acme.com",
      label: "Work",
    });

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Key).toEqual({
      address: "alice@acme.com",
      internal_id: "LABEL#work",
    });

    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.input.UpdateExpression).toBe("DELETE #labels :old");
      const old = (u.input.ExpressionAttributeValues as Record<string, unknown>)[
        ":old"
      ];
      expect(Array.from(old as Set<string>)).toEqual(["work"]);
    }

    expect(result).toEqual({
      label: "work",
      updated_row_count: 2,
      incomplete: false,
    });
  });

  it("is idempotent against a missing catalog row (no throw, strip still runs)", async () => {
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof DeleteCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "no row",
        });
      }
      if (cmd instanceof QueryCommand) {
        return { Items: [] };
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

    const result = await reader.deleteLabel({
      address: "alice@acme.com",
      label: "Work",
    });

    expect(updates).toHaveLength(0);
    expect(result).toEqual({
      label: "work",
      updated_row_count: 0,
      incomplete: false,
    });
  });
});

describe("DynamoMessageReader.renameLabel (ADR-0037)", () => {
  it("PUTs the new catalog row, deletes the old, and rewrites every row's set in place", async () => {
    const puts: PutCommand[] = [];
    const deletes: DeleteCommand[] = [];
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof PutCommand) {
        puts.push(cmd);
        return {};
      }
      if (cmd instanceof DeleteCommand) {
        deletes.push(cmd);
        return {};
      }
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

    const result = await reader.renameLabel(
      { address: "alice@acme.com", from: "Work", to: "Career" },
      NOW,
    );

    expect(puts).toHaveLength(1);
    expect(puts[0]!.input.Item).toMatchObject({
      address: "alice@acme.com",
      internal_id: "LABEL#career",
      kind: "label",
      label: "career",
      display_name: "Career",
    });

    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Key).toEqual({
      address: "alice@acme.com",
      internal_id: "LABEL#work",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.UpdateExpression).toBe(
      "DELETE #labels :old ADD #labels :new",
    );
    const v = updates[0]!.input.ExpressionAttributeValues as Record<
      string,
      unknown
    >;
    expect(Array.from(v[":old"] as Set<string>)).toEqual(["work"]);
    expect(Array.from(v[":new"] as Set<string>)).toEqual(["career"]);

    expect(result).toEqual({
      from: "work",
      to: "career",
      updated_row_count: 1,
      incomplete: false,
    });
  });

  it("returns null when the destination catalog row already exists (ConditionalCheckFailed)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof PutCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "exists",
        });
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.renameLabel(
      { address: "alice@acme.com", from: "Work", to: "Career" },
      NOW,
    );

    expect(result).toBeNull();
  });

  it("short-circuits same-key rename to a 0-count no-op (defensive — BFF schema rejects this too)", async () => {
    const client = makeStubClient(async () => {
      throw new Error("should not be called");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.renameLabel(
      { address: "alice@acme.com", from: "Work", to: "WORK" },
      NOW,
    );
    expect(result).toEqual({
      from: "work",
      to: "work",
      updated_row_count: 0,
      incomplete: false,
    });
  });
});
