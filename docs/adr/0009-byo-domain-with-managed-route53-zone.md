# BYO domain, managed Route 53 hosted zone: operator owns the name, Open Sesame owns the records

The operator brings their own domain (e.g. `acme.com`). Open Sesame provisions and owns the **Route 53 hosted zone** for that domain inside the operator's AWS account. The operator copies the zone's NS records to their registrar; from that point on, every email-related DNS record (SES domain verification TXT, DKIM CNAMEs, MAIL FROM MX/SPF, DMARC) is created and maintained by Open Sesame automatically.

Configuration is a single value: `domain = "acme.com"`. There is no managed-subdomain option.

## Why a managed hosted zone (not just managed records in an existing zone)

The alternative — operator runs their own hosted zone, Open Sesame asks them to add records — works, but every DNS-touching operation (DKIM rotation, MAIL FROM setup, future SPF tweaks) becomes a manual procedure. The product's posture is "AWS-native, automatable end to end"; manual DNS edits break that. By owning the zone, the system can:

- Auto-add SES domain verification TXT and DKIM CNAMEs on `configure`.
- Auto-rotate DKIM keys on a schedule without operator involvement.
- Add new records (DMARC reporting endpoints, BIMI, MTA-STS) in future versions without a "go edit your DNS" step.
- Surface a single point of audit: "what does Open Sesame have published about this domain?" is one zone-export call.

The cost is one delegation step at the registrar — a one-time action the operator does anyway when standing up SES.

## Provisioning flow

1. Operator: `opensesame configure --domain acme.com`.
2. Open Sesame creates the Route 53 hosted zone in the operator's account.
3. Open Sesame creates the SES domain identity and DKIM tokens; CNAMEs are written into the zone.
4. The CLI prints the four NS records and instructs the operator to set them at their registrar.
5. Operator updates the registrar; propagation takes minutes-to-hours.
6. Open Sesame polls SES verification status; once verified, the domain is usable.

A hard precondition: **Open Sesame will not accept a `domain` it cannot create a hosted zone for**. If the operator already has a Route 53 hosted zone for that name, configuration fails with instructions (delete the existing zone, or use a subdomain like `mail.acme.com`). This avoids the ambiguous case where two zones for the same name compete.

## DKIM key management

DKIM is handled by **SES Easy DKIM** — SES generates the keypair, holds the private key, and exposes three CNAMEs for the public selectors. Open Sesame writes those CNAMEs into the hosted zone on provisioning. Rotation is initiated by re-requesting Easy DKIM and updating the CNAMEs; the operator is never holding key material. Considered and rejected BYODKIM (operator-supplied keys): adds key-storage responsibility, key-rotation tooling, and a recovery story for nothing the threat model demands at this stage.

## Opinionated subdomain defaults

Open Sesame ships with a fixed naming scheme so every deployment looks the same and operators don't make one-off choices. All values are derived from the configured `domain` and are not knobs in v1:

- `webmail.<domain>` — webmail UI (multi-user shape only). CloudFront in front of API Gateway → BFF Lambda.
- `mcp.<domain>` — public MCP server endpoint (solo-with-MCP and multi-user shapes), backed by AgentCore Runtime.
- `bounces.<domain>` — SES **custom MAIL FROM** domain. Required for SPF alignment so DMARC passes when `From:` is on the apex or another subdomain. Open Sesame writes the MX and SPF TXT records into the managed zone automatically.

Agent addresses use a convention rather than an enforced rule: the default for `create_agent` populates `<agent_id>-agent@<domain>` (e.g., `billing-agent@acme.com`). Operators can override per-agent at registration. The `-agent` suffix exists so a human glancing at a `From:` line can tell at a glance which side of the human/agent line a sender is on.

DKIM selectors are not configurable — SES Easy DKIM chooses them.

Considered and rejected fully-configurable subdomains: every operator picking different names means every doc, every error message, every troubleshooting conversation has to be parameterized. The cost of opinionation is one paragraph in the README ("we use these names; if you need different ones, file an issue"). The benefit is a sharply lower support and documentation burden.

## Forwarding as a future feature (out of v1)

Email forwarding (`alice@acme.com` → `alice.personal@gmail.com`) is a known-future feature, not a v1 capability. The architecture leaves room for it cleanly:

- Forwards are a property of an **Address**, expressed as zero or more forward targets.
- The ingest Lambda (which already parses every inbound message and writes to S3 + DynamoDB) becomes the natural place to also re-emit a forward via SES.
- Forwarding requires SRS (Sender Rewriting Scheme) to keep SPF intact across the relay; that is the meaningful implementation work, deferred until forwards are actually built.
- No ADR-0009 decision needs to change to enable forwards later — the managed hosted zone already has whatever DNS surface (SPF, DMARC) future forwarding needs.

## Considered and rejected

- **Managed subdomain (`you.opensesame.app`).** Rejected per the framing of ADR-0006: shared infrastructure operated by Open Sesame breaks the AWS-native, operator-owned posture. Also creates reputation/abuse risk on a shared domain.
- **BYO with operator-managed DNS.** Works, but every future DNS-touching feature becomes a manual procedure. Not worth the lower one-time setup friction.
- **Subdomain delegation only (operator keeps `acme.com`, delegates `mail.acme.com` to a Route 53 zone).** A reasonable compromise — supported implicitly, since the operator can configure `domain = "mail.acme.com"` and delegate that label. We do not need a separate code path for it.

## Trade-offs accepted

- Hard requirement: the operator must be willing to delegate a name (apex or subdomain) to a Route 53 zone in their AWS account. This excludes operators who refuse to use Route 53 — a small population given the rest of the system is AWS-native.
- One-time NS-update step at the registrar before mail can flow. Standard SES setup friction; documented clearly.
- Open Sesame becomes responsible for not breaking DNS. Mitigated by all zone writes being scoped to records Open Sesame owns (`_amazonses`, `*._domainkey`, MAIL FROM endpoints) — the operator can freely add their own records (web `A`/`AAAA`, MX for non-SES mail flows, etc.) alongside.
