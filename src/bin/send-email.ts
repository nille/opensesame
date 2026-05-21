// Live-call driver for the outbound `send_email` primitive (ADR-0007 slices 1
// and 2). Composes a raw RFC 5322 message, writes a pre-send audit row,
// hands the bytes to SES SendEmail, then writes the post-send outcome row.
// Prints the SES MessageId, the RFC Message-ID, the audit_id, and timestamp.
//
//   pnpm tsx src/bin/send-email.ts \
//     --from test@nille.net \
//     --to alice@example.com \
//     --subject "Hello" \
//     --text "Hi there." \
//     [--cc c@example.com] [--bcc d@example.com] \
//     [--html "<p>Hi.</p>"] \
//     [--in-reply-to "<orig@example.com>"] \
//     [--references "<orig@example.com> <earlier@example.com>"]
//
// Required env:
//   AWS_REGION
//   OPENSESAME_AUDIT_TABLE
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_BODY_CHUNKS_TABLE
//   OPENSESAME_RAW_MIME_BUCKET
//
// Optional env (ADR-0019):
//   OPENSESAME_SUPPRESSIONS_TABLE — when set, sendWithAudit consults the
//     list before calling SES and refuses sends to suppressed recipients
//     unless `--allow-suppressed` is passed.
//
// Layer 2 of ADR-0008 (the IAM `ses:FromAddress` policy condition) is not
// wired in this slice — the CLI runs under the operator's admin profile.
// When the send path moves into a Lambda or MCP-server role, the role will
// pick up the constraint via CDK; this driver stays as an operator tool.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { composeRawMime, type ComposeInput } from "../core/composer.js";
import { persistOutbound } from "../core/persist-outbound.js";
import { sendWithAudit } from "../core/send-with-audit.js";
import { makeDynamoAuditLog } from "../aws/dynamodb-audit.js";
import { makeDynamoMessageStore } from "../aws/dynamodb.js";
import { makeDynamoSuppressionList } from "../aws/dynamodb-suppression.js";
import { makeS3RawMessageWriter } from "../aws/s3-raw-store.js";
import { makeSesOutboundMailer } from "../aws/ses.js";
import { SuppressionBlockError } from "../core/suppression.js";

type Args = {
  region: string;
  auditTable: string;
  messagesTable: string;
  bodyChunksTable: string;
  rawMimeBucket: string;
  configurationSetName: string | null;
  // ADR-0019: optional. When set, the CLI constructs a SuppressionList
  // and the pre-flight gate runs before SES.send.
  suppressionsTable: string | null;
  // ADR-0019: explicit per-invocation override — bypass the suppression
  // check. Audit row records `allow_suppressed: true` for forensics.
  allowSuppressed: boolean;
  compose: ComposeInput;
};

function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let subject: string | null = null;
  let bodyText: string | null = null;
  let bodyHtml: string | undefined;
  let inReplyTo: string | undefined;
  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  let references: string[] | undefined;
  let allowSuppressed = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Boolean flags have no value, so handle them before the value-bearing
    // cases that need `argv[i + 1]`.
    if (a === "--allow-suppressed") {
      allowSuppressed = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) break;
    switch (a) {
      case "--from":
        from = next;
        i++;
        break;
      case "--to":
        to.push(next);
        i++;
        break;
      case "--cc":
        cc.push(next);
        i++;
        break;
      case "--bcc":
        bcc.push(next);
        i++;
        break;
      case "--subject":
        subject = next;
        i++;
        break;
      case "--text":
        bodyText = next;
        i++;
        break;
      case "--html":
        bodyHtml = next;
        i++;
        break;
      case "--in-reply-to":
        inReplyTo = next;
        i++;
        break;
      case "--references":
        // Whitespace-separated list per RFC 5322 §3.6.4.
        references = next.split(/\s+/).filter((s) => s.length > 0);
        i++;
        break;
    }
  }

  if (from === null || subject === null || bodyText === null || to.length === 0) {
    throw new Error(
      "usage: send-email --from <addr> --to <addr> [--to ...] --subject <s> --text <s> " +
        "[--cc ...] [--bcc ...] [--html <s>] [--in-reply-to <id>] [--references \"<id1> <id2>\"] " +
        "[--allow-suppressed]",
    );
  }

  // Build ComposeInput without ever setting optional fields to undefined —
  // the project's tsconfig enables exactOptionalPropertyTypes.
  const compose: ComposeInput = { from, to, subject, bodyText };
  if (cc.length > 0) compose.cc = cc;
  if (bcc.length > 0) compose.bcc = bcc;
  if (bodyHtml !== undefined) compose.bodyHtml = bodyHtml;
  if (inReplyTo !== undefined) compose.inReplyTo = inReplyTo;
  if (references !== undefined) compose.references = references;

  // Optional in solo-direct mode (slice 4 not deployed yet); when present,
  // SES emits Bounce/Complaint/DeliveryDelay events to the destination.
  const configurationSetName = process.env["OPENSESAME_SES_CONFIG_SET"] ?? null;
  // ADR-0019: optional. Slice-4-only deployments leave this unset and the
  // pre-flight gate is skipped (back-compat).
  const suppressionsTable =
    process.env["OPENSESAME_SUPPRESSIONS_TABLE"] ?? null;

  return {
    region: requireEnv("AWS_REGION"),
    auditTable: requireEnv("OPENSESAME_AUDIT_TABLE"),
    messagesTable: requireEnv("OPENSESAME_MESSAGES_TABLE"),
    bodyChunksTable: requireEnv("OPENSESAME_BODY_CHUNKS_TABLE"),
    rawMimeBucket: requireEnv("OPENSESAME_RAW_MIME_BUCKET"),
    configurationSetName,
    suppressionsTable,
    allowSuppressed,
    compose,
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const composed = composeRawMime(args.compose, { now: () => new Date() });

  const ses = new SESv2Client({ region: args.region });
  const mailerDeps: Parameters<typeof makeSesOutboundMailer>[0] = {
    client: ses,
    now: () => new Date(),
  };
  if (args.configurationSetName !== null) {
    mailerDeps.configurationSetName = args.configurationSetName;
  }
  const mailer = makeSesOutboundMailer(mailerDeps);

  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: args.region }),
  );
  const auditLog = makeDynamoAuditLog({
    client: ddb,
    auditTable: args.auditTable,
  });

  const sendInput: Parameters<typeof sendWithAudit>[0]["input"] = {
    from: composed.fromAddress,
    to: args.compose.to,
    subject: args.compose.subject,
    rfcMessageId: composed.messageId,
    raw: composed.raw,
    envelopeTo: composed.envelopeTo,
  };
  if (args.compose.cc !== undefined) sendInput.cc = args.compose.cc;
  if (args.compose.bcc !== undefined) sendInput.bcc = args.compose.bcc;

  // Build SendWithAuditDeps without ever assigning undefined to the optional
  // fields — exactOptionalPropertyTypes forbids that.
  const sendDeps: Parameters<typeof sendWithAudit>[0] = {
    mailer,
    auditLog,
    input: sendInput,
    now: () => new Date(),
    warn: (m) => process.stderr.write(`[warn] ${m}\n`),
  };
  if (args.suppressionsTable !== null) {
    sendDeps.suppressionList = makeDynamoSuppressionList({
      client: ddb,
      suppressionsTable: args.suppressionsTable,
    });
  }
  if (args.allowSuppressed) {
    sendDeps.allowSuppressed = true;
  }

  const result = await sendWithAudit(sendDeps);

  // ADR-0017: persist the outbound copy after SES accepted. Failure here is
  // degraded but acceptable — the message went out and audit closed cleanly.
  // Surface the error to stderr so operator runs see the cause.
  let persisted: Awaited<ReturnType<typeof persistOutbound>> | null = null;
  try {
    const rawWriter = makeS3RawMessageWriter({
      client: new S3Client({ region: args.region }),
    });
    const store = makeDynamoMessageStore({
      client: ddb,
      messagesTable: args.messagesTable,
      bodyChunksTable: args.bodyChunksTable,
    });
    persisted = await persistOutbound(
      {
        raw: composed.raw,
        fromAddress: composed.fromAddress,
        composerMessageId: composed.messageId,
        sesMessageId: result.ses_message_id,
        sentAt: result.sent_at,
        awsRegion: args.region,
        rawMimeBucket: args.rawMimeBucket,
      },
      { store, rawWriter },
    );
  } catch (err) {
    process.stderr.write(
      `[warn] persist outbound copy failed (send still succeeded): ${(err as Error).message}\n`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        message_id: composed.messageId,
        ses_message_id: result.ses_message_id,
        stored_message_id: persisted?.storedMessageId ?? null,
        sent_at: result.sent_at,
        audit_id: result.audit_id,
        from_address: composed.fromAddress,
        envelope_to: composed.envelopeTo,
        outbound_internal_id: persisted?.internalId ?? null,
        outbound_s3_uri: persisted?.rawS3Uri ?? null,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  // ADR-0019: blocked sends are a normal terminal state, not a crash. Print
  // the offender list to stderr without the stack and exit non-zero with a
  // distinctive code so smoke drivers can branch on it.
  if (err instanceof SuppressionBlockError) {
    process.stderr.write(`send-email blocked: ${err.message}\n`);
    process.stderr.write(
      "Pass --allow-suppressed to override (audit row records the override).\n",
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`send-email failed: ${(err as Error).stack ?? err}\n`);
  process.exitCode = 1;
});
