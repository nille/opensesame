# `MailIngested` event schema: thin metadata + S3 pointer, with a stable versioned envelope

The `MailIngested` event (introduced in ADR-0003) is the integration point between Open Sesame and operator-owned downstream code. It is the only externally-visible schema in v1 besides the MCP tool surface, and like the tool surface, breaking it later is expensive — so the shape is decided up front.

## Envelope

Every event published to EventBridge follows this shape:

```json
{
  "schema_version": "1",
  "event_type": "MailIngested",
  "event_id": "01HF7E…",
  "occurred_at": "2026-05-19T14:23:11.482Z",
  "deployment_id": "<stable-per-deployment>",
  "data": { … }
}
```

The envelope is the same across all event types Open Sesame may emit in the future (`MailDelivered`, `MailBounced`, `GrantCreated`, …). `schema_version` is bumped only on breaking changes; additive fields inside `data` do not bump it.

## `MailIngested.data`

```json
{
  "message_id": "<rfc-5322-Message-ID>",
  "internal_id": "<dynamodb-pk-uuid>",
  "address": "alice@acme.com",
  "received_at": "2026-05-19T14:23:10.901Z",
  "from": { "address": "sender@example.com", "name": "Sender Name" },
  "to": [{ "address": "alice@acme.com", "name": null }],
  "cc": [],
  "subject": "Re: Q2 invoice",
  "in_reply_to": "<previous-message-id>",
  "references": ["<root-message-id>", "<previous-message-id>"],
  "thread_id": "<derived-thread-id>",
  "size_bytes": 28934,
  "has_attachments": true,
  "attachment_count": 2,
  "attachments": [
    { "filename": "invoice-q2.pdf", "content_type": "application/pdf", "size_bytes": 18452 },
    { "filename": "summary.xlsx",  "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "size_bytes": 9120 }
  ],
  "auto_submitted": "no",
  "list_id": null,
  "custom_headers": {
    "x-mailer": "Acme Billing 4.2",
    "x-priority": "3"
  },
  "spam_verdict": "PASS",
  "virus_verdict": "PASS",
  "dkim_verdict": "PASS",
  "spf_verdict": "PASS",
  "dmarc_verdict": "PASS",
  "raw_s3_uri": "s3://opensesame-raw-mime-<acct>/<yyyy>/<mm>/<dd>/<message_id>.eml"
}
```

Notes:

- **No body, no body chunks, no headers blob.** The event is for routing decisions ("should I trigger an auto-responder for this address?", "is this from a known sender?"), not for content delivery. Consumers that need full content call `get_message` via MCP or fetch the raw MIME from S3.
- **`raw_s3_uri` is included.** Lets advanced consumers bypass the MCP server when they have IAM access to the bucket — useful for pipelines that re-process mail in bulk.
- **`thread_id` is best-effort.** Derived from `In-Reply-To`/`References` per ADR-0002. Consumers must tolerate empty or unstable values.
- **SES verdicts pass through verbatim.** Open Sesame does not re-judge; it surfaces what SES decided.
- **`attachments[]` is summary only** (filename, MIME type, size). Binary content stays in the raw MIME archive — see ADR-0004.
- **`auto_submitted`** passes through the inbound `Auto-Submitted:` header value (`"no"` if absent), so consumers can suppress auto-responder loops per RFC 3834 without re-parsing the message.
- **`list_id`** carries the `List-Id:` header verbatim (`null` if absent). Lets consumers cheaply distinguish list mail from direct mail.
- **`custom_headers`** is a flat map of inbound `X-*` headers, lowercased. Useful for routing on vendor-specific tags (`X-Mailer`, `X-Spam-Status`, custom workflow markers) without re-fetching the raw MIME. Capped at 4 KB total in the event payload; overflow is silently truncated and signalled with `custom_headers_truncated: true`.
- **No agent-related fields.** `MailIngested` is about *inbound* mail; agent identities only matter on outbound. (Future `MailSent` events will include `principal`/`agent_id`/`grant_id`.)

## Routing keys for EventBridge rules

The event is published with these EventBridge attributes so operators can filter without parsing the body:

- `source = "opensesame"`
- `detail-type = "MailIngested"`
- `resources = ["arn:opensesame:address:alice@acme.com"]` (synthetic ARN, lets a rule scope by address)

Example rule — "trigger Lambda only for billing-agent@acme.com":

```yaml
EventPattern:
  source: ["opensesame"]
  detail-type: ["MailIngested"]
  resources: ["arn:opensesame:address:billing-agent@acme.com"]
```

## Considered and rejected

- **Include `body_text` in the event.** Pushes payload size past comfortable EventBridge limits (256 KB) for any non-trivial message and creates two divergent representations of the body (event payload vs DynamoDB chunks). Forces consumers to re-implement chunk reassembly downstream. Rejected; consumers that need body call `get_message`.
- **One event per recipient with full fan-out at publish time.** Tempting (each rule fires exactly once for its address), but RFC 5322 messages are routinely sent to many recipients and SES gives us one inbound per managed-address-recipient anyway. The current "one event per stored message, scoped by `address`" matches how SES actually delivers and avoids inventing a fan-out story.
- **Separate event per attachment.** Speculative; no consumer use case in v1.
- **Version the event types in their names (`MailIngestedV1`, `MailIngestedV2`).** Means every future bump rewires every operator's EventBridge rules. Putting `schema_version` inside the envelope keeps rules stable across additive changes.
- **Skip the envelope; put `MailIngested` fields at the top level.** Cheap now, painful later — adds inconsistency the moment a second event type appears.

## Forward compatibility

- New fields may be added to `data` without bumping `schema_version`. Consumers must ignore unknown fields.
- Removing or changing the type of any field bumps `schema_version` and emits both versions in parallel for a deprecation window.
- A future `MailSent`, `MailBounced`, etc. share the envelope verbatim.

## Trade-offs accepted

- Consumers that want body content pay one extra hop (MCP `get_message` or S3 GET). Right call: keeps the event size predictable and avoids body duplication.
- The synthetic `arn:opensesame:address:…` resource ARN is not an AWS-recognized ARN (it cannot be passed to IAM). It exists solely as an EventBridge filter target; this is documented behavior, not a bug.
