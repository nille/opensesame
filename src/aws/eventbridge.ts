import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsCommandOutput,
} from "@aws-sdk/client-eventbridge";
import type { MailIngestedEvent } from "../core/event.js";

// Adapter that satisfies the composer's `publish` port (see core/ingest.ts).
// Lives in src/aws/ because src/core/ stays free of SDK imports — that's the
// testability discipline the composer already follows.
//
// ADR-0010 fixes the routing keys:
//   source       = "opensesame"
//   detail-type  = "MailIngested"
//   resources    = ["arn:opensesame:address:<address>"]   // synthetic ARN
//   detail       = the full envelope as JSON

const SOURCE = "opensesame";
const DETAIL_TYPE = "MailIngested";

export type EventBridgePublisherDeps = {
  client: EventBridgeClient;
  eventBusName: string;
};

export function makeEventBridgePublisher(
  deps: EventBridgePublisherDeps,
): (event: MailIngestedEvent) => Promise<void> {
  return async (event) => {
    const command = new PutEventsCommand({
      Entries: [
        {
          Source: SOURCE,
          DetailType: DETAIL_TYPE,
          Detail: JSON.stringify(event),
          Resources: [addressArn(event.data.address)],
          EventBusName: deps.eventBusName,
        },
      ],
    });

    const response: PutEventsCommandOutput = await deps.client.send(command);
    assertNoFailures(response);
  };
}

function addressArn(address: string): string {
  // Synthetic ARN per ADR-0010: not AWS-recognized, exists solely as an
  // EventBridge filter target. Pinned in tests so the shape doesn't drift.
  return `arn:opensesame:address:${address}`;
}

function assertNoFailures(response: PutEventsCommandOutput): void {
  // EventBridge can 200 with partial failures inside Entries[].ErrorCode.
  // Per ADR-0012 the Lambda must surface publish failures so SQS visibility
  // timeout drives retry — silently swallowing this would break the
  // durability contract.
  if (!response.FailedEntryCount) return;
  const firstError = response.Entries?.find((e) => e.ErrorCode);
  const code = firstError?.ErrorCode ?? "UnknownError";
  const message = firstError?.ErrorMessage ?? "no message";
  throw new Error(`EventBridge PutEvents failed: ${code}: ${message}`);
}
