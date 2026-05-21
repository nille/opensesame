# Delivery-event handling: SES configuration set + SNS + bounce-handler Lambda + BounceLog table

ADR-0007 lists `send_email` and the read-side primitives. ADR-0015–0017 pinned slices 1–3 of the outbound path. This ADR pins **slice 4**: where SES bounce, complaint, and delivery-delay events land, how they're correlated to the outbound `Messages` row, and which derived status the read-side surfaces. Slice 4 is the prerequisite for requesting SES production access (the AWS form asks specifically how bounces and complaints are handled).

## Decision

### Event transport: SES configuration set → SNS → Lambda

SES exposes delivery events through an *event destination* attached to a *configuration set*. The send adapter passes the configuration-set name on every `SendEmail` call; SES then publishes events for the configured types to the destination.

We use **SNS** as the destination, with a **bounce-handler Lambda** subscribed to the topic. Reasons:

- **Canonical pattern.** The SES production-access form pattern-matches on "configuration set + SNS + Lambda" — minimal narrative needed in the request.
- **Decoupling.** SES retries publication on its own; the Lambda is a pure consumer with its own retry budget + DLQ. The send path stays unaware of bounce processing.
- **Smaller IAM footprint than EventBridge.** The Lambda needs only `dynamodb:UpdateItem` on Messages + `dynamodb:PutItem` on BounceLog. The SNS subscription is one statement, not a rule + target pair.

Event types subscribed: `Bounce`, `Complaint`, `DeliveryDelay`. (Not `Delivery` — confirmation of successful delivery isn't useful state in v1; the absence of a bounce within ~24h is the operator's signal.)

### Storage: new `BounceLog` table + projected `delivery_status` on Messages

Two writes per event, in order:

1. **`BounceLog`** — full per-event forensic record. `PK = ses_message_id`, `SK = event_id`. One outbound send can produce multiple events (transient delay → permanent bounce; complaint after delivery). Per-event rows preserve the full history.
2. **`Messages`** — `UpdateItem` on the outbound row (`PK = fromAddress`, `SK = internal_id`) projecting a derived `delivery_status` + `last_event_at`. The projection is what the inbox listing surfaces; BounceLog is for forensic queries.

`delivery_status` value mapping (latest event wins):

| SES event             | bounceType / bounceSubType  | `delivery_status`     |
| --------------------- | --------------------------- | --------------------- |
| Bounce (Permanent)    | any                         | `bounced_permanent`   |
| Bounce (Transient)    | any                         | `bounced_transient`   |
| Bounce (Undetermined) | any                         | `bounced_unknown`     |
| Complaint             | any                         | `complained`          |
| DeliveryDelay         | any                         | `delayed`             |

The mapping is intentionally narrow in v1: operators see whether something went wrong and look at BounceLog for the details. A future slice can add suppression-list management on top of `bounced_permanent` / `complained`.

The outbound Messages row resolves by `internal_id = makeInternalId({ s3Key: "outbound/{ses_message_id}", receivedAt: <event timestamp> })` — but `received_at` was set at send time, not event time, so the handler can't recompute the SK. Two options were considered:

- **(A) Project a `ses_message_id` GSI on Messages.** Adds a GSI to a hot table for an event volume that's measured in tens per day. Rejected as overkill.
- **(B) The handler queries BounceLog or the audit table to find `internal_id`.** Adds a hop and a coupling.
- **(C, chosen) The handler scans for the row using the SES message ID via GSI1.** GSI1 already indexes `message_id` — and the row carries `message_id = <{ses_message_id}@{region}.amazonses.com>` per ADR-0017. One Query on GSI1 returns the outbound row. No new index. The recipient-index suffix issue (ADR-0017) is moot here because BOTH the SES wire ID and the row's `message_id` carry it consistently.

### Idempotency: write BounceLog first, Messages-row update is unconditional

`Bounce` and `Complaint` events have stable per-event identifiers (`feedbackId` / `feedback-id` in the SNS payload's mail object). We use that as the BounceLog `event_id`. A duplicate SNS delivery PuTs the same composite key — last-write-wins on attribute values, but no row duplication.

The Messages-row projection is applied unconditionally on every event. If the Lambda re-processes a stale event after a newer one already landed, the older event briefly clobbers the newer status. We accept this race because (a) SNS's at-least-once delivery is the same source as the BounceLog row, so the same race exists for any handler, and (b) the BounceLog is the source of truth — a future slice can periodically reconcile Messages from BounceLog if needed.

### CDK shape: one new stack `BounceHandlerStack`, one new table on DataPlane

- **`DataPlaneStack`**: add `BounceLog` table. PITR + RETAIN like Messages / Audit (forensic data).
- **`BounceHandlerStack`** (new, opt-in like `SesIngressStack`): owns the SES `ConfigurationSet` + `EventDestination`, the SNS topic, and the bounce-handler Lambda + DLQ. Cross-stack deps imported, not embedded — same pattern as ComputePlaneStack.

The configuration-set name is a CDK-deterministic value (`opensesame-default`). The send-side CLI driver reads `OPENSESAME_SES_CONFIG_SET` from env and threads it through the SES adapter.

## Out of scope (deferred)

- **Suppression list / send-time blocking.** The send path doesn't yet check `delivery_status` before sending. Operators can read it back and decide manually in v1; automated suppression is a follow-up slice.
- **Delivery confirmation.** `Delivery` event type isn't subscribed. Adding it later is a configuration-set change, not a code change.
- **Per-recipient delivery status for multi-recipient sends.** ADR-0017 already documented multi-recipient as a v1 limitation; SES emits one event per recipient with distinct `feedbackId`s, but our row stores only the first-recipient form. Multi-recipient ergonomics are a known v2 concern.
- **Backfilling Messages with BounceLog rollups.** The Lambda updates Messages live; no backfill job ships in this slice.

## Consequences

- **Sandbox-exit narrative becomes concrete.** "Bounce, complaint, and delivery-delay events route via a configuration set to a Lambda that records each event in a forensic table and updates the message row with a derived status."
- **One new DDB table to operate.** Same shape and lifecycle policy as the existing forensic tables; no new operational mode.
- **The SES adapter grows one optional parameter.** Tests pin both shapes (with and without configuration-set name) to keep solo-direct mode usable without the bounce wiring deployed.
- **One new opt-in CDK stack to remember at deploy time.** Documented in the operator runbook alongside `SesIngressStack`.
