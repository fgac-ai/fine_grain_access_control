---
name: fgac-google-workspace
description: Safe Google Workspace for OpenClaw — Gmail, Docs, Sheets, Slides and Drive through FGAC.ai's hosted MCP server, under rules you set (hide 2FA and password-reset mail, send only to allowed recipients, expose only chosen files, one-click approvals). OAuth sign-in; no Google Cloud project, no API keys, no local scripts. A rule-limited alternative to gog.
homepage: https://fgac.ai/openclaw
metadata: {"openclaw":{"emoji":"🛡️","homepage":"https://fgac.ai/openclaw"}}
---

# FGAC — rule-limited Google Workspace (hosted MCP)

FGAC.ai gives you Gmail, Google Docs, Sheets, Slides and Drive through a
hosted MCP server. The account owner decides what you may read, who you may
email and which files you may touch; FGAC enforces that server-side. This
skill ships no code: it only connects OpenClaw to `https://fgac.ai/api/mcp`.

## Setup (once)

1. Inspect `openclaw mcp show fgac --json`. If a definition exists, keep it.
   If it is missing, register the hosted server:

   ```bash
   openclaw mcp add fgac --url https://fgac.ai/api/mcp --transport streamable-http --auth oauth
   ```

   Always pass `--transport streamable-http`; OpenClaw's default is SSE,
   which this server does not use. No API key, Google client secret or
   `sk_proxy_` key is involved — never ask the user for one.

2. Run `openclaw mcp login fgac` and give the user the sign-in link
   privately. They sign in to FGAC.ai with the Google account they want you
   to use. The loopback callback must reach the machine running OpenClaw; if
   it cannot, use the fallback the command prints
   (`openclaw mcp login fgac --code <code>`) and treat that code as a
   credential. Tokens stay in OpenClaw's managed store.

   On a shared channel where each person should connect their own account,
   the operator can set `oauth: { identity: "per-requester" }` (with
   `gateway.publicOrigin`) on the `fgac` server instead.

3. Run `openclaw mcp doctor fgac --probe`, then call `list_accounts`
   (read-only). Report a live read separately from "configured" — a saved
   definition alone does not prove access.

4. If `list_accounts` reports **pending approval**, show the user the
   dashboard link it returns and stop. The owner approves this agent once on
   fgac.ai and picks its rules; retry after they say it is done. If the tools
   have not appeared after login, check again on a fresh turn before changing
   configuration.

## Using it

- Start with `list_accounts`: it lists every mailbox you can reach (pass
  `account` to target a specific one) and next-step guidance.
- Typed tools cover the common cases: `gmail_list`, `gmail_read`,
  `gmail_send`, `gmail_labels`, `gmail_get_attachment`;
  `sheets_read_range`, `sheets_update_range`, `sheets_append_rows`,
  `sheets_edit`; `docs_read_document`, `docs_edit`; `slides_get_presentation`,
  `slides_edit`; `comments_read`, `comments_add`.
- Anything else in the Google API (threads, drafts, labels, archive, Drive
  listing and export, creating a new doc or sheet) goes through
  `google_api_get` (reads) and `google_api_modify` (writes). Use them rather
  than telling the user an operation is unsupported.
- Files over about 1 MB: call `create_temporary_api_key` and move the bytes
  with a script; the same rules apply to that key.
- `get_my_permissions` explains the rules in force.

## Denials are answers, not obstacles

A denied call returns a one-click approval link. Show it to the user, say in
one sentence what was blocked, and retry only after they approve. Never try
to work around a denial, never re-request the same link in a loop, and never
fall back to another Google skill or raw Google credentials to get past a
rule — the rule is the user's decision.

## Before acting

Confirm with the user before sending mail, sharing or trashing files, or any
bulk edit. For connectivity checks use reads only; never send a test email.
