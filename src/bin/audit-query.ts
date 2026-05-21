// Live-call driver for the read-side `audit_query` primitive (ADR-0007 +
// ADR-0020). Queries the AuditLog GSI1 ((principal, audit_id)) for events
// in a time range, optionally filtered by agent_id / address, and prints
// the rows as line-delimited JSON.
//
//   pnpm tsx src/bin/audit-query.ts
//   pnpm tsx src/bin/audit-query.ts --since 2026-05-21T00:00:00Z
//   pnpm tsx src/bin/audit-query.ts --address bounce@simulator.amazonses.com
//   pnpm tsx src/bin/audit-query.ts --agent-id agent-x --limit 10
//   pnpm tsx src/bin/audit-query.ts --all
//
// Required env:
//   AWS_REGION
//   OPENSESAME_AUDIT_TABLE
//
// Optional env:
//   OPENSESAME_AUDIT_GSI    — index name on the AuditLog table; defaults
//                             to the CDK construct's "GSI1".
//
// LDJSON output composes with jq:
//   pnpm tsx src/bin/audit-query.ts --all | jq -s 'group_by(.type) | map({type: .[0].type, n: length})'

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeDynamoAuditQueryReader } from "../aws/dynamodb-audit-query.js";
import type { AuditQueryInput } from "../core/audit-query.js";

// Safety belt for --all: even on the cheapest path we shouldn't accidentally
// stream tens of thousands of rows to stdout. Operators wanting more should
// use bounded --since / --until windows or the AWS console / Athena export.
const ALL_PAGE_CAP = 10_000;

type Args = {
  region: string;
  auditTable: string;
  gsiName: string;
  query: AuditQueryInput;
  drainAllPages: boolean;
};

function parseArgs(argv: string[]): Args {
  let agentId: string | null | undefined;
  let address: string | undefined;
  let since: Date | undefined;
  let until: Date | undefined;
  let limit: number | undefined;
  let cursor: string | undefined;
  let drainAllPages = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      drainAllPages = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) break;
    switch (a) {
      case "--agent-id":
        // The literal string "null" maps to the DDB NULL attribute — handy
        // for filtering solo-direct rows where agent_id is unset.
        agentId = next === "null" ? null : next;
        i++;
        break;
      case "--address":
        address = next;
        i++;
        break;
      case "--since":
        since = parseDate("--since", next);
        i++;
        break;
      case "--until":
        until = parseDate("--until", next);
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
      case "--cursor":
        cursor = next;
        i++;
        break;
    }
  }

  // exactOptionalPropertyTypes: only attach optional fields when defined.
  const query: AuditQueryInput = {};
  if (agentId !== undefined) query.agent_id = agentId;
  if (address !== undefined) query.address = address;
  if (since !== undefined) query.since = since;
  if (until !== undefined) query.until = until;
  if (limit !== undefined) query.limit = limit;
  if (cursor !== undefined) query.cursor = cursor;

  return {
    region: requireEnv("AWS_REGION"),
    auditTable: requireEnv("OPENSESAME_AUDIT_TABLE"),
    gsiName: process.env["OPENSESAME_AUDIT_GSI"] ?? "GSI1",
    query,
    drainAllPages,
  };
}

function parseDate(flag: string, raw: string): Date {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`${flag}: not a valid ISO-8601 timestamp: ${raw}`);
  }
  return new Date(ms);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: args.region }),
  );
  const reader = makeDynamoAuditQueryReader({
    client: ddb,
    auditTable: args.auditTable,
    gsiName: args.gsiName,
  });

  let emitted = 0;
  let nextCursor = args.query.cursor;
  do {
    // Build the per-page input fresh — the cursor changes between pages.
    const pageInput: AuditQueryInput = { ...args.query };
    if (nextCursor !== undefined) pageInput.cursor = nextCursor;
    else delete pageInput.cursor;

    const page = await reader.query(pageInput);
    for (const ev of page.events) {
      process.stdout.write(JSON.stringify(ev) + "\n");
      emitted++;
      if (emitted >= ALL_PAGE_CAP) break;
    }
    if (!args.drainAllPages || emitted >= ALL_PAGE_CAP) {
      // One-page mode: the next_cursor is informational. Surface it on
      // stderr so a piped `jq` pipeline doesn't see it on stdout.
      if (page.next_cursor !== undefined) {
        process.stderr.write(`next_cursor=${page.next_cursor}\n`);
      }
      return;
    }
    nextCursor = page.next_cursor;
  } while (nextCursor !== undefined);
}

main().catch((err) => {
  process.stderr.write(`audit-query failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
