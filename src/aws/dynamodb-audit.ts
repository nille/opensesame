import {
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type {
  AuditAttempt,
  AuditBlocked,
  AuditLog,
  AuditOutcome,
} from "../core/audit.js";

// DDB-backed implementation of the AuditLog port (ADR-0008 + ADR-0016).
//
// `recordAttempt` is a Put on `opensesame-audit` keyed by audit_id (ULID).
// `recordOutcome` is an Update against the same audit_id; ADR-0016 §"Two
// writes per send" — the row exists from the moment of intent, and the
// outcome write only mutates the outcome columns.
//
// `type` and `error` are reserved DynamoDB tokens, so the Update uses
// ExpressionAttributeNames to alias them. (`error` is reserved per the AWS
// docs' list of DynamoDB reserved words; `type` is on the same list.)

export type DynamoAuditLogDeps = {
  client: DynamoDBDocumentClient;
  auditTable: string;
};

export function makeDynamoAuditLog(deps: DynamoAuditLogDeps): AuditLog {
  return {
    recordAttempt: (attempt) => recordAttempt(deps, attempt),
    recordOutcome: (outcome) => recordOutcome(deps, outcome),
    recordBlocked: (blocked) => recordBlocked(deps, blocked),
  };
}

async function recordAttempt(
  deps: DynamoAuditLogDeps,
  attempt: AuditAttempt,
): Promise<void> {
  await deps.client.send(
    new PutCommand({
      TableName: deps.auditTable,
      Item: attempt,
    }),
  );
}

async function recordBlocked(
  deps: DynamoAuditLogDeps,
  blocked: AuditBlocked,
): Promise<void> {
  // ADR-0019: terminal row, no later UpdateItem follows. PutCommand on the
  // same audit_id PK shape as send_attempted; the row's `type` discriminates.
  await deps.client.send(
    new PutCommand({
      TableName: deps.auditTable,
      Item: blocked,
    }),
  );
}

async function recordOutcome(
  deps: DynamoAuditLogDeps,
  outcome: AuditOutcome,
): Promise<void> {
  if (outcome.type === "send_succeeded") {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.auditTable,
        Key: { audit_id: outcome.audit_id },
        UpdateExpression:
          "SET #type = :type, ses_message_id = :ses_message_id, succeeded_at = :succeeded_at",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: {
          ":type": outcome.type,
          ":ses_message_id": outcome.ses_message_id,
          ":succeeded_at": outcome.succeeded_at,
        },
      }),
    );
    return;
  }
  await deps.client.send(
    new UpdateCommand({
      TableName: deps.auditTable,
      Key: { audit_id: outcome.audit_id },
      UpdateExpression:
        "SET #type = :type, #error = :error, failed_at = :failed_at",
      ExpressionAttributeNames: { "#type": "type", "#error": "error" },
      ExpressionAttributeValues: {
        ":type": outcome.type,
        ":error": outcome.error,
        ":failed_at": outcome.failed_at,
      },
    }),
  );
}
