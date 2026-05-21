import { describe, expect, it } from "vitest";
import { sendWithAudit } from "../src/core/send-with-audit.js";
import type { AuditLog, AuditAttempt, AuditOutcome } from "../src/core/audit.js";
import type { OutboundMailer } from "../src/core/outbound.js";

const FIXED_NOW = new Date("2026-05-21T17:00:00.000Z");
const FIXED_RANDOM = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function makeStubMailer(
  reply: { sesMessageId: string; sentAt: string } | Error,
): { mailer: OutboundMailer; sendCount: number } {
  let sendCount = 0;
  const mailer: OutboundMailer = {
    async send() {
      sendCount++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return {
    mailer,
    get sendCount() {
      return sendCount;
    },
  };
}

function makeStubAuditLog(opts: {
  failAttempt?: boolean;
  failOutcome?: boolean;
} = {}): {
  log: AuditLog;
  attempts: AuditAttempt[];
  outcomes: AuditOutcome[];
} {
  const attempts: AuditAttempt[] = [];
  const outcomes: AuditOutcome[] = [];
  const log: AuditLog = {
    async recordAttempt(a) {
      if (opts.failAttempt) throw new Error("DDB attempt failure");
      attempts.push(a);
    },
    async recordOutcome(o) {
      if (opts.failOutcome) throw new Error("DDB outcome failure");
      outcomes.push(o);
    },
  };
  return { log, attempts, outcomes };
}

const INPUT = {
  from: "test@nille.net",
  to: ["a@example.com"],
  subject: "Hello",
  rfcMessageId: "<01ABC@nille.net>",
  raw: new Uint8Array([0x68, 0x69]),
  envelopeTo: ["a@example.com"],
};

describe("sendWithAudit", () => {
  it("writes attempt, calls SES, writes success outcome — in that order", async () => {
    const { mailer } = makeStubMailer({
      sesMessageId: "ses-1",
      sentAt: "2026-05-21T17:00:01.000Z",
    });
    const audit = makeStubAuditLog();

    const result = await sendWithAudit({
      mailer,
      auditLog: audit.log,
      input: INPUT,
      now: () => FIXED_NOW,
      randomBytes: () => FIXED_RANDOM,
    });

    expect(audit.attempts).toHaveLength(1);
    expect(audit.attempts[0]!.type).toBe("send_attempted");
    expect(audit.outcomes).toHaveLength(1);
    expect(audit.outcomes[0]!.type).toBe("send_succeeded");
    if (audit.outcomes[0]!.type === "send_succeeded") {
      expect(audit.outcomes[0]!.ses_message_id).toBe("ses-1");
    }
    expect(result.audit_id).toBe(audit.attempts[0]!.audit_id);
    expect(result.ses_message_id).toBe("ses-1");
  });

  it("does NOT call SES when the pre-send attempt write fails (ADR-0008)", async () => {
    const stub = makeStubMailer({
      sesMessageId: "ses-1",
      sentAt: "2026-05-21T17:00:01.000Z",
    });
    const audit = makeStubAuditLog({ failAttempt: true });

    await expect(
      sendWithAudit({
        mailer: stub.mailer,
        auditLog: audit.log,
        input: INPUT,
        now: () => FIXED_NOW,
        randomBytes: () => FIXED_RANDOM,
      }),
    ).rejects.toThrow(/DDB attempt failure/);

    expect(stub.sendCount).toBe(0);
    expect(audit.outcomes).toHaveLength(0);
  });

  it("records send_failed outcome and rethrows when SES rejects", async () => {
    const { mailer } = makeStubMailer(new Error("MessageRejected: not verified"));
    const audit = makeStubAuditLog();

    await expect(
      sendWithAudit({
        mailer,
        auditLog: audit.log,
        input: INPUT,
        now: () => FIXED_NOW,
        randomBytes: () => FIXED_RANDOM,
      }),
    ).rejects.toThrow(/MessageRejected/);

    expect(audit.attempts).toHaveLength(1);
    expect(audit.outcomes).toHaveLength(1);
    expect(audit.outcomes[0]!.type).toBe("send_failed");
    if (audit.outcomes[0]!.type === "send_failed") {
      expect(audit.outcomes[0]!.error).toMatch(/MessageRejected/);
    }
  });

  it("returns success even if outcome write fails (degraded but acceptable)", async () => {
    const warnings: string[] = [];
    const { mailer } = makeStubMailer({
      sesMessageId: "ses-1",
      sentAt: "2026-05-21T17:00:01.000Z",
    });
    const audit = makeStubAuditLog({ failOutcome: true });

    const result = await sendWithAudit({
      mailer,
      auditLog: audit.log,
      input: INPUT,
      now: () => FIXED_NOW,
      randomBytes: () => FIXED_RANDOM,
      warn: (m) => warnings.push(m),
    });

    expect(result.ses_message_id).toBe("ses-1");
    expect(audit.outcomes).toHaveLength(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/outcome write failed/);
  });
});
