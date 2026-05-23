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

// ADR-0035 (slice 8.17): drafts share the address partition with messages
// but live under SK prefix "DRAFT#" with a `kind: "draft"` marker. The
// reader exposes saveDraft / listDrafts / getDraft / deleteDraft. None of
// these read the body chunks table — drafts inline body_text on the row.

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

function fixedUlid(values: string[]): () => string {
  let i = 0;
  return () => {
    const v = values[i] ?? values[values.length - 1]!;
    i += 1;
    return v;
  };
}

const NOW = new Date("2026-05-22T10:00:00.000Z");

describe("DynamoMessageReader.saveDraft (ADR-0035)", () => {
  it("first save: mints a ULID and PUTs with attribute_not_exists guard", async () => {
    const puts: PutCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof PutCommand) {
        puts.push(cmd);
        return {};
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
      makeUlid: fixedUlid(["01KS500000000000000000DR01"]),
    });

    const result = await reader.saveDraft(
      {
        address: "alice@acme.com",
        draft_id: null,
        body_text: "Hello world",
        subject: "WIP",
      },
      NOW,
    );

    expect(result).toEqual({
      draft_id: "01KS500000000000000000DR01",
      created_at: "2026-05-22T10:00:00.000Z",
      updated_at: "2026-05-22T10:00:00.000Z",
    });
    expect(puts).toHaveLength(1);
    const p = puts[0]!;
    expect(p.input.TableName).toBe(TABLES.messagesTable);
    expect(p.input.ConditionExpression).toBe(
      "attribute_not_exists(internal_id)",
    );
    expect(p.input.Item).toMatchObject({
      address: "alice@acme.com",
      internal_id: "DRAFT#01KS500000000000000000DR01",
      kind: "draft",
      schema_v: "1",
      draft_id: "01KS500000000000000000DR01",
      body_text: "Hello world",
      subject: "WIP",
      to: null,
      cc: null,
      in_reply_to: null,
      references: null,
      created_at: "2026-05-22T10:00:00.000Z",
      updated_at: "2026-05-22T10:00:00.000Z",
    });
  });

  it("first save: throws if makeUlid was not wired in deps", async () => {
    const client = makeStubClient(async () => ({}));
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    await expect(
      reader.saveDraft(
        { address: "alice@acme.com", draft_id: null, body_text: "x" },
        NOW,
      ),
    ).rejects.toThrow(/makeUlid/);
  });

  it("first save: retries once with a fresh ULID on a ConditionalCheckFailed", async () => {
    let calls = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof PutCommand) {
        calls += 1;
        if (calls === 1) {
          throw new ConditionalCheckFailedException({
            $metadata: {},
            message: "collision",
          });
        }
        return {};
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
      makeUlid: fixedUlid([
        "01KS500000000000000000DR01",
        "01KS500000000000000000DR02",
      ]),
    });

    const result = await reader.saveDraft(
      { address: "alice@acme.com", draft_id: null, body_text: "Hi" },
      NOW,
    );
    expect(result?.draft_id).toBe("01KS500000000000000000DR02");
    expect(calls).toBe(2);
  });

  it("upsert: UpdateCommand with kind=draft guard, then GET created_at", async () => {
    const updates: UpdateCommand[] = [];
    const gets: GetCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return { Attributes: {} };
      }
      if (cmd instanceof GetCommand) {
        gets.push(cmd);
        return { Item: { created_at: "2026-05-22T09:00:00.000Z" } };
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.saveDraft(
      {
        address: "alice@acme.com",
        draft_id: "01KS500000000000000000DR01",
        body_text: "Updated body",
        subject: "Updated subject",
      },
      NOW,
    );

    expect(result).toEqual({
      draft_id: "01KS500000000000000000DR01",
      created_at: "2026-05-22T09:00:00.000Z",
      updated_at: "2026-05-22T10:00:00.000Z",
    });
    expect(updates).toHaveLength(1);
    const u = updates[0]!;
    expect(u.input.TableName).toBe(TABLES.messagesTable);
    expect(u.input.Key).toEqual({
      address: "alice@acme.com",
      internal_id: "DRAFT#01KS500000000000000000DR01",
    });
    // The kind-guard prevents the upsert from accidentally writing to a
    // non-draft row at DRAFT#... (impossible by construction but cheap).
    expect(u.input.ConditionExpression).toBe(
      "attribute_exists(address) AND #kind = :draft",
    );
    expect(u.input.ExpressionAttributeNames).toMatchObject({
      "#kind": "kind",
      "#subject": "subject",
    });
    expect(String(u.input.UpdateExpression)).toMatch(
      /body_text\s*=\s*:body_text/,
    );
    expect(String(u.input.UpdateExpression)).toMatch(
      /#subject\s*=\s*:subject/,
    );
    // No to/cc/in_reply_to/references in the input → those slots untouched.
    expect(String(u.input.UpdateExpression)).not.toMatch(/#to\s*=/);
    expect(String(u.input.UpdateExpression)).not.toMatch(/#cc\s*=/);
    expect(gets).toHaveLength(1);
  });

  it("upsert: explicit null on optional field clears it (SET #to = :to with :to = null)", async () => {
    const updates: UpdateCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        return { Attributes: {} };
      }
      if (cmd instanceof GetCommand) {
        return { Item: { created_at: "2026-05-22T09:00:00.000Z" } };
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    await reader.saveDraft(
      {
        address: "alice@acme.com",
        draft_id: "01KS500000000000000000DR01",
        body_text: "x",
        to: null,
      },
      NOW,
    );

    const u = updates[0]!;
    expect(String(u.input.UpdateExpression)).toMatch(/#to\s*=\s*:to/);
    expect(
      (u.input.ExpressionAttributeValues as Record<string, unknown>)[":to"],
    ).toBeNull();
  });

  it("upsert: returns null when the row is gone (deleted from another tab)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "row missing",
        });
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.saveDraft(
      {
        address: "alice@acme.com",
        draft_id: "01KS500000000000000000DR01",
        body_text: "x",
      },
      NOW,
    );
    expect(result).toBeNull();
  });
});

describe("DynamoMessageReader.listDrafts", () => {
  it("queries the address partition under DRAFT# prefix, newest-first", async () => {
    const queries: QueryCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queries.push(cmd);
        return {
          Items: [
            {
              kind: "draft",
              schema_v: "1",
              address: "alice@acme.com",
              draft_id: "01KS500000000000000000DR02",
              internal_id: "DRAFT#01KS500000000000000000DR02",
              body_text: "newer",
              created_at: "2026-05-22T09:00:00.000Z",
              updated_at: "2026-05-22T10:00:00.000Z",
            },
            {
              kind: "draft",
              schema_v: "1",
              address: "alice@acme.com",
              draft_id: "01KS500000000000000000DR01",
              internal_id: "DRAFT#01KS500000000000000000DR01",
              body_text: "older",
              created_at: "2026-05-22T08:00:00.000Z",
              updated_at: "2026-05-22T08:30:00.000Z",
            },
          ],
        };
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });

    const result = await reader.listDrafts({
      address: "alice@acme.com",
      limit: 50,
    });

    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.input.TableName).toBe(TABLES.messagesTable);
    expect(q.input.IndexName).toBeUndefined();
    expect(q.input.ScanIndexForward).toBe(false);
    expect(q.input.KeyConditionExpression).toBe(
      "address = :addr AND begins_with(internal_id, :pfx)",
    );
    expect(q.input.ExpressionAttributeValues).toEqual({
      ":addr": "alice@acme.com",
      ":pfx": "DRAFT#",
    });
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]!.body_text).toBe("newer");
    expect(result.drafts[1]!.body_text).toBe("older");
    expect(result.next_cursor).toBeNull();
  });

  it("propagates LastEvaluatedKey as next_cursor (opaque base64)", async () => {
    const lek = {
      address: "alice@acme.com",
      internal_id: "DRAFT#01KS500000000000000000DR01",
    };
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return { Items: [], LastEvaluatedKey: lek };
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.listDrafts({
      address: "alice@acme.com",
      limit: 1,
    });
    expect(result.next_cursor).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(result.next_cursor!, "base64").toString("utf-8"),
    );
    expect(decoded).toEqual(lek);
  });

  it("silently drops corrupt rows (missing required fields)", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            // valid
            {
              kind: "draft",
              schema_v: "1",
              address: "alice@acme.com",
              draft_id: "01KS500000000000000000DR02",
              body_text: "ok",
              created_at: "2026-05-22T09:00:00.000Z",
              updated_at: "2026-05-22T10:00:00.000Z",
            },
            // missing draft_id
            {
              kind: "draft",
              schema_v: "1",
              address: "alice@acme.com",
              body_text: "broken",
              created_at: "2026-05-22T09:00:00.000Z",
              updated_at: "2026-05-22T10:00:00.000Z",
            },
            // wrong kind — not a draft (defense in depth against the prefix
            // colliding with a non-draft row).
            {
              kind: "message",
              schema_v: "1",
              address: "alice@acme.com",
              draft_id: "x",
              body_text: "y",
              created_at: "2026-05-22T09:00:00.000Z",
              updated_at: "2026-05-22T10:00:00.000Z",
            },
          ],
        };
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.listDrafts({
      address: "alice@acme.com",
      limit: 50,
    });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.body_text).toBe("ok");
  });
});

describe("DynamoMessageReader.getDraft", () => {
  it("returns the projected draft when the row exists", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) {
        return {
          Item: {
            kind: "draft",
            schema_v: "1",
            address: "alice@acme.com",
            draft_id: "01KS500000000000000000DR01",
            internal_id: "DRAFT#01KS500000000000000000DR01",
            body_text: "hi",
            to: "bob@example.com",
            cc: null,
            subject: "Re: Q2",
            in_reply_to: null,
            references: null,
            created_at: "2026-05-22T09:00:00.000Z",
            updated_at: "2026-05-22T10:00:00.000Z",
          },
        };
      }
      throw new Error("unexpected command");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const draft = await reader.getDraft({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
    });
    expect(draft).not.toBeNull();
    expect(draft!.body_text).toBe("hi");
    expect(draft!.to).toBe("bob@example.com");
    expect(draft!.subject).toBe("Re: Q2");
  });

  it("returns null when the row is missing", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) return {};
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const draft = await reader.getDraft({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DRXX",
    });
    expect(draft).toBeNull();
  });
});

describe("DynamoMessageReader.deleteDraft", () => {
  it("deletes a draft row and reports deleted: true", async () => {
    const deletes: DeleteCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) {
        return { Item: { kind: "draft" } };
      }
      if (cmd instanceof DeleteCommand) {
        deletes.push(cmd);
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.deleteDraft({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DR01",
    });
    expect(result).toEqual({
      draft_id: "01KS500000000000000000DR01",
      deleted: true,
    });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Key).toEqual({
      address: "alice@acme.com",
      internal_id: "DRAFT#01KS500000000000000000DR01",
    });
    expect(deletes[0]!.input.ConditionExpression).toBe("#kind = :draft");
  });

  it("is idempotent on a missing row — reports deleted: false without firing a delete", async () => {
    let deletes = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) return {};
      if (cmd instanceof DeleteCommand) {
        deletes += 1;
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.deleteDraft({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DRXX",
    });
    expect(result).toEqual({
      draft_id: "01KS500000000000000000DRXX",
      deleted: false,
    });
    expect(deletes).toBe(0);
  });

  it("refuses to delete a non-draft row at DRAFT#... — reports deleted: false", async () => {
    let deletes = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof GetCommand) {
        return { Item: { kind: "message" } };
      }
      if (cmd instanceof DeleteCommand) {
        deletes += 1;
        return {};
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    const result = await reader.deleteDraft({
      address: "alice@acme.com",
      draft_id: "01KS500000000000000000DRXX",
    });
    expect(result.deleted).toBe(false);
    expect(deletes).toBe(0);
  });
});

describe("draft exclusion from inbox + search", () => {
  it("listInbox carries NOT begins_with(internal_id, :draft_pfx) so drafts are filtered", async () => {
    const queries: QueryCommand[] = [];
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queries.push(cmd);
        return { Items: [], Count: 0 };
      }
      throw new Error("unexpected");
    });
    const reader = makeDynamoMessageReader({
      client: client as never,
      ...TABLES,
    });
    await reader.listInbox({
      address: "alice@acme.com",
      limit: 25,
      cursor: null,
      since: null,
    });
    const q = queries[0]!;
    expect(String(q.input.FilterExpression)).toMatch(
      /NOT begins_with\(internal_id, :draft_pfx\)/,
    );
    expect(
      (q.input.ExpressionAttributeValues as Record<string, unknown>)[
        ":draft_pfx"
      ],
    ).toBe("DRAFT#");
  });
});
