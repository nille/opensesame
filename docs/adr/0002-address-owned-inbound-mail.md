# Inbound mail ownership is by Address, not by Thread

Each inbound message belongs to exactly one Address (its recipient). Agent visibility is determined by Grants on Addresses: an Agent sees a message iff its Grant covers the recipient Address. Threading (`In-Reply-To` / `References`) is preserved and exposed as a view and as an optional subscription filter ("only notify me about threads I started"), but it is not the primary ownership unit.

We considered conversation-owned ownership (an Agent sees a message iff it participated in the thread) and rejected it. Conversation-owned isolation requires a durable thread store keyed by `Message-ID` and graceful degradation when senders strip threading headers — corporate mail gateways do this routinely, which would produce surprising "I sent that, why can't I see the reply?" failures for agents. Address-owned isolation maps directly onto the SES → S3/SNS/Lambda inbound pipeline (a message has a recipient; fan out to its subscribers) and keeps Grants IAM-shaped and composable.

The trade-off accepted: co-granted agents on the same Address see each other's threads. Tighter isolation is achieved by provisioning more Addresses (e.g. give an agent its own customer-facing address) rather than by slicing a shared Address per thread.
