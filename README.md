````markdown
# Open Sesame 🔓✉️

> Unlock agentic email — open source email for agents and humans.

Open Sesame is an AWS SES-powered email platform that bridges the gap between AI agents and human users. It provides a unified email infrastructure where agents interact via MCP (Model Context Protocol) and humans interact via a modern webmail interface — all backed by the same mailbox.

## ✨ Features

### 🤖 Agentic Email (MCP Server)
- **MCP-native interface** — agents connect via the Model Context Protocol to send, receive, read, and manage email
- **Powered by Amazon Bedrock AgentCore** — scalable, managed agentic workloads
- **Tool-use ready** — expose email capabilities as tools for any MCP-compatible agent framework
- **Inbox monitoring** — agents can subscribe to incoming mail events and react autonomously
- **Multi-agent support** — multiple agents can share or partition mailboxes with permission scoping

### ⌨️ CLI Tool
- **Direct email operations** — send, read, reply, search from your terminal with zero token overhead
- **Scriptable** — pipe-friendly output for use in bash scripts, cron jobs, and CI/CD pipelines
- **Same core engine** — CLI, MCP server, and webmail all share the same underlying logic
- **Fast local workflows** — `sesame inbox`, `sesame send`, `sesame search` without spinning up a server
- **Configuration management** — `sesame config` for domain, credentials, and preferences
- **Great for debugging** — test your SES pipeline without involving agents or UI

> 💡 The CLI is the simplest way to get started — no server required for personal use.

### 📬 Webmail (Human Interface)
- **Modern web UI** — clean, responsive webmail client for human users
- **Shared mailbox view** — see what agents have sent/received on your behalf
- **Approval workflows** — optionally require human approval before agents send sensitive emails
- **Conversation threading** — full thread view across agent and human interactions

### 📡 Email Infrastructure
- **Amazon SES integration** — reliable, scalable email sending and receiving
- **Custom domain support** — bring your own domain with full DNS configuration guides
- **Inbound email processing** — SES receipt rules → S3/SNS/Lambda pipeline
- **DKIM, SPF, DMARC** — built-in email authentication and deliverability best practices

### 🔐 Security & Access Control
- **IAM-based permissions** — fine-grained access control for agents and users
- **Audit trail** — full logging of all agent email actions
- **Scoped credentials** — agents only access what they're explicitly granted

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Open Sesame                            │
├──────────────┬──────────────────┬────────────────────────────┤
│  Webmail UI  │    CLI Tool      │        MCP Server           │
│ (Human use)  │  (Scripts/Term)  │      (Agent use)            │
├──────────────┴──────────────────┴────────────────────────────┤
│                      Core Email Engine                        │
│              (Send / Receive / Store / Search)                │
├──────────────────────────────────────────────────────────────┤
│  Amazon Bedrock    │    Amazon SES     │     Route 53         │
│  (LLM Inference)   │  (Send/Receive)   │   (DNS/Domains)     │
├──────────────────────────────────────────────────────────────┤
│                    Amazon SES                                 │
│          (Sending & Receiving Infrastructure)           │
├──────────────────────────────────────────────────────────────┤
│  S3 (Raw Email +   │  DynamoDB (Metadata,  │  Lambda (Event   │
│   Attachments +     │  Threads, State)      │  Processing +    │
│   Static Assets)    │                       │  API Backend)    │
├──────────────────────────────────────────────────────────────┤
│  CloudFront (CDN + TLS)  │  ACM (Certificates)  │  Route 53  │
└──────────────────────────────────────────────────────────────┘
```

## 🚀 Getting Started

### Prerequisites
- AWS Account with SES configured (out of sandbox)
- Verified domain in SES
- Node.js 20+ / Python 3.12+
- AWS CDK (for infrastructure deployment)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/open-sesame.git
cd open-sesame

# Install dependencies
npm install

# Configure your environment
cp .env.example .env
# Edit .env with your AWS credentials and domain settings

# Deploy infrastructure
npx cdk deploy

# Start the webmail server
npm run dev

# Start the MCP server
npm run mcp
```

### CLI Usage

```bash
# Send an email
sesame send --to alice@example.com --subject "Hello" --body "Hi from the terminal"

# Check your inbox
sesame inbox --limit 10 --unread

# Search emails
sesame search "quarterly report"

# Reply to a message
sesame reply <message-id> --body "Thanks, got it!"
```

## 🔧 Configuration

```yaml
# sesame.config.yaml
domain: mail.yourdomain.com
region: us-east-1

ses:
  sending_identity: yourdomain.com
  receipt_rule_set: open-sesame-rules

storage:
  mail_bucket: open-sesame-mail
  metadata_table: open-sesame-metadata  # DynamoDB table

agents:
  runtime: bedrock-agentcore
  max_concurrent: 10
  approval_required: false  # Set true for human-in-the-loop
```

## 🧩 MCP Integration

Open Sesame exposes email as MCP tools that any compatible agent can use:

```json
{
  "tools": [
    {
      "name": "send_email",
      "description": "Send an email from the configured mailbox",
      "parameters": {
        "to": "recipient@example.com",
        "subject": "Hello from an agent",
        "body": "This email was composed by an AI agent."
      }
    },
    {
      "name": "read_inbox",
      "description": "Read recent emails from the inbox"
    },
    {
      "name": "search_email",
      "description": "Search emails by query"
    },
    {
      "name": "reply_to_email",
      "description": "Reply to an existing email thread"
    }
  ]
}
```

## 📁 Project Structure

```
open-sesame/
├── infra/              # AWS CDK infrastructure
├── cli/                # CLI tool (sesame command)
├── packages/
│   ├── core/           # Shared email engine logic
│   ├── mcp-server/     # MCP server for agent access
│   └── webmail/        # Webmail frontend + API
├── docs/               # Documentation
├── examples/           # Example agent configurations
└── sesame.config.yaml  # Main configuration
```

## 🗺️ Roadmap

- [ ] Core SES send/receive pipeline
- [ ] MCP server with basic email tools
- [ ] Webmail UI (read, compose, reply)
- [ ] Agent approval workflows
- [ ] Multi-user / multi-mailbox support
- [ ] Calendar integration (ICS handling)
- [ ] Attachment handling & virus scanning
- [ ] Plugin system for custom email processing
- [ ] Self-hosted deployment guide

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Amazon SES](https://aws.amazon.com/ses/) — email infrastructure
- [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) — agentic runtime
- [Model Context Protocol](https://modelcontextprotocol.io/) — agent interoperability standard

---

*Open Sesame — because email should be open to everyone, including your AI agents.*
````

