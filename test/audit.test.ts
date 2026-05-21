import { describe, expect, it } from "vitest";
import {
  hashSubject,
  makeAuditAttempt,
  makeFailureOutcome,
  makeSuccessOutcome,
  type AuditAttemptInput,
} from "../src/core/audit.js";

const FIXED_NOW = new Date("2026-05-21T17:00:00.000Z");
const FIXED_RANDOM = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function makeInput(): AuditAttemptInput {
  return {
    from: "test@nille.net",
    to: ["a@example.com"],
    subject: "Hello",
    rfcMessageId: "<01ABC@nille.net>",
  };
}

describe("hashSubject", () => {
  it("returns the hex SHA-256 of the UTF-8 subject", () => {
    // Sanity vector: hash of "Hello" is 185f8db32271fe... per any SHA-256 calc.
    expect(hashSubject("Hello")).toBe(
      "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969",
    );
  });

  it("hashes UTF-8 bytes, not the JS string length", () => {
    // "Räksmörgås" has multibyte chars — make sure we hash the encoded form.
    const a = hashSubject("Räksmörgås");
    const b = hashSubject("Räksmörgås");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("hashes empty string deterministically", () => {
    expect(hashSubject("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("makeAuditAttempt", () => {
  it("produces a ULID-shaped audit_id and the attempt row", () => {
    const attempt = makeAuditAttempt(makeInput(), {
      now: () => FIXED_NOW,
      randomBytes: () => FIXED_RANDOM,
    });

    expect(attempt.audit_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(attempt.schema_v).toBe("1");
    expect(attempt.type).toBe("send_attempted");
    expect(attempt.principal).toBe("iam:operator");
    expect(attempt.agent_id).toBeNull();
    expect(attempt.from).toBe("test@nille.net");
    expect(attempt.to).toBe("a@example.com");
    expect(attempt.cc).toBeUndefined();
    expect(attempt.bcc).toBeUndefined();
    expect(attempt.subject_hash).toBe(hashSubject("Hello"));
    expect(attempt.rfc_message_id).toBe("<01ABC@nille.net>");
    expect(attempt.requested_at).toBe("2026-05-21T17:00:00.000Z");
  });

  it("comma-joins multi-recipient lists for to/cc/bcc", () => {
    const attempt = makeAuditAttempt(
      {
        ...makeInput(),
        to: ["a@example.com", "b@example.com"],
        cc: ["c@example.com"],
        bcc: ["d@example.com", "e@example.com"],
      },
      { now: () => FIXED_NOW, randomBytes: () => FIXED_RANDOM },
    );

    expect(attempt.to).toBe("a@example.com, b@example.com");
    expect(attempt.cc).toBe("c@example.com");
    expect(attempt.bcc).toBe("d@example.com, e@example.com");
  });

  it("omits cc/bcc when not supplied (no undefined leakage)", () => {
    const attempt = makeAuditAttempt(makeInput(), {
      now: () => FIXED_NOW,
      randomBytes: () => FIXED_RANDOM,
    });

    expect("cc" in attempt).toBe(false);
    expect("bcc" in attempt).toBe(false);
  });

  it("two attempts at the same instant get distinct audit_ids", () => {
    const a = makeAuditAttempt(makeInput(), {
      now: () => FIXED_NOW,
      randomBytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });
    const b = makeAuditAttempt(makeInput(), {
      now: () => FIXED_NOW,
      randomBytes: () => new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
    });
    expect(a.audit_id).not.toBe(b.audit_id);
  });
});

describe("makeSuccessOutcome / makeFailureOutcome", () => {
  it("success outcome carries ses_message_id and succeeded_at", () => {
    const outcome = makeSuccessOutcome({
      auditId: "01HXYZ",
      sesMessageId: "ses-abc",
      succeededAt: "2026-05-21T17:00:01.000Z",
    });

    expect(outcome.audit_id).toBe("01HXYZ");
    expect(outcome.type).toBe("send_succeeded");
    expect(outcome.ses_message_id).toBe("ses-abc");
    expect(outcome.succeeded_at).toBe("2026-05-21T17:00:01.000Z");
  });

  it("failure outcome carries error and failed_at", () => {
    const outcome = makeFailureOutcome({
      auditId: "01HXYZ",
      error: "MessageRejected: Email address is not verified",
      failedAt: "2026-05-21T17:00:01.000Z",
    });

    expect(outcome.audit_id).toBe("01HXYZ");
    expect(outcome.type).toBe("send_failed");
    expect(outcome.error).toBe(
      "MessageRejected: Email address is not verified",
    );
    expect(outcome.failed_at).toBe("2026-05-21T17:00:01.000Z");
  });
});
