# Failure & recovery: S3 is canonical, SQS-buffered ingest with idempotent writes, skeleton rows for poison messages, PITR + versioning for backups

This ADR captures the durability contract for inbound mail and the failure-handling shape that makes it real.

## Durability contract

**If a message reaches the raw-MIME S3 bucket, it will eventually be in DynamoDB and a `MailIngested` event will fire.** That is the only promise the system makes to operators and downstream consumers. It is the operational expression of "raw MIME is canonical" (ADR-0004) and "S3 replay is the upgrade escape hatch" (ADR-0011).

What the contract deliberately is *not*:

- It is not "atomic across S3 and DynamoDB." DynamoDB transactions don't span S3, so any "atomic" claim would be a fiction. There is a brief window after S3 write where the message exists but isn't yet searchable / hasn't fired its event — bounded by Lambda retry latency.
- It is not "the user sees nothing until everything is consistent." See *skeleton rows* below.

## Ingest topology

> Amended 2026-05-20: the trigger is now SES → SNS → SQS rather than S3 ObjectCreated → SQS. S3 remains the canonical body store. See *Amendment (2026-05-20)* below for the rationale and the full before/after.

```
SES → S3 (canonical body store)
   └→ SNS notification → SQS standard queue → ingest Lambda
                                                  ├─→ DynamoDB (Address row, message row, body chunks, headers blob)
                                                  └─→ EventBridge (MailIngested)

                                       (failures) → SQS DLQ
```

- **SQS between SNS and Lambda** (rather than SNS → Lambda direct). Decouples ingest from notification delivery, enables redrive policy, absorbs bursts. **Standard queue, not FIFO** — ordering across messages doesn't matter; throughput does.
- **Visibility timeout = 6× p99 processing time** (~3 min for a ~30s p99 ingest). Three retries before DLQ.
- **DLQ is a separate SQS queue.** CloudWatch alarm on `ApproximateNumberOfMessagesVisible > 0` for the DLQ paged via the operator's notification channel. Manual `opensesame redrive-dlq` command after diagnosis or fix.
- **Reconciliation job.** Hourly Lambda compares the last hour's S3 keys to DynamoDB primary keys and re-enqueues anything missing. Catches the rare case where SQS itself drops the event.

## Idempotency

Every DynamoDB write uses keys derived deterministically from the S3 object key (which is itself derived from the SES `MessageId`). Re-running the ingest Lambda on the same input rewrites the same items — partial-write recovery becomes a non-issue. The `MailIngested` event also carries the S3 object key, so EventBridge double-publishes are deduplicatable downstream by consumers that care.

## Failure classes

1. **Transient** (DynamoDB throttle, network blip, Lambda timeout) — SQS retries handle it. Three attempts, then DLQ.
2. **Poison** (malformed MIME, parser bug, attachment that breaks chunking) — retries never help. After three attempts, the Lambda writes a *skeleton row* to DynamoDB (see below), then sends to DLQ for operator attention.
3. **Partial-write** — non-issue under deterministic keys; retry rewrites the same items.

## Skeleton rows for poison messages

When the parser fails, the ingest Lambda still writes a minimal DynamoDB row:

```
{
  pk: <message_id>,
  parse_status: "failed",
  parse_error: "<short reason>",
  raw_s3_uri: "s3://…",
  received_at: …,
  address: <recipient>,
  schema_v: "1"
}
```

The webmail UI and `read_inbox` MCP tool render skeleton rows as `[Could not parse — raw available]` with a link/handle to fetch the raw MIME. The user sees that *something* arrived; the operator triages via DLQ.

This is a deliberate trade: every reader handles the partially-parsed state (one branch in `get_message`), in exchange for never silently losing a message from the user's point of view. For a system whose value proposition is "agentic and human access to the same mailbox", silent gaps would be the worst failure mode.

A `MailIngested` event still fires for skeleton rows, with `parse_status: "failed"` in `data`. Consumers can choose to ignore or surface them.

## Backups

- **S3 raw archive**: Versioning **ON**; MFA Delete **OFF** (breaks programmatic flows); lifecycle to Glacier Deep Archive after 90 days; cross-region replication **not in v1** (operators who need it flip a CDK property).
- **DynamoDB**: Point-in-time Recovery **ON** for every table (any-second restore within 35 days). Plus a scheduled daily on-demand backup retained 35 days as a cheap second line.
- **Cognito User Pool**: nightly Lambda dumps users + groups via `cognito-idp list-users` to a versioned S3 prefix. Recovery is documented (re-import via `cognito-idp admin-create-user`).
- **Route 53 zone**: zone state is in CDK; recovery is `cdk deploy` against a fresh account.
- **Grants table**: covered by DynamoDB PITR; no separate path.

## Deletion semantics

- `delete_message` is **soft delete** (per ADR-0007). Raw MIME stays in S3 for audit. Aligns with the canonical-S3 model.
- Grant revocation is **hard delete** from the Grants table; the audit log retains the history. Different shape because Grants are config, not content.
- Agent deletion cascades to grant revocation but does **not** delete the agent's mail. The Address rows persist; the agent simply has no principal that can read them. An operator who wants the data gone runs `rebuild-derived-data` with the address excluded.

## Considered and rejected

- **S3 → Lambda direct, no SQS.** Loses redrive policy, no native DLQ, no burst absorption. SQS in front is a small infrastructure addition for a large operability gain.
- **FIFO queue with `MessageGroupId = address`.** Tempting (per-address ordering), but ingest order is not semantically meaningful — `received_at` is the timestamp consumers actually care about, and message threading is reconstructed from headers, not arrival order. FIFO would cap throughput unnecessarily.
- **"Invisible until fixed" for poison messages.** Simpler reader code, but produces silent gaps from the user's POV — which is the failure mode this system most wants to avoid.
- **Cross-region replication on by default.** Doubles S3 cost for a rare threat. Available as a CDK property; operators who need it enable it.
- **DynamoDB Streams to drive ingest output instead of in-Lambda writes.** Adds a moving part for no win — a single Lambda can write all four sinks (DynamoDB items, EventBridge event) sequentially within the SQS visibility timeout.

## Trade-offs accepted

- A bounded inconsistency window between S3 write and DynamoDB visibility (seconds to low minutes under retry). Documented; not a guarantee operators can rely on being zero.
- One reader-side branch for `parse_status: "failed"` in every code path that surfaces messages.
- Operator on-call burden when DLQ depth > 0. Mitigated by the alarm being load-bearing for the durability contract — not a nuisance alert.

## Amendment (2026-05-20)

The original *Ingest topology* assumed SES could attach the recipient address to the canonical S3 object as `x-amz-meta-recipient` and that an S3 ObjectCreated notification would drive the ingest Lambda. SES's "Deliver to S3 bucket" action does not expose any hook for setting custom S3 object metadata, so that path was unbuildable against real SES — the smoke driver populated the header by hand because it was standing in for SES. The ingest trigger moves to SES's SNS notification, which carries the recipient and SES verdicts authoritatively in the same event. This matches ADR-0002's stance that SES is the only authoritative source for the recipient, and lets real verdicts flow into the row instead of the placeholder PASS values. S3 stays as the canonical body store the reconciliation Lambda walks (per ADR-0011); ADR-0010's `MailIngested.data` shape is unchanged — `spam_verdict`/`virus_verdict`/`dkim_verdict`/`spf_verdict`/`dmarc_verdict` are now sourced from the SNS body rather than stamped PASS.

Before / after:

| Concern        | Before                                              | After                                                            |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Trigger        | S3 ObjectCreated → SQS                              | SES SNS notification → SQS                                       |
| Recipient      | S3 object metadata `x-amz-meta-recipient`           | SNS body `mail.destination[0]`                                   |
| Verdicts       | Hardcoded `PASS` placeholder in the ingest Lambda   | `receipt.{spam,virus,dkim,spf,dmarc}Verdict.status` from the SNS body |
| `received_at`  | S3 `LastModified`                                   | `mail.timestamp` from the SES envelope                           |
| Bucket + key   | S3 event record                                     | `receipt.action.{bucketName,objectKey}` from the SES envelope    |

The Lambda parses each SQS record body as an SNS `Notification` envelope whose `Message` field is a JSON-stringified SES event, then GETs the raw bytes from S3 by the key in `receipt.action`.

Stays the same: S3 as the canonical body store; standard SQS + DLQ + `maxReceiveCount=3` + 6× p99 visibility timeout; per-record `ReportBatchItemFailures`; skeleton rows on parser failure rather than DLQ; DLQ-depth alarm as the load-bearing durability signal; reconciliation Lambda walking the bucket to catch the rare drop.

Dead code note: the ingest Lambda's `s3:TestEvent` skip can no longer fire under the new path. It is left in place as defense-in-depth — the comment is worth keeping so a future reader doesn't go hunting for the call site.

Forward pointer: the SES receipt rule is being authored as a separate slice. It has two actions on the rule — write raw mail to the canonical S3 bucket, and publish to the SNS topic the ingest queue subscribes to. IAM and topic-policy plumbing live there, not here.
