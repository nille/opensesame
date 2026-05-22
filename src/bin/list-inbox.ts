// Live-call driver for the read-side `read_inbox` primitive (ADR-0007).
// Lists messages for an address, newest-first, with optional `since` filter
// and opaque cursor paging. Prints the ListInboxResult as JSON.
//
//   pnpm tsx src/bin/list-inbox.ts --address test@nille.net
//   pnpm tsx src/bin/list-inbox.ts --address test@nille.net --limit 5
//   pnpm tsx src/bin/list-inbox.ts --address test@nille.net --since 2026-05-20T00:00:00Z
//   pnpm tsx src/bin/list-inbox.ts --address test@nille.net --cursor <base64>
//
// Required env (subset of get-message — no GSI1 needed for this read):
//   AWS_REGION
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_BODY_CHUNKS_TABLE   # unused by listInbox but the reader factory wants it

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeDynamoMessageReader } from "../aws/dynamodb-reader.js";

type Args = {
  address: string;
  limit: number;
  since: string | null;
  cursor: string | null;
};

const DEFAULT_LIMIT = 20;

function parseArgs(argv: string[]): Args {
  let address: string | null = null;
  let limit: number = DEFAULT_LIMIT;
  let since: string | null = null;
  let cursor: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!next) break;
    switch (a) {
      case "--address":
        address = next;
        i++;
        break;
      case "--limit": {
        const parsed = Number.parseInt(next, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--limit must be a positive integer, got ${next}`);
        }
        limit = parsed;
        i++;
        break;
      }
      case "--since":
        since = next;
        i++;
        break;
      case "--cursor":
        cursor = next;
        i++;
        break;
    }
  }

  if (address === null) {
    throw new Error(
      "usage: list-inbox --address <addr> [--limit N] [--since ISO] [--cursor B64]",
    );
  }
  return { address, limit, since, cursor };
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

  const result = await reader.listInbox({
    address: args.address,
    limit: args.limit,
    since: args.since,
    cursor: args.cursor,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`list-inbox failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
