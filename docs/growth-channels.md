# Growth Channels — listing ledger and publishing runbook

Where FGAC's hosted MCP server (`https://fgac.ai/api/mcp`) is listed, what is
still pending, and the exact steps that need a human. Strategy and rationale
live in `docs/implementation_plans/connector-growth_v2.md` and
`docs/distribution_architecture.md`; this file is the operational ledger.

Listing copy source of truth: `docs/connector_submission/listing_copy.md`
(keyword-first — capabilities before the security story).

## Ledger

| surface | submitted | status | listing link |
|---|---|---|---|
| Claude connector directory | 2026-08-16 | **live** | https://claude.ai/directory (search "FGAC") |
| Official MCP Registry (registry.modelcontextprotocol.io) | 2026-09-10 | **live** — `ai.fgac/fgac` v0.1.1 (republished 2026-09-17 with the `fgac-ai` repository URL after the org transfer; v0.1.0 (renamed 2026-09-10 from `ai.fgac/google-workspace`, which is marked `deleted`: a Google trademark must not be the server's own name — descriptive use in title/description is fine) via the **MCP Registry Publish** action | https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.fgac |
| GitHub MCP Registry (github.com/mcp) | 2026-09-10 (via official) | pending propagation — auto-ingests from the official registry, no separate submission (VS Code / Copilot `/mcp search` consumes it); check within a day and paste the link | https://github.com/mcp |
| Smithery | 2026-09-10 | **live** — `fgac/fgac` (19 tools indexed, ranks in Smithery search for "fgac"; SmitheryBot scanned the endpoint 2026-09-10, the day Clerk CIMD went live, and its `smithery-probe` client re-checks it a few times a day). Smithery fronts our remote through its hosted proxy `https://fgac--fgac.run.tools` — a Smithery-originated user shows up in `mcp_auth_attempt` / `mcp_client_initialize` as a non-Anthropic `client_name` or user agent, never as `Claude-User`; as of 2026-09-16 none has (probe traffic only, `useCount` is null on their API). `/.well-known/mcp/server-card.json` remains the fallback card | https://smithery.ai/server/fgac/fgac |
| ChatGPT Plugin directory | — | pending (30–120 day review, no fee; see memory note "OpenAI Plugin Directory") | https://chatgpt.com/plugins |
| Cline MCP Marketplace | — | optional, not submitted — GitHub issue template below | https://github.com/cline/mcp-marketplace |
| PulseMCP | — | optional, not submitted — submit button on the site | https://www.pulsemcp.com/submit |
| Glama | — | optional — `/.well-known/glama.json` (maintainer: support@fgac.ai) is served; claim at https://glama.ai/mcp/servers | https://glama.ai/mcp/servers |
| awesome-mcp-servers (mcpservers.org) | — | optional, not submitted | https://mcpservers.org/submit |
| xAI plugin marketplace (Grok Build) | 2026-09-17 | **submitted** — PR https://github.com/xai-org/plugin-marketplace/pull/766 from the `fgac-ai/plugin-marketplace` fork, pinned to main `952a187`; Socket scan green, Semgrep + catalog validation awaiting first-contributor workflow approval; third-party merges took 3–19 days in Sep 2026 | https://github.com/xai-org/plugin-marketplace |
| cursor.directory (Cursor community marketplace) | 2026-09-17 | **submitted** — listing created from the repo scan (root `.mcp.json` dev PostHog entry removed by hand before publishing; scanner ignores subdirectory URLs), hidden until their security agent finishes | https://cursor.directory/plugins/fgacai-gmail-google-sheets-docs |
| Cursor Marketplace (first-party; also Grok Bot's Plugins pane) | 2026-09-17 | **application submitted** — publisher application (org name FGAC.ai, handle `fgac-ai`, contact support@fgac.ai, repo + logo + website) accepted with "Thanks for applying"; manual review, no status page, follow-up comes by email from Cursor's marketplace-publishing mailbox. Watch item: cursor.directory's scanner reads the repo root, so a re-scan would re-add the dev-only PostHog server from the root `.mcp.json` | https://cursor.com/marketplace |

Update the *submitted* and *status* columns as each step lands.

## Attribution: which directory did an install come from?

There is **no direct listing-source signal** — an MCP OAuth handshake carries no
referrer, and the official/GitHub registries do not proxy traffic. What FGAC
does capture, per `docs/analytics.md`:

- `mcp_client_initialize` — `client_name` / `client_version` (the client's
  self-reported MCP clientInfo), `client_id`, `user_agent`. One row per session.
- `connector_install_started` — `user_agent` + `install_fingerprint` on the
  OAuth discovery routes, before any account exists.
- `$mcp_tool_call` — `client_name`, `client_id`, `user_agent` on every call.

So attribution is **by client family**, which maps to a directory closely
enough for the channels above: `Anthropic/ClaudeAI` / `claude-ai` = Claude
connector directory; VS Code / Copilot client names = GitHub MCP Registry
(the official registry is not a VS Code surface by itself); Cline = Cline
marketplace; Grok Build / Grok Bot / Cursor client names = the xAI plugin
marketplace or the Cursor Marketplace (record the exact `client_name` each
reports during the §7 verification step); Smithery **proxies** every request through its gateway, so its
installs show a Smithery user agent. PulseMCP, Glama and awesome-lists cannot
be told apart from organic (any client). Baseline in the 30 days to
2026-09-10, before any registry listing: `claude-code` (129 users),
`Anthropic/ClaudeAI` (179), `Anthropic/Toolbox` (64 — directory inspection),
`sheet-add-in` (9); **no VS Code, Cursor, Cline or Smithery client at all**, so
any of those appearing after 2026-09-10 is registry-driven.

Query (new client families per week since the registry listing):

```sql
select toStartOfWeek(timestamp) as week, properties.client_name as client,
       uniq(distinct_id) as users, count() as inits
from events
where event = 'mcp_client_initialize' and timestamp >= '2026-09-10'
group by week, client order by week, users desc
```

Date-bound the cohorts with a PostHog annotation at each listing's go-live
(the Claude directory has one at 2026-08-16T17:00Z; the registry publish at
2026-09-10T02:32Z still needs one — the CI key lacks `annotation:write`, add it
in the PostHog UI). If a listing ever needs hard attribution, the profile-slug
mechanism already proves path-suffixed MCP URLs work with real clients, so a
reserved per-directory suffix is feasible; not worth it until a channel shows
volume.

## What is in the repo (automated)

| piece | path | serves |
|---|---|---|
| Registry manifest | `server.json` (repo root) | `ai.fgac/fgac`, remote `streamable-http` at `https://fgac.ai/api/mcp`; version tracks `package.json` (enforced by `scripts/test-server-json.ts` in `npm run mcp:lint`) |
| Domain proof | `src/app/.well-known/mcp-registry-auth/route.ts` | `v=MCPv1; k=ed25519; p=<public key>` as text/plain at `https://fgac.ai/.well-known/mcp-registry-auth` |
| Smithery server card | `src/app/.well-known/mcp/server-card.json/route.ts` | JSON card built from `server.json` + `TOOL_DEFS` at `https://fgac.ai/.well-known/mcp/server-card.json` |
| Glama maintainer file | `public/.well-known/glama.json` | `https://fgac.ai/.well-known/glama.json` |
| 400×400 logo | `public/logo-400.png` | `https://fgac.ai/logo-400.png` (registry `icons`, Cline marketplace) |
| Grok / Cursor / Claude Code plugin package | `public/skills/fgac-mcp/` | `.grok-plugin/`, `.cursor-plugin/` and `.claude-plugin/` manifests, `.mcp.json` (Grok Build, Claude Code) and `mcp.json` (Cursor) pointing at `https://fgac.ai/api/mcp`, one skill, README, MIT-0 license. Root `.grok-plugin/marketplace.json` and `.cursor-plugin/marketplace.json` list it so the repo itself is an installable marketplace |
| Publish workflow | `.github/workflows/mcp-registry-publish.yml` | `workflow_dispatch`: install `mcp-publisher`, check the live proof, `login http`, `publish`, verify search |

The private key exists **only** at `.secrets/mcp-registry-key.pem` on the machine
that generated it (gitignored) and, once step 2 below is done, in the GitHub
Actions secret. Losing both means re-keying: regenerate the pair, replace the
record string in the route, redeploy, re-add the secret.

## Human checklist (in order)

> Steps 1–4 completed 2026-09-10 (key in 1Password, `MCP_PUBLISHER_PRIVATE_KEY` set, PR #120 deployed, published via the action). Steps 5–6 remain.

### 1. Back up the private key to 1Password

The key is on this machine only. Create a 1Password item (type: Document or
Secure Note) named **"FGAC MCP Registry signing key (Ed25519)"** and attach or
paste the contents of:

```bash
cat .secrets/mcp-registry-key.pem
```

Do not paste it anywhere that reaches GitHub, chat, or a ticket.

### 2. Add the GitHub Actions secret

Print the raw hex private key (64 hex chars) and store it as the repository
secret `MCP_PUBLISHER_PRIVATE_KEY`:

```bash
openssl pkey -in .secrets/mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'
```

Either paste it at
https://github.com/fgac-ai/fine_grain_access_control/settings/secrets/actions/new
or from the CLI (reads from stdin, nothing lands in shell history):

```bash
openssl pkey -in .secrets/mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n' | gh secret set MCP_PUBLISHER_PRIVATE_KEY --repo fgac-ai/fine_grain_access_control
```

### 3. Merge the PR and deploy production

Merge the PR, then run `/deploy-prod` (user-only). The registry cannot verify
the domain until the well-known routes are live. Confirm:

```bash
curl -fsS https://fgac.ai/.well-known/mcp-registry-auth && curl -fsS https://fgac.ai/.well-known/mcp/server-card.json | jq '.serverInfo, (.tools | length)'
```

Expected: the `v=MCPv1; k=ed25519; p=…` line, then the serverInfo block and
the tool count (currently 19).

### 4. Publish to the official MCP Registry

**Option A — one click:** https://github.com/fgac-ai/fine_grain_access_control/actions/workflows/mcp-registry-publish.yml
→ *Run workflow* on `main`. The job checks the live proof, validates
`server.json`, logs in with the secret, publishes, and greps the search API.

**Option B — locally:**

```bash
brew install mcp-publisher
```

```bash
mcp-publisher login http --domain fgac.ai --private-key "$(openssl pkey -in .secrets/mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
```

```bash
mcp-publisher publish server.json
```

Verify (either option):

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.fgac" | jq '.servers[] | {name: .server.name, version: .server.version, status: ._meta}'
```

**Naming rule** (decided 2026-09-10): the server ID never carries a Google trademark. Google's brand guidelines allow descriptive use ("for Google Workspace", "Gmail, Sheets & Docs" in the title) but not a Google mark as the product's own name, and FGAC's restricted-scope OAuth app is re-reviewed by Google. Retire a wrongly named entry with `mcp-publisher status --status deleted <name> <version>` **before** publishing the replacement — the registry allows one listing per remote URL and rejects the new name while the old one is active.


The GitHub MCP Registry (github.com/mcp) ingests the official registry; allow
up to a day, then search "FGAC" there and record the link in the ledger.

**Republishing** (registry preview reset, or a new version): bump `version` in
`package.json` *and* `server.json` (the lint test keeps them equal), merge,
re-run the workflow. The registry refuses to overwrite an existing version.

### 5. Smithery

1. Sign in at https://smithery.ai/new (GitHub account).
2. Submit the server URL `https://fgac.ai/api/mcp` (Streamable HTTP, OAuth). Namespace `fgac` (the `fgac-ai` GitHub org owns the repo since 2026-09-16), server ID `fgac`, so the install string matches the registry name.
3. If the automatic scan stalls at the auth wall (Smithery registers clients
   via Client ID Metadata Documents; FGAC's Clerk authorization server uses
   Dynamic Client Registration), Smithery falls back to the card at
   `https://fgac.ai/.well-known/mcp/server-card.json`, which is already live
   after step 3. If the form asks, the scan may be completed by authenticating
   with a QA account — never a personal one.
4. Record the listing URL in the ledger.

### 6. Optional same-afternoon batch

**Cline MCP Marketplace** — open a new issue at
https://github.com/cline/mcp-marketplace/issues/new/choose ("Server Submission")
and attach `public/logo-400.png` (400×400 PNG, resampled from the 381×379
brand mark `public/logo-v2.png`). Body:

> **GitHub Repo URL:** https://github.com/fgac-ai/fine_grain_access_control
>
> **Logo:** attached, 400×400 PNG.
>
> **Server type:** remote (Streamable HTTP) — `https://fgac.ai/api/mcp`, OAuth
> 2.1 with Dynamic Client Registration and PKCE; no install step, no API key.
>
> **Reason for addition:** FGAC.ai gives AI agents access to multiple Gmail
> accounts (work, school, personal, and inboxes delegated by teammates) and to
> editable Google Sheets and Google Docs, behind deny-by-default access rules
> the user controls: read rules hide sensitive mail (2FA codes, password
> resets), send whitelists limit outbound mail, per-file rules expose only the
> spreadsheets and documents chosen. A denied action returns a one-click
> approval link instead of a dead end. Nineteen tools — typed Gmail, Sheets,
> Docs and comments tools plus a rule-checked raw Google API escape hatch.
>
> **Installation testing:** I have tested the server with Cline: add
> `https://fgac.ai/api/mcp` as a remote (Streamable HTTP) server, complete the
> browser sign-in, and the tool list appears with annotations. Documentation:
> https://fgac.ai/docs. Privacy policy: https://fgac.ai/privacy.

**PulseMCP** — https://www.pulsemcp.com/submit. Fields: name `FGAC.ai`; URL
`https://fgac.ai/api/mcp`; repo `https://github.com/fgac-ai/fine_grain_access_control`;
short description:

> Multiple Gmail accounts, editable Google Sheets & Docs for AI agents. Deny-by-default access rules.

**Glama** — https://glama.ai/mcp/servers → *Add server* → repo URL
`https://github.com/fgac-ai/fine_grain_access_control`. Ownership is proven by
`https://fgac.ai/.well-known/glama.json` (maintainer email support@fgac.ai);
click *Claim* on the server page once it is indexed.

**awesome-mcp-servers** — https://mcpservers.org/submit. Category:
Productivity / Communication. Name `FGAC.ai — Gmail, Google Sheets & Docs`;
URL `https://fgac.ai`; one-liner:

> Connect AI agents to multiple Gmail accounts and editable Google Sheets and Docs behind deny-by-default, per-file and per-recipient access rules. Hosted MCP server with OAuth — nothing to install.

### 7. Grok Build, Grok Bot and Cursor (researched 2026-09-16)

Grok Bot's Plugins pane **is the Cursor Marketplace** (SpaceXAI owns Cursor);
Grok Build, the coding CLI, reads `xai-org/plugin-marketplace`. Both accept a
manifest-only plugin that points at a hosted OAuth MCP server. The package is
`public/skills/fgac-mcp/`. The Grok Bot template marketplace is curated with no
submission path, and grok.com custom connectors are Business/Enterprise
admin-only — neither is a channel.

**Prerequisites (user):** the repo lives under the `fgac-ai` org (both catalogs
close branded plugins submitted from personal accounts), and a Cursor Pro or
SuperGrok subscription for the verification step.

1. **Verify the handshake before submitting.** In Grok Build:
   `grok mcp add --transport http fgac https://fgac.ai/api/mcp` → browser
   sign-in → `list_accounts` returns the pending-approval link. In Grok Bot:
   message a bot "Add a custom MCP server called fgac at
   https://fgac.ai/api/mcp" → Authorize on the connect card. In Cursor: add
   the same URL under Settings → Tools & MCP. Record each client's
   `mcp_client_initialize` `client_name` in the attribution list above.
2. **xAI marketplace PR.** Fork `xai-org/plugin-marketplace` **into the
   `fgac-ai` org** (`gh repo fork xai-org/plugin-marketplace --org fgac-ai`),
   add one entry to `.grok-plugin/marketplace.json`:
   `{"name":"fgac-mcp","category":"productivity","source":{"source":"url","url":"https://github.com/fgac-ai/fine_grain_access_control.git","sha":"<40-char main SHA>","path":"public/skills/fgac-mcp"},"homepage":"https://fgac.ai/docs","keywords":["fgac","fgac.ai","fgac gmail","fgac google workspace","fgac mcp"],"domains":["fgac.ai","gmail.fgac.ai"]}`,
   run `python3 scripts/generate-plugin-index.py && python3 scripts/validate-catalog.py`,
   open the PR with their template (declare the endpoints from the plugin
   README). Third-party merges took 3–19 days in September 2026; xAI's bot
   re-pins the SHA daily after merge.
3. **Cursor.** List on https://cursor.directory (community marketplace,
   self-managed, faster) first, then submit the repo link at
   https://cursor.com/marketplace/publish. The form is tied to the submitting
   user's account: note "company submission, contact support@fgac.ai" in the
   notes field. Manual review, follow-up by email, no status page. The plugin
   files are MIT-0; if review asks about the repo's personal-use root license,
   mirror `public/skills/fgac-mcp/` into a dedicated `fgac-ai/fgac-plugin` repo.
4. Record listing links and the go-live dates in the ledger, and add a PostHog
   annotation per listing.
