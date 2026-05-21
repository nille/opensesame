import { describe, expect, it } from "vitest";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeDynamoAuditLog } from "../src/aws/dynamodb-audit.js";
import type {
  AuditAttempt,
  AuditFailureOutcome,
  AuditSuccessOutcome,
} from "../src/core/audit.js";

type CommandLike = { input: unknown };

function makeStubClient(): {
  client: DynamoDBDocumentClient;
  sent: CommandLike[];
} {
  const sent: CommandLike[] = [];
  const client = {
    async send(cmd: CommandLike) {
      sent.push(cmd);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const ATTEMPT: AuditAttempt = {
  audit_id: "01KS5NC90HDQMHH8GCPQNCF23R",
  schema_v: "1",
  type: "send_attempted",
  principal: "iam:operator",
  agent_id: null,
  from: "test@nille.net",
  to: "a@example.com",
  cc: "c@example.com",
  subject_hash:
    "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969",
  rfc_message_id: "<01ABC@nille.net>",
  requested_at: "2026-05-21T17:00:00.000Z",
};

describe("makeDynamoAuditLog.recordAttempt", () => {
  it("writes a Put with the audit row to the configured table", async () => {
    const { client, sent } = makeStubClient();
    const log = makeDynamoAuditLog({ client, auditTable: "audit-tbl" });

    await log.recordAttempt(ATTEMPT);

    expect(sent.length).toBe(1);
    expect(sent[0]).toBeInstanceOf(PutCommand);
    const input = sent[0]!.input as { TableName?: string; Item?: AuditAttempt };
    expect(input.TableName).toBe("audit-tbl");
    expect(input.Item).toEqual(ATTEMPT);
  });

  it("propagates DDB errors so the SES call never fires (ADR-0008)", async () => {
    const client = {
      async send() {
        throw new Error("ProvisionedThroughputExceededException");
      },
    } as unknown as DynamoDBDocumentClient;
    const log = makeDynamoAuditLog({ client, auditTable: "audit-tbl" });

    await expect(log.recordAttempt(ATTEMPT)).rejects.toThrow(
      /ProvisionedThroughput/,
    );
  });
});

describe("makeDynamoAuditLog.recordOutcome", () => {
  it("issues an UpdateCommand keyed by audit_id with success fields", async () => {
    const { client, sent } = makeStubClient();
    const log = makeDynamoAuditLog({ client, auditTable: "audit-tbl" });

    const outcome: AuditSuccessOutcome = {
      audit_id: "01KS5NC90HDQMHH8GCPQNCF23R",
      type: "send_succeeded",
      ses_message_id: "ses-msg-1",
      succeeded_at: "2026-05-21T17:00:01.000Z",
    };
    await log.recordOutcome(outcome);

    expect(sent.length).toBe(1);
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    const input = sent[0]!.input as {
      TableName?: string;
      Key?: { audit_id?: string };
      UpdateExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, string>;
    };
    expect(input.TableName).toBe("audit-tbl");
    expect(input.Key?.audit_id).toBe("01KS5NC90HDQMHH8GCPQNCF23R");
    expect(input.UpdateExpression).toBe(
      "SET #type = :type, ses_message_id = :ses_message_id, succeeded_at = :succeeded_at",
    );
    expect(input.ExpressionAttributeNames).toEqual({ "#type": "type" });
    expect(input.ExpressionAttributeValues).toEqual({
      ":type": "send_succeeded",
      ":ses_message_id": "ses-msg-1",
      ":succeeded_at": "2026-05-21T17:00:01.000Z",
    });
  });

  it("issues an UpdateCommand with failure fields", async () => {
    const { client, sent } = makeStubClient();
    const log = makeDynamoAuditLog({ client, auditTable: "audit-tbl" });

    const outcome: AuditFailureOutcome = {
      audit_id: "01KS5NC90HDQMHH8GCPQNCF23R",
      type: "send_failed",
      error: "MessageRejected",
      failed_at: "2026-05-21T17:00:01.000Z",
    };
    await log.recordOutcome(outcome);

    expect(sent.length).toBe(1);
    const input = sent[0]!.input as {
      UpdateExpression?: string;
      ExpressionAttributeValues?: Record<string, string>;
    };
    expect(input.UpdateExpression).toBe(
      "SET #type = :type, #error = :error, failed_at = :failed_at",
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ":type": "send_failed",
      ":error": "MessageRejected",
      ":failed_at": "2026-05-21T17:00:01.000Z",
    });
  });
});
