# FGAC.ai — Gmail, Sheets, Docs and Slides with access rules you control

FGAC.ai lets Claude work across **several Gmail accounts in one connection** (work,
school, personal, and inboxes teammates delegate to you) and edit the **Google
Sheets, Docs and Slides** you choose. Every call passes through access rules you
control. Read rules hide sensitive mail such as 2FA codes and password resets, send
whitelists limit who the agent can email, and per-file rules expose only the files
you pick. When the agent hits a rule, it gets a one-click approval link to show you
instead of a dead end.

This plugin ships **no code**. It contains one hosted MCP server entry, one skill
that teaches Claude how to work with the rules, this README and a license.

## Install in Claude

1. In Claude, open **Directory → Plugins**, find **FGAC.ai** and select **Add**.
2. On first use, a browser window opens. Sign in to FGAC.ai with the Google account
   you want Claude to reach.
3. That's it. The new connection is attached to your **Default Profile**, which is
   read-only. Claude can read that account's mail, plus any inbox whose owner
   delegated it to you, straight away. Sending mail and opening Sheets, Docs or
   Slides each return an approval link the first time. Approve it once and Claude
   can do it from then on. Review, re-scope or block the connection at any time on
   the [dashboard](https://fgac.ai/dashboard).

## Other clients

| client | how |
|---|---|
| Claude Code (CLI) | `/plugin marketplace add fgac-ai/fine_grain_access_control` then `/plugin install fgac-mcp@fine_grain_access_control` |
| Grok Build | `/marketplace` → `fgac-mcp` → install, or `grok plugin install fgac-mcp` |
| Grok Bot | Settings → Plugins → search **FGAC** → Add, then Authorize in the browser |
| Cursor | Marketplace → **FGAC.ai** → Install, then Settings → Tools & MCP → sign in |
| Any MCP client | add `https://fgac.ai/api/mcp` as a remote (Streamable HTTP) server |

## What Claude gets

Twenty-two tools, all annotated (`readOnlyHint` / `destructiveHint`) so clients can
auto-run reads and ask before writes:

- **Gmail**: `list_accounts`, `gmail_list`, `gmail_read`, `gmail_get_attachment`, `gmail_labels`, `gmail_send`
- **Sheets**: `sheets_get_spreadsheet`, `sheets_read_range`, `sheets_update_range`, `sheets_append_rows`, `sheets_edit`
- **Docs and comments**: `docs_read_document`, `docs_edit`, `comments_read`, `comments_add`
- **Slides**: `slides_get_presentation`, `slides_edit`
- **Rule-checked raw Google API**: `google_api_get`, `google_api_modify`
- **Self-service**: `get_my_permissions`, `request_access`
- **Large files**: `create_temporary_api_key`, a short-lived key that lets a script
  upload or download files too large for tool calls, under the same rules

Every tool takes an optional `account` argument, so one connection can reach a
work inbox, a school inbox, and inboxes teammates have delegated.

## Data flows, network endpoints and credentials (for reviewers)

- **Where data goes:** the plugin contacts only `fgac.ai`. It has no other endpoints
  or telemetry. The FGAC.ai service calls Google APIs (Gmail, Sheets, Docs, Slides,
  Drive) on the user's behalf. It runs on the hosting, sign-in, database and
  analytics providers named in the [privacy policy](https://fgac.ai/privacy). Gmail
  and Drive contents are processed in memory and never stored or sent to those
  providers.
- `https://fgac.ai/api/mcp` is the only endpoint in `.mcp.json` / `mcp.json`. It is a
  hosted MCP server over Streamable HTTP, and every tool call goes there.
- The OAuth 2.1 authorization server is discovered from
  `https://fgac.ai/.well-known/oauth-protected-resource/mcp` (named in the 401
  `WWW-Authenticate` header) and `https://fgac.ai/.well-known/oauth-authorization-server`.
  It uses the authorization code flow with PKCE (S256), and accepts both Dynamic
  Client Registration and Client ID Metadata Documents. Unauthenticated calls return
  401 with a `WWW-Authenticate` header pointing at the resource metadata.
- **Credentials required:** an FGAC.ai account (Google sign-in). The Google grant
  stays with FGAC.ai. The client only ever holds an FGAC OAuth token, and every
  call is limited to the access rules the user set for this connection.
- **What FGAC.ai stores:** the account's email address, access rules and audit
  metadata. It never stores message bodies, subjects, attachments or file contents.
  Google OAuth tokens are held by the sign-in provider, never in FGAC.ai's database.
- No local files, hooks, environment variables or scripts.

## Links

- Website and docs: https://fgac.ai · https://fgac.ai/docs
- Dashboard: https://fgac.ai/dashboard
- Privacy policy: https://fgac.ai/privacy
- Terms: https://fgac.ai/terms
- Support: support@fgac.ai
- Source: https://github.com/fgac-ai/fine_grain_access_control

## License

Plugin files: MIT-0 (see `LICENSE`). The hosted service is governed by the
FGAC.ai terms at https://fgac.ai/terms.
