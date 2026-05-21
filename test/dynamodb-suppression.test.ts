import { describe, expect, it, vi } from "vitest";
import {
  BatchGetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoSuppressionList,
  makeDynamoSuppressionWriter,
} from "../src/aws/dynamodb-suppression.js";

// On-the-wire shape tests for the Suppressions adapters (ADR-0019). Mirrors
// the dynamodb-bounce-log test style: assert the command class + .input
// shape so a future SDK bump or parameter rename breaks the test instead of
// silently changing the persisted item.

const TABLE = "opensesame-suppressions-test";

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(
  responder: (cmd: unknown) => Promise<unknown>,
): StubClient {
  return { send: vi.fn(responder) };
}

describe("DynamoSuppressionList.checkRecipients", () => {
  it("returns empty for an empty input without calling DDB", async () => {
    const client = makeStubClient(async () => ({}));
    const list = makeDynamoSuppressionList({
      client: client as never,
      suppressionsTable: TABLE,
    });

    const out = await list.checkRecipients([]);
    expect(out).toEqual([]);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("issues a BatchGetCommand keyed by normalized recipient", async () => {
    const client = makeStubClient(async (cmd) => {
      expect(cmd).toBeInstanceOf(BatchGetCommand);
      const input = (cmd as BatchGetCommand).input;
      expect(input.RequestItems?.[TABLE]?.Keys).toEqual([
        { recipient: "alice@example.com" },
        { recipient: "bob@example.com" },
      ]);
      return { Responses: { [TABLE]: [] } };
    });
    const list = makeDynamoSuppressionList({
      client: client as never,
      suppressionsTable: TABLE,
    });

    // Mixed-case input must be normalized before querying — the row key is
    // always lowercased.
    const out = await list.checkRecipients(["Alice@Example.COM", "BOB@example.com"]);
    expect(out).toEqual([]);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("returns suppressed rows with the canonical SuppressedRecipient shape", async () => {
    const client = makeStubClient(async () => ({
      Responses: {
        [TABLE]: [
          {
            recipient: "alice@example.com",
            reason: "bounced_permanent",
            last_event_at: "2026-05-20T08:00:00.000Z",
            first_event_at: "2026-05-19T12:00:00.000Z",
            last_ses_message_id: "ses-old",
            source: "bounce_handler",
          },
        ],
      },
    }));
    const list = makeDynamoSuppressionList({
      client: client as never,
      suppressionsTable: TABLE,
    });

    const out = await list.checkRecipients(["alice@example.com"]);
    expect(out).toEqual([
      {
        recipient: "alice@example.com",
        reason: "bounced_permanent",
        last_event_at: "2026-05-20T08:00:00.000Z",
      },
    ]);
  });

  it("skips inputs that fail normalization", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as BatchGetCommand).input;
      // Only the valid address should reach DDB — "not-an-email" is dropped.
      expect(input.RequestItems?.[TABLE]?.Keys).toEqual([
        { recipient: "alice@example.com" },
      ]);
      return { Responses: { [TABLE]: [] } };
    });
    const list = makeDynamoSuppressionList({
      client: client as never,
      suppressionsTable: TABLE,
    });

    const out = await list.checkRecipients(["alice@example.com", "not-an-email"]);
    expect(out).toEqual([]);
  });

  it("dedupes recipients that normalize to the same key", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as BatchGetCommand).input;
      expect(input.RequestItems?.[TABLE]?.Keys).toEqual([
        { recipient: "alice@example.com" },
      ]);
      return { Responses: { [TABLE]: [] } };
    });
    const list = makeDynamoSuppressionList({
      client: client as never,
      suppressionsTable: TABLE,
    });

    await list.checkRecipients(["Alice@example.com", "ALICE@EXAMPLE.COM"]);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("ignores rows with malformed reason or missing fields", async () => {
    const client = makeStubClient(async () => ({
      Responses: {
        [TABLE]: [
          // Missing reason — must be skipped, not coerced.
          { recipient: "x@example.com", last_event_at: "2026-05-20T08:00:00.000Z" },
          // Reason not in the documented enum — skipped.
          {
            recipient: "y@example.com",
            reason: "delayed",
            last_event_at: "2026-05-20T08:00:00.000Z",
          },
          // Valid.
          {
            recipient: "z@example.com",
            reason: "complained",
            last_event_at: "2026-05-22T08:00:00.000Z",
          },
        ],
      },
    }));
    const list = makeDynamoSuppressionList({
      client: client as never,
      suppressionsTable: TABLE,
    });

    const out = await list.checkRecipients([
      "x@example.com",
      "y@example.com",
      "z@example.com",
    ]);
    expect(out).toEqual([
      {
        recipient: "z@example.com",
        reason: "complained",
        last_event_at: "2026-05-22T08:00:00.000Z",
      },
    ]);
  });
});

describe("DynamoSuppressionWriter.upsert", () => {
  const ROW = {
    recipient: "Alice@Example.com",
    reason: "bounced_permanent" as const,
    event_at: "2026-05-21T17:00:00.000Z",
    ses_message_id: "ses-1",
    event_id: "feedback-1",
  };

  it("issues an UpdateCommand keyed by normalized recipient", async () => {
    // Switched from PutCommand → UpdateCommand so first_event_at can be
    // preserved across upserts via if_not_exists. PutCommand replaces the
    // whole item on every event, which clobbered first_event_at on
    // 2026-05-21 during slice-5 live verify.
    const client = makeStubClient(async (cmd) => {
      expect(cmd).toBeInstanceOf(UpdateCommand);
      const input = (cmd as UpdateCommand).input;
      expect(input.TableName).toBe(TABLE);
      expect(input.Key).toEqual({ recipient: "alice@example.com" });
      return {};
    });
    const writer = makeDynamoSuppressionWriter({
      client: client as never,
      suppressionsTable: TABLE,
    });

    await writer.upsert(ROW);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("preserves first_event_at via if_not_exists; updates last_* every time", async () => {
    // The whole point of the bug fix: first_event_at is set on row creation
    // and never overwritten, while the last_* fields refresh on every event
    // that passes the freshness guard.
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as UpdateCommand).input;
      const ue = input.UpdateExpression ?? "";
      expect(ue).toMatch(
        /first_event_at\s*=\s*if_not_exists\(\s*first_event_at\s*,\s*:event_at\s*\)/,
      );
      expect(ue).toContain("last_event_at = :event_at");
      expect(ue).toContain("last_ses_message_id = :ses_message_id");
      expect(ue).toContain("last_event_id = :event_id");
      expect(ue).toContain("reason = :reason");
      // `source` is a DDB reserved word — must be escaped via #src.
      expect(ue).toMatch(/#src\s*=\s*:source/);
      expect(input.ExpressionAttributeNames?.["#src"]).toBe("source");
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":event_at": "2026-05-21T17:00:00.000Z",
        ":ses_message_id": "ses-1",
        ":event_id": "feedback-1",
        ":reason": "bounced_permanent",
        ":source": "bounce_handler",
      });
      return {};
    });
    const writer = makeDynamoSuppressionWriter({
      client: client as never,
      suppressionsTable: TABLE,
    });

    await writer.upsert(ROW);
  });

  it("guards the write with attribute_not_exists OR last_event_at <= :event_at", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as UpdateCommand).input;
      expect(input.ConditionExpression).toBe(
        "attribute_not_exists(recipient) OR last_event_at <= :event_at",
      );
      expect(input.ExpressionAttributeValues?.[":event_at"]).toBe(
        "2026-05-21T17:00:00.000Z",
      );
      return {};
    });
    const writer = makeDynamoSuppressionWriter({
      client: client as never,
      suppressionsTable: TABLE,
    });

    await writer.upsert(ROW);
  });

  it("treats ConditionalCheckFailedException as success (idempotent stale event)", async () => {
    const client = makeStubClient(async () => {
      const err = new Error("conditional check failed") as Error & {
        name: string;
      };
      err.name = "ConditionalCheckFailedException";
      throw err;
    });
    const writer = makeDynamoSuppressionWriter({
      client: client as never,
      suppressionsTable: TABLE,
    });

    // Stale events resolve as `true` — idempotent success. The fresher
    // row already on file is the authoritative one.
    await expect(writer.upsert(ROW)).resolves.toBe(true);
  });

  it("rethrows other errors", async () => {
    const client = makeStubClient(async () => {
      throw new Error("boom");
    });
    const writer = makeDynamoSuppressionWriter({
      client: client as never,
      suppressionsTable: TABLE,
    });

    await expect(writer.upsert(ROW)).rejects.toThrow(/boom/);
  });

  it("returns false (not throws) when normalization fails", async () => {
    const client = makeStubClient(async () => ({}));
    const writer = makeDynamoSuppressionWriter({
      client: client as never,
      suppressionsTable: TABLE,
    });

    const ok = await writer.upsert({
      ...ROW,
      recipient: "not-an-email",
    });
    expect(ok).toBe(false);
    expect(client.send).not.toHaveBeenCalled();
  });
});
