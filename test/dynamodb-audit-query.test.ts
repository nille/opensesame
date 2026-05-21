import { describe, expect, it, vi } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { makeDynamoAuditQueryReader } from "../src/aws/dynamodb-audit-query.js";

// On-the-wire tests for the audit-query DDB adapter (ADR-0020). Asserts the
// QueryCommand input shape: GSI1 + (principal, audit_id) key condition,
// FilterExpression for agent_id/address, cursor round-trip via
// ExclusiveStartKey/LastEvaluatedKey.

const TABLE = "opensesame-audit-test";
const GSI = "GSI1";

type StubClient = { send: ReturnType<typeof vi.fn> };

function makeStubClient(
  responder: (cmd: unknown) => Promise<unknown>,
): StubClient {
  return { send: vi.fn(responder) };
}

const SAMPLE_ROW = {
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
  type: "send_attempted",
};

describe("DynamoAuditQueryReader.query", () => {
  it("issues a QueryCommand on GSI1 with the (principal, audit_id) key condition", async () => {
    const client = makeStubClient(async (cmd) => {
      expect(cmd).toBeInstanceOf(QueryCommand);
      const input = (cmd as QueryCommand).input;
      expect(input.TableName).toBe(TABLE);
      expect(input.IndexName).toBe(GSI);
      expect(input.KeyConditionExpression).toBe(
        "principal = :principal AND audit_id BETWEEN :lo AND :hi",
      );
      expect(input.ExpressionAttributeValues?.[":principal"]).toBe(
        "iam:operator",
      );
      // No since/until passed → bounds collapse to the 48-bit floor/ceiling.
      expect(input.ExpressionAttributeValues?.[":lo"]).toBe(
        "00000000000000000000000000",
      );
      expect(input.ExpressionAttributeValues?.[":hi"]).toBe(
        "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
      );
      // Default page size from clampLimit.
      expect(input.Limit).toBe(50);
      // No filters → no FilterExpression. Pinning the absence prevents an
      // accidental always-on filter from regressing the cheap path.
      expect(input.FilterExpression).toBeUndefined();
      return { Items: [SAMPLE_ROW] };
    });

    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    const out = await reader.query({});
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      audit_id: SAMPLE_ROW.audit_id,
      type: "send_attempted",
    });
    expect(out.next_cursor).toBeUndefined();
  });

  it("converts since/until into ULID bounds on the audit_id sort key", async () => {
    const since = new Date(Date.UTC(2026, 4, 21, 0, 0, 0, 0));
    const until = new Date(Date.UTC(2026, 4, 22, 0, 0, 0, 0));
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      const lo = input.ExpressionAttributeValues?.[":lo"] as string;
      const hi = input.ExpressionAttributeValues?.[":hi"] as string;
      // Both bounds are exactly 26 chars (the ULID width).
      expect(lo).toHaveLength(26);
      expect(hi).toHaveLength(26);
      // Lower bound has the all-zero random tail; upper has the all-Z tail.
      expect(lo.slice(10)).toBe("0000000000000000");
      expect(hi.slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    await reader.query({ since, until });
  });

  it("adds an agent_id FilterExpression when agent_id is provided", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      expect(input.FilterExpression).toBe("agent_id = :agent_id");
      expect(input.ExpressionAttributeValues?.[":agent_id"]).toBe("agent-x");
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    await reader.query({ agent_id: "agent-x" });
  });

  it("matches solo-direct rows when agent_id: null is passed explicitly", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      expect(input.FilterExpression).toBe("agent_id = :null_agent_id");
      // DDB doc client maps a JS `null` to the NULL attribute type — same
      // shape every audit row writes for solo-direct.
      expect(input.ExpressionAttributeValues?.[":null_agent_id"]).toBe(null);
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    await reader.query({ agent_id: null });
  });

  it("address filter spans from + contains() over to/cc/bcc, aliasing reserved words", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      expect(input.FilterExpression).toBe(
        "(#from = :addr OR contains(#to, :addr) OR contains(#cc, :addr) OR contains(#bcc, :addr))",
      );
      expect(input.ExpressionAttributeNames?.["#from"]).toBe("from");
      expect(input.ExpressionAttributeNames?.["#to"]).toBe("to");
      expect(input.ExpressionAttributeNames?.["#cc"]).toBe("cc");
      expect(input.ExpressionAttributeNames?.["#bcc"]).toBe("bcc");
      expect(input.ExpressionAttributeValues?.[":addr"]).toBe(
        "alice@example.com",
      );
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    await reader.query({ address: "alice@example.com" });
  });

  it("combines agent_id + address filters with AND", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      expect(input.FilterExpression).toBe(
        "agent_id = :agent_id AND (#from = :addr OR contains(#to, :addr) OR contains(#cc, :addr) OR contains(#bcc, :addr))",
      );
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    await reader.query({ agent_id: "agent-x", address: "alice@example.com" });
  });

  it("clamps Limit into the [1, 500] range", async () => {
    let observedLimit: number | undefined;
    const client = makeStubClient(async (cmd) => {
      observedLimit = (cmd as QueryCommand).input.Limit;
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });

    await reader.query({ limit: 9999 });
    expect(observedLimit).toBe(500);

    await reader.query({ limit: 0 });
    expect(observedLimit).toBe(1);
  });

  it("emits next_cursor as base64url(JSON(LastEvaluatedKey)) and round-trips via ExclusiveStartKey", async () => {
    const lastKey = {
      principal: "iam:operator",
      audit_id: "01J0000000ABCDEFGHJKMNPQRS",
    };
    let firstCall = true;
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      if (firstCall) {
        firstCall = false;
        expect(input.ExclusiveStartKey).toBeUndefined();
        return { Items: [SAMPLE_ROW], LastEvaluatedKey: lastKey };
      }
      // Second call passes the cursor — adapter must decode it back to
      // exactly the LastEvaluatedKey we returned on the first call.
      expect(input.ExclusiveStartKey).toEqual(lastKey);
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });

    const page1 = await reader.query({});
    expect(typeof page1.next_cursor).toBe("string");
    // Sanity check the cursor encoding without coupling tests to its exact
    // internal shape — it must round-trip back to lastKey.
    const decoded = JSON.parse(
      Buffer.from(page1.next_cursor!, "base64url").toString("utf8"),
    );
    expect(decoded).toEqual(lastKey);

    const page2 = await reader.query({ cursor: page1.next_cursor! });
    expect(page2.next_cursor).toBeUndefined();
  });

  it("rejects malformed cursors with a clear error", async () => {
    const client = makeStubClient(async () => ({ Items: [] }));
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    await expect(reader.query({ cursor: "!!!not-base64!!!" })).rejects.toThrow(
      /cursor/i,
    );
  });

  it("drops malformed rows from the result rather than failing the query", async () => {
    const client = makeStubClient(async () => ({
      Items: [
        SAMPLE_ROW,
        // Missing the discriminator — defensively dropped by normalizeAuditRow.
        { ...SAMPLE_ROW, audit_id: "01J0000000WXYZWXYZWXYZWXYZ", type: undefined },
      ],
    }));
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
    });
    const out = await reader.query({});
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.audit_id).toBe(SAMPLE_ROW.audit_id);
  });

  it("uses the override principal when one is provided in deps", async () => {
    const client = makeStubClient(async (cmd) => {
      const input = (cmd as QueryCommand).input;
      expect(input.ExpressionAttributeValues?.[":principal"]).toBe(
        "cognito:abc-123",
      );
      return { Items: [] };
    });
    const reader = makeDynamoAuditQueryReader({
      client: client as never,
      auditTable: TABLE,
      gsiName: GSI,
      principal: "cognito:abc-123",
    });
    await reader.query({});
  });
});
