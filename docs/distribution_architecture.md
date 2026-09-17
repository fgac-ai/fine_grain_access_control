# FGAC.ai Distribution Architecture

> **Canonical reference** for how FGAC.ai is packaged and distributed to agents.
> This document defines the 4 distribution packages, their auth mechanisms,
> and what code ships for each. All implementation plans should reference this.

## Distribution Packages

We ship **4 distinct packages**, each designed for a different client and use case:

| # | Package | Auth Mechanism | What Ships | Target Client |
|---|---------|---------------|------------|---------------|
| 1 | **Hosted MCP Server** | OAuth (Clerk DCR → Pending Approval) | Nothing — hosted at `/api/mcp` | Any MCP-compatible agent |
| 2 | **OpenClaw Skill** | OAuth baked into local scripts | `SKILL.md` + local scripts (`auth.js`, `gmail.js`, etc.) | OpenClaw |
| 3 | **Claude Code MCP Plugin** | OAuth (via hosted MCP server) | `claude mcp add` command | Claude Code (MCP users) |
| 4 | **Claude Code CLI Plugin** | OAuth baked into local scripts (shared w/ #2) | `SKILL.md` + local scripts | Claude Code (CLI users) |
| 5 | **Partner Handoff** | Pre-registered OAuth app → FGAC consent interstitial (consent-time provisioning, no pending step) | Nothing — `/oauth/authorize` + `/api/auth/partner-token`; optional signed webhooks | Third-party web apps with server-side agents |
| 6 | **Hosted MCP Plugin** (Grok Build, Grok Bot, Cursor, Claude Code) | OAuth (via hosted MCP server, same as #1) | `public/skills/fgac-mcp/` — manifests + `.mcp.json`/`mcp.json` pointing at `/api/mcp`, one skill, no code | Plugin marketplaces: `xai-org/plugin-marketplace`, Cursor Marketplace, Claude Code `/plugin` |

## Key Design Principles

### Packages #2 and #4 share scripts
The OpenClaw skill and Claude Code CLI plugin use the **same underlying scripts**. The OAuth flow is implemented in the shipped code (`auth.js`), giving agents the ability to read, modify, and extend the Gmail integration. This is in contrast to #1 and #3, which delegate auth to the hosted MCP server.

### Hosted MCP vs Local Scripts — when to use which
- **Hosted MCP** (#1, #3): Best for native MCP clients. Agent gets structured tools. Least code to ship. But it's an opaque remote server — limits agent's ability to innovate.
- **Local Scripts** (#2, #4): Best for code-first agents. Agent can read, modify, and extend scripts. Full Gmail API surface via REST proxy. Better ClawHub trust score (all code visible to scanners).

### Auth flow comparison

```
Hosted MCP (#1, #3):
  Agent → /api/mcp → Clerk OAuth (DCR + consent)
    → Pending Approval → User approves in dashboard → Proxy Key assigned
    → Agent tools execute with that key's permissions

Local Scripts (#2, #4):
  Agent → runs auth.js → FGAC OAuth (browser opens for consent)
    → Token saved locally → scripts use token + REST proxy
    → Proxy key resolved server-side from OAuth identity
    → Scripts mirror the standard Gmail API but route through gmail.fgac.ai
```

## Permission Chain

All packages ultimately resolve to the same permission chain:

```
Identity (OAuth token or API key)
  → userId
  → proxy_key
  → key_email_access (which emails this key can reach)
  → access_rules (send whitelist, read blacklist, deletion controls)
  → Clerk Google OAuth token (for the email owner)
  → Gmail API
```

## Multi-Email Support

Each proxy key can access multiple email accounts via `key_email_access`:
- **Own email:** Always accessible if mapped to the key
- **Delegated emails:** Resolved via `email_delegations` table; Google token fetched from the email owner's Clerk account
- **Account parameter:** All tools accept an optional `account` param. `"me"` = key owner's primary email

## Hosted MCP Tool Surface

Tool metadata (names, titles, descriptions, `readOnlyHint`/`destructiveHint`
annotations) lives in `src/app/api/mcp/toolDefs.ts` and is linted by
`npm run mcp:lint` (also run at the start of every build) against the Anthropic
Connectors Directory requirements: every tool titled and annotated, names ≤ 64
chars, no tool forwarding both safe and unsafe HTTP methods.

- **Read-only tools** (`readOnlyHint: true` — MCP clients may auto-run these):
  `list_accounts`, `gmail_list`, `gmail_read`, `gmail_get_attachment`,
  `gmail_labels`, `sheets_get_spreadsheet`, `sheets_read_range`,
  `docs_read_document`, `comments_read`, `get_my_permissions`, `request_access`,
  `google_api_get`
- **Write tools** (`destructiveHint` set — MCP clients prompt before running):
  `gmail_send`, `sheets_update_range`, `sheets_append_rows`, `sheets_edit`,
  `docs_edit`, `comments_add`, `google_api_modify`

**Raw Google API pair.** The former `raw_google_api_call` (one tool spanning
GET→DELETE — an automatic directory rejection) is split into `google_api_get`
(GET only) and `google_api_modify` (POST/PUT/PATCH). Both classify the request
in `src/app/api/mcp/googleApiPolicy.ts`:

- Gmail GETs are forwarded, then the **full response** passes the same
  label/content read-restriction checks as `gmail_read` (labels are collected
  recursively, so thread/list responses are covered).
- Gmail writes are **allow-by-default** (2026-08-30 posture change: empower
  users, don't block them): labels, drafts create/update, `messages/modify`
  (archive/mark-read), trash/untrash, `batchModify`, insert/import all forward
  under the `gmail.modify` grant, stamped `raw_api_kind: 'gmail_write'` for
  rule-engine demand data. Sending stays whitelisted: `messages/send` parses
  recipients out of the RFC 2822 payload; `drafts/send` resolves the STORED
  draft's recipients server-side (fetch `drafts/{id}?format=raw`, union with
  any inline `message.raw`) — unparseable/unresolvable → deny, never forward
  blind. Media-upload path variants (`upload/gmail/…`) classify like their
  non-upload twins, so the whitelist cannot be bypassed via the upload host
  path. Still refused: settings writes (`gmail_settings_unsupported` — needs
  gmail.settings.* scopes FGAC never requests; the denial says so honestly)
  and `messages/batchDelete` (`gmail_write_unsupported`, now meaning ONLY
  permanent deletion — legacy `mail.google.com` grants mean Google would not
  reliably backstop it).
- Sheets and Docs calls with a file id require a per-file rule; writes require
  Read & Write. Any write endpoint on a permitted file passes (including
  `:batchUpdate` — Docs tables/styles, Sheets formatting/charts).
- Creation is allowed and auto-granted to the calling key (2026-08-19 posture
  change): `POST v4/spreadsheets` / `POST v1/documents` mint an
  "Agent-created: …" Read & Write rule for the new id.
- Comment paths (`drive/v3/files/{id}/comments`, incl. replies) are classified
  `file_comments` and inherit the file's per-file rule — comment writes on a
  read-only or blocked doc/sheet are denied, never scope-only passthrough.
  The `comments_read` / `comments_add` typed tools ride the same check.
- Other unknown Google API families that could work under the grant (Drive
  listing/export, Slides, Forms) **pass through** with the account's token —
  classify-don't-block, with Google's OAuth scopes as the backstop
  (`drive.file` limits Drive to picked/app-created files) — and are stamped
  `raw_api_passthrough` for demand monitoring. Slides and Forms paths route to
  their own API hosts (`slides.googleapis.com` / `forms.googleapis.com`;
  `www.googleapis.com` does not serve them). Passthrough 404s explain
  drive.file invisibility (a file outside the grant 404s identically to a
  wrong id).
- Families the grant can **never** authorize (People/Contacts, Calendar,
  Tasks, YouTube, Chat, Admin SDK, Classroom, Photos, Meet, Groups) are
  refused pre-flight with a 🚫 denial naming the grant surface
  (`raw_api_family_unsupported`) — forwarding them produced opaque 403s/404s
  and path-respelling retry loops (2026-08 production), and the OAuth token
  cannot authorize them under any spelling.
- Non-Gmail raw calls on a token that provably lacks `drive.file` (account
  connected before the scope existed, or box unchecked at consent) are
  pre-flight denied with a reconnect link (`drive_file_scope_missing`),
  mirroring the Gmail scope pre-flight.
- Batch endpoints and non-send Gmail writes are denied. DELETE is not exposed
  at all.

**Discoverability layers** (2026-08-23, after an agent shipped a pipe-character
text table because nothing at its decision point mentioned the raw fallback):
the server `instructions` block states the typed-tools-are-shortcuts model up
front; every convenience tool's description ends with a redirect to its
superset (values tools → `sheets_edit`; `_edit` tools → `google_api_modify`;
gmail tools → the raw pair), lint-enforced by `mcp-tool-lint.ts`; sheets
values successes carry an `fgac_hint` pointer; `list_accounts.next_steps` and
`get_my_permissions.defaults` name the raw pair.

**Typed-layer shape** (2026-08-23 reshape, grounded in 30d usage data): one
read tool plus one `{service}_edit` tool bound to the service's native
batchUpdate endpoint (`docs_edit`, `sheets_edit` — full editing surface via
`requests[]` passthrough), values-style shortcuts only where the native
simple path is meaningfully simpler (Sheets values' A1 notation at 1,200
calls/30d; `gmail_send`'s MIME assembly), and the cross-service
`comments_read`/`comments_add` pair for Drive-API comments. The plain-text
`docs_append_text`/`docs_replace_text` wrappers were removed (9 calls/30d;
their names taught agents a false plain-text-only capability model). A
request for a new typed tool is first a test of whether these layers made
the operation findable.

## API Surfaces

| Surface | URL | Auth | Used By |
|---------|-----|------|---------|
| REST Proxy | `https://gmail.fgac.ai/gmail/v1/...` | `Bearer sk_proxy_...` | Local scripts, direct API calls |
| MCP Server | `https://fgac.ai/api/mcp` | OAuth Bearer token (Clerk) | Claude Code MCP, any MCP client |
| MCP Server (profile-addressed) | `https://fgac.ai/api/mcp/<profile-slug>` | OAuth Bearer token (Clerk) | Same server; a NEW connection binds to the profile whose slugified label matches (`src/lib/profileSlugs.ts`). Unknown slug → Default Profile; never rebinds existing connections |
| CLI Token | `https://fgac.ai/api/auth/cli-token` | OAuth Bearer token (Clerk) | Local scripts (auth.js) — exchanges token for proxy key |
| Dashboard | `https://fgac.ai/dashboard` | Clerk session | Users managing agents |

## File Locations

| Component | Path |
|-----------|------|
| Hosted MCP Server | `src/app/api/mcp/route.ts` |
| CLI Token Endpoint | `src/app/api/auth/cli-token/route.ts` |
| OpenClaw SKILL.md | `docs/skills/fgac/SKILL.md` |
| OpenClaw scripts | `docs/skills/fgac/scripts/` *(symlink → public/skills/claude-code-cli/scripts/)* |
| Claude Code MCP SKILL.md | `public/skills/claude-code/SKILL.md` |
| Claude Code CLI plugin | `public/skills/claude-code-cli/` |
| Claude Code CLI SKILL.md | `public/skills/claude-code-cli/skills/fgac/SKILL.md` |
| Claude Code CLI scripts | `public/skills/claude-code-cli/scripts/` *(canonical location)* |
| Hosted MCP plugin (Grok/Cursor/Claude Code) | `public/skills/fgac-mcp/` |
| Cursor / Grok marketplace manifests | `.cursor-plugin/marketplace.json`, `.grok-plugin/marketplace.json` |
| Marketplace manifest | `.claude-plugin/marketplace.json` |
| Plugin manifest | `public/skills/claude-code-cli/.claude-plugin/plugin.json` |
| Discovery endpoints | `src/app/.well-known/oauth-*/route.ts` |
| Dashboard connections | `src/app/dashboard/ConnectionsPanel.tsx` |
| Connections API | `src/app/api/connections/route.ts` |


## Partner Handoff (Package #5)

Third-party apps registered in the `partner_apps` table (via
`scripts/register-partner-app.ts`, per Clerk instance) hand signed-in users to
FGAC's consent interstitial:

```
Partner site → fgac.ai/oauth/authorize?client_id=…
  → [Clerk session check → sign-in if needed]
  → FGAC consent (manifest-rendered permissions + mailbox picker)
  → Approve = provisioning transaction (key + email access + rule copies +
    approved connection pinned to manifestVersion [+ notification subscription])
  → 303 into Clerk /oauth/authorize (consent_screen_enabled=false → silent code)
  → partner callback → token exchange → optional /api/auth/partner-token → sk_proxy_
```

Bypassing the interstitial (driving Clerk's authorize directly) yields tokens
whose connection is pending-by-default — tools refuse until dashboard approval.

**Push notifications** (optional, manifest `notifications`): Gmail `users.watch`
→ Pub/Sub (`GMAIL_PUBSUB_TOPIC`, same GCP project as the Google OAuth client —
dev `dev-fgac-ai`, prod `fine-grain-access-control`) → `/api/webhooks/gmail`
(OIDC-verified) → read-rule filter → `webhook_deliveries` outbox → HMAC-signed
thin ping (message IDs only) → partner webhook. Crons: delivery drainer
(per-minute) + watch renewal (daily) in `vercel.json`. Infra:
`scripts/setup-gmail-push.ts`. Design + spike evidence:
`docs/implementation_plans/third-party-handoff-permissions_v6.md`.
