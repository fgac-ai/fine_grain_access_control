# Grok / Cursor publishing and the move to the `fgac-ai` org — v1

Branch: `claude/fgac-grok-bot-publishing-254bad` · 2026-09-16

## Goal

Make FGAC installable from the Grok ecosystem and finish moving the repository
from a personal account to the `fgac-ai` GitHub organization, which both
target catalogs require for a branded plugin.

## Findings that shaped the plan

- Grok Bot's Plugins pane is the Cursor Marketplace; Grok Build reads
  `xai-org/plugin-marketplace`. The Grok Bot template marketplace is curated
  with no submission path; grok.com custom connectors are Business/Enterprise
  admin-only. Details and sources: `docs/growth-channels.md` §7.
- Both catalogs accept a manifest-only plugin pointing at a hosted OAuth MCP
  server (model: TimeCamp, `xai-org/plugin-marketplace#752`). Both closed
  branded plugins submitted from personal GitHub accounts.
- Cursor's Gmail plugin is one shared, account-wide connection, one mailbox at
  a time, and bots are documented as "not a security boundary". That is the
  FGAC pitch. No Gmail plugin with access control exists in either catalog.
- PostHog (90 days to 2026-09-16): zero Grok, xAI or Cursor client families
  have touched `fgac.ai`.

## Changes in this branch

1. `public/skills/fgac-mcp/` — the plugin package: `.grok-plugin/`,
   `.cursor-plugin/`, `.claude-plugin/` manifests (same content), `.mcp.json`
   (Grok Build, Claude Code) and `mcp.json` (Cursor) with one HTTP server at
   `https://fgac.ai/api/mcp`, `skills/fgac/SKILL.md`, README declaring
   endpoints and credentials for reviewers, MIT-0 LICENSE. No code.
2. Root `.grok-plugin/marketplace.json` and `.cursor-plugin/marketplace.json`
   so the repo is itself an installable marketplace; `fgac-mcp` added to
   `.claude-plugin/marketplace.json`.
3. Every live reference to `kyesh/fine_grain_access_control` now reads
   `fgac-ai/fine_grain_access_control` (CLAUDE.md, plugin READMEs and
   SKILL.md, `server.json`, `scripts/test-server-json.ts`,
   `scripts/mcp-auth-probe.ts`, `get-url.mjs`, `get-prod-status.mjs`, the
   Claude Code CLI production runbook, growth-channels). Archived
   implementation plans keep the old path as history.
4. Version 0.1.0 → 0.1.1 in `package.json`, `package-lock.json` and
   `server.json` so the MCP registry entry can be republished with the new
   repository URL (the registry refuses to overwrite an existing version).
5. Docs: growth-channels ledger rows, attribution note, repo table row and §7
   runbook; distribution architecture package #6 and file locations.

## Sequencing

1. **Transfer the repo** (user; the API call was blocked for the agent):
   Settings → Danger zone → Transfer → `fgac-ai`, or
   `gh api -X POST repos/kyesh/fine_grain_access_control/transfer -f new_owner=fgac-ai`.
   GitHub redirects the old URL, so nothing breaks the moment it lands.
2. Install the Vercel GitHub App on the org; verify the project's Git link in
   Vercel shows `fgac-ai` (disconnect and reconnect if it does not); push a
   trivial commit to confirm preview deploys still build. Check org
   Settings → Third-party access for gh CLI and Vercel OAuth restrictions.
3. Merge this PR, `/deploy-prod`, then run the MCP Registry Publish action so
   the registry shows the new repository URL.
4. Re-point local clones: `git -C ~/GitRepos/fine_grain_access_control remote
   set-url origin https://github.com/fgac-ai/fine_grain_access_control.git`
   (covers every worktree) and `gh repo set-default fgac-ai/fine_grain_access_control`.
5. Verify the OAuth handshake from Grok Build, Grok Bot and Cursor (needs a
   Cursor Pro or SuperGrok subscription), record client names, then submit per
   growth-channels §7.

## Open questions

- Cursor requires plugins to be open source; the plugin files are MIT-0 but
  the repo root license is personal-use-only. If review objects, mirror the
  package into a dedicated `fgac-ai/fgac-plugin` repo.
- Grok Bot's connect card has only been confirmed with servers using dynamic
  client registration by third parties; FGAC's DCR + CIMD path is untested
  there until step 5.
