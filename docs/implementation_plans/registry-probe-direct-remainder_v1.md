# Registry probe classification: the `direct` remainder (v1, 2026-09-12)

Branch: `claude/elated-bassi-949905`. Measurement-only; no schema, nothing
blocked or rate-limited on `client_class` (docs/monitoring.md section 1).

## Problem

`classifyMcpClient` (src/lib/mcpClientSignals.ts) labels every
unauthenticated `/api/mcp` request `claude | internal | scanner | direct`.
The daily analytics review reads `direct` as "a crawler the classifier
misses OR a real client that broke" (docs/monitoring.md 7.21). Three days
after the MCP Registry listing that bucket was growing — 30 → 65 → 111
`no_token` rows on 09-10/11/12 — and 7.21b showed it was crawler traffic.

## Established first

1. 7.21b over the three days, `direct` only (one row per UA × client_name
   × HTTP method) — see the table now in docs/monitoring.md 7.21.
2. None of those UAs or names appears on any authenticated event
   (`mcp_auth_attempt` ok, `mcp_client_initialize`, `$mcp_tool_call`) in
   the 14 days to 09-12. Since the classifier deployed (09-10 12:28Z) every
   authenticated request carries a `Claude-User` or `claude-code/` UA; the
   248 empty-UA authenticated rows on 09-10 all predate 12:23Z (the previous
   build, before the property existed).
3. `MCPScoringEngine` slipped through because `keywordHit` splits only on
   non-alphanumerics: the whole string was one token and none of `mcp`,
   `scoring`, `engine` was ever tried. `audit`, `study`, `inventory`,
   `canary`, `pulse` were simply not in the vocabulary.

## Decision per shape

| shape | choice | why |
| --- | --- | --- |
| `MCPScoringEngine`, `AgentPulse` | (b) CamelCase split in `keywordHit` + `scoring`, `pulse` keywords | product names that describe a scanner, hidden by tokenisation |
| `SaSame-MCP-Audit`, `schema-study`, `mcp-inventory(-canary)` | (b) keywords `audit`/`auditor`, `study`, `inventory`, `canary` | the words are the tell; none appears in any authenticated name |
| `rpg-connect-check` | (a) exact name | `check` alone is too common a word to be vocabulary |
| `Bun/`, `Python/… aiohttp/`, `Go-http-client/`, bare `node`/`undici`, `python-httpx/` GET — all with no `clientInfo` | (c) stays `direct`, new `client_class_signal = 'ua:stock-runtime-no-name'` | a runtime UA is what the real SDKs send; not evidence of a crawler. The absence of `clientInfo` is what marks it as not an install flow. A signal, not a class, so no query's exclusion set changes and nothing is over-claimed as `scanner` |
| `python-httpx` / `Anthropic`, `undici` / `obolo-gateway`, `python-httpx` / `mcp`, `node` / `otter`, curl, browsers | unchanged, unlabelled `direct` | named-but-unknown or a person; `gateway` and the SDK default `mcp` are deliberately not tells |

Rejected: `engine` and `check` as keywords (a real product could carry
them); a fifth `client_class` value (would silently change every
`NOT IN ('scanner','internal')` exclusion's meaning and the review's
mental model for no gain over the signal).

## Replay (scripts pattern: `scripts/test-mcp-client-class.ts` pins every string)

Replaying the new rules over every classified failure row since 09-10:

| day | scanner before→after | direct before→after | of which `ua:stock-runtime-no-name` / unlabelled |
| --- | --- | --- | --- |
| 09-10 | 133→140 | 30→23 | 11 / 12 |
| 09-11 | 394→407 | 65→52 | 35 / 17 |
| 09-12 (to ~15:00Z) | 248→259 | 112→101 | 97 / 4 |

`claude` and `internal` rows are untouched; zero of the 15 authenticated
UA × name pairs from the last 14 days would become `scanner`.

## Ship

- src/lib/mcpClientSignals.ts — vocabulary, CamelCase tokenisation,
  `rpg-connect-check`, `STOCK_RUNTIME_UA` + the `direct` signal; doc comment.
- scripts/test-mcp-client-class.ts — new pinned test, wired into
  `npm run mcp:lint` (package.json).
- docs/monitoring.md — section 1 row, 7.21 narrative + table, 7.21a
  comment, new 7.21e query, reading guidance.
- docs/analytics.md — event-table mentions of the signal.
- The daily review task definition (local scheduled task
  `fgac-user-behavior-review`, step 4) now reads `direct` through 7.21e.

## Validation

- `npm run mcp:lint` green locally (new test included); eslint clean.
- Preview: tokenless POST with a stock-runtime UA and no body, a named
  scanner UA (`MCPScoringEngine/1.0`), and `python-httpx` + `AgentPulse`
  initialize against the preview `/api/mcp`, then PostHog
  `mcp_auth_attempt` rows with `environment = 'preview'` carry the expected
  `client_class` / `client_class_signal`.
