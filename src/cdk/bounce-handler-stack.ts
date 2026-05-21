import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Architecture,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SnsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  ConfigurationSet,
  ConfigurationSetEventDestination,
  EmailSendingEvent,
  EventDestination,
} from "aws-cdk-lib/aws-ses";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

// SES delivery-event handling (ADR-0018):
//
//   send-email → SES SendEmail (with ConfigurationSetName)
//                       │
//                       │ Bounce / Complaint / DeliveryDelay
//                       ▼
//                  SES configuration set
//                       │ EventDestination.snsTopic(...)
//                       ▼
//                   SNS topic
//                       │ Lambda subscription
//                       ▼
//                bounce-handler Lambda
//                  ├──▶ DDB BounceLog  (per-event forensic record)
//                  └──▶ DDB Messages   (UpdateItem: delivery_status)
//
// Opt-in like SesIngressStack: synthesized only when the operator wants the
// bounce wiring deployed. The SES configuration set is account-scoped, so
// re-deploying this stack adds the destination idempotently.
//
// Construct-ID stability rule (ADR-0011) applies to the table reference, the
// configuration set, and the SNS topic. The Lambda + DLQ are replaceable
// (ADR-0012 pattern, same as ComputePlaneStack's ingest function).

const HANDLER_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lambda",
  "bounce-handler.handler.ts",
);

const LAMBDA_TIMEOUT_SECONDS = 30;
const LAMBDA_RETRY_ATTEMPTS = 2;
const DLQ_RETENTION_DAYS = 14;

// Names the SES configuration set + topic deterministically. The CLI driver
// reads the configuration set name from env (OPENSESAME_SES_CONFIG_SET); we
// keep it constant per deployment so operators don't have to plumb the CDK
// output through.
const CONFIG_SET_NAME = "opensesame-default";

export type BounceHandlerStackProps = StackProps & {
  messagesTable: Table;
  bounceLogTable: Table;
  // Name of the GSI1 the Lambda uses to locate the outbound row by SES
  // message id. The DataPlaneStack's Messages table only exposes the index
  // name through the L2 construct, so we plumb it explicitly to keep the
  // handler decoupled from a future GSI rename.
  messageIdGsiName?: string;
};

export class BounceHandlerStack extends Stack {
  readonly configurationSet: ConfigurationSet;
  readonly eventsTopic: Topic;
  readonly bounceHandler: NodejsFunction;
  readonly bounceDlq: Queue;

  constructor(scope: Construct, id: string, props: BounceHandlerStackProps) {
    super(scope, id, props);

    // SES configuration set. Operators reference it by name (the CLI driver
    // exports OPENSESAME_SES_CONFIG_SET=<name>); the SES adapter passes
    // the value as ConfigurationSetName on every SendEmail.
    this.configurationSet = new ConfigurationSet(this, "ConfigSet", {
      configurationSetName: CONFIG_SET_NAME,
    });

    // SNS topic — destination for the configuration set's event publication.
    // SQS-managed encryption is fine for this single-account pattern; KMS
    // is unnecessary overhead for an internal event fan-out.
    this.eventsTopic = new Topic(this, "DeliveryEventsTopic", {
      topicName: "opensesame-delivery-events",
    });

    new ConfigurationSetEventDestination(this, "SnsEventDestination", {
      configurationSet: this.configurationSet,
      destination: EventDestination.snsTopic(this.eventsTopic),
      // Subscribe only to the events the handler actually processes
      // (ADR-0018). Adding DELIVERY here later is a config-only change.
      events: [
        EmailSendingEvent.BOUNCE,
        EmailSendingEvent.COMPLAINT,
        EmailSendingEvent.DELIVERY_DELAY,
      ],
      enabled: true,
    });

    // Lambda async DLQ — captures retries-exhausted invocations for triage.
    this.bounceDlq = new Queue(this, "BounceDlq", {
      queueName: "opensesame-bounce-dlq",
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(DLQ_RETENTION_DAYS),
    });

    const logGroup = new LogGroup(this, "BounceHandlerLogGroup", {
      retention: RetentionDays.ONE_MONTH,
    });

    this.bounceHandler = new NodejsFunction(this, "BounceHandlerFunction", {
      functionName: "opensesame-bounce-handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      entry: HANDLER_ENTRY,
      handler: "handler",
      timeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
      memorySize: 256,
      logGroup,
      retryAttempts: LAMBDA_RETRY_ATTEMPTS,
      onFailure: new SqsDestination(this.bounceDlq),
      bundling: {
        target: "node22",
        minify: false,
        sourceMap: true,
      },
      environment: {
        OPENSESAME_MESSAGES_TABLE: props.messagesTable.tableName,
        OPENSESAME_BOUNCE_LOG_TABLE: props.bounceLogTable.tableName,
        OPENSESAME_MESSAGES_GSI1: props.messageIdGsiName ?? "GSI1",
      },
    });

    // SNS → Lambda. SnsEventSource handles the topic subscription + grants
    // sns.amazonaws.com lambda:InvokeFunction in one step.
    this.bounceHandler.addEventSource(new SnsEventSource(this.eventsTopic));

    // IAM grants. The Lambda needs Query on Messages (GSI1 lookup),
    // UpdateItem on Messages (delivery_status projection), and PutItem on
    // BounceLog (forensic record).
    props.messagesTable.grantReadWriteData(this.bounceHandler);
    props.bounceLogTable.grantWriteData(this.bounceHandler);

    new CfnOutput(this, "ConfigurationSetName", {
      value: this.configurationSet.configurationSetName,
    });
    new CfnOutput(this, "DeliveryEventsTopicArn", {
      value: this.eventsTopic.topicArn,
    });
    new CfnOutput(this, "BounceHandlerFunctionName", {
      value: this.bounceHandler.functionName,
    });
    new CfnOutput(this, "BounceDlqName", {
      value: this.bounceDlq.queueName,
    });
  }
}
