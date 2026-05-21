# Outbound composer: hand-rolled RFC 5322, SESv2 SendEmail, and accepting that SES rewrites the Message-ID

ADR-0007 commits to `send_email` / `reply_to_email` as v1 MCP primitives. ADR-0008 commits to the defense-in-depth enforcement model (MCP grant + IAM `ses:FromAddress`). This ADR pins the **outbound composer + SES adapter** shape that lands in slice 1: pure raw-MIME builder in core, SESv2 `SendEmail` adapter behind a port, and the explicit acceptance that SES regenerates the RFC `Message-ID` on accepted sends.

## Decision

### Composer produces raw RFC 5322 bytes; nothing else

`composeRawMime(input, deps) → { raw, messageId, fromAddress, envelopeTo }` builds a UTF-8 byte stream ready for SESv2 `SendEmail` with `Content.Raw.Data`. No SES dependency, no audit log, no DDB write — those live in higher-layer slices. The composer is a pure function of `(input, now, randomBytes)`.

Inputs map 1:1 onto ADR-0007:

```ts
ComposeInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
};
```

Body shape:
- `bodyText` only → single-part `text/plain; charset="utf-8"`, quoted-printable.
- `bodyText` + `bodyHtml` → `multipart/alternative` with text/plain first, text/html second (RFC 2046 §5.1.4 — least-capable form first so the recipient picks the richest they understand).

Header conventions:
- Generated `Message-ID` in the form `<{ULID}@{from-domain}>` so the local part is lex-sortable and the domain matches the sending identity. (SES rewrites this on the wire — see "Trade-offs accepted".)
- `Date` in RFC 5322 fixed-offset form, always `+0000` (UTC). Local-time formatting is operator presentation, not on-the-wire concern.
- Non-ASCII subject and display names go through RFC 2047 encoded-words (`=?utf-8?B?…?=`). The addr-spec (`local@domain`) is left alone — IDN/SMTPUTF8 is out of v1 scope.
- `Bcc` is **never** rendered on the wire. Bcc recipients live only in `envelopeTo`, which the SES adapter passes as `Destination.ToAddresses`.

Quoted-printable transfer encoding chosen over base64 for human-readable wire bytes. Bodies with mostly ASCII look like ASCII; only non-ASCII bytes get `=XX`. Soft line breaks at 75 columns per RFC 2045 §6.7.

### SESv2 `SendEmail` with `Content.Raw.Data`

The adapter calls `SendEmailCommand({ FromEmailAddress, Destination.ToAddresses, Content.Raw.Data })`. SESv2 is the current API; the legacy `SendRawEmail` (SES classic) was deprecated for new development. Functionally identical for our purposes — both accept raw MIME and respect the `From:` header on the wire.

The adapter returns `{ sesMessageId, sentAt }` separately from the composer's RFC `messageId`. They are different values and downstream code MUST treat them as such (see below).

### SES regenerates the RFC `Message-ID` header on accepted sends

Live verification confirmed: the composer emitted `<01KS5FB0BETTBVZDSM9GQ20B7Y@nille.net>` and SES delivered the message with `Message-ID: <0110019e4af585ab-c072c1c8-9db7-431c-8104-603dd0c3b7fa-000000@eu-north-1.amazonses.com>`. The SES `MessageId` returned by the API matches the local part of the rewritten header.

This is undocumented in the SESv2 API reference but observable in every accepted send. The rationale (inferred from SES feedback notification topology): SES needs a stable ID to thread bounce/complaint notifications back to the sender, and using the operator-supplied `Message-ID` would break feedback if the operator omitted it or used a non-unique value.

**Consequence:** the composer's `messageId` is the RFC ID *we attempted to send* and is the right value for our own audit logs. The `sesMessageId` returned by the adapter is the RFC ID the *recipient* will see. Threading (`In-Reply-To` / `References`) on inbound replies will quote the SES-rewritten ID, not ours.

For ADR-0007's `reply_to_email`, this means: when constructing a reply, look up the original message by its **stored** `message_id` (which is what the recipient saw — the SES-rewritten form for outbound, the sender's form for inbound), not by what we originally generated. The threading doc string on `reply_to_email` should make this explicit.

## Considered and rejected

- **Pull in `nodemailer` or `mailparser` for the composer.** Both are battle-tested but bring substantial dep weight (nodemailer pulls in a full SMTP transport we don't use; mailparser overlaps with our parser). The composer surface is small (~250 lines) and the encoding rules are frozen RFCs — same calculus as ULID/base32: hand-roll, audit, move on. Aligns with the "small primitives in tree" stance applied earlier in this codebase.
- **Use `Content.Simple` (key/value fields) instead of `Content.Raw`.** SESv2 simple content auto-builds the MIME, which sounds attractive, but it strips control over the exact `Message-ID`, `Date`, and threading headers. It also doesn't carry `In-Reply-To` / `References` cleanly. Raw is the only viable shape for full RFC 5322 control.
- **Force operator-supplied Message-ID by writing it post-send.** SES does not expose a knob to preserve the incoming `Message-ID`. The closest workaround is configuring an [identity-level "Send raw email" feature flag](https://docs.aws.amazon.com/ses/latest/dg/send-using-message-id.html) that's account-scoped and undocumented in v2. Not worth the ops complexity for v1.
- **Strip Bcc from the input rather than only from the wire.** Some implementations refuse to accept `bcc[]` and require the operator to handle envelope hand-off externally. We accept Bcc and resolve it ourselves — that's the whole point of the API.

## Trade-offs accepted

- **`messageId` returned by the composer is informational, not authoritative.** Callers that persist outbound copies (slice 3) MUST store the SES-rewritten ID under `message_id` so threading round-trips. The composer's value belongs in the audit log under a different field name (e.g. `attempted_message_id`).
- **No DKIM signing in the composer.** SES signs with the sending identity's keys when DKIM is configured for the domain (verified live: `dkim=pass header.i=@nille.net` on a self-loopback). The composer is DKIM-naive — adding it here would duplicate work SES does for free.
- **Solo-direct mode is implied.** ADR-0008 Layer 1 (MCP grant check) is a no-op in solo-direct (ADR-0006). Layer 2 (IAM `ses:FromAddress`) is **not yet wired** in slice 1 — the CLI runs under the operator's admin profile and SES allows any verified identity. When the send path moves into a Lambda or MCP-server role, the role will pick up the constraint via CDK; this is a slice-2-or-later concern.
- **Bcc rendering is implementation-trusted.** A composer bug that emits `Bcc:` on the wire would leak addresses. Mitigation: explicit test (`test/composer.test.ts` — "never emits Bcc on the wire even when bcc[] is set") that asserts both the absent `Bcc:` header and the absent recipient string anywhere in `raw`.
- **Sandbox SES limits live verification.** This account has `ProductionAccessEnabled: false`; outbound sends are restricted to verified identities. Slice-1 verification used a `test@nille.net → test@nille.net` self-loopback, which is sufficient to exercise the composer + SES adapter + DKIM + inbound round-trip but does not exercise multi-recipient, cross-domain, or bounce-handling paths. Production-access request is operational follow-up, not a code change.
