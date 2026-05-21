import { describe, expect, it, vi } from "vitest";
import { makeEventBridgePublisher } from "../src/aws/eventbridge.js";
import type { MailIngestedEvent } from "../src/core/event.js";

// Hand-built event matching ADR-0010's envelope. Tests assert on what the
// adapter does to it, not on event composition (that's covered by event tests).
const SAMPLE_EVENT: MailIngestedEvent = {
  schema_version: "1",
  event_type: "MailIngested",
  event_id: "01HF7E0000000000000000EVENTX",
  occurred_at: "2026-05-19T14:23:11.482Z",
  deployment_id: "deploy-acme-prod",
  data: {
    message_id: "<msg-1@example.com>",
    internal_id: "01HF7E0000000000000000DYNAMO",
    address: "alice@acme.com",
    received_at: "2026-05-19T14:23:10.901Z",
    from: { address: "sender@example.com", name: "Sender Name" },
    to: [{ address: "alice@acme.com", name: null }],
    cc: [],
    subject: "Re: Q2 invoice",
    in_reply_to: null,
    references: [],
    thread_id: null,
    size_bytes: 28934,
    has_attachments: false,
    attachment_count: 0,
    attachments: [],
    auto_submitted: "no",
    list_id: null,
    custom_headers: {},
    spam_verdict: "PASS",
    virus_verdict: "PASS",
    dkim_verdict: "PASS",
    spf_verdict: "PASS",
    dmarc_verdict: "PASS",
    raw_s3_uri: "s3://bucket/2026/05/19/msg.eml",
  },
};

// Minimal client stub. The real EventBridgeClient.send takes a Command and
// returns a response shape; we only need to capture the command's input and
// hand back a shape the adapter can read.
type SendInput = { Entries: PutEventsRequestEntry[] };
type PutEventsRequestEntry = {
  Source: string;
  DetailType: string;
  Detail: string;
  Resources: string[];
  EventBusName?: string;
  Time?: Date;
};
type SendResponse = {
  FailedEntryCount?: number;
  Entries?: { ErrorCode?: string; ErrorMessage?: string }[];
};
type StubClient = {
  send: ReturnType<typeof vi.fn>;
};

function makeStubClient(
  response: SendResponse = { FailedEntryCount: 0 },
): StubClient {
  return {
    send: vi.fn(async () => response),
  };
}

function lastSendInput(client: StubClient): SendInput {
  // The adapter calls client.send(new PutEventsCommand({Entries: [...]})).
  // Commands carry their input on `.input` per the AWS SDK v3 convention.
  const lastCall = client.send.mock.calls.at(-1);
  if (!lastCall) throw new Error("send was not called");
  const command = lastCall[0] as { input: SendInput };
  return command.input;
}

describe("makeEventBridgePublisher", () => {
  it("publishes a single PutEvents entry with the ADR-0010 routing keys", async () => {
    const client = makeStubClient();
    const publish = makeEventBridgePublisher({
      client: client as never,
      eventBusName: "opensesame-bus",
    });

    await publish(SAMPLE_EVENT);

    expect(client.send).toHaveBeenCalledTimes(1);
    const input = lastSendInput(client);
    expect(input.Entries).toHaveLength(1);
    const entry = input.Entries[0]!;
    expect(entry.Source).toBe("opensesame");
    expect(entry.DetailType).toBe("MailIngested");
    expect(entry.EventBusName).toBe("opensesame-bus");
  });

  it("scopes Resources by the synthetic address ARN per ADR-0010", async () => {
    // The ARN is not an AWS-recognized ARN; it exists only as an EventBridge
    // filter target. ADR-0010 documents this verbatim — the test pins it so
    // the shape doesn't drift.
    const client = makeStubClient();
    const publish = makeEventBridgePublisher({
      client: client as never,
      eventBusName: "opensesame-bus",
    });

    await publish(SAMPLE_EVENT);

    const entry = lastSendInput(client).Entries[0]!;
    expect(entry.Resources).toEqual(["arn:opensesame:address:alice@acme.com"]);
  });

  it("serializes the full envelope into Detail as JSON", async () => {
    const client = makeStubClient();
    const publish = makeEventBridgePublisher({
      client: client as never,
      eventBusName: "opensesame-bus",
    });

    await publish(SAMPLE_EVENT);

    const entry = lastSendInput(client).Entries[0]!;
    // Round-trip — Detail must be a JSON string of the entire envelope, not
    // just `data`. EventBridge's "detail" maps to envelope here so consumers
    // see schema_version + event_id at the top level.
    expect(JSON.parse(entry.Detail)).toEqual(SAMPLE_EVENT);
  });

  it("throws when FailedEntryCount > 0 so SQS retry can drive recovery", async () => {
    // Per ADR-0012 the composer/Lambda must surface publish failures so SQS
    // visibility timeout retries. EventBridge can return 200 with partial
    // failures inside Entries[].ErrorCode — the adapter must catch that.
    const client = makeStubClient({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "oops" }],
    });
    const publish = makeEventBridgePublisher({
      client: client as never,
      eventBusName: "opensesame-bus",
    });

    await expect(publish(SAMPLE_EVENT)).rejects.toThrow(/InternalFailure/);
  });

  it("propagates SDK errors verbatim", async () => {
    const boom = new Error("ServiceUnavailable");
    const client: StubClient = {
      send: vi.fn(async () => {
        throw boom;
      }),
    };
    const publish = makeEventBridgePublisher({
      client: client as never,
      eventBusName: "opensesame-bus",
    });

    await expect(publish(SAMPLE_EVENT)).rejects.toBe(boom);
  });
});
