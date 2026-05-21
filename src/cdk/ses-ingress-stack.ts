import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import {
  MxRecord,
  PublicHostedZone,
  type IPublicHostedZone,
} from "aws-cdk-lib/aws-route53";
import type { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { EmailIdentity, Identity, ReceiptRuleSet } from "aws-cdk-lib/aws-ses";
import {
  Lambda as LambdaAction,
  LambdaInvocationType,
  S3 as S3Action,
} from "aws-cdk-lib/aws-ses-actions";
import type { Construct } from "constructs";

// SES inbound ingress (per ADR-0010 / ADR-0011 / ADR-0012, amended 2026-05-21):
//
//   External MTA ──SMTP──▶ SES inbound (eu-north-1)
//                              │
//                              ├──▶ S3 raw bucket (DataPlaneStack, imported)
//                              │       key = mail.messageId
//                              │
//                              └──▶ Lambda receipt action (async/EVENT)
//                                       │
//                                       └──▶ ingest Lambda (ComputePlaneStack)
//
// We replaced the previous SES → SNS → SQS receipt action with a SES Lambda
// receipt action. The SNS receipt action embeds the entire email body in
// the SNS payload and bounces messages > 150 KB; the Lambda action carries
// only the SES event JSON (metadata) and has no message-size limit. The
// canonical raw bytes still land in S3 from the parallel S3 action.
//
// Construct-ID-stability rule (ADR-0011) still applies. Nothing here is
// RETAIN — the MX record, the rule set, etc. can all be re-created without
// touching mail already at rest in S3 / DDB.

// SES inbound SMTP endpoint for eu-north-1. Fixed per region; documented
// in the AWS SES Developer Guide ("Amazon SES SMTP endpoints" table).
const SES_INBOUND_ENDPOINT_EU_NORTH_1 = "inbound-smtp.eu-north-1.amazonaws.com";

// Standard MX priority for a single inbound mail server.
const MX_PRIORITY = 10;

// Activating a receipt rule set is a per-region, single-active operation
// that has no clean CloudFormation property — we surface a CLI command in
// the outputs for the operator to run after deploy.
const ACTIVATE_RULE_SET_COMMAND_PREFIX = "aws ses set-active-receipt-rule-set --rule-set-name";

export type SesIngressStackProps = StackProps & {
  // From DataPlaneStack — SES writes raw MIME here via the S3 receipt-rule action.
  rawMimeBucket: Bucket;
  // From ComputePlaneStack — SES invokes this function async (EVENT) per email.
  ingestFunction: IFunction;
  // Operator config: the hosted zone is owned outside this app.
  hostedZoneId: string;
  hostedZoneName: string;
  // Receiving domain. Currently equal to hostedZoneName, but kept separate
  // so a future operator can host inbound on a subdomain without editing
  // the import call.
  receivingDomain: string;
  // Allowlist of recipient addresses the receipt rule will match. Catch-all
  // is deliberately NOT supported here — operators add addresses explicitly.
  initialRecipients: string[];
};

export class SesIngressStack extends Stack {
  readonly emailIdentity: EmailIdentity;
  readonly receiptRuleSet: ReceiptRuleSet;

  constructor(scope: Construct, id: string, props: SesIngressStackProps) {
    super(scope, id, props);

    // Hosted zone is imported, never created. Using
    // fromPublicHostedZoneAttributes (vs fromLookup) keeps synth offline —
    // no AWS account context is required to render the template.
    const hostedZone: IPublicHostedZone =
      PublicHostedZone.fromPublicHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });

    // Email identity bound to the public hosted zone: with Easy DKIM, the
    // EmailIdentity construct auto-emits the three DKIM CNAME records into
    // the zone. SES uses DKIM as its verification mechanism, so no separate
    // _amazonses TXT verification record is needed here.
    this.emailIdentity = new EmailIdentity(this, "ReceivingDomainIdentity", {
      identity: Identity.publicHostedZone(hostedZone),
    });

    // Receipt rule set. Activation is a per-region operation with no clean
    // CFN property — we surface it as a CfnOutput command for the operator
    // to run post-deploy.
    this.receiptRuleSet = new ReceiptRuleSet(this, "InboundRuleSet", {
      receiptRuleSetName: "opensesame-inbound",
    });

    // The S3 action helper auto-adds the bucket policy granting
    // ses.amazonaws.com s3:PutObject with aws:SourceAccount = this.account.
    // We pass the concrete Bucket (not a re-import) because imported buckets
    // have autoCreatePolicy=false, which would silently skip the bucket
    // policy attachment that SES inbound delivery requires. The `as IBucket`
    // cast is necessary only to placate exactOptionalPropertyTypes — the
    // CDK Bucket class declares `isWebsite` as `boolean | undefined` while
    // IBucket declares it as `isWebsite?: boolean`, which TS treats as
    // structurally distinct under that flag.
    const rawBucket = props.rawMimeBucket as unknown as IBucket;
    const s3Action = new S3Action({ bucket: rawBucket });

    // Lambda action: EVENT/async invocation. The CDK Lambda action helper
    // automatically adds the lambda:InvokeFunction permission for
    // ses.amazonaws.com with aws:SourceAccount on the function, so we don't
    // need to add a Permission ourselves.
    const lambdaAction = new LambdaAction({
      function: props.ingestFunction,
      invocationType: LambdaInvocationType.EVENT,
    });

    this.receiptRuleSet.addRule("InboundRule", {
      receiptRuleName: "opensesame-inbound-rule",
      recipients: props.initialRecipients,
      enabled: true,
      // S3 first so the raw MIME is durable before we invoke the Lambda;
      // the Lambda reads from S3 via mail.messageId, so the object MUST
      // exist by the time the function is called.
      actions: [s3Action, lambdaAction],
    });

    // MX record at the receiving domain apex pointing at the SES inbound
    // SMTP endpoint for this region.
    new MxRecord(this, "InboundMxRecord", {
      zone: hostedZone,
      // recordName omitted → record sits at the zone apex.
      values: [
        {
          priority: MX_PRIORITY,
          hostName: SES_INBOUND_ENDPOINT_EU_NORTH_1,
        },
      ],
    });

    // DKIM CNAMEs are emitted automatically: Identity.publicHostedZone +
    // Easy DKIM tells the EmailIdentity construct to add three CfnRecordSet
    // CNAME records to the imported zone. SES uses DKIM as its verification
    // mechanism, so no separate _amazonses TXT record is required. (Older
    // tutorials reference it; modern domain identities don't need it.)

    // Outputs — operator runbooks, smoke driver, and the post-deploy
    // activation command.
    new CfnOutput(this, "SesDomainName", {
      value: props.receivingDomain,
    });
    new CfnOutput(this, "SesReceiptRuleSetName", {
      value: this.receiptRuleSet.receiptRuleSetName,
    });
    new CfnOutput(this, "SesMxTarget", {
      value: SES_INBOUND_ENDPOINT_EU_NORTH_1,
    });
    new CfnOutput(this, "SesActivationCommand", {
      value: `${ACTIVATE_RULE_SET_COMMAND_PREFIX} ${this.receiptRuleSet.receiptRuleSetName}`,
    });
  }
}
