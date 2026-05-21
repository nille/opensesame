import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoBounceLogWriter,
  makeDynamoMessageStatusUpdater,
} from "../aws/dynamodb-bounce-log.js";
import { makeDynamoSuppressionWriter } from "../aws/dynamodb-suppression.js";
import type { BounceHandlerDeps } from "./bounce-handler.js";
import { makeBounceHandler } from "./bounce-handler.js";

// Production Lambda entry for the SES bounce/complaint/delivery-delay
// handler (ADR-0018, ADR-0019). Wired by BounceHandlerStack to an SNS topic
// that the SES configuration set publishes to.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const region = requireEnv("AWS_REGION");
const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
const bounceLogTable = requireEnv("OPENSESAME_BOUNCE_LOG_TABLE");
// GSI1 on the Messages table — the same index inbound reads use to thread
// replies. Required for locating the outbound row from the SES message id.
const messageIdGsiName = process.env["OPENSESAME_MESSAGES_GSI1"] ?? "GSI1";
// ADR-0019: optional. When set, the handler upserts a Suppressions row per
// recipient on suppressing events. Slice-4-only deployments leave this
// unset and behave as before.
const suppressionsTable = process.env["OPENSESAME_SUPPRESSIONS_TABLE"] ?? null;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const bounceLog = makeDynamoBounceLogWriter({
  client: ddb,
  bounceLogTable,
});
const messageStatus = makeDynamoMessageStatusUpdater({
  client: ddb,
  messagesTable,
  messageIdGsiName,
});

const handlerDeps: BounceHandlerDeps = {
  awsRegion: region,
  bounceLog,
  messageStatus,
  warn: (m) => console.warn(m),
};
if (suppressionsTable !== null) {
  handlerDeps.suppression = makeDynamoSuppressionWriter({
    client: ddb,
    suppressionsTable,
  });
}

export const handler = makeBounceHandler(handlerDeps);
