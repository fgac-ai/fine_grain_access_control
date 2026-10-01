# `client_name` on tool calls: the directory inspector's name sticks to every call

Branch: `claude/angry-haibt-7bf8a3` — revision 1 (2026-09-24)

## Finding (production PostHog, project FGAC.ai)

`client_name` on `$mcp_tool_call` is copied from the agent connection row, and
the row kept the first `initialize` name it ever saw. For claude.ai users who
connect through the connector directory that first handshake is the
directory's own inspection, named `Anthropic/Toolbox`; the user's real client
(`Anthropic/ClaudeAI`) handshakes seconds later and never got to rename the
row.

| `client_name` on `$mcp_tool_call`, week of 2026-09-14 | user agent | calls | callers |
| --- | --- | --- | --- |
| Anthropic/Toolbox | Claude-User | 12,431 | 65 |
| Anthropic/ClaudeAI | Claude-User | 7,804 | 33 |
| claude-code | Claude-User | 349 | 9 |
| claude-code | claude-code/2.1.27x (CLI) | 358 | 5 |

Established before building (queries in `docs/monitoring.md` 7.32):

1. **Which requests carry the inspector name.** Only the directory's
   connect-time handshake. 137 `Anthropic/Toolbox` initializes from 124
   accounts since the name capture went live (2026-08-28), 114 of them exactly
   once per account; the gap to the account's first `Anthropic/ClaudeAI`
   handshake is under one minute for 114 and under ten for the rest. Daily
   inspector handshakes track the day's `mcp_connection_created` (3/3, 5/5,
   5/5 …). Every registration that reported the inspector also reported
   ClaudeAI; none reported only the inspector. Same `Claude-User` user agent.
2. **No per-session name exists at tool-call time.** The server runs
   stateless streamable HTTP (`createMcpHandler` with no `sessionIdGenerator`,
   a fresh `McpServer` per POST): no Mcp-Session-Id is issued, so clients send
   none, and a `tools/call` body carries no clientInfo. The one per-request
   product signal is the Claude Code CLI's own user agent
   (`claude-code/<version>`), which claude.ai never sends.
3. **How far back.** The first inspector handshake is 2026-08-28T13:50Z and
   the first inspector-labelled tool call 2026-08-29T12:12Z — the day the
   initialize-time name capture (PR #90/#98) reached production. Weekly
   inspector-labelled calls: 110, 2,126, 6,502, 12,431, 18,027 (weeks of
   08-24 → 09-21), growing as directory connections aged in.
4. **A registration is not a product.** 177 registrations reported both
   `Anthropic/ClaudeAI` and `claude-code` handshakes: claude.ai-managed
   connectors are shared with Claude Code. Under "first real name wins" every
   one of those users' calls carried whichever product handshook first.

## Directions, with the evidence that decided them

| direction | decision | why |
| --- | --- | --- |
| stamp from the request's own session | **rejected** | no session exists (finding 2); the only per-request signal is the CLI user agent, which is used |
| treat the inspector as non-authoritative; a later non-inspector handshake overwrites it | **accepted, extended** | fixes every measured case (finding 1); extended to "latest product handshake wins" because of finding 4 — every claude.ai conversation and every Claude Code process opens with a handshake, so the row follows the product in use |
| `first_client_name` + `last_client_name` columns | **rejected** | the "how did they connect" signal already exists as the first `mcp_connection_client_identified` per connection (now labelled `transition = 'first'`) and per handshake on `mcp_client_initialize`; a schema change buys nothing the events do not hold |
| backfill script over production rows | **rejected** | rows self-heal: all 65 mislabelled callers handshook as ClaudeAI in the same week (about 18 times each); rows whose owner never returns generate no tool calls, so nothing stays mislabelled. Historical events are read with the 7.32 fold instead |

## Change

- `src/lib/mcpClientName.ts` (new, pure): `nextConnectionClientName` — an
  unnamed row takes any name, an inspector name yields to the first product
  name, after that the most recent product handshake wins, an inspector never
  downgrades a product; `toolCallClientName` — the CLI user agent overrides the
  row; `classifyClientNameTransition`. Pinned by
  `scripts/test-mcp-client-name.ts` (in `npm run mcp:lint`).
- `src/app/api/mcp/route.ts`: `resolveConnection` renames by the rule and
  fires `mcp_connection_client_identified` on every change with `transition`
  and `previous_client_name`; `requireApproval` stamps `toolCallClientName`.
- `src/lib/connectionTouchMemo.ts`: an initialize skips the DB touch only when
  its name would leave the row unchanged (handshake storms repeat one name, so
  they still skip; the inspector→product handshake and product switches always
  reach the DB). Test updated.
- Docs: `monitoring.md` 7.32 (window, reading rule, three queries),
  `analytics.md` (event row, `client_name` passage), `growth-channels.md`
  (attribution note); the daily analytics-review task folds the inspector
  into claude.ai for pre-deploy weeks.

## Residual error, stated

One row per registration cannot label two products used at the same time.
After the deploy the label is the most recent handshake; a user running
claude.ai and remote Claude Code concurrently on one registration will have
some calls labelled with the other product. The CLI's own calls are exact
(user agent). No signal exists to do better without a stateful transport.

## Verification

- Unit: `npx tsx scripts/test-mcp-client-name.ts`,
  `npx tsx scripts/test-connection-touch-memo.ts`; full `npm run mcp:lint`.
- Preview: a bearer minted on the preview deployment, then the measured
  sequence — `initialize` as `Anthropic/Toolbox`, `initialize` as
  `Anthropic/ClaudeAI`, `tools/call list_accounts` — must produce a
  `$mcp_tool_call` with `client_name = 'Anthropic/ClaudeAI'` and two
  `mcp_connection_client_identified` events (`first`, then
  `inspector_to_product`) in `environment = 'preview'`. Organic traffic does
  not reach a preview, so the 7-day production table cannot be re-run there;
  7.32a is the production check a week after the deploy.
