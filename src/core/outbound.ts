// Port for the outbound mailer (ADR-0007 `send_email`). Pure types in core;
// the SES-bound implementation lives in src/aws/ses.ts.
//
// The composer (src/core/composer.ts) produces the inputs to this port:
//   - raw          : RFC 5322 bytes (already includes From/To/Cc on the wire).
//   - fromAddress  : bare addr-spec, used as the SES envelope `Source`.
//   - envelopeTo   : full recipient list including Bcc, used as `Destinations`.

export type OutboundSendInput = {
  raw: Uint8Array;
  fromAddress: string;
  envelopeTo: string[];
};

export type OutboundSendResult = {
  // SES MessageId — distinct from the RFC `Message-ID` header. We surface
  // both: the composer's RFC Message-ID is what RFC clients see; the SES
  // MessageId is what AWS uses internally and in delivery notifications.
  sesMessageId: string;
  sentAt: string;
};

export interface OutboundMailer {
  send(input: OutboundSendInput): Promise<OutboundSendResult>;
}
