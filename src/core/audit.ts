import { createHash, randomFillSync } from "node:crypto";
import { encodeUlid } from "./ids.js";

// Outbound audit log per ADR-0008 + ADR-0016. Pure types and helpers in core;
// the DDB-bound implementation lives in src/aws/dynamodb-audit.ts.
//
// Two writes per send:
//   1. recordAttempt(attempt)  — Put before SES.send is called.
//   2. recordOutcome(outcome)  — Update after SES returns (success or failure).
//
// Solo-direct (ADR-0006) has no Cognito principals or Grants, so principal is
// the placeholder "iam:operator" and grant fields are absent. When Layer 1
// of ADR-0008 lands, the principal resolver will produce a real Cognito sub
// or IAM role ARN and grant_id / disclosure_mode / autonomy_mode will follow.

const ULID_RANDOM_BYTES = 10;
const SOLO_DIRECT_PRINCIPAL = "iam:operator";

export type AuditAttemptInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  rfcMessageId: string;
  // ADR-0019: forwarded onto the attempt row so audit queries can tell
  // which sends bypassed the suppression-list check.
  allowSuppressed?: boolean;
};

export type AuditAttemptDeps = {
  now: () => Date;
  randomBytes?: () => Uint8Array;
};

export type AuditAttempt = {
  audit_id: string;
  schema_v: "1";
  type: "send_attempted";
  principal: string;
  agent_id: string | null;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject_hash: string;
  rfc_message_id: string;
  requested_at: string;
  // ADR-0019: present and `true` only when the operator passed an explicit
  // override to bypass the suppression-list pre-flight check. Absent on
  // unguarded sends so the default row shape is unchanged.
  allow_suppressed?: true;
};

export type AuditBlocked = {
  audit_id: string;
  schema_v: "1";
  type: "send_blocked";
  principal: string;
  agent_id: string | null;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject_hash: string;
  rfc_message_id: string;
  requested_at: string;
  // Joined "alice@x.com, bob@y.com" — same format as `to`/`cc`/`bcc`.
  blocked_recipients: string;
  block_reason: "suppression_list";
};

export type AuditSuccessOutcome = {
  audit_id: string;
  type: "send_succeeded";
  ses_message_id: string;
  succeeded_at: string;
};

export type AuditFailureOutcome = {
  audit_id: string;
  type: "send_failed";
  error: string;
  failed_at: string;
};

export type AuditOutcome = AuditSuccessOutcome | AuditFailureOutcome;

export interface AuditLog {
  recordAttempt(attempt: AuditAttempt): Promise<void>;
  recordOutcome(outcome: AuditOutcome): Promise<void>;
  // ADR-0019: terminal row written when the suppression-list pre-flight
  // check refuses a send. No `recordOutcome` follows — the audit query
  // surfaces send_blocked alongside send_succeeded / send_failed.
  recordBlocked(blocked: AuditBlocked): Promise<void>;
}

export function makeAuditAttempt(
  input: AuditAttemptInput,
  deps: AuditAttemptDeps,
): AuditAttempt {
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  const now = deps.now();
  const auditId = encodeUlid(now.getTime(), randomBytes());

  const attempt: AuditAttempt = {
    audit_id: auditId,
    schema_v: "1",
    type: "send_attempted",
    principal: SOLO_DIRECT_PRINCIPAL,
    agent_id: null,
    from: input.from,
    to: input.to.join(", "),
    subject_hash: hashSubject(input.subject),
    rfc_message_id: input.rfcMessageId,
    requested_at: now.toISOString(),
  };
  // Only attach cc/bcc when present — keeps the row free of empty attributes
  // and matches the tsconfig's exactOptionalPropertyTypes setting.
  if (input.cc && input.cc.length > 0) attempt.cc = input.cc.join(", ");
  if (input.bcc && input.bcc.length > 0) attempt.bcc = input.bcc.join(", ");
  if (input.allowSuppressed === true) attempt.allow_suppressed = true;
  return attempt;
}

export function makeAuditBlocked(
  input: AuditAttemptInput & { blockedRecipients: string[] },
  deps: AuditAttemptDeps,
): AuditBlocked {
  const randomBytes = deps.randomBytes ?? defaultRandomBytes;
  const now = deps.now();
  const auditId = encodeUlid(now.getTime(), randomBytes());

  const blocked: AuditBlocked = {
    audit_id: auditId,
    schema_v: "1",
    type: "send_blocked",
    principal: SOLO_DIRECT_PRINCIPAL,
    agent_id: null,
    from: input.from,
    to: input.to.join(", "),
    subject_hash: hashSubject(input.subject),
    rfc_message_id: input.rfcMessageId,
    requested_at: now.toISOString(),
    blocked_recipients: input.blockedRecipients.join(", "),
    block_reason: "suppression_list",
  };
  if (input.cc && input.cc.length > 0) blocked.cc = input.cc.join(", ");
  if (input.bcc && input.bcc.length > 0) blocked.bcc = input.bcc.join(", ");
  return blocked;
}

export function makeSuccessOutcome(input: {
  auditId: string;
  sesMessageId: string;
  succeededAt: string;
}): AuditSuccessOutcome {
  return {
    audit_id: input.auditId,
    type: "send_succeeded",
    ses_message_id: input.sesMessageId,
    succeeded_at: input.succeededAt,
  };
}

export function makeFailureOutcome(input: {
  auditId: string;
  error: string;
  failedAt: string;
}): AuditFailureOutcome {
  return {
    audit_id: input.auditId,
    type: "send_failed",
    error: input.error,
    failed_at: input.failedAt,
  };
}

export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

function defaultRandomBytes(): Uint8Array {
  const buf = new Uint8Array(ULID_RANDOM_BYTES);
  randomFillSync(buf);
  return buf;
}
