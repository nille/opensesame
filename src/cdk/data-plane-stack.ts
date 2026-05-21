import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  StorageClass,
} from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

// Data plane (per ADR-0011 + ADR-0013 + ADR-0016 + ADR-0018):
//   - Messages           PK=address, SK=internal_id, GSI1 on message_id+received_at
//   - MessageBodyChunks  PK=internal_id, SK=chunk_seq
//   - AuditLog           PK=audit_id (ULID, lex-sortable by attempt time)
//   - BounceLog          PK=ses_message_id, SK=event_id (per-event forensic store)
//   - Raw MIME bucket    versioning ON, BPA, lifecycle to Glacier Deep Archive
//   - EventBridge bus    target for MailIngested
//
// Construct IDs are load-bearing (ADR-0011): renaming any of them forces a
// destructive replace and is forbidden without an explicit migration ADR.

export class DataPlaneStack extends Stack {
  readonly messagesTable: Table;
  readonly bodyChunksTable: Table;
  readonly auditTable: Table;
  readonly bounceLogTable: Table;
  readonly rawMimeBucket: Bucket;
  readonly eventBus: EventBus;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.messagesTable = new Table(this, "Messages", {
      tableName: this.scoped("messages"),
      partitionKey: { name: "address", type: AttributeType.STRING },
      sortKey: { name: "internal_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.messagesTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "message_id", type: AttributeType.STRING },
      sortKey: { name: "received_at", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.bodyChunksTable = new Table(this, "MessageBodyChunks", {
      tableName: this.scoped("message-body-chunks"),
      partitionKey: { name: "internal_id", type: AttributeType.STRING },
      sortKey: { name: "chunk_seq", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Audit log (ADR-0008 + ADR-0016). Single PK on audit_id (ULID — already
    // lex-sortable by attempt time). No GSI in slice 2; audit_query (ADR-0007)
    // arrives in a later slice and will pin the GSI shape (likely on
    // (principal, audit_id)). RETAIN because audit data is forensic.
    this.auditTable = new Table(this, "AuditLog", {
      tableName: this.scoped("audit"),
      partitionKey: { name: "audit_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // BounceLog (ADR-0018). One row per delivery event published by SES via
    // the configuration-set destination. PK=ses_message_id groups every
    // event for the same outbound send; SK=event_id (mail.feedbackId or a
    // synthesized id for delivery delays) lets retries dedupe. PITR +
    // RETAIN match the other forensic tables.
    this.bounceLogTable = new Table(this, "BounceLog", {
      tableName: this.scoped("bounces"),
      partitionKey: { name: "ses_message_id", type: AttributeType.STRING },
      sortKey: { name: "event_id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.rawMimeBucket = new Bucket(this, "RawMimeBucket", {
      bucketName: this.scoped(
        // S3 bucket names are global. Account-scoping makes the name
        // deterministic-yet-unique without needing a hash construct ID.
        `raw-mime-${Stack.of(this).account}`,
      ),
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // ADR-0012: cold storage after 90 days. CRR not on by default;
          // operators who need it flip a CDK property in a later slice.
          enabled: true,
          transitions: [
            {
              storageClass: StorageClass.DEEP_ARCHIVE,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });

    this.eventBus = new EventBus(this, "EventBus", {
      eventBusName: this.scoped("bus"),
    });

    // Outputs feed the smoke driver via `cdk deploy --outputs-file`.
    new CfnOutput(this, "MessagesTableName", {
      value: this.messagesTable.tableName,
    });
    new CfnOutput(this, "MessageBodyChunksTableName", {
      value: this.bodyChunksTable.tableName,
    });
    new CfnOutput(this, "AuditTableName", {
      value: this.auditTable.tableName,
    });
    new CfnOutput(this, "BounceLogTableName", {
      value: this.bounceLogTable.tableName,
    });
    new CfnOutput(this, "RawMimeBucketName", {
      value: this.rawMimeBucket.bucketName,
    });
    new CfnOutput(this, "EventBusName", {
      value: this.eventBus.eventBusName,
    });
  }

  // Resource names share a single prefix derived from the stack name so
  // multiple deployments (dev, staging) coexist in one account if needed.
  private scoped(suffix: string): string {
    return `opensesame-${suffix}`;
  }
}
