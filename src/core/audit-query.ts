// Audit query (ADR-0020). Pure types + a row-narrowing function. The DDB
// adapter (src/aws/dynamodb-audit-query.ts) calls Query on the AuditLog
// table's GSI1 ((principal, audit_id)), maps each raw row through
// `normalizeAuditRow`, and returns the discriminated union below.
//
// We deliberately do *not* re-derive the AuditLog row shapes from
// src/core/audit.ts — that file's types describe the *write* contract
// (what's persisted), and audit_query is a *read* contract (what callers
// see). Coupling them would force every audit-row schema change to ripple
// through the read API even when the read shape can stay stable.

export type AuditQueryInput = {
  // Optional filter — solo-direct rows always have agent_id: null, so this
  // is mainly forward-compat for when ADR-0008 Layer 1 lands. Pass `null`
  // explicitly to filter for solo-direct rows; pass a string to match a
  // future Cognito-issued agent id.
  agent_id?: string | null;
  // Address filter applies as: from = :addr OR contains(to, :addr) OR
  // contains(cc, :addr) OR contains(bcc, :addr). Substring match on a
  // delimited list is good enough at v1 volume; full SS-attribute support
  // is deferred (see ADR-0020 §"FilterExpressions, not key conditions").
  address?: string;
  since?: Date;
  until?: Date;
  // Caller-controlled page size. Clamped to [1, MAX_LIMIT]; default
  // DEFAULT_LIMIT when unset.
  limit?: number;
  // Opaque base64url(JSON) cursor returned as `next_cursor` from a prior
  // call. The library treats it as a black box; the DDB adapter encodes it
  // from `LastEvaluatedKey` and decodes it back into `ExclusiveStartKey`.
  cursor?: string;
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export type AuditQueryResult = {
  events: AuditQueryEvent[];
  // Present iff the query truncated at the limit and more rows remain.
  next_cursor?: string;
};

export type AuditQueryEvent =
  | AuditQueryAttempted
  | AuditQueryBlocked
  | AuditQuerySucceeded
  | AuditQueryFailed;

// Common to every variant. The audit_id is the join key between attempt and
// outcome rows in the underlying table — but on the wire we expose the
// *currently materialized* shape (whatever `type` the row's UpdateCommand
// last wrote). See ADR-0020 §"Result shape".
type AuditQueryBase = {
  audit_id: string;
  schema_v: "1";
  principal: string;
  agent_id: string | null;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject_hash: string;
  rfc_message_id: string;
  requested_at: string;
};

export type AuditQueryAttempted = AuditQueryBase & {
  type: "send_attempted";
  // ADR-0019: present iff the operator passed --allow-suppressed.
  allow_suppressed?: true;
};

export type AuditQueryBlocked = AuditQueryBase & {
  type: "send_blocked";
  blocked_recipients: string;
  block_reason: "suppression_list";
};

export type AuditQuerySucceeded = AuditQueryBase & {
  type: "send_succeeded";
  ses_message_id: string;
  succeeded_at: string;
};

export type AuditQueryFailed = AuditQueryBase & {
  type: "send_failed";
  error: string;
  failed_at: string;
};

export interface AuditQueryReader {
  query(input: AuditQueryInput): Promise<AuditQueryResult>;
}

// DDB row → normalized event. Defensive: malformed rows return null and the
// adapter drops them. Audit data is forensic, so we'd rather skip a single
// corrupt row than crash the whole query — operators querying historical
// data shouldn't be denied service by one bad write.
export function normalizeAuditRow(row: unknown): AuditQueryEvent | null {
  if (!isRecord(row)) return null;
  const base = readBase(row);
  if (base === null) return null;

  const type = row["type"];
  if (type === "send_attempted") {
    const event: AuditQueryAttempted = { ...base, type: "send_attempted" };
    if (row["allow_suppressed"] === true) event.allow_suppressed = true;
    return event;
  }
  if (type === "send_blocked") {
    const blocked_recipients = row["blocked_recipients"];
    const block_reason = row["block_reason"];
    if (
      typeof blocked_recipients !== "string" ||
      block_reason !== "suppression_list"
    ) {
      return null;
    }
    return {
      ...base,
      type: "send_blocked",
      blocked_recipients,
      block_reason: "suppression_list",
    };
  }
  if (type === "send_succeeded") {
    const ses_message_id = row["ses_message_id"];
    const succeeded_at = row["succeeded_at"];
    if (typeof ses_message_id !== "string" || typeof succeeded_at !== "string") {
      return null;
    }
    return { ...base, type: "send_succeeded", ses_message_id, succeeded_at };
  }
  if (type === "send_failed") {
    const error = row["error"];
    const failed_at = row["failed_at"];
    if (typeof error !== "string" || typeof failed_at !== "string") return null;
    return { ...base, type: "send_failed", error, failed_at };
  }
  return null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  if (limit > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(limit);
}

function readBase(row: Record<string, unknown>): AuditQueryBase | null {
  const audit_id = row["audit_id"];
  const schema_v = row["schema_v"];
  const principal = row["principal"];
  const agent_id = row["agent_id"];
  const from = row["from"];
  const to = row["to"];
  const subject_hash = row["subject_hash"];
  const rfc_message_id = row["rfc_message_id"];
  const requested_at = row["requested_at"];

  if (
    typeof audit_id !== "string" ||
    schema_v !== "1" ||
    typeof principal !== "string" ||
    !(typeof agent_id === "string" || agent_id === null) ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof subject_hash !== "string" ||
    typeof rfc_message_id !== "string" ||
    typeof requested_at !== "string"
  ) {
    return null;
  }

  const base: AuditQueryBase = {
    audit_id,
    schema_v: "1",
    principal,
    agent_id,
    from,
    to,
    subject_hash,
    rfc_message_id,
    requested_at,
  };
  const cc = row["cc"];
  const bcc = row["bcc"];
  if (typeof cc === "string") base.cc = cc;
  if (typeof bcc === "string") base.bcc = bcc;
  return base;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
