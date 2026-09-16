# Label the `mcpdd` crawler (and three one-off probes) in `client_class` — v1

**Branch:** `claude/jovial-varahamihira-8c31db` · **Date:** 2026-09-15 · **Scope:** measurement label only, no auth or rate-limit change, no schema change.

## Problem

After PR #138 (`ua:stock-runtime-no-name`, deployed 2026-09-14) the daily review's
"unlabelled `direct`" column (docs/monitoring.md 7.21e) should hold only real clients
that broke or crawlers the classifier misses. Re-measured on 2026-09-15 it holds one
source almost entirely: `client_name = 'mcpdd'` on a bare `node` UA.

## Established before changing anything (PostHog, production)

| check | result |
| --- | --- |
| `mcpdd` in `src/lib/mcpClientSignals.ts` at main (3b5d758) | absent |
| 7.21b, last 24 h, `direct` + no signal | mcpdd 78 · LiveAgent 15 · Anthropic 4 · eyrie-validator 1 · mcp 1 |
| `mcpdd` `mcp_auth_attempt` outcome = ok, 14 d | 0 (359 failures, one UA, 09-12 → 09-16) |
| `mcpdd` on `mcp_client_initialize` / `$mcp_tool_call`, 14 d | 0 rows |
| `validator` / `survey` / `seeder` / `mcpdd` on any authenticated name or UA, 14 d | 0 rows |
| MCPScoringEngine, AgentPulse after #138 | labelled (absent from the unlabelled column) |

## Change

1. `SCANNER_CLIENT_NAMES` += `mcpdd` → `client_class_signal = 'name:mcpdd'`.
2. `SCANNER_KEYWORDS` += `validator`, `survey`, `seeder` (eyrie-validator, wormhole-survey, cadastr-seeder — 1–4 rows each, never authenticated).
3. `scripts/test-mcp-client-class.ts`: a case per new string, plus pins that `LiveAgent` and `otter` stay plain `direct`.
4. docs/monitoring.md 7.21: a 2026-09-15 re-measure paragraph.

Deliberately left `direct`: `LiveAgent` (`agent` is not a tell), `centinela`, `yado-walker`, `otter`, and the known `Anthropic` / `mcp` constants.

## Validation

- `npx tsx scripts/test-mcp-client-class.ts` green.
- Preview: tokenless POST to the preview's `/api/mcp` with UA `node` and `clientInfo.name = 'mcpdd'` → 401, and the resulting `mcp_auth_attempt` row carries `client_class = 'scanner'`, `client_class_signal = 'name:mcpdd'`.
