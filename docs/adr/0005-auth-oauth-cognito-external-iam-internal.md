# Auth: OAuth via Cognito for external clients, IAM SigV4 for AWS-internal; one Grant model, two issuance paths

The MCP server accepts two authentication forms:

- **OAuth 2.0 / OIDC via Amazon Cognito** for external callers — agents running outside AWS, the CLI by default, and humans authenticating into the webmail (via Cognito Hosted UI). One User Pool, with `cognito:groups` distinguishing humans from agents.
- **AWS IAM SigV4** for AWS-internal callers — the webmail backend Lambdas, operator-owned `MailIngested` consumer Lambdas, and any other in-AWS service that needs to call the MCP server.

A Grant binds an Agent to a **principal**, which resolves to either a Cognito `sub` claim or an IAM role ARN. The MCP server validates whichever auth form was presented, extracts the principal, and looks up the Grant in a single table. One Grant model, two issuance paths.

The webmail backend acts as a trusted intermediary: it authenticates humans via Cognito Hosted UI (OIDC), establishes a session, then calls the MCP server using its own IAM role plus a forwarded user identity context, rather than passing the human's JWT downstream. This keeps the MCP server's auth contract simple (validate one of two principal forms) and avoids token-forwarding fragility across hops.

We considered and rejected:

- **Cognito-only for everything (option D)** — internal Lambdas would use Cognito's `client_credentials` grant, which adds a token-fetch / refresh / cache cycle to every in-AWS caller. IAM SigV4 is the AWS-native way to authenticate service-to-service and removes that plumbing entirely. The cost of supporting both auth paths is one middleware branch in the MCP server (AgentCore Runtime accepts both natively); the benefit is removing token-lifecycle handling from every internal caller.
- **Self-issued long-lived API tokens (option C)** — looks simple, then quietly grows into a custom OAuth (rotation, revocation, scopes, refresh, audience binding, audit). At that point you've built OAuth without OAuth's interop, and every new MCP client needs bespoke wiring. Rejected as the trap option.

Cost is not a differentiator: Cognito's free tier (10,000 monthly active users) covers personal-to-small-team comfortably; mid-scale deployments are single-digit dollars per month; IAM SigV4 is free.

Trade-offs accepted: two auth paths to maintain in the MCP server middleware (small); two principal types in the Grant lookup (small, one column); the webmail backend pattern of "trusted intermediary with forwarded user context" rather than end-to-end JWT propagation (deliberate — keeps the MCP server's contract clean and avoids cross-hop token fragility).

Token lifetime, refresh policy, and agent-registration flow are deliberately not specified in this ADR — they are operational choices that may evolve.
