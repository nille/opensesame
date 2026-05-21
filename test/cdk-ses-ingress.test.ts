import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ComputePlaneStack } from "../src/cdk/compute-plane-stack.js";
import { DataPlaneStack } from "../src/cdk/data-plane-stack.js";
import { SesIngressStack } from "../src/cdk/ses-ingress-stack.js";

// Pin the synthesized SES inbound topology from the design (amended 2026-05-21):
//   External MTA → SES inbound → S3 raw bucket + Lambda receipt action
//                                                  ↓ async/EVENT
//                                              ingest Lambda (ComputePlane)
//
// As with the other CDK stacks, logical-ID-shaped assertions are kept
// loose (we use Match.objectLike / arrayWith) but the *structure* — recipient
// list, action types, principal conditions — is asserted strictly.

const ENV = { account: "925039213717", region: "eu-north-1" };

const HOSTED_ZONE_ID = "Z00000000000000000000";
const HOSTED_ZONE_NAME = "nille.net";
const RECEIVING_DOMAIN = "nille.net";
const INITIAL_RECIPIENTS = ["test@nille.net"];

function synthAll() {
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
  const ses = new SesIngressStack(app, "OpenSesameSesIngress", {
    env: ENV,
    rawMimeBucket: data.rawMimeBucket,
    ingestFunction: compute.ingestFunction,
    hostedZoneId: HOSTED_ZONE_ID,
    hostedZoneName: HOSTED_ZONE_NAME,
    receivingDomain: RECEIVING_DOMAIN,
    initialRecipients: INITIAL_RECIPIENTS,
  });
  return {
    sesTemplate: Template.fromStack(ses),
    dataTemplate: Template.fromStack(data),
    computeTemplate: Template.fromStack(compute),
  };
}

describe("SesIngressStack — SES email identity + DKIM", () => {
  it("creates an SES EmailIdentity for the configured domain", () => {
    const { sesTemplate } = synthAll();
    sesTemplate.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: RECEIVING_DOMAIN,
    });
  });

  it("emits 3 DKIM CNAME records into the imported hosted zone", () => {
    const { sesTemplate } = synthAll();
    const recordSets = sesTemplate.findResources("AWS::Route53::RecordSet");
    const cnames = Object.values(recordSets).filter(
      (r) => (r.Properties as { Type?: string }).Type === "CNAME",
    );
    expect(cnames).toHaveLength(3);
  });
});

describe("SesIngressStack — receipt rule set + rule", () => {
  it("creates a ReceiptRuleSet", () => {
    const { sesTemplate } = synthAll();
    sesTemplate.resourceCountIs("AWS::SES::ReceiptRuleSet", 1);
  });

  it("attaches one ReceiptRule with the allowlisted recipients", () => {
    const { sesTemplate } = synthAll();
    sesTemplate.resourceCountIs("AWS::SES::ReceiptRule", 1);
    sesTemplate.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({
        Recipients: INITIAL_RECIPIENTS,
        Enabled: true,
      }),
    });
  });

  it("orders rule actions S3 first, Lambda second", () => {
    // S3 first so the raw MIME object exists by the time Lambda runs and
    // GETs it via mail.messageId. Reversing the order would race.
    const { sesTemplate } = synthAll();
    sesTemplate.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({
        Actions: [
          Match.objectLike({
            S3Action: Match.objectLike({ BucketName: Match.anyValue() }),
          }),
          Match.objectLike({
            LambdaAction: Match.objectLike({
              FunctionArn: Match.anyValue(),
              InvocationType: "Event",
            }),
          }),
        ],
      }),
    });
  });
});

describe("SesIngressStack — no SNS topology", () => {
  it("does not create an SNS topic (Lambda receipt action replaces it)", () => {
    // The SES SNS receipt action bounces emails > 150 KB because it embeds
    // the body in the SNS payload. We pin the absence of any SNS resources
    // in this stack so a regression that re-introduces SNS is caught.
    const { sesTemplate } = synthAll();
    sesTemplate.resourceCountIs("AWS::SNS::Topic", 0);
    sesTemplate.resourceCountIs("AWS::SNS::Subscription", 0);
    sesTemplate.resourceCountIs("AWS::SNS::TopicPolicy", 0);
  });

  it("does not create a queue policy (no SNS → SQS subscription)", () => {
    const { sesTemplate } = synthAll();
    sesTemplate.resourceCountIs("AWS::SQS::QueuePolicy", 0);
  });
});

describe("SesIngressStack — IAM resource policies", () => {
  it("grants ses.amazonaws.com s3:PutObject on the raw bucket with aws:SourceAccount", () => {
    // Bucket policy lives in the *data* stack — the S3 receipt action
    // helper writes to the bucket's own resource policy in whichever stack
    // owns the bucket.
    const { dataTemplate } = synthAll();
    dataTemplate.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:PutObject",
            Principal: { Service: "ses.amazonaws.com" },
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "aws:SourceAccount": Match.anyValue(),
              }),
            }),
          }),
        ]),
      }),
    });
  });

  it("grants ses.amazonaws.com lambda:InvokeFunction on the ingest function with aws:SourceAccount", () => {
    // The Lambda permission is added by the SES Lambda action helper to
    // the function — which lives in the compute stack. The CDK helper
    // routes it to the function's stack, not the SES stack.
    const { computeTemplate } = synthAll();
    computeTemplate.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      Principal: "ses.amazonaws.com",
      SourceAccount: Match.anyValue(),
    });
  });
});

describe("SesIngressStack — Route 53 records", () => {
  it("creates one MX record at the receiving domain pointed at inbound-smtp.eu-north-1.amazonaws.com", () => {
    const { sesTemplate } = synthAll();
    const mxResources = sesTemplate.findResources("AWS::Route53::RecordSet", {
      Properties: { Type: "MX" },
    });
    expect(Object.keys(mxResources)).toHaveLength(1);
    sesTemplate.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "MX",
      ResourceRecords: Match.arrayWith([
        Match.stringLikeRegexp("10 inbound-smtp\\.eu-north-1\\.amazonaws\\.com"),
      ]),
    });
  });
});

describe("SesIngressStack — outputs", () => {
  it("exports SesDomainName, SesReceiptRuleSetName, SesMxTarget, and the activation command", () => {
    const { sesTemplate } = synthAll();
    const keys = Object.keys(sesTemplate.findOutputs("*"));
    expect(keys).toContain("SesDomainName");
    expect(keys).toContain("SesReceiptRuleSetName");
    expect(keys).toContain("SesMxTarget");
    expect(keys).toContain("SesActivationCommand");
  });
});
