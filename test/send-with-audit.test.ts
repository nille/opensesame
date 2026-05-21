import { describe, expect, it } from "vitest";
import { sendWithAudit } from "../src/core/send-with-audit.js";
import type {
  AuditLog,
  AuditAttempt,
  AuditOutcome,
  AuditBlocked,
} from "../src/core/audit.js";
import type { OutboundMailer } from "../src/core/outbound.js";
import {
  SuppressionBlockError,
  type SuppressionList,
  type SuppressedRecipient,
} from "../src/core/suppression.js";

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
  failBlocked?: boolean;
} = {}): {
  log: AuditLog;
  attempts: AuditAttempt[];
  outcomes: AuditOutcome[];
  blocked: AuditBlocked[];
} {
  const attempts: AuditAttempt[] = [];
  const outcomes: AuditOutcome[] = [];
  const blocked: AuditBlocked[] = [];
  const log: AuditLog = {
    async recordAttempt(a) {
      if (opts.failAttempt) throw new Error("DDB attempt failure");
      attempts.push(a);
    },
    async recordOutcome(o) {
      if (opts.failOutcome) throw new Error("DDB outcome failure");
      outcomes.push(o);
    },
    async recordBlocked(b) {
      if (opts.failBlocked) throw new Error("DDB blocked failure");
      blocked.push(b);
    },
  };
  return { log, attempts, outcomes, blocked };
}

function makeStubSuppressionList(
  matches: readonly SuppressedRecipient[],
): {
  list: SuppressionList;
  calls: Array<readonly string[]>;
} {
  const calls: Array<readonly string[]> = [];
  const list: SuppressionList = {
    async checkRecipients(recipients) {
      calls.push(recipients);
      return matches.slice();
    },
  };
  return { list, calls };
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

  describe("suppression-list gate (ADR-0019)", () => {
    it("does not check suppression when no list is configured (back-compat)", async () => {
      const stub = makeStubMailer({
        sesMessageId: "ses-1",
        sentAt: "2026-05-21T17:00:01.000Z",
      });
      const audit = makeStubAuditLog();

      const result = await sendWithAudit({
        mailer: stub.mailer,
        auditLog: audit.log,
        input: INPUT,
        now: () => FIXED_NOW,
        randomBytes: () => FIXED_RANDOM,
      });

      expect(result.ses_message_id).toBe("ses-1");
      expect(audit.attempts).toHaveLength(1);
      expect(audit.outcomes).toHaveLength(1);
      expect(audit.blocked).toHaveLength(0);
    });

    it("sends when configured list returns empty (clear)", async () => {
      const stub = makeStubMailer({
        sesMessageId: "ses-1",
        sentAt: "2026-05-21T17:00:01.000Z",
      });
      const audit = makeStubAuditLog();
      const supp = makeStubSuppressionList([]);

      const result = await sendWithAudit({
        mailer: stub.mailer,
        auditLog: audit.log,
        suppressionList: supp.list,
        input: INPUT,
        now: () => FIXED_NOW,
        randomBytes: () => FIXED_RANDOM,
      });

      expect(supp.calls).toHaveLength(1);
      // Union of to + cc + bcc — INPUT has only `to: ["a@example.com"]`.
      expect(supp.calls[0]).toEqual(["a@example.com"]);
      expect(result.ses_message_id).toBe("ses-1");
      expect(audit.attempts).toHaveLength(1);
      expect(audit.blocked).toHaveLength(0);
    });

    it("blocks the send and writes send_blocked when a recipient is suppressed", async () => {
      const stub = makeStubMailer({
        sesMessageId: "ses-1",
        sentAt: "2026-05-21T17:00:01.000Z",
      });
      const audit = makeStubAuditLog();
      const supp = makeStubSuppressionList([
        {
          recipient: "a@example.com",
          reason: "bounced_permanent",
          last_event_at: "2026-05-20T08:00:00.000Z",
        },
      ]);

      await expect(
        sendWithAudit({
          mailer: stub.mailer,
          auditLog: audit.log,
          suppressionList: supp.list,
          input: INPUT,
          now: () => FIXED_NOW,
          randomBytes: () => FIXED_RANDOM,
        }),
      ).rejects.toBeInstanceOf(SuppressionBlockError);

      expect(stub.sendCount).toBe(0);
      expect(audit.attempts).toHaveLength(0);
      expect(audit.outcomes).toHaveLength(0);
      expect(audit.blocked).toHaveLength(1);
      expect(audit.blocked[0]!.type).toBe("send_blocked");
      expect(audit.blocked[0]!.block_reason).toBe("suppression_list");
      expect(audit.blocked[0]!.blocked_recipients).toBe("a@example.com");
    });

    it("checks the union of to + cc + bcc for multi-recipient sends", async () => {
      const stub = makeStubMailer({
        sesMessageId: "ses-1",
        sentAt: "2026-05-21T17:00:01.000Z",
      });
      const audit = makeStubAuditLog();
      const supp = makeStubSuppressionList([]);

      await sendWithAudit({
        mailer: stub.mailer,
        auditLog: audit.log,
        suppressionList: supp.list,
        input: {
          ...INPUT,
          cc: ["c@example.com"],
          bcc: ["d@example.com"],
        },
        now: () => FIXED_NOW,
        randomBytes: () => FIXED_RANDOM,
      });

      expect(supp.calls).toHaveLength(1);
      expect([...supp.calls[0]!].sort()).toEqual([
        "a@example.com",
        "c@example.com",
        "d@example.com",
      ]);
    });

    it("blocks even when only one of N recipients is suppressed (partial match)", async () => {
      const stub = makeStubMailer({
        sesMessageId: "ses-1",
        sentAt: "2026-05-21T17:00:01.000Z",
      });
      const audit = makeStubAuditLog();
      const supp = makeStubSuppressionList([
        {
          recipient: "c@example.com",
          reason: "complained",
          last_event_at: "2026-05-22T08:00:00.000Z",
        },
      ]);

      await expect(
        sendWithAudit({
          mailer: stub.mailer,
          auditLog: audit.log,
          suppressionList: supp.list,
          input: { ...INPUT, cc: ["c@example.com"] },
          now: () => FIXED_NOW,
          randomBytes: () => FIXED_RANDOM,
        }),
      ).rejects.toBeInstanceOf(SuppressionBlockError);

      expect(stub.sendCount).toBe(0);
      expect(audit.blocked).toHaveLength(1);
      expect(audit.blocked[0]!.blocked_recipients).toBe("c@example.com");
    });

    it("skips the check and proceeds when allowSuppressed is true", async () => {
      const stub = makeStubMailer({
        sesMessageId: "ses-1",
        sentAt: "2026-05-21T17:00:01.000Z",
      });
      const audit = makeStubAuditLog();
      // Even if the list says blocked, the override should bypass and not
      // call checkRecipients at all.
      let called = false;
      const list: SuppressionList = {
        async checkRecipients() {
          called = true;
          return [
            {
              recipient: "a@example.com",
              reason: "bounced_permanent",
              last_event_at: "2026-05-20T08:00:00.000Z",
            },
          ];
        },
      };

      const result = await sendWithAudit({
        mailer: stub.mailer,
        auditLog: audit.log,
        suppressionList: list,
        allowSuppressed: true,
        input: INPUT,
        now: () => FIXED_NOW,
        randomBytes: () => FIXED_RANDOM,
      });

      expect(called).toBe(false);
      expect(stub.sendCount).toBe(1);
      expect(result.ses_message_id).toBe("ses-1");
      expect(audit.attempts).toHaveLength(1);
      // The attempt row carries allow_suppressed: true so the audit query
      // can distinguish overridden sends from unguarded ones.
      expect(audit.attempts[0]!.allow_suppressed).toBe(true);
      expect(audit.outcomes).toHaveLength(1);
      expect(audit.blocked).toHaveLength(0);
    });
  });
});
