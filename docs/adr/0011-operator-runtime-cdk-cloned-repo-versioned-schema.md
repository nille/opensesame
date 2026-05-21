# Operator runtime: AWS CDK in TypeScript, cloned-repo deployment, versioned items + S3 replay for upgrades

The system is deployed by the operator into their own AWS account. This ADR captures three coupled decisions about how that deployment works: the IaC tool, the packaging shape, and the upgrade path.

## IaC: AWS CDK (TypeScript)

The infrastructure is defined as a CDK app in TypeScript. `opensesame configure` is a thin CLI wrapper that invokes `cdk deploy` with operator-supplied context (`domain`, `deployment_shape`, etc.).

Why CDK over alternatives:

- **CDK over Terraform.** The system is unapologetically AWS-only (SES, DynamoDB, S3, Lambda, AgentCore Runtime, Route 53, Cognito). Terraform's vendor-neutrality buys nothing here, while CDK's tighter integration with AWS service constructs (especially AgentCore Runtime and SES domain identities) buys real ergonomics.
- **CDK over SAM.** SAM is a strict subset of what we need; we'll outgrow it the moment AgentCore Runtime, Cognito, or Route 53 zone management is involved.
- **TypeScript over CDK Python.** The MCP server, BFF Lambda, and core email library are all TypeScript. Same language end-to-end means operators reading a fork see one stack.

## Packaging: cloned repo, not published artifact

Operators clone the repo and run CDK directly:

```
git clone https://github.com/<org>/opensesame
cd opensesame
pnpm install
pnpm opensesame configure --domain acme.com
```

`opensesame configure` is local to the repo (a `package.json` script that calls `cdk deploy` with the right context).

Why cloned-repo over published-CLI-with-embedded-CDK:

- The system runs production email and Grants. Operators should see the CDK source before approving the IAM policies it creates; an opaque "the CLI deploys things for you" model is the wrong default for a security-relevant deployment.
- Avoids release-channel machinery (npm publishing, version pinning, "which CLI version produced which stack" debugging) for v1. Operators are pinned to a git ref, which is the simplest pin.
- "I want to tweak this" becomes a fork, not a feature request. Healthy for an early project.
- The everyday-use CLI (sending mail, managing grants — *not* deploy) may still ship as a published binary later; only the configure/deploy path is repo-cloned.

Trade-off: higher onboarding bar (Node 20+, pnpm, bootstrapped CDK in the target account). Acceptable — anyone running a private email server is already past that bar.

## Upgrade path: versioned items (default) + S3 replay (escape hatch)

DynamoDB schemas cannot be altered in place, and the body-chunking layout (per ADR-0004) is the most likely thing to evolve. Two complementary mechanisms:

### Default: versioned items + lazy migration

Every DynamoDB item carries `schema_v: "1"` from v1.0 onward.

- Writers always write the newest schema version.
- Readers handle every supported version (`v1`, `v2`, …) simultaneously.
- Old items get rewritten on next access; a backfill Lambda upgrades cold data on a schedule.
- `cdk deploy` is the entire upgrade procedure — no downtime, no maintenance window, no operator action.

This handles the 90% case: adding an attribute, adding a GSI, renaming a field, splitting one attribute into two.

The `schema_v` on DynamoDB items is independent of the `schema_version` on `MailIngested` events (per ADR-0010); they evolve separately.

### Escape hatch: S3 replay

For changes too invasive for lazy migration — repartitioning, restructuring the body-chunk layout, changing how threads are derived — the canonical store is the **raw MIME archive in S3** (per ADR-0004). DynamoDB is derived data and can always be rebuilt:

1. Deploy the new ingest Lambda with the new schema.
2. Run `opensesame rebuild-derived-data` (a documented operation that fans out the S3 archive through the new ingest path).
3. DynamoDB is repopulated from canonical truth.

Slow at scale, but it always works because we are not adding architecture — we are naming a capability that already exists by virtue of "raw MIME is canonical".

### Stable construct IDs

CDK preserves resources across deploys only if their **logical IDs** remain stable. The Route 53 hosted zone, SES domain identity, DKIM CNAMEs, Cognito User Pool, DynamoDB tables, and S3 buckets are committed to stable construct IDs across versions. Renaming any of these would force a destructive replace and is forbidden without an explicit migration ADR.

## Considered and rejected

- **Side-by-side tables + cutover (B in the discussion).** Doubles ongoing storage cost during the cutover window, adds an orchestrated config-flip step, and requires per-upgrade tooling. The versioned-items + replay pair handles every case B does, more cheaply.
- **Schema-version-in-table-name (`messages_v1`, `messages_v2`).** Variant of B. Same problems plus every IaC change becomes destructive.
- **Auto-migrate on cold start.** Tempting, but a Lambda cold start is the wrong place to do unbounded work. Backfill is its own scheduled Lambda.

## Trade-offs accepted

- Reader code grows over time (must handle `v1` and `v2` and `v3`). Mitigated by retiring old versions on a documented schedule once the backfill Lambda has rewritten everything.
- Operators who want to skip an upgrade (jump v1.0 → v1.3) must walk through intermediate versions or run replay. Documented; the alternative (every version supports every prior schema forever) is worse.
- The cloned-repo model means upgrade is `git pull && pnpm install && cdk deploy`. Operators are responsible for reading the CHANGELOG before pulling. Acceptable for the user model.
