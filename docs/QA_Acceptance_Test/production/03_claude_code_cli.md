# Production: Claude Code CLI (Marketplace Install)

> **GATED — user-confirmed production QA only.** Do not execute this runbook
> unless the dispatching prompt states the user explicitly confirmed production
> QA in the current session (see `/qa-production`). If that sentence is absent,
> stop and report instead of running. This suite mutates the shared production
> QA account and deliberately triggers denials against production endpoints.

> Install: Via Claude Code plugin marketplace
> Runs ALL capabilities against `https://gmail.fgac.ai`

## Install from Distribution Channel

1. Add the FGAC marketplace:
   ```
   /plugin marketplace add fgac-ai/fine_grain_access_control
   ```

2. Install the Gmail skill:
   ```
   /plugin install fgac@fine_grain_access_control
   ```

3. Verify install:
   ```
   /plugin list
   ```

### Verify Install
- `[ ]` `fgac` appears in `/plugin list`
- `[ ]` `.claude/skills/fgac/SKILL.md` exists
- `[ ]` `node .claude/skills/fgac/scripts/gmail.js --help` works (exits 0)

## Auth

```bash
node .claude/skills/fgac/scripts/auth.js --action login
```
- `[ ]` Browser opens to `https://fgac.ai` OAuth consent
- `[ ]` Token saved locally after consent
- `[ ]` Connection approved in production dashboard (`https://fgac.ai/dashboard#connected-agents`)
- `[ ]` `node .claude/skills/fgac/scripts/auth.js --action status` returns proxy key

## Run ALL Capabilities

> **CRITICAL**: Production testing MUST validate full end-to-end plumbing. Do not just verify installation.

Run the *exact same capability checklists* as the local tests, but against the production endpoints. Follow the steps in `agents/03_claude_code_cli.md` (no URL override needed, scripts default to production):

- `[ ]` Execute **Send Whitelist** checklist (→ `capabilities/01_send_whitelist.md`)
- `[ ]` Execute **Read Blacklist** checklist (→ `capabilities/02_read_blacklist.md`)
- `[ ]` Execute **Multi-Email Scoping** checklist (→ `capabilities/03_multi_email_scoping.md`)
- `[ ]` Execute **Delegation** checklist (→ `capabilities/04_delegation.md`)
- `[ ]` Execute **Connection Lifecycle** checklist (→ `capabilities/06_connection_lifecycle.md`)
- `[ ]` Execute **Key Lifecycle** checklist (→ `capabilities/07_key_lifecycle.md`)
- `[ ]` Execute **Label Access** checklist (→ `capabilities/05_label_access.md`)

## Capability: Analytics Events (→ capabilities/16_analytics_events.md)

> Run LAST — it inspects the PostHog events the capabilities above generated.
> Environment tier here is `production` (fgac.ai); this run's events are QA
> noise in prod dashboards — the "Internal / QA" cohort filter covers it.

- A1–A5: query per capability 16 “How to query” — primary: the session's
  PostHog MCP connector (load via ToolSearch keyword `posthog exec`, then
  `execute-sql` HogQL) filtering `properties.environment = 'production'` and the
  run window; fallback: `npx tsx scripts/qa-posthog-events.ts --event
  '$mcp_tool_call' --since <minutes since run start> --environment production`
  (needs the currently-unprovisioned query keys). A2 expects 0 rows for the
  legacy `mcp_tool_call` name. `skip` only if the session has no PostHog
  query path at all. Ingestion lags ~30–60s — re-query before failing.
- A6: via the browser agent, click a sign-up CTA signed-out (never complete
  sign-up), then query `--event sign_up_started`. Headless-only run → `skip`.
- A7: start playback on a landing-page demo video (play control, or the
  console postMessage fallback in the capability doc), then query
  `--event video_played`. Headless-only run → `skip`.
