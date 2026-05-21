// Pure parser + handler for SES delivery events (ADR-0018).
//
// SES publishes Bounce, Complaint, and DeliveryDelay events to a configuration
// set's event destination — for our deployment, an SNS topic. The bounce-
// handler Lambda is subscribed to the topic and invokes `handleDeliveryEvent`
// per SNS record.
//
// This module owns:
//   - the parsed shape `DeliveryEvent` (decoupled from SNS / SES wire JSON)
//   - the SNS-notification → DeliveryEvent parser (`parseSnsDeliveryEvent`)
//   - the status mapping (`deriveDeliveryStatus`)
//   - the orchestrator (`handleDeliveryEvent`) that calls into ports
//
// Adapters (DDB-bound BounceLogWriter + MessageStatusUpdater + the SNS-event
// reader) live in src/aws.

// --- public types ---

export type BounceCategory =
  | "bounce_permanent"
  | "bounce_transient"
  | "bounce_unknown"
  | "complaint"
  | "delivery_delay";

export type DeliveryStatus =
  | "bounced_permanent"
  | "bounced_transient"
  | "bounced_unknown"
  | "complained"
  | "delayed";

export type DeliveryEvent = {
  // The opaque SES message ID returned by SendEmail (ADR-0017). For
  // multi-recipient sends SES emits one event per recipient with a
  // recipient-suffixed id; we treat each recipient's event as distinct.
  ses_message_id: string;
  // Stable per-event identifier from the SNS payload's mail.feedbackId
  // (Bounce/Complaint) or the event's own id (DeliveryDelay). Used as the
  // BounceLog SK so retries don't duplicate rows.
  event_id: string;
  // ISO-8601 timestamp from the SES event payload.
  event_at: string;
  category: BounceCategory;
  // Optional sub-category SES surfaces — bounceSubType, complaintFeedbackType,
  // delayType. Pure metadata; not used for the derived status.
  sub_category: string | null;
  // The recipient(s) the event applies to. SES emits one event per affected
  // recipient (so this is usually length 1), but the SNS payload sometimes
  // batches diagnostics for the same recipient set. We store all of them.
  recipients: string[];
  // SES's diagnostic blob — SMTP response, complaint feedback, etc. Stored
  // verbatim for forensic queries; never parsed by us.
  diagnostic: string | null;
  // The full original SNS payload (parsed JSON) — kept for forensic use.
  // BounceLogWriter persists this so future code can re-derive any field
  // without re-fetching from CloudWatch.
  raw: Record<string, unknown>;
};

export type ParseDeliveryEventResult =
  | { ok: true; event: DeliveryEvent }
  | { ok: false; error: string };

// --- ports ---

// PutItem on opensesame-bounces. PK = ses_message_id, SK = event_id.
// Idempotent: a duplicate event_id PuTs the same row.
export interface BounceLogWriter {
  writeEvent(event: DeliveryEvent): Promise<void>;
}

// UpdateItem on opensesame-messages — sets delivery_status + last_event_at on
// the outbound row whose message_id (GSI1) corresponds to this ses_message_id.
// Returns whether a Messages row was actually located + updated; a missing
// row isn't fatal (the persist-outbound write may have raced or failed —
// BounceLog still has the forensic record).
export interface MessageStatusUpdater {
  applyDeliveryStatus(input: {
    ses_message_id: string;
    rfc_message_id: string;
    status: DeliveryStatus;
    event_at: string;
  }): Promise<{ updated: boolean }>;
}

export type DeliveryEventHandlerDeps = {
  bounceLog: BounceLogWriter;
  messageStatus: MessageStatusUpdater;
  // SES region — used to reconstruct the row's `message_id` (GSI1 key) from
  // the SES message id. Same construction as ADR-0017's
  // `makeSesRewrittenMessageId`.
  awsRegion: string;
};

// --- public API ---

const PERMANENT_BOUNCE = "Permanent";
const TRANSIENT_BOUNCE = "Transient";

// Map SES's eventType + bounceType to the operator-facing category. SES uses
// {Bounce: Permanent | Transient | Undetermined, Complaint, DeliveryDelay}.
export function categorize(input: {
  eventType: string;
  bounceType?: string | null;
}): BounceCategory | null {
  if (input.eventType === "Bounce") {
    if (input.bounceType === PERMANENT_BOUNCE) return "bounce_permanent";
    if (input.bounceType === TRANSIENT_BOUNCE) return "bounce_transient";
    // SES uses "Undetermined" for the remaining bucket — we collapse to
    // "unknown" so operators have a single label.
    return "bounce_unknown";
  }
  if (input.eventType === "Complaint") return "complaint";
  if (input.eventType === "DeliveryDelay") return "delivery_delay";
  return null;
}

// Project a parsed event onto the derived row status. Last-event-wins
// (ADR-0018); the handler applies this unconditionally on every event.
export function deriveDeliveryStatus(category: BounceCategory): DeliveryStatus {
  switch (category) {
    case "bounce_permanent":
      return "bounced_permanent";
    case "bounce_transient":
      return "bounced_transient";
    case "bounce_unknown":
      return "bounced_unknown";
    case "complaint":
      return "complained";
    case "delivery_delay":
      return "delayed";
  }
}

// Reconstruct the GSI1 lookup key from the SES message id + region. Mirrors
// ADR-0017's `makeSesRewrittenMessageId` (so a refactor there should ripple
// here — kept as a separate function only to avoid a direct cross-module
// dependency from the bounce handler into persist-outbound).
export function makeRfcMessageIdFromSes(input: {
  sesMessageId: string;
  region: string;
}): string {
  return `<${input.sesMessageId}@${input.region}.amazonses.com>`;
}

// Parse a single SNS notification's `Message` field (the SES delivery event
// JSON, double-encoded). Returns a tagged result so callers can log + skip
// malformed events without throwing — SES occasionally publishes events for
// types we don't subscribe to (e.g. AmazonSesPublish test events).
export function parseSnsDeliveryEvent(
  snsMessage: string,
): ParseDeliveryEventResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(snsMessage) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }

  const eventType = raw["eventType"];
  const notificationType = raw["notificationType"];
  // SES publishes either `eventType` (configuration-set destination) or
  // `notificationType` (legacy SNS feedback notifications). We accept both
  // so an operator who happened to wire bounces via the legacy path during
  // migration still gets parsed events.
  const type =
    typeof eventType === "string"
      ? eventType
      : typeof notificationType === "string"
        ? notificationType
        : null;
  if (type === null) {
    return { ok: false, error: "missing eventType / notificationType" };
  }

  const mail = raw["mail"];
  if (!isRecord(mail)) {
    return { ok: false, error: "missing mail object" };
  }
  const sesMessageId = mail["messageId"];
  if (typeof sesMessageId !== "string" || sesMessageId.length === 0) {
    return { ok: false, error: "missing mail.messageId" };
  }

  let bounceType: string | null = null;
  let subCategory: string | null = null;
  let recipients: string[] = [];
  let diagnostic: string | null = null;
  let timestamp: string | null = null;
  let feedbackId: string | null = null;

  if (type === "Bounce") {
    const bounce = raw["bounce"];
    if (!isRecord(bounce)) {
      return { ok: false, error: "missing bounce object" };
    }
    bounceType = stringOr(bounce["bounceType"], null);
    subCategory = stringOr(bounce["bounceSubType"], null);
    recipients = collectRecipients(bounce["bouncedRecipients"]);
    diagnostic = collectDiagnostics(bounce["bouncedRecipients"]);
    timestamp = stringOr(bounce["timestamp"], null);
    feedbackId = stringOr(bounce["feedbackId"], null);
  } else if (type === "Complaint") {
    const complaint = raw["complaint"];
    if (!isRecord(complaint)) {
      return { ok: false, error: "missing complaint object" };
    }
    subCategory = stringOr(complaint["complaintFeedbackType"], null);
    recipients = collectRecipients(complaint["complainedRecipients"]);
    timestamp = stringOr(complaint["timestamp"], null);
    feedbackId = stringOr(complaint["feedbackId"], null);
  } else if (type === "DeliveryDelay") {
    const delay = raw["deliveryDelay"];
    if (!isRecord(delay)) {
      return { ok: false, error: "missing deliveryDelay object" };
    }
    subCategory = stringOr(delay["delayType"], null);
    recipients = collectRecipients(delay["delayedRecipients"]);
    timestamp = stringOr(delay["timestamp"], null);
    // DeliveryDelay events don't ship a feedbackId; use the SES messageId
    // suffixed with `-delay-{timestamp}` so re-deliveries of the same delay
    // dedupe but distinct delay events don't overwrite each other.
    feedbackId = `delay-${timestamp ?? "unknown"}`;
  } else {
    return { ok: false, error: `unsupported eventType: ${type}` };
  }

  // Fall back to the SES messageId if SES omitted feedbackId — keeps the
  // BounceLog SK non-null. Still stable across retries because the SES
  // messageId is constant for the same outbound send.
  const eventId = feedbackId ?? sesMessageId;

  const eventAt =
    timestamp ?? stringOr(mail["timestamp"], null) ?? new Date(0).toISOString();

  const category = categorize({ eventType: type, bounceType });
  if (category === null) {
    return { ok: false, error: `uncategorized event: ${type}` };
  }

  return {
    ok: true,
    event: {
      ses_message_id: sesMessageId,
      event_id: eventId,
      event_at: eventAt,
      category,
      sub_category: subCategory,
      recipients,
      diagnostic,
      raw,
    },
  };
}

// Orchestrator: persist forensic record first, then project status onto
// Messages. Order is load-bearing — if the Messages update fails we still
// have the BounceLog record (forensic invariant).
export async function handleDeliveryEvent(
  event: DeliveryEvent,
  deps: DeliveryEventHandlerDeps,
): Promise<{ status: DeliveryStatus; messageRowUpdated: boolean }> {
  await deps.bounceLog.writeEvent(event);

  const status = deriveDeliveryStatus(event.category);
  const rfcMessageId = makeRfcMessageIdFromSes({
    sesMessageId: event.ses_message_id,
    region: deps.awsRegion,
  });

  const { updated } = await deps.messageStatus.applyDeliveryStatus({
    ses_message_id: event.ses_message_id,
    rfc_message_id: rfcMessageId,
    status,
    event_at: event.event_at,
  });

  return { status, messageRowUpdated: updated };
}

// --- helpers ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOr(v: unknown, fallback: string | null): string | null {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function collectRecipients(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const r of v) {
    if (isRecord(r)) {
      const email = r["emailAddress"];
      if (typeof email === "string" && email.length > 0) {
        out.push(email);
      }
    }
  }
  return out;
}

function collectDiagnostics(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const parts: string[] = [];
  for (const r of v) {
    if (isRecord(r)) {
      const diag = r["diagnosticCode"];
      if (typeof diag === "string" && diag.length > 0) {
        parts.push(diag);
      }
    }
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}
