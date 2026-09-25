# First Grok install: attribute the `connectors-manager` client family — plan v1

Branch `claude/elegant-engelbart-8cebb0`, 2026-09-25.

## What happened

The first non-Claude install reached production on 2026-09-24T18:04Z. One
person (an existing FGAC account created via the Claude directory on
2026-09-21) added `https://fgac.ai/api/mcp` as a grok.com custom connector.
Through it: 21 `mcp_client_initialize` rows and 20 `$mcp_tool_call` rows in
14 hours (18 Gmail reads across two mailboxes, then two `sheets_get_spreadsheet`
calls refused `sheets_not_exposed` with approval links — the normal Sheets
gate). Five minutes after the Grok install the same window shows a Cursor
attempt: six tokenless discovery rows, no OAuth completion, no `initialize`.

Strings as sent (production, verified 2026-09-25 with HogQL over 30 days —
none of them appears on any other client or crawler):

| family | `client_name` | `user_agent` |
|---|---|---|
| Grok | `connectors-manager` (discovery, every initialize, every tool call); `grok-validator` (the add-time validation) | `grok-connectors-manager/0.1.0`; bare `Grok` on one discovery hit |
| Cursor | `Cursor`, `Cursor MCP Availability` | `Cursor/1.0.0`; bare `CursorServer/1.0.0` |

## Which surface

grok.com/connectors → New Connector → Custom (Bring Your Own MCP), not the
xAI plugin-marketplace PR (still open) and not the Cursor Marketplace
(application pending; Cursor's strings are distinct and were seen separately):

- the UA names Grok's connectors manager, and Grok Build (a CLI) would
  present differently and initialize once per process;
- 21 initializes for 20 tool calls is the hosted-client pattern (claude.ai
  re-handshakes per call the same way);
- the add-time `grok-validator` handshake is a server-side validation step,
  which a catalog install does not have.

The §7 note of 2026-09-16 that grok.com custom connectors are Business /
Enterprise admin-only was wrong: the 09-24 account is a consumer address, and
third-party write-ups place BYO-MCP on SuperGrok. Corrected in
`docs/growth-channels.md`.

## Problem

`classifyMcpClient` knew Anthropic products, FGAC's probes and crawlers.
Grok's rows came out `client_class = 'direct'` with no signal — the column
monitoring 7.21e reads as "a named client the classifier does not know, or a
real client that broke" — and `grok-validator` was mis-classed `scanner` via
`keyword:validator`. The per-product split (PR #162's 7.31 expression) had
no Grok row, so the daily review's per-product table would show the raw
`connectors-manager` string or nothing.

## Changes

1. `src/lib/mcpClientSignals.ts` — `PRODUCT_CLIENTS`: a third-party product
   layer, checked after `internal` and `claude` and before every scanner
   rule. Matches stay `client_class = 'direct'` (7.5 counts Anthropic
   products only) with `client_class_signal = 'product:grok'` /
   `'product:cursor'`. Names whole and case-insensitive; a UA entry ending
   in `/` is a prefix, otherwise exact (so bare `Grok` matches and a
   hypothetical `GrokBot/` still reaches the vocabulary).
2. `scripts/test-mcp-client-class.ts` — 13 pinned cases: every observed
   string, `grok-validator` beating `keyword:validator`, product never
   outranking a Claude or internal UA, never `claude`.
3. `docs/growth-channels.md` — ledger rows (grok.com custom connector
   first install; Cursor attempt on the Marketplace row; PR #766 stays
   submitted), the client-family table under Attribution, the §7 correction.
4. `docs/monitoring.md` — section-1 row for the signal, `product` column in
   7.21e, new 7.21f (product expression with the Grok and Cursor arms,
   weekly per-product split 7.21f-a, per-product install funnel 7.21f-b).
   PR #162's 7.31 expression is the same `multiIf` minus the two arms; the
   PR that merges second adds them there.
5. `docs/analytics.md` — property notes on `mcp_auth_attempt` and
   `connector_install_started`.
6. PostHog annotation 460432 "First Grok install (connectors-manager)" at
   2026-09-24T18:04Z, project 343912 (created via the connector, which does
   have annotation write).

## Validation

- `npx tsx scripts/test-mcp-client-class.ts`: all checks pass (the 13 new
  ones included). `tsc --noEmit` reports only the pre-existing missing
  `happy-dom` / `posthog-node` modules in this worktree's partial
  `node_modules`, nothing in the changed files.
- HogQL over 30 days: the new match strings hit only the 2026-09-24 Grok and
  Cursor rows.
- After deploy: 7.21f-b shows `grok` on the next Grok handshake; 7.21e's
  `unlabelled` column no longer grows with Grok traffic.

## Not done here

- The daily review task file (`~/.claude/scheduled-tasks/fgac-user-behavior-review/SKILL.md`)
  is Ken's to edit; the hand-back gives the exact line for step 5 of
  DISTRIBUTION LISTINGS.
