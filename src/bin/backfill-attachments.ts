// Backfill driver — re-derives attachments for existing Messages rows
// (rows written before slice 8.1 carry no `attachments` attribute and never
// had their bytes copied to S3).
//
// Strategy:
//   1. Page through Messages with a parallel Scan (workers split keyspace).
//   2. Skip rows where parse_status !== "ok" (skeletons have no parsed parts).
//   3. Skip rows where `attachments` already exists (idempotent re-run).
//   4. For each candidate, GET the canonical raw_s3_uri object, parseMime,
//      and — when the parse produced one or more attachments — write each
//      part's bytes to S3 and UpdateItem the Messages row with the
//      summary list.
//
// What we do NOT do:
//   - Re-publish MailIngested events (the original landed on the bus already)
//   - Rewrite the Messages row from scratch (avoid clobbering direction or
//     SES-rewritten message_id on outbound rows — ADR-0017 invariant).
//   - Touch body chunks (the parse-time bodyText already lives in DDB).
//
//   pnpm tsx src/bin/backfill-attachments.ts \
//     [--workers 4] [--dry-run] [--limit-per-page 200]
//
// Required env:
//   AWS_REGION
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_RAW_MIME_BUCKET    used for the per-attachment writer; raw
//                                 bytes themselves come from raw_s3_uri.
//
// Idempotence: relies on (address, internal_id, part_index) → S3 key being
// stable, plus DDB UpdateItem replacing `attachments` wholesale. A second
// run on the same row is a no-op once the attribute is present.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { makeS3AttachmentWriter } from "../aws/s3-attachment-store.js";
import {
  makeAttachmentS3Key,
  type AttachmentWriter,
} from "../core/attachment-store.js";
import { parseMime } from "../core/parser.js";

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

type S3Uri = { bucket: string; key: string };

function parseS3Uri(uri: string): S3Uri {
  const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m || !m[1] || !m[2]) {
    throw new Error(`invalid s3 uri: ${uri}`);
  }
  return { bucket: m[1], key: m[2] };
}

async function fetchObject(s3: S3Client, uri: S3Uri): Promise<Uint8Array> {
  const out = await s3.send(
    new GetObjectCommand({ Bucket: uri.bucket, Key: uri.key }),
  );
  const body = out.Body as
    | { transformToByteArray?: () => Promise<Uint8Array> }
    | undefined;
  if (!body || typeof body.transformToByteArray !== "function") {
    throw new Error("S3 GetObject body is not a stream-shaped response");
  }
  return body.transformToByteArray();
}

type Counters = {
  scanned: number;
  skippedFailed: number;
  skippedAlreadyDone: number;
  zeroAttachments: number;
  backfilled: number;
  errors: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const region = requireEnv("AWS_REGION");
  const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
  // Bytes are written to whichever bucket holds the canonical raw — that's
  // the same raw-mime bucket every row points at via raw_s3_uri. Sanity
  // check by env so a misconfigured run can't write to a foreign bucket.
  const rawMimeBucket = requireEnv("OPENSESAME_RAW_MIME_BUCKET");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const attachmentWriter = makeS3AttachmentWriter({ client: s3 });

  const counters: Counters = {
    scanned: 0,
    skippedFailed: 0,
    skippedAlreadyDone: 0,
    zeroAttachments: 0,
    backfilled: 0,
    errors: 0,
  };

  const tasks: Promise<void>[] = [];
  for (let segment = 0; segment < args.workers; segment++) {
    tasks.push(
      runSegment({
        ddb,
        s3,
        attachmentWriter,
        messagesTable,
        rawMimeBucket,
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
  s3: S3Client;
  attachmentWriter: AttachmentWriter;
  messagesTable: string;
  rawMimeBucket: string;
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
        // Project only what we need to decide whether to backfill. Keeps
        // RCU spend bounded on the scan.
        ProjectionExpression:
          "address, internal_id, parse_status, raw_s3_uri, attachments",
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
  if (row["attachments"] !== undefined) {
    deps.counters.skippedAlreadyDone++;
    return;
  }
  const address = String(row["address"]);
  const internalId = String(row["internal_id"]);
  const rawS3Uri = String(row["raw_s3_uri"]);

  const uri = parseS3Uri(rawS3Uri);
  const raw = await fetchObject(deps.s3, uri);
  const parsed = parseMime(raw);

  if (parsed.attachments.length === 0) {
    // No-op rows still get marked so a re-run skips them via attribute
    // presence. Empty list keeps the read-side projection identical to the
    // attribute-absent default.
    if (!deps.dryRun) {
      await deps.ddb.send(
        new UpdateCommand({
          TableName: deps.messagesTable,
          Key: { address, internal_id: internalId },
          UpdateExpression: "SET attachments = :empty",
          ExpressionAttributeValues: { ":empty": [] },
        }),
      );
    }
    deps.counters.zeroAttachments++;
    return;
  }

  if (deps.dryRun) {
    deps.counters.backfilled++;
    return;
  }

  // Write attachment bytes first (S3 put), so a partially-failed run never
  // leaves a row pointing at a missing object. Same invariant the live
  // ingest path enforces (ADR-0013, extended for slice 8.1).
  for (const att of parsed.attachments) {
    await deps.attachmentWriter.putAttachment({
      bucket: deps.rawMimeBucket,
      key: makeAttachmentS3Key(address, internalId, att.partIndex),
      bytes: att.bytes,
      contentType: att.contentType,
      filename: att.filename,
    });
  }

  await deps.ddb.send(
    new UpdateCommand({
      TableName: deps.messagesTable,
      Key: { address, internal_id: internalId },
      UpdateExpression: "SET attachments = :a",
      ExpressionAttributeValues: {
        ":a": parsed.attachments.map((att) => ({
          filename: att.filename,
          content_type: att.contentType,
          size_bytes: att.sizeBytes,
          content_id: att.contentId,
          part_index: att.partIndex,
          sha256: att.sha256,
        })),
      },
    }),
  );
  deps.counters.backfilled++;
}

main().catch((err) => {
  process.stderr.write(`backfill failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
