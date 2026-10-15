# claude/scanner-uptime-monitors — v1

PR: https://github.com/fgac-ai/fine_grain_access_control/pull/207

## Problem
`mcp_auth_attempt` (production, client_class='direct', outcome!='ok') jumped from
~110/day (2026-10-11) to 350–450/day. Almost all of the new volume came from one
tokenless uptime monitor, `fixter-uptime` on `fixter-monitoring/1.0`, plus
`McpStatus/0.1` at ~5/day. Neither one carries a `client_class_signal`, so both
land in the unlabelled half of `direct` that 7.21e treats as "a new crawler or a
real client that broke".

## Pre-ship check (PostHog, 90 days, every event matching either string)
| event | rows | outcomes |
| --- | --- | --- |
| mcp_auth_attempt | 982 | all `no_token` |
| connector_install_started | 982 | (twin of the above) |
| mcp_client_initialize / $mcp_tool_call / outcome='ok' | 0 | — |

Neither has ever authenticated, so classing them `scanner` is safe.

## Change
- `SCANNER_CLIENT_NAMES` += `fixter-uptime`; this also catches its one row on `python-httpx/0.28.1`
- `SCANNER_UA_PREFIXES` += `fixter-monitoring/`, `McpStatus/`
- The vocabulary is unchanged. `uptime` and `status` are too generic to be tells.
- `scripts/test-mcp-client-class.ts`: 6 pinned checks
- `docs/monitoring.md` 7.21: an evidence paragraph

## Validation
- `npx tsx scripts/test-mcp-client-class.ts`: all checks pass
- Preview build: see the PR. No UI change. The classifier only changes PostHog labels.

## Measuring after deploy
Run 7.21e from the production deploy onward. The unlabelled `direct` remainder
should drop back to ~110/day, and 7.21a `scanner` should rise by the same amount.
The relabel is not retroactive.
