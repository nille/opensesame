// Replay an existing S3 raw-MIME object back through the local ingest
// composer (parse → DDB write → EventBridge publish), without involving SES
// or the deployed Lambda. Use this when a production row is wrong (parser
// bug fix landed after ingest, etc.) and you need to recompute it from the
// canonical bytes.
//
//   pnpm tsx src/bin/replay-ingest.ts \
//     --bucket opensesame-raw-mime-925039213717 \
//     --key   <ses-message-id> \
//     --address test@nille.net \
//     [--received-at 2026-05-21T12:45:30.725Z]   # default = S3 LastModified
//
// internal_id is derived from (s3Key, received_at) per ADR-0013, so passing
// the original received_at rewrites the same Messages row + body chunks
// idempotently — no orphans, no duplicates.
//
// SES verdicts are NOT preserved on the raw S3 object; the originals lived
// on the SES event payload at receipt time. We synthesize all-PASS verdicts
// here on the assumption that the message already passed SES intake (it
// reached S3, which means receipt rules accepted it). That's a documented
// trade-off — for adversarial replays of historical SPAM/VIRUS = FAIL
// messages, do not use this driver.
//
// Required env (same set as smoke-ingest):
//   AWS_REGION
//   OPENSESAME_DEPLOYMENT_ID
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_BODY_CHUNKS_TABLE
//   OPENSESAME_EVENT_BUS_NAME

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { handleRawMail } from "../core/handle-raw-mail.js";
import { makeDynamoMessageStore } from "../aws/dynamodb.js";
import { makeEventBridgePublisher } from "../aws/eventbridge.js";

type Args = {
  bucket: string;
  key: string;
  address: string;
  receivedAt: string | null;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { receivedAt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!next) break;
    switch (a) {
      case "--bucket":
        out.bucket = next;
        i++;
        break;
      case "--key":
        out.key = next;
        i++;
        break;
      case "--address":
        out.address = next;
        i++;
        break;
      case "--received-at":
        out.receivedAt = next;
        i++;
        break;
    }
  }
  if (!out.bucket || !out.key || !out.address) {
    throw new Error(
      "usage: replay-ingest --bucket <name> --key <s3-key> --address <addr> [--received-at <iso>]",
    );
  }
  return out as Args;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function fetchObject(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<{ bytes: Uint8Array; lastModified: Date | null }> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body as
    | { transformToByteArray?: () => Promise<Uint8Array> }
    | undefined;
  if (!body || typeof body.transformToByteArray !== "function") {
    throw new Error("S3 GetObject body is not a stream-shaped response");
  }
  const bytes = await body.transformToByteArray();
  return { bytes, lastModified: out.LastModified ?? null };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const region = requireEnv("AWS_REGION");
  const deploymentId = requireEnv("OPENSESAME_DEPLOYMENT_ID");
  const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
  const bodyChunksTable = requireEnv("OPENSESAME_BODY_CHUNKS_TABLE");
  const eventBusName = requireEnv("OPENSESAME_EVENT_BUS_NAME");

  const s3 = new S3Client({ region });
  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const ebClient = new EventBridgeClient({ region });

  const { bytes, lastModified } = await fetchObject(s3, args.bucket, args.key);
  const receivedAt =
    args.receivedAt ?? (lastModified ? lastModified.toISOString() : null);
  if (!receivedAt) {
    throw new Error(
      "no --received-at provided and S3 LastModified is missing; cannot derive deterministic internal_id",
    );
  }

  const store = makeDynamoMessageStore({
    client: ddbClient,
    messagesTable,
    bodyChunksTable,
  });
  const publish = makeEventBridgePublisher({
    client: ebClient,
    eventBusName,
  });

  // Synthesized verdicts — see header comment.
  const event = await handleRawMail(
    {
      raw: bytes,
      s3Bucket: args.bucket,
      s3Key: args.key,
      address: args.address,
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
  process.stderr.write(`replay-ingest failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
