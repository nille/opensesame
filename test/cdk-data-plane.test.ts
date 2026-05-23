import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { DataPlaneStack } from "../src/cdk/data-plane-stack.js";

// Tests pin the synthesized CloudFormation against ADR-0011 (stable construct
// IDs, RETAIN on stateful resources) and ADR-0013 (table keys, GSI shape).
// Logical-ID assertions are deliberately strict — renaming any of these
// resources would force a destructive replace, which ADR-0011 forbids without
// an explicit migration ADR.

function synth() {
  const app = new App();
  const stack = new DataPlaneStack(app, "OpenSesameDataPlane", {
    env: { account: "925039213717", region: "eu-north-1" },
  });
  return Template.fromStack(stack);
}

describe("DataPlaneStack — Messages table", () => {
  it("creates Messages table keyed by address (PK) + internal_id (SK)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "address", KeyType: "HASH" },
        { AttributeName: "internal_id", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "address", AttributeType: "S" },
        { AttributeName: "internal_id", AttributeType: "S" },
      ]),
    });
  });

  it("provisions GSI1 on message_id (PK) + received_at (SK)", () => {
    // GSI1 is the lookup path for the ADR-0007 tool surface. Sparse — rows
    // without message_id (skeleton rows) are intentionally absent.
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "message_id", KeyType: "HASH" },
            { AttributeName: "received_at", KeyType: "RANGE" },
          ],
        }),
      ]),
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "message_id", AttributeType: "S" },
        { AttributeName: "received_at", AttributeType: "S" },
      ]),
    });
  });

  it("provisions ThreadIdGSI on thread_id (PK) + internal_id (SK) (ADR-0027)", () => {
    // ThreadIdGSI is the read path for list_thread_messages. Sparse — rows
    // without thread_id (skeleton rows + legacy pre-slice-8.8 rows) sit out
    // of the index. Projection is INCLUDE rather than ALL so the GSI item
    // size stays bounded; body chunks + headers_blob still resolve via the
    // base-table primary key.
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "ThreadIdGSI",
          KeySchema: [
            { AttributeName: "thread_id", KeyType: "HASH" },
            { AttributeName: "internal_id", KeyType: "RANGE" },
          ],
          Projection: Match.objectLike({
            ProjectionType: "INCLUDE",
            // Match.arrayWith requires the patterns to appear in order, so the
            // sequence below mirrors the construct's NonKeyAttributes order.
            NonKeyAttributes: Match.arrayWith([
              "parse_status",
              "schema_v",
              "received_at",
              "message_id",
              "from_raw",
              "subject",
              "snippet",
              "direction",
              "read_at",
            ]),
          }),
        }),
      ]),
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "thread_id", AttributeType: "S" },
      ]),
    });
  });

  it("enables PITR on Messages (ADR-0012 backups)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: "address" }),
      ]),
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe("DataPlaneStack — MessageBodyChunks table", () => {
  it("creates MessageBodyChunks keyed by internal_id (PK) + chunk_seq (SK)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "internal_id", KeyType: "HASH" },
        { AttributeName: "chunk_seq", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "internal_id", AttributeType: "S" },
        { AttributeName: "chunk_seq", AttributeType: "S" },
      ]),
    });
  });

  it("enables PITR on MessageBodyChunks", () => {
    const t = synth();
    t.allResourcesProperties("AWS::DynamoDB::Table", {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe("DataPlaneStack — AuditLog table", () => {
  it("provisions GSI1 on (principal, audit_id) for audit_query (ADR-0020)", () => {
    // ADR-0020: the read path range-scans by audit_id (ULID = lex-sortable
    // by attempt time) within a single principal partition. ALL projection
    // because the audit table is small and the cost of a follow-up GetItem
    // per result outweighs the storage overhead.
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "audit_id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "principal", KeyType: "HASH" },
            { AttributeName: "audit_id", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "audit_id", AttributeType: "S" },
        { AttributeName: "principal", AttributeType: "S" },
      ]),
    });
  });
});

describe("DataPlaneStack — BounceLog table", () => {
  it("creates BounceLog keyed by ses_message_id (PK) + event_id (SK) (ADR-0018)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "ses_message_id", KeyType: "HASH" },
        { AttributeName: "event_id", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "ses_message_id", AttributeType: "S" },
        { AttributeName: "event_id", AttributeType: "S" },
      ]),
    });
  });
});

describe("DataPlaneStack — Suppressions table", () => {
  it("creates Suppressions keyed by recipient (PK only) (ADR-0019)", () => {
    // ADR-0019: PK=recipient (lowercased email) — no SK because we keep the
    // single canonical row per address (last-event-wins on the conditional
    // upsert). RETAIN + PITR like the other forensic tables.
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "recipient", KeyType: "HASH" }],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "recipient", AttributeType: "S" },
      ]),
    });
  });
});

describe("DataPlaneStack — table count and stable logical IDs", () => {
  it("creates exactly the five ADR-0013 + ADR-0016 + ADR-0018 + ADR-0019 tables (no speculative extras)", () => {
    const t = synth();
    t.resourceCountIs("AWS::DynamoDB::Table", 5);
  });

  it("pins stable logical IDs per ADR-0011 (renaming forces destructive replace)", () => {
    // CDK derives logical IDs from construct paths; pinning them here means
    // accidental construct renames fail loudly in CI rather than silently
    // recreating a table on next deploy.
    const t = synth();
    const ids = Object.keys(t.findResources("AWS::DynamoDB::Table"));
    expect(ids).toContain(expectIdContaining(ids, "Messages"));
    expect(ids).toContain(expectIdContaining(ids, "MessageBodyChunks"));
    expect(ids).toContain(expectIdContaining(ids, "AuditLog"));
    expect(ids).toContain(expectIdContaining(ids, "BounceLog"));
    expect(ids).toContain(expectIdContaining(ids, "Suppressions"));
  });
});

describe("DataPlaneStack — raw MIME bucket", () => {
  it("creates the raw bucket with versioning ON (ADR-0012)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({}),
        ]),
      }),
    });
  });

  it("blocks all public access on the raw bucket", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("transitions raw objects to Glacier Deep Archive after 90 days (ADR-0012)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: "DEEP_ARCHIVE",
                TransitionInDays: 90,
              }),
            ]),
          }),
        ]),
      },
    });
  });

  it("expires staged draft attachments after 30 days (ADR-0043)", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: "Enabled",
            Prefix: "outbound-staging/",
            ExpirationInDays: 30,
          }),
        ]),
      },
    });
  });
});

describe("DataPlaneStack — RETAIN on stateful resources", () => {
  it("marks both DynamoDB tables and the raw bucket as Retain on stack delete", () => {
    // ADR-0011's stable-ID rule means accidental stack delete must not vaporize
    // operator data. RETAIN preserves the resource and surfaces a manual
    // cleanup step instead.
    const t = synth();
    for (const r of Object.values(t.findResources("AWS::DynamoDB::Table"))) {
      expect((r as { DeletionPolicy?: string }).DeletionPolicy).toBe("Retain");
    }
    for (const r of Object.values(t.findResources("AWS::S3::Bucket"))) {
      expect((r as { DeletionPolicy?: string }).DeletionPolicy).toBe("Retain");
    }
  });
});

describe("DataPlaneStack — EventBridge bus", () => {
  it("creates a custom EventBridge bus (the MailIngested target)", () => {
    const t = synth();
    t.resourceCountIs("AWS::Events::EventBus", 1);
    t.hasResourceProperties("AWS::Events::EventBus", {
      Name: Match.stringLikeRegexp("opensesame"),
    });
  });
});

describe("DataPlaneStack — outputs for smoke driver", () => {
  it("exports table, bucket, and bus names so the smoke driver can resolve them", () => {
    // smoke-ingest reads OPENSESAME_* env vars; these outputs make
    // `cdk deploy --outputs-file` straightforward.
    const t = synth();
    const outputs = t.findOutputs("*");
    const keys = Object.keys(outputs);
    expect(keys).toContain("MessagesTableName");
    expect(keys).toContain("MessageBodyChunksTableName");
    expect(keys).toContain("RawMimeBucketName");
    expect(keys).toContain("EventBusName");
  });
});

// Tiny helper: assert any synthesized logical ID contains the human-readable
// construct ID, so we catch accidental renames without pinning the exact
// hash suffix CDK appends.
function expectIdContaining(ids: string[], needle: string): string {
  const hit = ids.find((id) => id.includes(needle));
  if (!hit) {
    throw new Error(`no logical ID containing ${needle} (got: ${ids.join(", ")})`);
  }
  return hit;
}
