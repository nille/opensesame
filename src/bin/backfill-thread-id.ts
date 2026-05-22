// Backfill driver — stamps `thread_id` on existing Messages rows that pre-date
// slice 8.8 (server-side thread_id stamping) so slice 8.9's list_thread_messages
// (ADR-0027) can index legacy threads via the ThreadIdGSI.
//
// The slice 8.8 ingest path derives thread_id at write time using the same
// rule as deriveThreadId() — first References msg-id, then In-Reply-To, then
// the row's own Message-ID. Without this backfill, the GSI is empty for any
// thread whose rows were ingested before slice 8.8 shipped.
//
// Strategy:
//   1. Parallel Scan over Messages.
//   2. Skip rows where parse_status !== "ok" (skeletons have no headers to
//      derive from; they each render as their own one-row thread).
//   3. Skip rows that already carry thread_id (idempotent re-run; live ingest
//      could also race the backfill).
//   4. Derive thread_id from references_raw / in_reply_to / message_id.
//   5. Conditional UpdateItem `SET thread_id = :tid` with
//      `attribute_not_exists(thread_id)` — first-write-wins, so a concurrent
//      live write from the slice 8.8 ingest can't be clobbered.
//
//   pnpm tsx src/bin/backfill-thread-id.ts \
//     [--workers 4] [--dry-run] [--limit-per-page 200]
//
// Required env:
//   AWS_REGION
//   OPENSESAME_MESSAGES_TABLE

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { deriveThreadId } from "../core/threading.js";

type Args = {
  workers: number;
  dryRun: boolean;
  limitPerPage: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { workers: 4, dryRun: false, limitPerPage: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--workers":
        if (!next) throw new Error("--workers requires a value");
        out.workers = parseIntStrict(next, "workers");
        i++;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--limit-per-page":
        if (!next) throw new Error("--limit-per-page requires a value");
        out.limitPerPage = parseIntStrict(next, "limit-per-page");
        i++;
        break;
    }
  }
  return out;
}

function parseIntStrict(s: string, name: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${s}`);
  }
  return n;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

type Counters = {
  scanned: number;
  skippedFailed: number;
  skippedAlreadyDone: number;
  skippedNoDerivable: number;
  stamped: number;
  raceConditionalFailed: number;
  errors: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const region = requireEnv("AWS_REGION");
  const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const counters: Counters = {
    scanned: 0,
    skippedFailed: 0,
    skippedAlreadyDone: 0,
    skippedNoDerivable: 0,
    stamped: 0,
    raceConditionalFailed: 0,
    errors: 0,
  };

  const tasks: Promise<void>[] = [];
  for (let segment = 0; segment < args.workers; segment++) {
    tasks.push(
      runSegment({
        ddb,
        messagesTable,
        segment,
        totalSegments: args.workers,
        limitPerPage: args.limitPerPage,
        dryRun: args.dryRun,
        counters,
      }),
    );
  }
  await Promise.all(tasks);

  process.stdout.write(JSON.stringify({ ok: true, ...counters }, null, 2) + "\n");
}

type SegmentDeps = {
  ddb: DynamoDBDocumentClient;
  messagesTable: string;
  segment: number;
  totalSegments: number;
  limitPerPage: number;
  dryRun: boolean;
  counters: Counters;
};

async function runSegment(deps: SegmentDeps): Promise<void> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await deps.ddb.send(
      new ScanCommand({
        TableName: deps.messagesTable,
        Segment: deps.segment,
        TotalSegments: deps.totalSegments,
        Limit: deps.limitPerPage,
        ExclusiveStartKey: exclusiveStartKey,
        ProjectionExpression:
          "address, internal_id, parse_status, message_id, in_reply_to, references_raw, thread_id",
      }),
    );
    for (const row of out.Items ?? []) {
      try {
        await processRow(deps, row);
      } catch (err) {
        deps.counters.errors++;
        process.stderr.write(
          `[error] ${row["address"]}/${row["internal_id"]}: ${(err as Error).message}\n`,
        );
      }
    }
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
}

async function processRow(
  deps: SegmentDeps,
  row: Record<string, unknown>,
): Promise<void> {
  deps.counters.scanned++;
  if (row["parse_status"] !== "ok") {
    deps.counters.skippedFailed++;
    return;
  }
  if (row["thread_id"] !== undefined && row["thread_id"] !== null) {
    deps.counters.skippedAlreadyDone++;
    return;
  }

  const tid = deriveThreadId({
    messageId: stringOrNull(row["message_id"]),
    inReplyTo: stringOrNull(row["in_reply_to"]),
    references: stringOrNull(row["references_raw"]),
  });
  if (tid === null) {
    // No headers to chain on. The client-side JWZ-lite fallback handles these
    // (subject + month bucket); they remain absent from the GSI by design.
    deps.counters.skippedNoDerivable++;
    return;
  }

  const address = String(row["address"]);
  const internalId = String(row["internal_id"]);

  if (deps.dryRun) {
    deps.counters.stamped++;
    return;
  }

  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.messagesTable,
        Key: { address, internal_id: internalId },
        UpdateExpression: "SET thread_id = :tid",
        // A concurrent slice-8.8 live write could race; the condition makes
        // the live stamp win and the backfill becomes a no-op for that row.
        ConditionExpression: "attribute_not_exists(thread_id)",
        ExpressionAttributeValues: { ":tid": tid },
      }),
    );
    deps.counters.stamped++;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      deps.counters.raceConditionalFailed++;
      return;
    }
    throw err;
  }
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  return null;
}

main().catch((err) => {
  process.stderr.write(`backfill failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
