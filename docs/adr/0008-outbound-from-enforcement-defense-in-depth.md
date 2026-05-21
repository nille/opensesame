# Outbound `From:` enforcement: defense-in-depth (MCP grant check + IAM backstop), with pre-send audit

Every outbound message must satisfy two independent checks before SES accepts it. Either layer alone would be technically sufficient; both are present so a bug or misconfiguration in one cannot silently let an Agent send under an Address it has no Grant for.

## Layer 1 — MCP server grant check (primary)

On every `send_email` / `reply_to_email` call:

1. Resolve the **principal** from the request (Cognito `sub` or IAM role ARN, per ADR-0005).
2. Look up the Grant binding that principal to the requested `from` Address.
3. If no Grant exists, or the Grant lacks the required capability (`send-on-behalf-of` or `send-as`), return `{error: {code: "grant_denied", retriable: false}}`.
4. Apply **origin headers** per the Grant's disclosure and autonomy modes (per ADR-0001):
   - `send-on-behalf-of` → set `Sender:` to the Agent's Address.
   - `send-as` → omit `Sender:`.
   - `autonomous` → set `Auto-Submitted: auto-generated`.
   - `interactive` → omit `Auto-Submitted:`.
5. Write a **pre-send audit entry** (`send_attempted`) with `{principal, agent_id, from, to, subject_hash, grant_id, disclosure_mode, autonomy_mode, requested_at}` *before* calling SES.
6. Call SES `SendRawEmail` (raw MIME is required for full RFC 5322 header control).
7. On success, update the audit entry to `send_succeeded` with the SES `MessageId`. On failure, keep `send_attempted` and append the error.

## Layer 2 — IAM `SendRawEmail` constraint (backstop)

The Lambda role that calls SES has a policy condition restricting `ses:SendRawEmail` to verified domain identities under the operator's control:

```
Condition: { StringLike: { "ses:FromAddress": "*@acme.com" } }
```

This catches the failure mode where Layer 1 has a bug — a forgotten capability check, a Grant lookup that returns the wrong row, a parsing error that lets a hostile `From:` slip through. SES will refuse the send and return an error; nothing reaches the recipient.

## Solo-direct mode

In solo-direct (CLI + library + AWS, no MCP server, no Cognito — per ADR-0006), there are no Grants. The operator's IAM principal *is* the authority. The library detects the deployment shape and skips the Grant check; Layer 2 still enforces "you can only send from domains you own". This is consistent with the broader ADR-0006 stance: solo-direct has no multi-tenant boundary to enforce, so there is nothing for Layer 1 to guard.

## Why pre-send audit (not post-send)

If the audit entry is written *after* SES returns, a process crash between the SES call and the audit write produces a sent message with no audit record — the worst possible outcome for an "agentic email" system where attribution matters. Writing `send_attempted` first guarantees that every send attempt is recorded; the second write upgrades successful attempts to `send_succeeded`. Failed/abandoned `send_attempted` rows are themselves useful signal (crash diagnostics, retry analysis).

The cost is one extra DynamoDB write per send. At the scales this system is designed for, that is negligible.

## Considered and rejected

- **MCP grant check only (no IAM backstop).** Single layer; one bug in the MCP server's grant logic could let an Agent send as anyone. The IAM backstop is cheap (one policy condition) and removes that class of failure entirely.
- **IAM constraint only (no MCP grant check).** IAM can enforce "only verified domains" but cannot distinguish "Agent X may send from `alice@acme.com`" from "Agent X may send from `bob@acme.com`" — both are inside the same domain. Per-Address authorization has to live in application code.
- **Post-send audit only.** Loses the crash-window guarantee described above.
- **Synchronous DynamoDB transactional write tying audit + send.** SES is not a transactional resource; you cannot wrap it in a DynamoDB transaction. The pre-send/post-send pattern is the closest substitute and is the standard approach for "log intent, then act, then log outcome".

## Trade-offs accepted

Two enforcement points to maintain (one in application code, one in IAM policy). Two audit writes per send (one pre, one post). The IAM condition tightens the operator's deploy story — adding a new managed domain requires both an SES verification and a policy update — but that friction is intentional: domains are operational scope, not runtime configuration.
