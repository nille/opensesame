import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { DataPlaneStack } from "../src/cdk/data-plane-stack.js";
import { ComputePlaneStack } from "../src/cdk/compute-plane-stack.js";

// ComputePlaneStack pins the SES Lambda receipt-action ingest topology from
// ADR-0012 (amended 2026-05-21):
//   SES Lambda receipt action → Lambda → DDB + EventBridge
//                                          (failures) → async DLQ (SQS)
//
// Compute resources are deliberately NOT marked RETAIN — unlike
// DataPlaneStack, they are replaceable. Renaming them is fine.

const ENV = { account: "925039213717", region: "eu-north-1" };

function synthBoth() {
  const app = new App();
  const data = new DataPlaneStack(app, "OpenSesameDataPlane", { env: ENV });
  const compute = new ComputePlaneStack(app, "OpenSesameComputePlane", {
    env: ENV,
    messagesTable: data.messagesTable,
    bodyChunksTable: data.bodyChunksTable,
    rawMimeBucket: data.rawMimeBucket,
    eventBus: data.eventBus,
    deploymentId: "deploy-prod2-test",
  });
  return Template.fromStack(compute);
}

describe("ComputePlaneStack — DLQ only (no SQS event source)", () => {
  it("creates exactly one SQS queue (the async DLQ)", () => {
    // The SES → SNS → SQS topology is gone. SES Lambda receipt action
    // invokes the function directly; only the async DLQ remains.
    const t = synthBoth();
    t.resourceCountIs("AWS::SQS::Queue", 1);
  });

  it("does not wire any AWS::Lambda::EventSourceMapping (SES is the trigger now)", () => {
    // Receipt actions invoke Lambda directly via lambda:InvokeFunction.
    // No event-source-mapping = no SQS poller = no batch wrapping.
    const t = synthBoth();
    t.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
  });

  it("configures Lambda async retry attempts and DLQ destination", () => {
    // The async retry config replaces the SQS event-source-mapping retry
    // (maxReceiveCount). Lambda retries 2× then routes to OnFailure.
    const t = synthBoth();
    t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 2,
      DestinationConfig: Match.objectLike({
        OnFailure: Match.objectLike({
          Destination: Match.anyValue(),
        }),
      }),
    });
  });
});

describe("ComputePlaneStack — ingest Lambda", () => {
  it("creates the ingest Lambda with env vars wiring data-plane resources + raw bucket", () => {
    const t = synthBoth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: Match.stringLikeRegexp("nodejs"),
      Environment: {
        Variables: Match.objectLike({
          OPENSESAME_DEPLOYMENT_ID: "deploy-prod2-test",
          OPENSESAME_MESSAGES_TABLE: Match.anyValue(),
          OPENSESAME_BODY_CHUNKS_TABLE: Match.anyValue(),
          OPENSESAME_EVENT_BUS_NAME: Match.anyValue(),
          // New env: SES Lambda action doesn't echo the bucket from the
          // parallel S3 action, so the function needs it out of band.
          OPENSESAME_RAW_MIME_BUCKET: Match.anyValue(),
        }),
      },
    });
  });
});

describe("ComputePlaneStack — IAM permissions", () => {
  it("grants the Lambda S3 read on the raw MIME bucket", () => {
    const t = synthBoth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject*"]),
          }),
        ]),
      }),
    });
  });

  it("grants the Lambda DDB write access on Messages + MessageBodyChunks", () => {
    const t = synthBoth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "dynamodb:BatchWriteItem",
              "dynamodb:PutItem",
            ]),
          }),
        ]),
      }),
    });
  });

  it("grants the Lambda EventBridge PutEvents on the bus", () => {
    const t = synthBoth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "events:PutEvents",
          }),
        ]),
      }),
    });
  });
});

describe("ComputePlaneStack — outputs", () => {
  it("exports the DLQ name and the function name + ARN", () => {
    // ARN is needed by the SES stack so the receipt rule can target the
    // function via lambda:InvokeFunction.
    const t = synthBoth();
    const outputs = t.findOutputs("*");
    const keys = Object.keys(outputs);
    expect(keys).toContain("IngestDlqName");
    expect(keys).toContain("IngestFunctionName");
    expect(keys).toContain("IngestFunctionArn");
  });
});
