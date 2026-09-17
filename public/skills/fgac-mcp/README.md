# fgac-mcp — FGAC.ai hosted MCP plugin

Connect Grok Build, Grok Bot, Cursor, or Claude Code to **multiple Gmail
accounts** and **editable Google Sheets & Docs** through the
[FGAC.ai](https://fgac.ai) hosted MCP server. Every call passes through
deny-by-default access rules the user controls: read rules hide sensitive mail
(2FA codes, password resets), send whitelists limit outbound mail, per-file
rules expose only the spreadsheets and documents chosen. A denied action
returns a one-click approval link instead of a dead end.

This plugin ships **no code**: one hosted MCP server entry, one skill, this
README and a license.

## Install

| client | how |
|---|---|
| Grok Build | `/marketplace` → `fgac-mcp` → install, or `grok plugin install fgac-mcp` |
| Grok Bot | Settings → Plugins → search **FGAC** → Add, then Authorize in the browser |
| Cursor | Marketplace → **FGAC.ai** → Install, then Settings → Tools & MCP → sign in |
| Claude Code | `/plugin marketplace add fgac-ai/fine_grain_access_control` then `/plugin install fgac-mcp@fine_grain_access_control` |
| Any MCP client | add `https://fgac.ai/api/mcp` as a remote (Streamable HTTP) server |

On first use the client opens a browser window: sign in to FGAC.ai with the
Google account you want to protect. The first tool call then reports
**pending approval** with a dashboard link; approve the agent there, assign it
a profile, and every tool works with that profile's rules from then on.

## What the agent gets

Nineteen tools, all annotated (`readOnlyHint` / `destructiveHint`) so clients can
auto-run reads and prompt before writes:

- **Gmail**: `list_accounts`, `gmail_list`, `gmail_read`, `gmail_get_attachment`, `gmail_labels`, `gmail_send`
- **Sheets**: `sheets_get_spreadsheet`, `sheets_read_range`, `sheets_update_range`, `sheets_append_rows`, `sheets_edit`
- **Docs and comments**: `docs_read_document`, `docs_edit`, `comments_read`, `comments_add`
- **Rule-checked raw Google API**: `google_api_get`, `google_api_modify`
- **Self-service**: `get_my_permissions`, `request_access`

Every tool takes an optional `account` argument, so one connection can reach a
work inbox, a school inbox, and inboxes teammates have delegated.

## Network endpoints and credentials (for reviewers)

- `https://fgac.ai/api/mcp` — the only endpoint in `.mcp.json` / `mcp.json`.
  Hosted MCP server over Streamable HTTP; every tool call goes here.
- OAuth 2.1 authorization server discovered from
  `https://fgac.ai/.well-known/oauth-protected-resource/mcp` (named in the 401 `WWW-Authenticate` header) and
  `https://fgac.ai/.well-known/oauth-authorization-server`: authorization code
  with PKCE (S256), Dynamic Client Registration, and Client ID Metadata
  Documents both accepted. Unauthenticated calls return 401 with a
  `WWW-Authenticate` header pointing at the resource metadata.
- Credentials required: an FGAC.ai account (Google sign-in). The Google grant
  stays with FGAC.ai; the client only ever holds an FGAC OAuth token, and every
  call is scoped to the access rules the user approved for this agent.
- No local files, hooks, environment variables, or scripts.

## Links

- Website and docs: https://fgac.ai · https://fgac.ai/docs
- Dashboard: https://fgac.ai/dashboard
- Privacy policy: https://fgac.ai/privacy
- Source: https://github.com/fgac-ai/fine_grain_access_control

## License

Plugin files: MIT-0 (see `LICENSE`). The hosted service is governed by the
FGAC.ai terms at https://fgac.ai/terms.
