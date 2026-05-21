import {
  BatchGetCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  normalizeRecipient,
  type SuppressedRecipient,
  type SuppressionList,
  type SuppressionReason,
  type SuppressionUpsertInput,
  type SuppressionWriter,
} from "../core/suppression.js";

// DDB-bound implementations of the SuppressionList read port and the
// SuppressionWriter write port (ADR-0019). Both adapters key on
// normalized lowercase recipient — the normalizer is the single source of
// truth for the table's PK shape.

const SUPPRESSING_REASONS: ReadonlySet<SuppressionReason> = new Set([
  "bounced_permanent",
  "complained",
]);

// --- read-side ---

export type DynamoSuppressionListDeps = {
  client: DynamoDBDocumentClient;
  suppressionsTable: string;
};

export function makeDynamoSuppressionList(
  deps: DynamoSuppressionListDeps,
): SuppressionList {
  return {
    checkRecipients: (recipients) => checkRecipients(deps, recipients),
  };
}

async function checkRecipients(
  deps: DynamoSuppressionListDeps,
  recipients: readonly string[],
): Promise<SuppressedRecipient[]> {
  // Normalize + dedupe before BatchGetItem — the suppression key is always
  // the lowercased form, and BatchGetItem rejects duplicate keys in a single
  // request. Returning early on an empty input avoids a wasted DDB call.
  const seen = new Set<string>();
  const keys: Array<{ recipient: string }> = [];
  for (const r of recipients) {
    const n = normalizeRecipient(r);
    if (n === null) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    keys.push({ recipient: n });
  }
  if (keys.length === 0) return [];

  const out = await deps.client.send(
    new BatchGetCommand({
      RequestItems: {
        [deps.suppressionsTable]: { Keys: keys },
      },
    }),
  );

  const items = out.Responses?.[deps.suppressionsTable] ?? [];
  const result: SuppressedRecipient[] = [];
  for (const it of items) {
    const recipient = it["recipient"];
    const reason = it["reason"];
    const lastEventAt = it["last_event_at"];
    if (
      typeof recipient !== "string" ||
      typeof reason !== "string" ||
      typeof lastEventAt !== "string"
    ) {
      continue;
    }
    if (!SUPPRESSING_REASONS.has(reason as SuppressionReason)) continue;
    result.push({
      recipient,
      reason: reason as SuppressionReason,
      last_event_at: lastEventAt,
    });
  }
  return result;
}

// --- write-side ---

export type DynamoSuppressionWriterDeps = {
  client: DynamoDBDocumentClient;
  suppressionsTable: string;
};

export function makeDynamoSuppressionWriter(
  deps: DynamoSuppressionWriterDeps,
): SuppressionWriter {
  return {
    upsert: (input) => upsert(deps, input),
  };
}

async function upsert(
  deps: DynamoSuppressionWriterDeps,
  input: SuppressionUpsertInput,
): Promise<boolean> {
  const recipient = normalizeRecipient(input.recipient);
  if (recipient === null) return false;

  // Idempotent guard: write only when the row is brand-new OR the existing
  // row's last_event_at is older than (or equal to) this event. A late-
  // arriving stale event fails the condition and is silently dropped — the
  // forensic record in BounceLog is still authoritative (ADR-0019).
  //
  // UpdateCommand (not Put) so first_event_at is preserved across upserts
  // via if_not_exists. PutCommand replaced the whole item on every event,
  // which clobbered first_event_at. `source` is a DDB reserved word; aliased
  // via ExpressionAttributeNames.
  try {
    await deps.client.send(
      new UpdateCommand({
        TableName: deps.suppressionsTable,
        Key: { recipient },
        UpdateExpression:
          "SET first_event_at = if_not_exists(first_event_at, :event_at), " +
          "last_event_at = :event_at, " +
          "last_ses_message_id = :ses_message_id, " +
          "last_event_id = :event_id, " +
          "reason = :reason, " +
          "#src = :source",
        ConditionExpression:
          "attribute_not_exists(recipient) OR last_event_at <= :event_at",
        ExpressionAttributeNames: {
          "#src": "source",
        },
        ExpressionAttributeValues: {
          ":event_at": input.event_at,
          ":ses_message_id": input.ses_message_id,
          ":event_id": input.event_id,
          ":reason": input.reason,
          ":source": "bounce_handler",
        },
      }),
    );
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // Stale event — newer suppression already on file. Treat as success.
      return true;
    }
    throw err;
  }
}
