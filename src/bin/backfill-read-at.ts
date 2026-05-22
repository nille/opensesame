// Backfill driver — stamps `read_at = received_at` on existing Messages rows
// that pre-date slice 8 (no `read_at` attribute).
//
// Without this, every row written before mark_read existed would render as
// unread the first time the operator opens the inbox. The triage signal lives
// in *new* mail, not in the historical archive — so we stamp pre-existing rows
// as already-read at their received timestamp.
//
// Strategy:
//   1. Parallel Scan over Messages.
//   2. Skip rows where parse_status !== "ok" (skeletons flag for triage via
//      the failed-dot, not the unread-dot).
//   3. Skip rows where direction === "out" (outbound mail is never "unread";
//      the UI gutter ignores read_at on outbound rows already).
//   4. Skip rows that already have `read_at` (idempotent re-run).
//   5. Conditional UpdateItem `SET read_at = :ts` with
//      `attribute_not_exists(read_at)` — first-write-wins, so a concurrent
//      live mark_read can't be clobbered by the backfill.
//
//   pnpm tsx src/bin/backfill-read-at.ts \
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
  skippedOutbound: number;
  skippedAlreadyDone: number;
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
    skippedOutbound: 0,
    skippedAlreadyDone: 0,
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
          "address, internal_id, parse_status, direction, received_at, read_at",
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
  // ADR-0017: direction defaults to "in" when attribute-absent.
  if (row["direction"] === "out") {
    deps.counters.skippedOutbound++;
    return;
  }
  if (row["read_at"] !== undefined) {
    deps.counters.skippedAlreadyDone++;
    return;
  }

  const address = String(row["address"]);
  const internalId = String(row["internal_id"]);
  const receivedAt = String(row["received_at"]);
  if (!receivedAt) {
    throw new Error("row has no received_at — refusing to stamp without a timestamp");
  }

  if (deps.dryRun) {
    deps.counters.stamped++;
    return;
  }

  try {
    await deps.ddb.send(
      new UpdateCommand({
        TableName: deps.messagesTable,
        Key: { address, internal_id: internalId },
        UpdateExpression: "SET read_at = :ts",
        // Live mark_read could race with the backfill. The condition makes
        // the live stamp win — the backfill becomes a no-op for that row.
        ConditionExpression: "attribute_not_exists(read_at)",
        ExpressionAttributeValues: { ":ts": receivedAt },
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

main().catch((err) => {
  process.stderr.write(`backfill failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
