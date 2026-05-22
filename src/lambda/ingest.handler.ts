import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { makeDynamoMessageStore } from "../aws/dynamodb.js";
import { makeEventBridgePublisher } from "../aws/eventbridge.js";
import { makeS3AttachmentWriter } from "../aws/s3-attachment-store.js";
import { makeIngestHandler } from "./ingest.js";

// Production Lambda entry. Reads env vars supplied by the ComputePlaneStack
// construct, builds the AWS SDK clients once at module load, and exports
// `handler` as the SES Lambda receipt-action handler.
//
// Env contract — every var must be set by the CDK Function construct.
// Missing any of them is a deploy-time misconfiguration; we fail at load
// rather than per-invocation so the function never reports a healthy
// init while in fact being broken.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const region = requireEnv("AWS_REGION");
const deploymentId = requireEnv("OPENSESAME_DEPLOYMENT_ID");
const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
const bodyChunksTable = requireEnv("OPENSESAME_BODY_CHUNKS_TABLE");
const eventBusName = requireEnv("OPENSESAME_EVENT_BUS_NAME");
const rawMimeBucket = requireEnv("OPENSESAME_RAW_MIME_BUCKET");

// SDK clients are created at module scope so Lambda's container reuse
// keeps them across invocations — TLS handshakes are expensive on cold
// starts; reusing them is a measurable latency win.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const eb = new EventBridgeClient({ region });
const s3 = new S3Client({ region });

const store = makeDynamoMessageStore({
  client: ddb,
  messagesTable,
  bodyChunksTable,
  attachmentWriter: makeS3AttachmentWriter({ client: s3 }),
  attachmentBucket: rawMimeBucket,
});
const publish = makeEventBridgePublisher({
  client: eb,
  eventBusName,
});

export const handler = makeIngestHandler({
  s3,
  region,
  deploymentId,
  rawMimeBucket,
  store,
  publish,
});
