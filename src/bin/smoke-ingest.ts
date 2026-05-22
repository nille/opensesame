// Smoke-test driver: read a local .eml, run it through the full ingest
// orchestration (parse → DDB write → EventBridge publish), print the event.
//
//   pnpm tsx src/bin/smoke-ingest.ts <path-to.eml> [--address alice@acme.com]
//
// Required env:
//   AWS_REGION
//   OPENSESAME_DEPLOYMENT_ID
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_BODY_CHUNKS_TABLE
//   OPENSESAME_EVENT_BUS_NAME
//   OPENSESAME_RAW_BUCKET
//
// Optional env:
//   OPENSESAME_RECEIVED_AT  (ISO-8601; default = now)
//   OPENSESAME_S3_KEY       (default = "<basename>.eml")
//
// Stays a smoke driver — not the production Lambda entry. The Lambda
// handler is the next slice.

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { S3Client } from "@aws-sdk/client-s3";
import { handleRawMail } from "../core/handle-raw-mail.js";
import { makeDynamoMessageStore } from "../aws/dynamodb.js";
import { makeEventBridgePublisher } from "../aws/eventbridge.js";
import { makeS3AttachmentWriter } from "../aws/s3-attachment-store.js";

type Args = { emlPath: string; address: string };

function parseArgs(argv: string[]): Args {
  const [emlPath, ...rest] = argv;
  if (!emlPath) {
    throw new Error("usage: smoke-ingest <path-to.eml> [--address alice@acme.com]");
  }
  let address = "smoke@example.com";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--address" && rest[i + 1]) {
      address = rest[i + 1]!;
      i++;
    }
  }
  return { emlPath, address };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const { emlPath, address } = parseArgs(process.argv.slice(2));

  const region = requireEnv("AWS_REGION");
  const deploymentId = requireEnv("OPENSESAME_DEPLOYMENT_ID");
  const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
  const bodyChunksTable = requireEnv("OPENSESAME_BODY_CHUNKS_TABLE");
  const eventBusName = requireEnv("OPENSESAME_EVENT_BUS_NAME");
  const rawBucket = requireEnv("OPENSESAME_RAW_BUCKET");
  const receivedAt =
    process.env.OPENSESAME_RECEIVED_AT ?? new Date().toISOString();
  const s3Key = process.env.OPENSESAME_S3_KEY ?? basename(emlPath);

  const raw = new Uint8Array(await readFile(resolve(emlPath)));

  const ddbClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
  );
  const ebClient = new EventBridgeClient({ region });
  const s3 = new S3Client({ region });

  const store = makeDynamoMessageStore({
    client: ddbClient,
    messagesTable,
    bodyChunksTable,
    attachmentWriter: makeS3AttachmentWriter({ client: s3 }),
    attachmentBucket: rawBucket,
  });
  const publish = makeEventBridgePublisher({
    client: ebClient,
    eventBusName,
  });

  // SES verdicts: in real ingest these come from the SES notification. For
  // smoke we mark everything PASS; the schema requires the field to be set.
  const event = await handleRawMail(
    {
      raw,
      s3Bucket: rawBucket,
      s3Key,
      address,
      receivedAt,
      verdicts: {
        spam: "PASS",
        virus: "PASS",
        dkim: "PASS",
        spf: "PASS",
        dmarc: "PASS",
      },
    },
    {
      store,
      publish,
      now: () => new Date(),
      deploymentId,
    },
  );

  process.stdout.write(JSON.stringify(event, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`smoke-ingest failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
