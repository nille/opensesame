// BFF integration harness (PRD: bff-integration-harness).
//
// Boots `buildBffApp(deps)` with hand-rolled AWS stubs and exercises the
// RPC surface end-to-end via Hono's in-process `app.request()`. Catches
// wiring drift the unit suite can't see — the dispatcher's framework layer,
// the schema parser, the reader's SDK calls, and the dep-construction path
// in `webmail-bff.ts` all run together.
//
// Two regression cases pin past wiring bugs (slice 8.17 makeUlid omission,
// slice 8.21 `draft_id` schema strictness) so they can't ship silently again.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBffApp, type BffRuntimeConfig } from "../src/bin/webmail-bff.js";
import {
  makeStubDynamoClient,
  makeStubS3Client,
  makeStubSesClient,
  type StubDynamoClient,
  type StubS3Client,
  type StubSesClient,
} from "./support/aws-stubs.js";
import type { Hono } from "hono";

// Each test boots a fresh app + stubs. The harness is fast (sub-second per
// test) and isolated state means tests can run in any order without
// cross-talk via the in-memory tables.
type Harness = {
  app: ReturnType<typeof buildBffApp>;
  ddb: StubDynamoClient;
  s3: StubS3Client;
  ses: StubSesClient;
  config: BffRuntimeConfig;
};

const MESSAGES_TABLE = "opensesame-messages-test";
const BODY_CHUNKS_TABLE = "opensesame-body-chunks-test";
const AUDIT_TABLE = "opensesame-audit-test";
const RAW_MIME_BUCKET = "opensesame-raw-mime-test";

function makeConfig(): BffRuntimeConfig {
  return {
    region: "us-test-1",
    messagesTable: MESSAGES_TABLE,
    bodyChunksTable: BODY_CHUNKS_TABLE,
    auditTable: AUDIT_TABLE,
    rawMimeBucket: RAW_MIME_BUCKET,
    messageIdGsiName: "GSI1",
    threadIdGsiName: "ThreadIdGSI",
    suppressionsTable: null,
    configurationSetName: null,
    corsOrigin: undefined,
  };
}

function makeHarness(): Harness {
  const ddb = makeStubDynamoClient();
  const s3 = makeStubS3Client();
  const ses = makeStubSesClient();
  const config = makeConfig();
  const app = buildBffApp({
    ddb: ddb.client,
    s3: s3.client,
    ses: ses.client,
    config,
    now: () => new Date("2026-05-23T12:00:00.000Z"),
  });
  return { app, ddb, s3, ses, config };
}

async function rpc(
  app: ReturnType<typeof buildBffApp>,
  tool: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await (app as unknown as Hono).request(`/rpc/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe("BFF integration harness — drafts", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    // No teardown needed — every harness is fresh per test. The helper is
    // here so a future "leak the AWS stub state across tests" mistake is a
    // localized fix.
  });

  // Slice 8.17 regression: webmail-bff.ts originally constructed
  // makeDynamoMessageReader without `makeUlid`, so first-save threw 500.
  // Reverting commit 6432663 should make this test fail at status 500 on
  // the makeUlid throw.
  it("save_draft first-save (draft_id=null) returns 200 with a fresh ULID and writes the row", async () => {
    const { app, ddb } = h;
    const r = await rpc(app, "save_draft", {
      address: "alice@example.com",
      draft_id: null,
      body_text: "hello world",
    });
    expect(r.status).toBe(200);
    const body = r.json as { draft_id: string; created_at: string; updated_at: string };
    expect(typeof body.draft_id).toBe("string");
    expect(body.draft_id.length).toBeGreaterThanOrEqual(20);
    // Dispatcher passes `new Date()` to reader.saveDraft (not the harness's
    // injected `now`), so we just check shape — wall clock timing is
    // coupled to the dispatcher's Date constructor call site.
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const rows = ddb.dump(MESSAGES_TABLE);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      address: "alice@example.com",
      kind: "draft",
      body_text: "hello world",
      attachments: [],
    });
  });

  it("save_draft upsert (existing draft_id) returns same id and updates body_text", async () => {
    const { app } = h;
    const first = await rpc(app, "save_draft", {
      address: "alice@example.com",
      draft_id: null,
      body_text: "hello",
    });
    const draftId = (first.json as { draft_id: string }).draft_id;

    const second = await rpc(app, "save_draft", {
      address: "alice@example.com",
      draft_id: draftId,
      body_text: "hello, world",
    });
    expect(second.status).toBe(200);
    expect((second.json as { draft_id: string }).draft_id).toBe(draftId);

    const get = await rpc(app, "get_draft", {
      address: "alice@example.com",
      draft_id: draftId,
    });
    expect(get.status).toBe(200);
    expect((get.json as { body_text: string }).body_text).toBe("hello, world");
  });

  // Slice 8.21 regression: composer omitted `draft_id` from the wire body.
  // The schema requires it (null or string). Reverting commit 6432663 in
  // src/bff/schemas.ts would let the missing key slip through; this test
  // pins the 400 response shape.
  it("save_draft without draft_id key returns 400 with field=draft_id", async () => {
    const { app } = h;
    const r = await rpc(app, "save_draft", {
      address: "alice@example.com",
      body_text: "no draft_id here",
    });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({
      code: "invalid_request",
      field: "draft_id",
      reason: "missing",
    });
  });
});

describe("BFF integration harness — read_inbox", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("read_inbox returns seeded message rows and excludes drafts", async () => {
    const { app, ddb } = h;
    // Two real message rows + one draft row sharing the same address. The
    // BETWEEN bound on internal_id should exclude the draft (DRAFT# SK
    // sorts above the 0-7 ULID range).
    ddb.seed(MESSAGES_TABLE, {
      address: "alice@example.com",
      internal_id: "01HX0000000000000000MSGAAA",
      received_at: "2026-05-22T10:00:00.000Z",
      parse_status: "ok",
      schema_v: "1",
      message_id: "<a@example.com>",
      from_raw: "Bob <bob@example.com>",
      to_raw: "alice@example.com",
      subject: "first",
      snippet: "hello",
      raw_s3_uri: "s3://bucket/a.eml",
      direction: "in",
    });
    ddb.seed(MESSAGES_TABLE, {
      address: "alice@example.com",
      internal_id: "01HX0000000000000000MSGBBB",
      received_at: "2026-05-22T11:00:00.000Z",
      parse_status: "ok",
      schema_v: "1",
      message_id: "<b@example.com>",
      from_raw: "Carol <carol@example.com>",
      to_raw: "alice@example.com",
      subject: "second",
      snippet: "world",
      raw_s3_uri: "s3://bucket/b.eml",
      direction: "in",
    });
    ddb.seed(MESSAGES_TABLE, {
      address: "alice@example.com",
      internal_id: "DRAFT#01HX0000000000000000DRAFT",
      kind: "draft",
      schema_v: "1",
      body_text: "wip",
    });

    const r = await rpc(app, "read_inbox", { address: "alice@example.com" });
    expect(r.status).toBe(200);
    const body = r.json as { messages: Array<{ message_id: string }> };
    expect(body.messages).toHaveLength(2);
    // ScanIndexForward=false → newest first.
    expect(body.messages[0]!.message_id).toBe("<b@example.com>");
    expect(body.messages[1]!.message_id).toBe("<a@example.com>");
  });
});

describe("BFF integration harness — get_message", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("get_message returns body_html when raw MIME has an HTML part (slice 8.21 rehydrate)", async () => {
    const { app, ddb, s3 } = h;
    // Seed a message row plus a single text body chunk + raw MIME with HTML.
    ddb.seed(MESSAGES_TABLE, {
      address: "alice@example.com",
      internal_id: "01HX0000000000000000MSGRTH",
      received_at: "2026-05-22T10:00:00.000Z",
      parse_status: "ok",
      schema_v: "1",
      message_id: "<rich@example.com>",
      from_raw: "Bob <bob@example.com>",
      to_raw: "alice@example.com",
      subject: "rich text",
      headers_blob: "From: Bob <bob@example.com>\r\nTo: alice@example.com\r\n",
      raw_s3_uri: `s3://${RAW_MIME_BUCKET}/inbound/rich.eml`,
      direction: "in",
    });
    ddb.seed(BODY_CHUNKS_TABLE, {
      internal_id: "01HX0000000000000000MSGRTH",
      chunk_seq: "0000",
      text: "plain body",
      start_byte: 0,
      end_byte: 10,
    });
    const rawMime = [
      "From: Bob <bob@example.com>",
      "To: alice@example.com",
      "Subject: rich text",
      "Message-ID: <rich@example.com>",
      'Content-Type: multipart/alternative; boundary="b1"',
      "MIME-Version: 1.0",
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain body",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>rich <strong>text</strong></p>",
      "--b1--",
      "",
    ].join("\r\n");
    s3.seed(
      RAW_MIME_BUCKET,
      "inbound/rich.eml",
      new TextEncoder().encode(rawMime),
    );

    const r = await rpc(app, "get_message", { message_id: "<rich@example.com>" });
    expect(r.status).toBe(200);
    const body = r.json as {
      parse_status: string;
      body_text: string;
      body_html: string | null;
    };
    expect(body.parse_status).toBe("ok");
    expect(body.body_text).toBe("plain body");
    expect(body.body_html).not.toBeNull();
    expect(body.body_html).toContain("<strong>text</strong>");
  });
});

describe("BFF integration harness — send_email", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("send_email happy path: SES stub records the call, audit row written, outbound copy persisted", async () => {
    const { app, ddb, s3, ses } = h;
    const r = await rpc(app, "send_email", {
      from: "alice@example.com",
      to: ["bob@example.com"],
      subject: "hi",
      body_text: "hello bob",
    });
    expect(r.status).toBe(200);
    const body = r.json as { message_id: string; sent_at: string };
    expect(body.message_id).toMatch(/^<.+@.+>$/);
    expect(body.sent_at).toBe("2026-05-23T12:00:00.000Z");

    // SES received the SendEmailCommand.
    expect(ses.state.sends).toHaveLength(1);
    expect(ses.state.sends[0]!.fromEmailAddress).toBe("alice@example.com");
    expect(ses.state.sends[0]!.destinationToAddresses).toEqual(["bob@example.com"]);
    expect(ses.state.sends[0]!.rawData).toBeInstanceOf(Uint8Array);

    // Audit log: one send_attempted row turned into send_succeeded by the
    // outcome write (UpdateCommand on the same audit_id PK).
    const auditRows = ddb.dump(AUDIT_TABLE);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      type: "send_succeeded",
      ses_message_id: expect.stringMatching(/^stub-ses-/),
    });

    // Outbound copy: raw bytes in S3 under outbound/<sesId> + a Messages row
    // with direction=out for the sender.
    const outboundKeys = [...(s3.state.buckets.get(RAW_MIME_BUCKET)?.keys() ?? [])];
    expect(outboundKeys.some((k) => k.startsWith("outbound/"))).toBe(true);

    const messageRows = ddb.dump(MESSAGES_TABLE);
    expect(messageRows.some((row) => row["direction"] === "out")).toBe(true);
  });
});
