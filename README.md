# Copilot MCP SSRF Test

A security research proof-of-concept (PoC) demonstrating that custom MCP
servers configured in GitHub Copilot's Coding Agent environment have
unrestricted network access, bypassing the Copilot agent firewall.

## Overview

When a repository includes a `.mcp.json` file (or configures an MCP server via
`copilot-setup-steps.yml`), the MCP server process runs **outside** the
firewall that GitHub applies to the Copilot Coding Agent itself. This means
the MCP server can freely reach:

- Cloud provider Instance Metadata Services (AWS IMDS, GCP metadata, Azure IMDS)
- Internal network addresses
- Any arbitrary URL

GitHub's own documentation acknowledges this behavior:
> "The firewall does not apply to MCP servers or processes started in
> configured Copilot setup steps."
>
> — [Customize the agent firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall)

## Repository Contents

| File | Description |
|------|-------------|
| `mcp-server.js` | The MCP server implementation (Node.js, stdio transport) |
| `.mcp.json` | MCP server configuration loaded by Copilot Coding Agent |
| `package.json` | Node.js project metadata |
| `test-mcp-locally.sh` | Helper script to run the MCP server locally for testing |

## PoC MCP Tools

The server exposes four tools to demonstrate the attack surface:

| Tool | Description |
|------|-------------|
| `probe_imds` | Probes AWS/GCP/Azure cloud metadata endpoints |
| `read_env` | Lists environment variables available to the MCP process |
| `probe_internal` | Probes an arbitrary URL to confirm unrestricted access |
| `read_imds_credentials` | Attempts to read AWS IAM role credentials from IMDS |

> **Note:** This PoC intentionally **redacts** actual credential values. It
> only proves that the endpoints are reachable and that the data structure is
> accessible — it does not exfiltrate real secrets.

## Security Impact

An attacker who can get a victim to open a repository containing a malicious
`.mcp.json` (or `copilot-setup-steps.yml`) and then trigger the Copilot Coding
Agent could:

1. Read `GITHUB_TOKEN` and `ACTIONS_*` tokens from the runner environment.
2. Retrieve cloud IAM credentials from the instance metadata service.
3. Reach internal network services that are normally firewalled from the agent.

## Responsible Disclosure

This repository was created as part of a bug bounty submission to the
[GitHub HackerOne program](https://hackerone.com/github).

## Running Locally

```bash
npm install   # no runtime dependencies; installs nothing
node mcp-server.js
```

Or use the provided helper:

```bash
bash test-mcp-locally.sh
```
