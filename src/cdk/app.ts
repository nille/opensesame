#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { BounceHandlerStack } from "./bounce-handler-stack.js";
import { ComputePlaneStack } from "./compute-plane-stack.js";
import { DataPlaneStack } from "./data-plane-stack.js";
import { SesIngressStack } from "./ses-ingress-stack.js";

// CDK app entry point. Account/region come from CDK_DEFAULT_ACCOUNT /
// CDK_DEFAULT_REGION (set by the CLI from the active AWS profile) so the
// stacks stay environment-portable; pinning them in code would be wrong
// because every operator deploys into their own account (ADR-0011).
//
// Three stacks, deliberately separated:
//   - DataPlaneStack: stateful (RETAIN tables, bucket, bus). Surviving the
//     compute-plane churn is its whole point.
//   - ComputePlaneStack: stateless ingest pipeline (SQS, Lambda). Replace
//     freely — code redeploys, queue rotations, etc. don't touch the data.
//   - SesIngressStack: SES inbound (receipt rule set, SNS topic, MX/DKIM
//     records into an imported Route 53 zone). Optional — only synthesized
//     when the operator supplies the hosted-zone env vars below.

const app = new App();

const env: { account?: string; region?: string } = {};
if (process.env.CDK_DEFAULT_ACCOUNT) env.account = process.env.CDK_DEFAULT_ACCOUNT;
if (process.env.CDK_DEFAULT_REGION) env.region = process.env.CDK_DEFAULT_REGION;

const data = new DataPlaneStack(app, "OpenSesameDataPlane", { env });

const compute = new ComputePlaneStack(app, "OpenSesameComputePlane", {
  env,
  messagesTable: data.messagesTable,
  bodyChunksTable: data.bodyChunksTable,
  rawMimeBucket: data.rawMimeBucket,
  eventBus: data.eventBus,
  // Operators override this per-deployment; "default" matches what the
  // smoke driver assumes when run against this stack.
  deploymentId: process.env.OPENSESAME_DEPLOYMENT_ID ?? "default",
});

// SES ingress is opt-in: the hosted zone is owned outside this app (ADR-0011
// keeps DNS ownership separate from the CDK), so we require the operator to
// pass its ID + name explicitly. If either is missing we skip synthesis
// entirely — the data + compute planes can be deployed standalone for dev
// or for ops who haven't decided on a domain yet.
const hostedZoneId = process.env.OPENSESAME_HOSTED_ZONE_ID;
const hostedZoneName = process.env.OPENSESAME_HOSTED_ZONE_NAME;
if (hostedZoneId && hostedZoneName) {
  const receivingDomain =
    process.env.OPENSESAME_RECEIVING_DOMAIN ?? hostedZoneName;
  // Comma-separated list; trimmed and filtered so a stray trailing comma in
  // the env file doesn't synthesize an empty recipient (which SES would
  // reject at deploy time anyway, but we'd rather fail at synth).
  const initialRecipients = (process.env.OPENSESAME_INITIAL_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (initialRecipients.length === 0) {
    throw new Error(
      "OPENSESAME_HOSTED_ZONE_ID/NAME are set but OPENSESAME_INITIAL_RECIPIENTS is empty. " +
        "Receipt rules with no recipients are rejected by SES; set at least one address.",
    );
  }
  new SesIngressStack(app, "OpenSesameSesIngress", {
    env,
    rawMimeBucket: data.rawMimeBucket,
    ingestFunction: compute.ingestFunction,
    hostedZoneId,
    hostedZoneName,
    receivingDomain,
    initialRecipients,
  });

  // Outbound delivery-event handling (ADR-0018) is gated behind the same
  // hosted-zone env vars: bounce/complaint wiring is only meaningful when
  // SES inbound is configured, since both depend on a verified domain. The
  // SES configuration set is account-scoped and idempotent on re-deploy.
  new BounceHandlerStack(app, "OpenSesameBounceHandler", {
    env,
    messagesTable: data.messagesTable,
    bounceLogTable: data.bounceLogTable,
  });
}
