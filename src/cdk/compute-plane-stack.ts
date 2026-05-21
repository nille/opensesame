import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import type { EventBus } from "aws-cdk-lib/aws-events";
import {
  Architecture,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

// Compute plane (per ADR-0012, amended 2026-05-21):
//   SES Lambda receipt action → ingest Lambda → DDB + EventBridge
//                                                 (failures) → async DLQ
//
// Why no SQS queue: the previous SES → SNS → SQS → Lambda topology bounced
// any email > 150 KB because the SES SNS receipt action embeds the entire
// body in the SNS payload. SES Lambda receipt actions carry only the event
// metadata (no message-size cap), so the queue + event-source-mapping are
// gone — the SES → Lambda invocation is the trigger.
//
// Unlike DataPlaneStack, NOTHING here is RETAIN — these are replaceable.
// The Lambda code can be redeployed at will; the DLQ exists for on-call
// triage, not durability.

const HANDLER_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lambda",
  "ingest.handler.ts",
);

const LAMBDA_TIMEOUT_SECONDS = 30; // p99 ingest budget per ADR-0012
const LAMBDA_RETRY_ATTEMPTS = 2; // total = 3 attempts (initial + 2 retries)
const DLQ_RETENTION_DAYS = 14;

export type ComputePlaneStackProps = StackProps & {
  messagesTable: Table;
  bodyChunksTable: Table;
  rawMimeBucket: Bucket;
  eventBus: EventBus;
  // Operator-supplied identifier embedded into every emitted MailIngested
  // event (ADR-0010 envelope). Distinct from the AWS account number; one
  // operator may run multiple deployments.
  deploymentId: string;
};

export class ComputePlaneStack extends Stack {
  readonly ingestDlq: Queue;
  readonly ingestFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ComputePlaneStackProps) {
    super(scope, id, props);

    // Lambda async DLQ. Repurposed from the prior SQS-event-source-mapping
    // DLQ — same name + retention, different role: now it captures async
    // invocations whose retries are exhausted.
    this.ingestDlq = new Queue(this, "IngestDlq", {
      queueName: "opensesame-ingest-dlq",
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(DLQ_RETENTION_DAYS),
    });

    // Pin a CloudWatch Logs group ourselves so we control retention; left
    // to the default, NodejsFunction creates a never-expiring log group.
    const logGroup = new LogGroup(this, "IngestLogGroup", {
      retention: RetentionDays.ONE_MONTH,
    });

    this.ingestFunction = new NodejsFunction(this, "IngestFunction", {
      functionName: "opensesame-ingest",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      entry: HANDLER_ENTRY,
      handler: "handler",
      timeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
      memorySize: 512,
      logGroup,
      // Async invocation tuning: SES invokes the Lambda with InvocationType
      // = Event (async). retryAttempts is a per-Lambda config that doesn't
      // require the caller to know about it — defaults to 2.
      retryAttempts: LAMBDA_RETRY_ATTEMPTS,
      onFailure: new SqsDestination(this.ingestDlq),
      bundling: {
        // Keep the bundle small. The Node 22 Lambda runtime no longer
        // ships an SDK in the layer, so we bundle our own.
        target: "node22",
        minify: false,
        sourceMap: true,
      },
      environment: {
        OPENSESAME_DEPLOYMENT_ID: props.deploymentId,
        OPENSESAME_MESSAGES_TABLE: props.messagesTable.tableName,
        OPENSESAME_BODY_CHUNKS_TABLE: props.bodyChunksTable.tableName,
        OPENSESAME_EVENT_BUS_NAME: props.eventBus.eventBusName,
        // The SES event for a Lambda action describes the Lambda action,
        // not the parallel S3 action — so the bucket name has to come in
        // out of band. The S3 key is mail.messageId (SES's default key
        // when no objectKeyPrefix is configured).
        OPENSESAME_RAW_MIME_BUCKET: props.rawMimeBucket.bucketName,
      },
    });

    // IAM grants. CDK's helper methods write the right IAM statements
    // and resolve the Resource ARNs from the imported constructs — much
    // safer than hand-writing PolicyStatements with literal ARNs.
    props.rawMimeBucket.grantRead(this.ingestFunction);
    props.messagesTable.grantWriteData(this.ingestFunction);
    props.bodyChunksTable.grantWriteData(this.ingestFunction);
    props.eventBus.grantPutEventsTo(this.ingestFunction);

    // The SES → Lambda invocation permission is added in SesIngressStack
    // (where the receipt rule lives) via the SES Lambda action helper.

    // Outputs feed the smoke driver and operator runbooks.
    new CfnOutput(this, "IngestDlqName", {
      value: this.ingestDlq.queueName,
    });
    new CfnOutput(this, "IngestFunctionName", {
      value: this.ingestFunction.functionName,
    });
    new CfnOutput(this, "IngestFunctionArn", {
      value: this.ingestFunction.functionArn,
    });
  }
}
