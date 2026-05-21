import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BounceHandlerStack } from "../src/cdk/bounce-handler-stack.js";
import { DataPlaneStack } from "../src/cdk/data-plane-stack.js";

// Pin the synthesized SES delivery-event topology from ADR-0018:
//   SES configuration set → EventDestination(SNS) → SNS topic → Lambda
//                                                        ↓ async/EVENT
//                                                    BounceLog + Messages
//
// As with the other CDK stack tests, structural assertions are strict but
// hash-suffixed logical IDs are matched loosely.

const ENV = { account: "925039213717", region: "eu-north-1" };

function synthAll() {
  const app = new App();
  const data = new DataPlaneStack(app, "OpenSesameDataPlane", { env: ENV });
  const bounce = new BounceHandlerStack(app, "OpenSesameBounceHandler", {
    env: ENV,
    messagesTable: data.messagesTable,
    bounceLogTable: data.bounceLogTable,
  });
  return {
    bounceTemplate: Template.fromStack(bounce),
    dataTemplate: Template.fromStack(data),
  };
}

describe("BounceHandlerStack — SES configuration set", () => {
  it("creates a ConfigurationSet named opensesame-default", () => {
    // Operators reference this by name (OPENSESAME_SES_CONFIG_SET); a rename
    // would silently break every outbound send that pins the old name.
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::SES::ConfigurationSet", {
      Name: "opensesame-default",
    });
  });

  it("creates exactly one ConfigurationSetEventDestination", () => {
    const { bounceTemplate } = synthAll();
    bounceTemplate.resourceCountIs(
      "AWS::SES::ConfigurationSetEventDestination",
      1,
    );
  });

  it("subscribes the destination to BOUNCE, COMPLAINT, DELIVERY_DELAY only", () => {
    // Subscribing to DELIVERY would balloon the BounceLog table without
    // actionable signal; ADR-0018 explicitly excludes it. Pin the exact
    // event list so a future operator who flips the wrong checkbox gets
    // a CI failure instead of a surprise DDB bill.
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties(
      "AWS::SES::ConfigurationSetEventDestination",
      {
        EventDestination: Match.objectLike({
          Enabled: true,
          MatchingEventTypes: Match.arrayEquals([
            "bounce",
            "complaint",
            "deliveryDelay",
          ]),
          SnsDestination: Match.objectLike({
            TopicARN: Match.anyValue(),
          }),
        }),
      },
    );
  });
});

describe("BounceHandlerStack — SNS topic", () => {
  it("creates the delivery-events topic", () => {
    const { bounceTemplate } = synthAll();
    bounceTemplate.resourceCountIs("AWS::SNS::Topic", 1);
    bounceTemplate.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: "opensesame-delivery-events",
    });
  });

  it("subscribes the bounce-handler Lambda to the topic", () => {
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
      Endpoint: Match.anyValue(),
    });
  });
});

describe("BounceHandlerStack — Lambda function + DLQ", () => {
  it("creates a Node 22 ARM64 Lambda named opensesame-bounce-handler", () => {
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "opensesame-bounce-handler",
      Runtime: "nodejs22.x",
      Architectures: ["arm64"],
    });
  });

  it("plumbs Messages + BounceLog table names through env vars", () => {
    // The handler reads OPENSESAME_MESSAGES_TABLE and
    // OPENSESAME_BOUNCE_LOG_TABLE at cold start; if either is missing the
    // Lambda throws on the first invocation rather than silently no-op'ing.
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPENSESAME_MESSAGES_TABLE: Match.anyValue(),
          OPENSESAME_BOUNCE_LOG_TABLE: Match.anyValue(),
          OPENSESAME_MESSAGES_GSI1: "GSI1",
        }),
      },
    });
  });

  it("attaches an SQS DLQ as the async on-failure destination", () => {
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "opensesame-bounce-dlq",
      SqsManagedSseEnabled: true,
    });
    bounceTemplate.hasResourceProperties(
      "AWS::Lambda::EventInvokeConfig",
      {
        DestinationConfig: {
          OnFailure: Match.objectLike({ Destination: Match.anyValue() }),
        },
      },
    );
  });

  it("invokes the Lambda from sns.amazonaws.com (lambda:InvokeFunction permission)", () => {
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "sns.amazonaws.com",
    });
  });
});

describe("BounceHandlerStack — IAM grants on data plane tables", () => {
  it("grants Query + UpdateItem on Messages and PutItem on BounceLog", () => {
    // Messages: Query GSI1 (by message_id), UpdateItem (delivery_status
    // projection). BounceLog: PutItem (forensic write). Pin the action
    // shape loosely — CDK appends BatchGet/Get when granting RW — but
    // assert the load-bearing actions are present.
    const { bounceTemplate } = synthAll();
    bounceTemplate.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ]),
          }),
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:PutItem"]),
          }),
        ]),
      }),
    });
  });
});

describe("BounceHandlerStack — outputs", () => {
  it("exports ConfigurationSetName, DeliveryEventsTopicArn, BounceHandlerFunctionName, BounceDlqName", () => {
    const { bounceTemplate } = synthAll();
    const keys = Object.keys(bounceTemplate.findOutputs("*"));
    expect(keys).toContain("ConfigurationSetName");
    expect(keys).toContain("DeliveryEventsTopicArn");
    expect(keys).toContain("BounceHandlerFunctionName");
    expect(keys).toContain("BounceDlqName");
  });
});
