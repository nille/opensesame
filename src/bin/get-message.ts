// Live-call driver for the read-side `get_message` primitive (ADR-0007).
// Resolves a message by either RFC Message-ID (GSI1 hop) or by primary key
// (address + internal_id) and prints the assembled ReadMessage as JSON.
//
//   pnpm tsx src/bin/get-message.ts \
//     --message-id "<CAFMTrzwKjKNfLWHrRR8ohcAiTcJBBNb32PAyy5Gdw5ZA5GQ_uQ@mail.gmail.com>"
//
//   pnpm tsx src/bin/get-message.ts \
//     --address test@nille.net \
//     --internal-id 01KS593M75YMDHN7DZ9YFDT2GX
//
// The two flag pairs are mutually exclusive — pick one.
//
// Required env (subset of the smoke/replay drivers — no S3/EventBridge):
//   AWS_REGION
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_BODY_CHUNKS_TABLE
//   OPENSESAME_MESSAGE_ID_GSI_NAME    # defaults to "GSI1" (matches data-plane-stack.ts)

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeDynamoMessageReader } from "../aws/dynamodb-reader.js";

type Args =
  | { kind: "by-message-id"; messageId: string }
  | { kind: "by-primary-key"; address: string; internalId: string };

function parseArgs(argv: string[]): Args {
  let messageId: string | null = null;
  let address: string | null = null;
  let internalId: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!next) break;
    switch (a) {
      case "--message-id":
        messageId = next;
        i++;
        break;
      case "--address":
        address = next;
        i++;
        break;
      case "--internal-id":
        internalId = next;
        i++;
        break;
    }
  }

  if (messageId !== null) {
    if (address !== null || internalId !== null) {
      throw new Error(
        "pass either --message-id OR (--address + --internal-id), not both",
      );
    }
    return { kind: "by-message-id", messageId };
  }
  if (address !== null && internalId !== null) {
    return { kind: "by-primary-key", address, internalId };
  }
  throw new Error(
    "usage: get-message --message-id <id>  |  --address <addr> --internal-id <id>",
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const region = requireEnv("AWS_REGION");
  const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
  const bodyChunksTable = requireEnv("OPENSESAME_BODY_CHUNKS_TABLE");
  const messageIdGsiName =
    process.env["OPENSESAME_MESSAGE_ID_GSI_NAME"] ?? "GSI1";
  const threadIdGsiName =
    process.env["OPENSESAME_THREAD_ID_GSI_NAME"] ?? "ThreadIdGSI";

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const reader = makeDynamoMessageReader({
    client: ddbClient,
    messagesTable,
    bodyChunksTable,
    messageIdGsiName,
    threadIdGsiName,
  });

  const result =
    args.kind === "by-message-id"
      ? await reader.getByMessageId(args.messageId)
      : await reader.getByPrimaryKey(args.address, args.internalId);

  if (result === null) {
    process.stderr.write("not found\n");
    process.exitCode = 2;
    return;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`get-message failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
