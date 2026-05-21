# Use RFC 5322 `Sender:` for agent on-behalf-of, not a custom AI header

Open Sesame supports two send modes when an Agent acts under a Human's address, modeled on Microsoft Exchange's long-standing "Send As" / "Send on Behalf" distinction:

- **send-on-behalf-of** (disclosed): `From:` = human, `Sender:` = agent. Major MUAs render a "via" badge. Standards-compliant under RFC 5322.
- **send-as** (stealth): `From:` = human, no `Sender:` header. Wire-level indistinguishable from the human sending directly. Authentication (DKIM/SPF/DMARC) still passes because the message originates from the same domain via SES.

Mode is fixed per Grant — the human granting authority chooses the disclosure level, the agent cannot pick at runtime. A separate orthogonal Grant property, **autonomy mode**, controls whether `Auto-Submitted: auto-generated` (RFC 3834) is emitted.

We considered an `X-AI-Generated`-style custom header but rejected it: there is no industry-standard "this email was AI-generated" header today, and RFC 6648 deprecates new `X-` prefixes. For the disclosed mode, `Sender:` is already rendered by major MUAs, giving real recipient-visible disclosure today rather than a header no client reads. We additionally emit a non-`X-` `Generated-By: open-sesame; agent=…; on-behalf-of=…` header in disclosed mode as informational documentation; it is omitted entirely in send-as mode.

The ethical trade-off — that `send-as` + `autonomous` together let an agent send mail in a human's voice without that human reviewing each message — is surfaced by treating disclosure and autonomy as separate grant axes, so a human can authorize stealth-but-interactive without simultaneously authorizing stealth-and-autonomous.

Granting `send-as` requires an explicit written acknowledgement step in the grant UI (typed confirmation of what stealth sending means) before the grant is created. `send-on-behalf-of` does not. We rejected requiring re-auth or MFA for `send-as` grants — at this stage of the product, written acknowledgement is enough friction to ensure intent without pushing users toward over-broad grants to avoid re-auth pain. Multi-user deployments may later expose an admin policy to require stronger steps.
