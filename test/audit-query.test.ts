import { describe, expect, it } from "vitest";
import {
  clampLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  normalizeAuditRow,
} from "../src/core/audit-query.js";

// Pure-row narrowing for ADR-0020. The DDB adapter (slice 6 step 3) drops
// each Query result through this function so callers never see a raw DDB
// item — only one of the four discriminated variants. Malformed rows return
// null and the adapter filters them out.

const BASE_ROW = {
  audit_id: "01J0000000ABCDEFGHJKMNPQRS",
  schema_v: "1",
  principal: "iam:operator",
  agent_id: null,
  from: "test@nille.net",
  to: "alice@example.com",
  subject_hash:
    "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
  rfc_message_id: "<msg-1@nille.net>",
  requested_at: "2026-05-21T17:00:00.000Z",
};

describe("normalizeAuditRow", () => {
  it("normalizes a send_attempted row", () => {
    const out = normalizeAuditRow({ ...BASE_ROW, type: "send_attempted" });
    expect(out).toEqual({ ...BASE_ROW, type: "send_attempted" });
  });

  it("preserves allow_suppressed: true on send_attempted", () => {
    const out = normalizeAuditRow({
      ...BASE_ROW,
      type: "send_attempted",
      allow_suppressed: true,
    });
    expect(out).toEqual({
      ...BASE_ROW,
      type: "send_attempted",
      allow_suppressed: true,
    });
  });

  it("normalizes a send_blocked row with suppression_list reason", () => {
    const out = normalizeAuditRow({
      ...BASE_ROW,
      type: "send_blocked",
      blocked_recipients: "alice@example.com",
      block_reason: "suppression_list",
    });
    expect(out).toEqual({
      ...BASE_ROW,
      type: "send_blocked",
      blocked_recipients: "alice@example.com",
      block_reason: "suppression_list",
    });
  });

  it("normalizes a send_succeeded row", () => {
    const out = normalizeAuditRow({
      ...BASE_ROW,
      type: "send_succeeded",
      ses_message_id: "ses-msg-1",
      succeeded_at: "2026-05-21T17:00:01.000Z",
    });
    expect(out).toEqual({
      ...BASE_ROW,
      type: "send_succeeded",
      ses_message_id: "ses-msg-1",
      succeeded_at: "2026-05-21T17:00:01.000Z",
    });
  });

  it("normalizes a send_failed row", () => {
    const out = normalizeAuditRow({
      ...BASE_ROW,
      type: "send_failed",
      error: "AccessDenied",
      failed_at: "2026-05-21T17:00:01.000Z",
    });
    expect(out).toEqual({
      ...BASE_ROW,
      type: "send_failed",
      error: "AccessDenied",
      failed_at: "2026-05-21T17:00:01.000Z",
    });
  });

  it("preserves cc/bcc when present", () => {
    const out = normalizeAuditRow({
      ...BASE_ROW,
      cc: "carol@example.com",
      bcc: "bob@example.com",
      type: "send_attempted",
    });
    expect(out).toMatchObject({
      cc: "carol@example.com",
      bcc: "bob@example.com",
    });
  });

  it("drops rows with an unknown type — forensic data should never be coerced", () => {
    expect(normalizeAuditRow({ ...BASE_ROW, type: "send_pending" })).toBe(null);
    expect(normalizeAuditRow({ ...BASE_ROW })).toBe(null); // no type at all
  });

  it("drops rows with the wrong schema_v — read fence against future migrations", () => {
    expect(
      normalizeAuditRow({ ...BASE_ROW, schema_v: "2", type: "send_attempted" }),
    ).toBe(null);
  });

  it("drops send_blocked rows with a malformed block_reason", () => {
    expect(
      normalizeAuditRow({
        ...BASE_ROW,
        type: "send_blocked",
        blocked_recipients: "alice@example.com",
        block_reason: "manual_override",
      }),
    ).toBe(null);
  });

  it("drops send_succeeded rows missing ses_message_id or succeeded_at", () => {
    expect(
      normalizeAuditRow({
        ...BASE_ROW,
        type: "send_succeeded",
        succeeded_at: "2026-05-21T17:00:01.000Z",
      }),
    ).toBe(null);
    expect(
      normalizeAuditRow({
        ...BASE_ROW,
        type: "send_succeeded",
        ses_message_id: "ses-1",
      }),
    ).toBe(null);
  });

  it("drops non-object inputs", () => {
    expect(normalizeAuditRow(null)).toBe(null);
    expect(normalizeAuditRow(undefined)).toBe(null);
    expect(normalizeAuditRow("string")).toBe(null);
    expect(normalizeAuditRow([])).toBe(null);
  });

  it("requires agent_id to be string or null (no implicit coercion)", () => {
    expect(
      normalizeAuditRow({
        ...BASE_ROW,
        agent_id: 42,
        type: "send_attempted",
      }),
    ).toBe(null);
  });

  it("ignores extra unknown fields without failing", () => {
    // Forward-compat: a future write may add columns that this slice's
    // reader doesn't know about. Drop-through is the desired behavior.
    const out = normalizeAuditRow({
      ...BASE_ROW,
      type: "send_attempted",
      future_field: "ignored",
    });
    expect(out).toEqual({ ...BASE_ROW, type: "send_attempted" });
  });
});

describe("clampLimit", () => {
  it("returns DEFAULT_LIMIT when limit is undefined", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
  });

  it("clamps non-positive or non-finite values to 1", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(Number.NaN)).toBe(1);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("clamps oversized values to MAX_LIMIT", () => {
    expect(clampLimit(MAX_LIMIT + 1)).toBe(MAX_LIMIT);
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
  });

  it("floors fractional values", () => {
    expect(clampLimit(7.9)).toBe(7);
  });

  it("preserves in-range values verbatim", () => {
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(clampLimit(1)).toBe(1);
  });
});
