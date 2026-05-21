import { describe, expect, it } from "vitest";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { makeSesOutboundMailer } from "../src/aws/ses.js";

type CommandLike = { input: unknown };

function makeStubClient(
  reply: { messageId: string } | Error,
): { client: SESv2Client; sent: CommandLike[] } {
  const sent: CommandLike[] = [];
  const client = {
    async send(cmd: CommandLike) {
      sent.push(cmd);
      if (reply instanceof Error) throw reply;
      return { MessageId: reply.messageId };
    },
  } as unknown as SESv2Client;
  return { client, sent };
}

const FIXED_NOW = new Date("2026-05-21T13:00:00.000Z");

describe("makeSesOutboundMailer", () => {
  it("calls SES SendEmail with raw bytes, FromEmailAddress, and Destinations", async () => {
    const { client, sent } = makeStubClient({ messageId: "ses-msg-1" });
    const mailer = makeSesOutboundMailer({ client, now: () => FIXED_NOW });

    const raw = new TextEncoder().encode("From: a@b.com\r\n\r\nhi");
    const result = await mailer.send({
      raw,
      fromAddress: "a@b.com",
      envelopeTo: ["c@d.com", "e@f.com"],
    });

    expect(sent.length).toBe(1);
    expect(sent[0]).toBeInstanceOf(SendEmailCommand);
    const input = sent[0]!.input as {
      FromEmailAddress?: string;
      Destination?: { ToAddresses?: string[] };
      Content?: { Raw?: { Data?: Uint8Array } };
    };
    expect(input.FromEmailAddress).toBe("a@b.com");
    expect(input.Destination?.ToAddresses).toEqual(["c@d.com", "e@f.com"]);
    expect(input.Content?.Raw?.Data).toBe(raw);

    expect(result.sesMessageId).toBe("ses-msg-1");
    expect(result.sentAt).toBe("2026-05-21T13:00:00.000Z");
  });

  it("propagates SES errors", async () => {
    const { client } = makeStubClient(
      new Error("MessageRejected: Email address is not verified"),
    );
    const mailer = makeSesOutboundMailer({ client, now: () => FIXED_NOW });

    await expect(
      mailer.send({
        raw: new Uint8Array(),
        fromAddress: "x@y.com",
        envelopeTo: ["z@w.com"],
      }),
    ).rejects.toThrow(/MessageRejected/);
  });

  it("throws when SES returns no MessageId (defensive)", async () => {
    const { client } = makeStubClient({ messageId: "" });
    const mailer = makeSesOutboundMailer({ client, now: () => FIXED_NOW });

    await expect(
      mailer.send({
        raw: new Uint8Array(),
        fromAddress: "x@y.com",
        envelopeTo: ["z@w.com"],
      }),
    ).rejects.toThrow(/MessageId/);
  });

  it("attaches ConfigurationSetName when supplied (ADR-0018)", async () => {
    // With the bounce-handler stack deployed, the operator wires
    // OPENSESAME_SES_CONFIG_SET into the CLI driver so SES emits delivery
    // events. Adapter must thread the value through verbatim.
    const { client, sent } = makeStubClient({ messageId: "ses-msg-1" });
    const mailer = makeSesOutboundMailer({
      client,
      now: () => FIXED_NOW,
      configurationSetName: "opensesame-default",
    });

    await mailer.send({
      raw: new Uint8Array(),
      fromAddress: "a@b.com",
      envelopeTo: ["c@d.com"],
    });

    const input = sent[0]!.input as { ConfigurationSetName?: string };
    expect(input.ConfigurationSetName).toBe("opensesame-default");
  });

  it("omits ConfigurationSetName entirely when no config set is configured", async () => {
    // Solo-direct mode without the bounce stack: the adapter must NOT
    // attach an empty string (SES rejects that as an invalid name).
    const { client, sent } = makeStubClient({ messageId: "ses-msg-1" });
    const mailer = makeSesOutboundMailer({ client, now: () => FIXED_NOW });

    await mailer.send({
      raw: new Uint8Array(),
      fromAddress: "a@b.com",
      envelopeTo: ["c@d.com"],
    });

    const input = sent[0]!.input as { ConfigurationSetName?: string };
    expect(input.ConfigurationSetName).toBeUndefined();
  });
});
