import {
  makeAuditAttempt,
  makeFailureOutcome,
  makeSuccessOutcome,
  type AuditLog,
} from "./audit.js";
import type { OutboundMailer } from "./outbound.js";

// Send orchestrator that wires the pre-send / post-send audit writes around
// the outbound mailer call (ADR-0008 + ADR-0016).
//
// Order of operations:
//   1. recordAttempt(...) — if this throws, abort. SES is never called.
//   2. mailer.send(...)
//        success → recordOutcome(send_succeeded) and return
//        failure → recordOutcome(send_failed) and rethrow
//
// The "outcome write failed but SES succeeded" branch is degraded but
// acceptable per ADR-0016: SES has already accepted the message; we keep
// the row at send_attempted, log a warning, and return success. The
// reconciler (future slice) closes those rows. Losing the *attempt* write
// is not acceptable, hence the early throw on step 1.

export type SendWithAuditInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  rfcMessageId: string;
  raw: Uint8Array;
  envelopeTo: string[];
};

export type SendWithAuditDeps = {
  mailer: OutboundMailer;
  auditLog: AuditLog;
  input: SendWithAuditInput;
  now: () => Date;
  randomBytes?: () => Uint8Array;
  // Side-channel for the degraded outcome-write-failed case so callers can
  // surface it at their own log level. Defaults to a no-op.
  warn?: (message: string) => void;
};

export type SendWithAuditResult = {
  audit_id: string;
  ses_message_id: string;
  sent_at: string;
};

export async function sendWithAudit(
  deps: SendWithAuditDeps,
): Promise<SendWithAuditResult> {
  const attemptDeps: { now: () => Date; randomBytes?: () => Uint8Array } = {
    now: deps.now,
  };
  if (deps.randomBytes !== undefined) {
    attemptDeps.randomBytes = deps.randomBytes;
  }
  const attempt = makeAuditAttempt(
    {
      from: deps.input.from,
      to: deps.input.to,
      ...(deps.input.cc !== undefined && deps.input.cc.length > 0
        ? { cc: deps.input.cc }
        : {}),
      ...(deps.input.bcc !== undefined && deps.input.bcc.length > 0
        ? { bcc: deps.input.bcc }
        : {}),
      subject: deps.input.subject,
      rfcMessageId: deps.input.rfcMessageId,
    },
    attemptDeps,
  );

  // Pre-send write must succeed. Errors propagate so the caller knows the
  // send was aborted before SES was contacted.
  await deps.auditLog.recordAttempt(attempt);

  let sesResult;
  try {
    sesResult = await deps.mailer.send({
      raw: deps.input.raw,
      fromAddress: deps.input.from,
      envelopeTo: deps.input.envelopeTo,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      await deps.auditLog.recordOutcome(
        makeFailureOutcome({
          auditId: attempt.audit_id,
          error: errorMessage,
          failedAt: deps.now().toISOString(),
        }),
      );
    } catch (outcomeErr) {
      const m =
        outcomeErr instanceof Error ? outcomeErr.message : String(outcomeErr);
      (deps.warn ?? noop)(
        `audit outcome write failed (send_failed) for ${attempt.audit_id}: ${m}`,
      );
    }
    throw err;
  }

  try {
    await deps.auditLog.recordOutcome(
      makeSuccessOutcome({
        auditId: attempt.audit_id,
        sesMessageId: sesResult.sesMessageId,
        succeededAt: sesResult.sentAt,
      }),
    );
  } catch (outcomeErr) {
    const m =
      outcomeErr instanceof Error ? outcomeErr.message : String(outcomeErr);
    (deps.warn ?? noop)(
      `audit outcome write failed (send_succeeded) for ${attempt.audit_id}: ${m}`,
    );
  }

  return {
    audit_id: attempt.audit_id,
    ses_message_id: sesResult.sesMessageId,
    sent_at: sesResult.sentAt,
  };
}

function noop(_: string): void {}
