import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type {
  BounceLogWriter,
  DeliveryEvent,
  MessageStatusUpdater,
} from "../core/delivery-events.js";

// DDB-bound implementations of the BounceLogWriter + MessageStatusUpdater
// ports (ADR-0018). Both adapters share a DocumentClient; they're separated
// only by table to keep IAM grants narrow.

// --- BounceLog writer ---

export type DynamoBounceLogDeps = {
  client: DynamoDBDocumentClient;
  bounceLogTable: string;
};

export function makeDynamoBounceLogWriter(
  deps: DynamoBounceLogDeps,
): BounceLogWriter {
  return {
    writeEvent: (event) => writeEvent(deps, event),
  };
}

async function writeEvent(
  deps: DynamoBounceLogDeps,
  event: DeliveryEvent,
): Promise<void> {
  await deps.client.send(
    new PutCommand({
      TableName: deps.bounceLogTable,
      Item: bounceLogItem(event),
    }),
  );
}

function bounceLogItem(event: DeliveryEvent): Record<string, unknown> {
  const item: Record<string, unknown> = {
    ses_message_id: event.ses_message_id,
    event_id: event.event_id,
    event_at: event.event_at,
    category: event.category,
    recipients: event.recipients,
    // Forensic store of the full SNS payload — round-trippable for any
    // future code that needs to re-derive a field we didn't promote to
    // the canonical shape.
    raw: event.raw,
  };
  if (event.sub_category !== null) item.sub_category = event.sub_category;
  if (event.diagnostic !== null) item.diagnostic = event.diagnostic;
  return item;
}

// --- Messages-row status projector ---

export type DynamoMessageStatusUpdaterDeps = {
  client: DynamoDBDocumentClient;
  messagesTable: string;
  messageIdGsiName: string;
  // Pluggable sleep so tests don't have to wait. Production callers can
  // omit this — the default is `setTimeout`.
  sleep?: (ms: number) => Promise<void>;
};

// SES regularly fires the bounce/complaint event 1–2 s after SendEmail
// returns; `persistOutbound` writes the Messages row asynchronously after
// SendEmail, so the GSI1 lookup races the persist on every event. Bounded
// retry rides out both the persist latency and the GSI propagation lag —
// total worst-case wait is ~6.3 s, well within the 30 s Lambda budget.
const LOOKUP_MAX_ATTEMPTS = 6;
const LOOKUP_BASE_DELAY_MS = 200;

export function makeDynamoMessageStatusUpdater(
  deps: DynamoMessageStatusUpdaterDeps,
): MessageStatusUpdater {
  return {
    applyDeliveryStatus: (input) => applyDeliveryStatus(deps, input),
  };
}

async function applyDeliveryStatus(
  deps: DynamoMessageStatusUpdaterDeps,
  input: {
    ses_message_id: string;
    rfc_message_id: string;
    status: string;
    event_at: string;
  },
): Promise<{ updated: boolean }> {
  // Locate the outbound row via GSI1 on message_id. ADR-0013 + ADR-0017:
  // GSI1 PK is the SES-rewritten RFC Message-ID with brackets.
  const sleep = deps.sleep ?? defaultSleep;
  let row: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < LOOKUP_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(LOOKUP_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
    const gsi = await deps.client.send(
      new QueryCommand({
        TableName: deps.messagesTable,
        IndexName: deps.messageIdGsiName,
        KeyConditionExpression: "message_id = :mid",
        ExpressionAttributeValues: { ":mid": input.rfc_message_id },
        Limit: 1,
      }),
    );
    const items = gsi.Items ?? [];
    if (items[0]) {
      row = items[0];
      break;
    }
  }
  if (!row) return { updated: false };

  const address = row["address"];
  const internalId = row["internal_id"];
  if (typeof address !== "string" || typeof internalId !== "string") {
    return { updated: false };
  }

  // ADR-0018: last-event-wins. The Update is unconditional; if a stale
  // event arrives after a newer one, it briefly clobbers — BounceLog is
  // the source of truth.
  await deps.client.send(
    new UpdateCommand({
      TableName: deps.messagesTable,
      Key: { address, internal_id: internalId },
      UpdateExpression:
        "SET delivery_status = :s, last_event_at = :t, last_ses_message_id = :sid",
      ExpressionAttributeValues: {
        ":s": input.status,
        ":t": input.event_at,
        ":sid": input.ses_message_id,
      },
    }),
  );
  return { updated: true };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
