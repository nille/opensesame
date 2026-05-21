import { describe, expect, it, vi } from "vitest";
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoBounceLogWriter,
  makeDynamoMessageStatusUpdater,
} from "../src/aws/dynamodb-bounce-log.js";
import type { DeliveryEvent } from "../src/core/delivery-events.js";

// On-the-wire shape tests for the bounce-log adapters (ADR-0018). We assert
// the DDB command class + .input shape so a future SDK bump or parameter
// rename breaks the test instead of silently changing the persisted item.

const TABLES = {
  bounceLogTable: "opensesame-bounces-test",
  messagesTable: "opensesame-messages-test",
  messageIdGsiName: "GSI1",
} as const;

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(
  responder: (cmd: unknown) => Promise<unknown>,
): StubClient {
  return { send: vi.fn(responder) };
}

function event(over: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    ses_message_id: "ses-1",
    event_id: "feedback-1",
    event_at: "2026-05-21T18:05:01.000Z",
    category: "bounce_permanent",
    sub_category: "General",
    recipients: ["bounce@simulator.amazonses.com"],
    diagnostic: "smtp; 550 5.1.1 user unknown",
    raw: { eventType: "Bounce", mail: { messageId: "ses-1" } },
    ...over,
  };
}

describe("DynamoBounceLogWriter", () => {
  it("issues a PutCommand keyed by (ses_message_id, event_id) with the full event payload", async () => {
    const client = makeStubClient(async () => ({}));
    const writer = makeDynamoBounceLogWriter({
      client: client as never,
      bounceLogTable: TABLES.bounceLogTable,
    });

    await writer.writeEvent(event());

    expect(client.send).toHaveBeenCalledTimes(1);
    const cmd = client.send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(PutCommand);
    const input = (cmd as PutCommand).input;
    expect(input.TableName).toBe(TABLES.bounceLogTable);
    const item = input.Item as Record<string, unknown>;
    expect(item.ses_message_id).toBe("ses-1");
    expect(item.event_id).toBe("feedback-1");
    expect(item.event_at).toBe("2026-05-21T18:05:01.000Z");
    expect(item.category).toBe("bounce_permanent");
    expect(item.sub_category).toBe("General");
    expect(item.recipients).toEqual(["bounce@simulator.amazonses.com"]);
    expect(item.diagnostic).toBe("smtp; 550 5.1.1 user unknown");
    // Raw payload round-trips for forensic queries.
    expect(item.raw).toEqual({
      eventType: "Bounce",
      mail: { messageId: "ses-1" },
    });
  });

  it("omits sub_category and diagnostic when they're null (sparse attributes)", async () => {
    const client = makeStubClient(async () => ({}));
    const writer = makeDynamoBounceLogWriter({
      client: client as never,
      bounceLogTable: TABLES.bounceLogTable,
    });

    await writer.writeEvent(event({ sub_category: null, diagnostic: null }));

    const item = (client.send.mock.calls[0]![0] as PutCommand).input.Item as
      | Record<string, unknown>;
    expect(item.sub_category).toBeUndefined();
    expect(item.diagnostic).toBeUndefined();
  });
});

describe("DynamoMessageStatusUpdater", () => {
  it("queries GSI1 by message_id, then UPDATEs the located row's delivery_status", async () => {
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            {
              address: "test@nille.net",
              internal_id: "01KS5VBS2K39KH8WHP67EGV7GZ",
            },
          ],
          Count: 1,
        };
      }
      if (cmd instanceof UpdateCommand) return {};
      throw new Error("unexpected command");
    });

    const updater = makeDynamoMessageStatusUpdater({
      client: client as never,
      messagesTable: TABLES.messagesTable,
      messageIdGsiName: TABLES.messageIdGsiName,
    });

    const result = await updater.applyDeliveryStatus({
      ses_message_id: "ses-1",
      rfc_message_id: "<ses-1@eu-north-1.amazonses.com>",
      status: "bounced_permanent",
      event_at: "2026-05-21T18:05:01.000Z",
    });

    expect(result.updated).toBe(true);

    const calls = client.send.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);

    // 1) GSI1 lookup
    const q = calls[0] as QueryCommand;
    expect(q).toBeInstanceOf(QueryCommand);
    expect(q.input.TableName).toBe(TABLES.messagesTable);
    expect(q.input.IndexName).toBe(TABLES.messageIdGsiName);
    expect(q.input.ExpressionAttributeValues).toMatchObject({
      ":mid": "<ses-1@eu-north-1.amazonses.com>",
    });
    expect(q.input.Limit).toBe(1);

    // 2) UpdateItem on the located row
    const u = calls[1] as UpdateCommand;
    expect(u).toBeInstanceOf(UpdateCommand);
    expect(u.input.TableName).toBe(TABLES.messagesTable);
    expect(u.input.Key).toEqual({
      address: "test@nille.net",
      internal_id: "01KS5VBS2K39KH8WHP67EGV7GZ",
    });
    expect(u.input.UpdateExpression).toMatch(/delivery_status\s*=\s*:s/);
    expect(u.input.UpdateExpression).toMatch(/last_event_at\s*=\s*:t/);
    expect(u.input.UpdateExpression).toMatch(/last_ses_message_id\s*=\s*:sid/);
    expect(u.input.ExpressionAttributeValues).toEqual({
      ":s": "bounced_permanent",
      ":t": "2026-05-21T18:05:01.000Z",
      ":sid": "ses-1",
    });
  });

  it("returns updated=false (and skips UpdateItem) when GSI1 returns no row after retries", async () => {
    // The Messages row may genuinely not exist — persist-outbound failed
    // silently. The handler should still write BounceLog (forensic) but not
    // pretend the projection landed. We swap in a no-op sleep so the bounded
    // retry loop runs to exhaustion synchronously.
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: [], Count: 0 };
      throw new Error("UpdateItem should not run");
    });

    const updater = makeDynamoMessageStatusUpdater({
      client: client as never,
      messagesTable: TABLES.messagesTable,
      messageIdGsiName: TABLES.messageIdGsiName,
      sleep: async () => {},
    });

    const result = await updater.applyDeliveryStatus({
      ses_message_id: "ses-missing",
      rfc_message_id: "<ses-missing@eu-north-1.amazonses.com>",
      status: "complained",
      event_at: "2026-05-21T18:10:00.000Z",
    });

    expect(result.updated).toBe(false);
    // Only GSI1 lookups ran (no UpdateItem).
    const updates = client.send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateCommand);
    expect(updates).toHaveLength(0);
  });

  it("retries the GSI1 lookup until the row appears (rides out persist-outbound race)", async () => {
    // SES typically fires the bounce event ~1.5 s after SendEmail returns,
    // but `persistOutbound` writes the Messages row asynchronously after
    // SendEmail. The first GSI1 lookup commonly returns empty; the row
    // shows up on the next attempt once the persist completes + the GSI
    // propagates. Pin the retry behavior so a regression that drops it
    // surfaces immediately.
    let queryAttempts = 0;
    const client = makeStubClient(async (cmd) => {
      if (cmd instanceof QueryCommand) {
        queryAttempts += 1;
        if (queryAttempts < 3) return { Items: [], Count: 0 };
        return {
          Items: [
            {
              address: "test@nille.net",
              internal_id: "01KS5VBS2K39KH8WHP67EGV7GZ",
            },
          ],
          Count: 1,
        };
      }
      if (cmd instanceof UpdateCommand) return {};
      throw new Error("unexpected command");
    });

    const updater = makeDynamoMessageStatusUpdater({
      client: client as never,
      messagesTable: TABLES.messagesTable,
      messageIdGsiName: TABLES.messageIdGsiName,
      sleep: async () => {},
    });

    const result = await updater.applyDeliveryStatus({
      ses_message_id: "ses-1",
      rfc_message_id: "<ses-1@eu-north-1.amazonses.com>",
      status: "bounced_permanent",
      event_at: "2026-05-21T18:05:01.000Z",
    });

    expect(result.updated).toBe(true);
    expect(queryAttempts).toBe(3);
    // The UpdateItem still ran exactly once.
    const updates = client.send.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof UpdateCommand);
    expect(updates).toHaveLength(1);
  });
});
