import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type {
  OutboundMailer,
  OutboundSendInput,
  OutboundSendResult,
} from "../core/outbound.js";

// SES-bound implementation of OutboundMailer (ADR-0007 + ADR-0008).
//
// SESv2 `SendEmail` with `Content.Raw.Data` is the modern equivalent of the
// classic `SendRawEmail`: hand it the composer's RFC 5322 bytes, set the
// envelope From and Destinations, get back a SES MessageId.
//
// Layer 2 of ADR-0008's defense-in-depth (the IAM `ses:FromAddress` condition)
// is enforced by the deployed IAM policy, not by this code. If the From
// address isn't verified or is outside the allowed domain, SES rejects the
// call and the error propagates through `send`.

export type SesOutboundMailerDeps = {
  client: SESv2Client;
  now: () => Date;
  // Optional SES configuration set name (ADR-0018). When supplied, every
  // SendEmail call attaches it so SES emits Bounce/Complaint/DeliveryDelay
  // events to the configuration set's destination (an SNS topic in our
  // deployment). Absent in solo-direct mode where bounce wiring isn't
  // deployed yet — keeps the adapter usable without the config-set stack.
  configurationSetName?: string;
};

export function makeSesOutboundMailer(
  deps: SesOutboundMailerDeps,
): OutboundMailer {
  return {
    send: (input) => send(deps, input),
  };
}

async function send(
  deps: SesOutboundMailerDeps,
  input: OutboundSendInput,
): Promise<OutboundSendResult> {
  const commandInput: ConstructorParameters<typeof SendEmailCommand>[0] = {
    FromEmailAddress: input.fromAddress,
    Destination: { ToAddresses: input.envelopeTo },
    Content: { Raw: { Data: input.raw } },
  };
  // Attach the config-set name only when present — exactOptionalPropertyTypes
  // forbids assigning `undefined` to optional fields.
  if (deps.configurationSetName !== undefined) {
    commandInput.ConfigurationSetName = deps.configurationSetName;
  }
  const out = await deps.client.send(new SendEmailCommand(commandInput));
  if (!out.MessageId) {
    throw new Error("SES SendEmail returned empty MessageId");
  }
  return {
    sesMessageId: out.MessageId,
    sentAt: deps.now().toISOString(),
  };
}
