---
name: fgac.ai Gmail Proxy
description: Secure Gmail access for Claude Code via FGAC.ai proxy — MCP server mode.
---

# Claude Code: fgac.ai Gmail via MCP

This skill enables Claude Code to interact with Gmail securely via the fgac.ai MCP server, enforcing fine-grained access control rules defined by the user.

## Setup

Add the FGAC.ai MCP server to Claude Code:

```bash
claude mcp add --transport http fgac https://gmail.fgac.ai/api/mcp
```

After running:
1. Claude Code will discover OAuth endpoints automatically
2. A browser window opens for you to sign in with your Google account
3. After consent, the first tool call shows: **"⚠️ Pending approval"**
4. Visit the linked dashboard URL to approve this agent and assign it a proxy key (agent profile)
5. Once approved, all Gmail tools work with the permissions you configured

## Available MCP Tools

- `list_accounts` — See which email accounts this agent can access
- `gmail_list` — List emails with optional search query
- `gmail_read` — Read a specific email by message ID
- `gmail_send` — Send email (subject to send whitelist rules)
- `gmail_labels` — List Gmail labels
- `get_my_permissions` — Show current access rules and permissions

## Instructions for Claude Code

When the user asks you to interact with Gmail, use the `fgac` MCP tools directly.
All requests route through `gmail.fgac.ai` — never use `googleapis.com` directly.
Authentication is handled automatically via the MCP OAuth flow.

### Multiple Email Accounts
A single proxy key can access multiple inboxes if the key owner has delegated access. 
- When querying the owner's email, use `"me"`.
- When querying a delegated email, replace `"me"` with the specific email address.

## Alternative: CLI Mode

For users who prefer local scripts over MCP, install the `fgac` plugin:

```
/plugin marketplace add fgac-ai/fine_grain_access_control
/plugin install fgac@fine_grain_access_control
```

This installs local scripts that Claude can invoke directly, giving you full control over the code.
