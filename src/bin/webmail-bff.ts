// Slice-7 BFF dev driver (ADR-0021).
//
// Boots a Hono server on 127.0.0.1:3000 that speaks the RPC envelope
// described in ADR-0021. Three tools: read_inbox, get_message, send_email.
//
//   pnpm tsx src/bin/webmail-bff.ts
//   pnpm tsx --watch src/bin/webmail-bff.ts   # hot-reload
//
// Required env (same set as the existing CLI drivers):
//   AWS_REGION
//   OPENSESAME_AUDIT_TABLE
//   OPENSESAME_MESSAGES_TABLE
//   OPENSESAME_BODY_CHUNKS_TABLE
//   OPENSESAME_RAW_MIME_BUCKET
//
// Optional env:
//   OPENSESAME_BFF_PORT          default: 3000
//   OPENSESAME_BFF_BIND          default: 127.0.0.1 (refuses non-loopback)
//   OPENSESAME_BFF_CORS_ORIGIN   default: http://localhost:5173
//   OPENSESAME_SES_CONFIG_SET    SES configuration set (slice 4+)
//   OPENSESAME_SUPPRESSIONS_TABLE  enables the pre-flight suppression gate
//   OPENSESAME_MESSAGE_ID_GSI_NAME default: GSI1
//
// SLICE-7 SAFETY: this server has no auth. The bind guard refuses anything
// other than 127.0.0.1 / ::1 / localhost. Slice 9 lifts the guard alongside
// adding Cognito JWT validation. Do not deploy this file to a non-loopback
// listener until both halves of that swap land together.

import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { makeDynamoAuditLog } from "../aws/dynamodb-audit.js";
import { makeDynamoMessageReader } from "../aws/dynamodb-reader.js";
import { makeDynamoMessageStore } from "../aws/dynamodb.js";
import { makeDynamoSuppressionList } from "../aws/dynamodb-suppression.js";
import {
  makeS3AttachmentPresigner,
  makeS3AttachmentWriter,
} from "../aws/s3-attachment-store.js";
import {
  makeS3RawMessageReader,
  makeS3RawMessageWriter,
} from "../aws/s3-raw-store.js";
import { makeSesOutboundMailer } from "../aws/ses.js";
import { makeHonoApp } from "../bff/hono-app.js";
import { composeRawMime, type ComposeInput } from "../core/composer.js";
import { persistOutbound } from "../core/persist-outbound.js";
import { sendWithAudit } from "../core/send-with-audit.js";
import type { SendEmailInput } from "../bff/schemas.js";
import type { SendEmailResult } from "../bff/dispatcher.js";

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function main(): void {
  const region = requireEnv("AWS_REGION");
  const messagesTable = requireEnv("OPENSESAME_MESSAGES_TABLE");
  const bodyChunksTable = requireEnv("OPENSESAME_BODY_CHUNKS_TABLE");
  const auditTable = requireEnv("OPENSESAME_AUDIT_TABLE");
  const rawMimeBucket = requireEnv("OPENSESAME_RAW_MIME_BUCKET");
  const messageIdGsiName =
    process.env["OPENSESAME_MESSAGE_ID_GSI_NAME"] ?? "GSI1";
  const threadIdGsiName =
    process.env["OPENSESAME_THREAD_ID_GSI_NAME"] ?? "ThreadIdGSI";
  const suppressionsTable =
    process.env["OPENSESAME_SUPPRESSIONS_TABLE"] ?? null;
  const configurationSetName =
    process.env["OPENSESAME_SES_CONFIG_SET"] ?? null;
  // Default lets either loopback variant in (Vite uses 127.0.0.1, humans
  // type localhost). The env override stays a single string for slice 9.
  const corsOriginEnv = process.env["OPENSESAME_BFF_CORS_ORIGIN"];
  const corsOrigin: string | string[] | undefined =
    corsOriginEnv === undefined ? undefined : corsOriginEnv;

  const port = Number.parseInt(
    process.env["OPENSESAME_BFF_PORT"] ?? "3000",
    10,
  );
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`OPENSESAME_BFF_PORT must be a valid port, got ${port}`);
  }
  const bind = process.env["OPENSESAME_BFF_BIND"] ?? "127.0.0.1";
  if (!LOOPBACK_BINDS.has(bind)) {
    throw new Error(
      `OPENSESAME_BFF_BIND must be a loopback address (127.0.0.1, localhost, ::1) — slice 7 has no auth. Got: ${bind}`,
    );
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const reader = makeDynamoMessageReader({
    client: ddb,
    messagesTable,
    bodyChunksTable,
    messageIdGsiName,
    threadIdGsiName,
  });
  const auditLog = makeDynamoAuditLog({ client: ddb, auditTable });
  const sesClient = new SESv2Client({ region });
  const s3 = new S3Client({ region });

  const sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
    const compose: ComposeInput = {
      from: input.from,
      to: input.to,
      subject: input.subject,
      bodyText: input.body_text,
    };
    if (input.cc !== undefined) compose.cc = input.cc;
    if (input.bcc !== undefined) compose.bcc = input.bcc;
    if (input.body_html !== undefined) compose.bodyHtml = input.body_html;
    if (input.in_reply_to !== undefined) compose.inReplyTo = input.in_reply_to;
    if (input.references !== undefined) compose.references = input.references;
    if (input.attachments !== undefined && input.attachments.length > 0) {
      // Schema parser already enforced size + count caps; here we just
      // decode the base64 to bytes for the composer's multipart/mixed
      // assembly.
      compose.attachments = input.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.content_type,
        contentBytes: decodeBase64(a.content_base64),
      }));
    }

    const composed = composeRawMime(compose, { now: () => new Date() });

    const mailerDeps: Parameters<typeof makeSesOutboundMailer>[0] = {
      client: sesClient,
      now: () => new Date(),
    };
    if (configurationSetName !== null) {
      mailerDeps.configurationSetName = configurationSetName;
    }
    const mailer = makeSesOutboundMailer(mailerDeps);

    const sendInput: Parameters<typeof sendWithAudit>[0]["input"] = {
      from: composed.fromAddress,
      to: input.to,
      subject: input.subject,
      rfcMessageId: composed.messageId,
      raw: composed.raw,
      envelopeTo: composed.envelopeTo,
    };
    if (input.cc !== undefined) sendInput.cc = input.cc;
    if (input.bcc !== undefined) sendInput.bcc = input.bcc;

    const sendDeps: Parameters<typeof sendWithAudit>[0] = {
      mailer,
      auditLog,
      input: sendInput,
      now: () => new Date(),
      warn: (m) => process.stderr.write(`[warn] ${m}\n`),
    };
    if (suppressionsTable !== null) {
      sendDeps.suppressionList = makeDynamoSuppressionList({
        client: ddb,
        suppressionsTable,
      });
    }

    const result = await sendWithAudit(sendDeps);

    // Best-effort: persist the outbound copy. Failure here is degraded but
    // acceptable per ADR-0017 — SES already accepted the message.
    try {
      const rawWriter = makeS3RawMessageWriter({ client: s3 });
      const store = makeDynamoMessageStore({
        client: ddb,
        messagesTable,
        bodyChunksTable,
        attachmentWriter: makeS3AttachmentWriter({ client: s3 }),
        attachmentBucket: rawMimeBucket,
      });
      await persistOutbound(
        {
          raw: composed.raw,
          fromAddress: composed.fromAddress,
          composerMessageId: composed.messageId,
          sesMessageId: result.ses_message_id,
          sentAt: result.sent_at,
          awsRegion: region,
          rawMimeBucket,
        },
        { store, rawWriter },
      );
    } catch (err) {
      process.stderr.write(
        `[warn] persist outbound copy failed (send still succeeded): ${(err as Error).message}\n`,
      );
    }

    return {
      message_id: composed.messageId,
      sent_at: result.sent_at,
    };
  };

  const honoDeps: Parameters<typeof makeHonoApp>[0] = {
    reader,
    sendEmail,
    attachmentPresigner: makeS3AttachmentPresigner({ client: s3 }),
    attachmentBucket: rawMimeBucket,
    rawReader: makeS3RawMessageReader({ client: s3 }),
  };
  if (corsOrigin !== undefined) honoDeps.corsOrigin = corsOrigin;
  const app = makeHonoApp(honoDeps);
  const corsBanner =
    corsOrigin === undefined
      ? "http://localhost:5173, http://127.0.0.1:5173 (default)"
      : Array.isArray(corsOrigin)
        ? corsOrigin.join(", ")
        : corsOrigin;

  serve({ fetch: app.fetch, port, hostname: bind }, (info) => {
    process.stdout.write(
      [
        "",
        "  Open Sesame webmail BFF (slice 7, ADR-0021)",
        `  listening on http://${info.address}:${info.port}`,
        `  CORS origin:  ${corsBanner}`,
        `  AWS region:   ${region}`,
        `  suppressions: ${suppressionsTable ? "enabled" : "disabled (no OPENSESAME_SUPPRESSIONS_TABLE)"}`,
        "",
        "  ⚠  NO AUTH. Localhost-only. Do not expose externally until slice 9.",
        "",
      ].join("\n"),
    );
  });
}

function decodeBase64(s: string): Uint8Array {
  // Strip any folding whitespace tolerated by the schema parser, then
  // decode via Node's Buffer.from('…', 'base64'). Allocates once per
  // attachment; the parser already capped total bytes.
  const stripped = s.replace(/[\r\n\t ]/g, "");
  return new Uint8Array(Buffer.from(stripped, "base64"));
}

main();
