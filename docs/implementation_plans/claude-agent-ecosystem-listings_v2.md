# Agent-ecosystem listings (Hermes catalog, OpenClaw/ClawHub) — v1

Branch: `claude/agent-ecosystem-listings` · 2026-10-06

## Why

Last-30-day production `$mcp_tool_call` traffic is essentially all Anthropic
clients (Claude.ai, the directory's connect-time inspector, Claude Code); one
person arrived via Grok's connector manager, none via OpenClaw, Hermes or
ChatGPT. The OpenClaw path FGAC ships today (`public/skills/open-claw/`, the
REST proxy + local scripts) has had zero successful customer calls in
production since `proxy_request` tracking began (2026-08-06), and the proxy
records no client identity, so it is unmeasurable.

Ecosystem scan (2026-10-06):

| ecosystem | discovery surface | decision |
| --- | --- | --- |
| Hermes Agent (Nous) | built-in, Nous-reviewed MCP catalog (`hermes mcp install <name>`), entries added by PR to `optional-mcps/` | **submit** — curated shelf, low competition |
| OpenClaw | ClawHub skills (registry CLI downloads −90% since March), listicles, tutorials; no MCP directory | **thin SKILL.md listing + /openclaw page**, low expectations |
| ChatGPT | Plugin directory, 30–120 d review | separate packet task (chip) |
| Claude | connector directory, plugins | remains priority #1, unchanged here |

Positioning everywhere: FGAC is the control layer (rules, approvals, send
limits), not "Gmail access" — Google's own Workspace MCP (developer preview
since 2026-05-01) and bundled skills (OpenClaw "gog", Hermes
google-workspace) already give raw access.

## Scope of this branch

1. `public/skills/hermes/` — the catalog manifest in Nous's exact format,
   ready to copy into a PR against `NousResearch/hermes-agent` (the PR itself
   is Ken's call — public, under FGAC's name).
2. `public/skills/openclaw-mcp/SKILL.md` — ClawHub skill, no scripts, wiring
   OpenClaw to the hosted MCP with `auth: "oauth"`. Publishing to ClawHub is
   Ken's action.
3. `/openclaw` landing page — one-command setup for OpenClaw and Hermes,
   comparison with full-access skills, CTA to /setup. Linked from /setup.
4. Docs: `docs/distribution_architecture.md` rows for both channels; the old
   script-based `open-claw` skill marked legacy (not deleted until the MCP path
   is verified with real clients).

## Out of scope (spun off)

- Real-client verification (OpenClaw in Docker, Hermes in a venv) of the OAuth
  flow + client-name capture in `classifyMcpClient` — separate task. Listings
  must not be published until it passes.
- ChatGPT Plugin directory packet — separate task.

## Measurement

After publication: per-client people/week in `$mcp_tool_call` by
`client_name` (Hermes / OpenClaw strings confirmed by the verification task),
plus `/go/<slug>` scans for links placed in each listing. Success bar: a few
active people per week per ecosystem within a month of listing.

## Validation plan

- `npm run lint` / typecheck / unit tests.
- Local: /openclaw renders, light/dark, mobile width, links resolve.
- Preview via `/deploy-pr-preview`: same checks on the deployed page.

## v2 — research results and validation (2026-10-06)

**Hermes catalog odds are low.** Entries live at
`optional-mcps/<name>/manifest.yaml` (loader `hermes_cli/mcp_catalog.py`).
The maintainers closed a well-formed small-vendor OAuth+DCR entry (#86720)
with "holding entries from early-stage single-maintainer products for now".
Their curation pass (#94513) excluded "Google Workspace … (per-account setup)"
and dropped generic API executors. The manifest therefore excludes
`google_api_modify`, `gmail_send` and `create_temporary_api_key` by default.
`/hermes` with the manual `mcp_servers.fgac` config is the working path.

**OpenClaw:** a skill cannot auto-configure an MCP server; only plugins can. So
the ClawHub skill is instructions-only. It runs
`openclaw mcp add … --transport streamable-http --auth oauth`; without the
transport flag, OpenClaw defaults to SSE. ClawHub refuses publishing accounts
younger than 14 days. Search ranks on embeddings plus slug and display-name
tokens, hence the slug `fgac-google-workspace` and naming gog in the
description.

**Client identification** (handed to the verification session, task "Verify
OpenClaw and Hermes connect to FGAC MCP"):
- OpenClaw: DCR "OpenClaw MCP", clientInfo `openclaw-bundle-mcp`, redirect
  `127.0.0.1:8989/oauth/callback`.
- Hermes: CIMD client_id on nousresearch.github.io, clientInfo is the SDK
  default `mcp`, OAuth UA `Hermes-Agent/<ver>`, loopback ports 27890–27894.

No `mcpClientName.ts` change on this branch. The Hermes name mapping needs a
real handshake, so it belongs to the verification task.

**Validation (local only — ADR-002 feature branch: pushed, no PR, no preview):**
- `tsc --noEmit` and eslint are clean on the touched files.
- `/openclaw`, `/hermes` and `/setup` return 200 from `dev:qa`; the setup page
  links both guides.
- Path B (Playwright) screenshots at 1280 px and 375 px: no horizontal page
  scroll at 375. Two defects found and fixed: a missing space in the
  comparison intro, and the copy button scrolling out of view on long
  commands (moved outside the scroller).
- `npm run db:branch` failed once on a Neon CLI error. These pages touch no
  database, so they rendered without a branch. Re-run it before any stateful
  work in this worktree.

**Publication gates (vendor actions, after real-client verification passes):**
1. Publish the ClawHub skill (`public/skills/clawhub/README.md`), then add the
   ClawHub line to `/openclaw` step 1.
2. Optionally open the Hermes catalog PR (`public/skills/hermes-catalog/README.md`).
3. Land this branch on the next integration train.
