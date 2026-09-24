# Argument-name tolerance for MCP tool calls — aliases before validation, guided refusals after — v2

Branch `claude/magical-liskov-2f26f1`, 2026-09-22/23. Repo is public: no customer
ids, emails, keys, or file ids appear here — counts only.

## Problem

The MCP SDK validates `tools/call` arguments against each tool's Zod shape before
any FGAC code runs. In the week to 2026-09-22 that refusal reached about one in six
of the people who called a tool, and the decoded rows (PR #151's field capture)
say why: the agent knew what it wanted and spelled the argument differently.

| tool | what the schema wanted | what agents sent (keys only) |
| --- | --- | --- |
| `sheets_read_range`, `sheets_get_spreadsheet` | `spreadsheetId` | `spreadsheet_id` |
| `gmail_read` | `messageId` | `message_id`, `id`, `query` |
| `google_api_get`, `google_api_modify` | `path` | `url`, `uri`, `api_path` |
| `request_access` | `type` (+ `spreadsheetId` …) | `resource_type` + `resource_id`, `fileId` |
| `sheets_update_range` | `values` as an array | a JSON-encoded string |

Zod strips unknown keys silently, so the SDK's answer named only the canonical key
it did not find — "expected string, received undefined" — inside a pretty-printed
JSON issue array, with no mention of the key that WAS sent. Agents retried blind:
one person sent the same rejected `sheets_update_range` shape 15 times.

## Established before any code (2026-09-23)

1. **What the agent literally sees.** Driving the installed SDK
   (`@modelcontextprotocol/sdk` 1.26.0, Zod 4.3.6) with the route's own shape over
   `InMemoryTransport`, `sheets_read_range {spreadsheet_id, range}` returns an
   `isError` result whose text is exactly

   ```
   MCP error -32602: Input validation error: Invalid arguments for tool sheets_read_range: [
     {
       "expected": "string",
       "code": "invalid_type",
       "path": [
         "spreadsheetId"
       ],
       "message": "Invalid input: expected string, received undefined"
     }
   ]
   ```

   and the production `message` prop carries that prefix byte for byte. The SDK
   offers no hook on it: `validateToolInput` throws
   `McpError(InvalidParams, ZodError.message)` and `getParseErrorMessage` returns
   `error.message` unconditionally. `mcp-handler` 1.1.0 builds a fresh `McpServer`
   per request, so a registration-time override cannot see the request either.
   The only place both the request and the response are ours is the transport
   wrapper (`withTransportObservability`) — that decided direction A + B below.
2. **The rows with no `first_issue_path`.** All 46 such rows in the 8-day window
   are dated 2026-09-15 15:17Z → 2026-09-18 14:10Z, before PR #151 went live
   (2026-09-19 00:40Z); every decoded row since has a field. Not a capture gap —
   recorded in runbook 7.10a as a query bound.
3. **`request_access` `type` `invalid_value`.** Same class: the agent sent
   `resource_type` / `resource_id` / `fileId` and no `type` at all — Zod reports an
   enum on `undefined` as `invalid_value` listing the allowed values. After the
   alias `resource_type → type` the VALUE is still likely wrong (`spreadsheet` vs
   `sheets_read`), so the guided text must name the enum and the per-kind id key.
4. **Baseline re-verified** (HogQL, project 343912, production, five internal
   accounts excluded by person email):

   | window | events | people |
   | --- | --- | --- |
   | 2026-09-15 10:00Z → 2026-09-22 10:00Z (fixed) | 75 | 18 |
   | trailing 7 d at 2026-09-23 01:32Z | 77 | 20 |

   The brief's 92 / 20 was computed with a different exclusion; the fixed-window
   figure is the one the next review should compare against.

## Decision

All three directions ship; the evidence supports each for a different slice.

- **A — alias normalisation before validation** (`src/lib/mcpArgumentGuidance.ts`
  `normalizeToolArguments`, applied by `prepareToolCall` in `route.ts`). Per
  canonical key, an explicit alias list (measured spellings plus obvious
  neighbours), then a snake_case → camelCase and case-insensitive fallback. A
  bare `id` is mapped only when the tool has exactly one `…Id` argument
  (`request_access` has three → left alone). A canonical key the agent did send
  is never overwritten. Hits ride on `$mcp_tool_call` as `arg_aliases`,
  `arg_alias_targets`, `arg_alias_count` (request-scoped `AsyncLocalStorage` in
  `toolCallContext.ts`, since the per-call bag is created after the SDK has
  validated). `canonicalizeGoogleApiPath` additionally reduces a full
  `*.googleapis.com` URL to its API path, so `url` → `path` carries a working
  value (other hosts are left for the classifier to refuse).
- **B — guided refusal** (`describeArgumentFailure`, `rewriteValidationFailureBody`).
  `prepareToolCall` pre-validates the normalised arguments with the same Zod
  object the SDK will use; when that fails, the SDK's response (a few hundred
  bytes) is buffered, the `-32602` frame's text is replaced with one paragraph —
  the missing / wrong argument with its expected type or enum values and its
  description, the keys the agent sent that the tool does not have (with a
  wrong-tool hint where one applies: `query` on `gmail_read` → `gmail_list`,
  `fileId` / `resource_id` on `request_access` → the per-kind id key), and the
  tool's exact argument list with required/optional. The `-32602` code stays in
  the text; argument VALUES are never echoed. The event is captured from the Zod
  issues directly (same `first_issue_*` props as the tee) with `guided: true` and
  the alias props; the rewritten text no longer matches the tee's regex, so
  nothing double-counts. The SDK stays the framing authority (SSE / JSON,
  headers) — only the text inside the frame changes.
- **C — descriptions** state the exact argument names in prose for the tools in
  the table (`gmail_read`, `sheets_get_spreadsheet`, `sheets_read_range`,
  `sheets_update_range`, `docs_read_document`, `request_access` with its seven
  `type` values). `google_api_get` / `google_api_modify` sit at the lint's 1500
  char cap and already describe `path` inline; A + B cover them.

Not done, on purpose: no value coercion beyond the URL strip (a JSON-encoded
`values` string is answered with the guided text naming the description's "pass a
real JSON array", not parsed on the agent's behalf); batches (JSON-RPC arrays)
and unknown tools are left to the SDK as before.

## Shape registry

`registerFgacTools` (the former inline `createMcpHandler` callback) is also run
once at module load against a stub server whose `registerTool` records each
tool's `inputSchema` into `TOOL_INPUT_SHAPES` / `TOOL_INPUT_OBJECTS`. The
transport wrapper reads those maps; the advertised `tools/list` schema is
untouched. A follow-up could move the shapes into a pure module next to
`toolDefs.ts` so `scripts/test-argument-guidance.ts` drives the real ones
instead of copies.

## Tests and docs

- `scripts/test-argument-guidance.ts` (in `npm run mcp:lint`): aliases for every
  production shape, the real SDK accepting the normalised call and refusing the
  raw one with exactly the text the rewrite keys on, the rewrite on SSE and JSON
  bodies, the tee no longer matching, and the paragraph's content (names the
  missing key and the sent keys, lists the arguments, never a value).
- `scripts/test-google-api-policy.ts`: googleapis.com origins stripped, other
  hosts and look-alikes not.
- QA: capability 09 A13 (aliased calls succeed, `arg_aliases` recorded), 15 A10
  (the `resource_type` / `fileId` shapes get the named-key paragraph, no link
  minted), 16 A29 (both measurable; A26 amended). Hosted-MCP runbook section
  "Argument tolerance" with the curl blocks.
- Runbook `monitoring.md` 7.10a: the pre-#151 bound, the baseline (75 / 18), the
  weekly decline query split guided / legacy, and the alias-hit query.
- `analytics.md`: `$mcp_tool_call` alias props; `mcp_input_validation_failed`
  `guided` and the message change.

## Validation (v2, 2026-09-24)

- Static: `npm run mcp:lint` (incl. `test-argument-guidance.ts`), `tsc --noEmit`,
  eslint — clean, before and after merging `origin/main` (PR #159, migration 0017).
- **Local dev server** (dev Clerk, fresh isolated Neon branch, real bearer minted
  by the QA setup runner via DCR + PKCE + the built-in browser as USER_A; every
  call a raw `tools/call` POST): 11 / 11.
- **Preview** (PR #160, commit `cf465aa`,
  https://fine-grain-access-control-ikttaiku9-kenyesh-gmailcoms-projects.vercel.app,
  fresh DCR client, same path): 11 / 11, response texts byte-identical to local
  except the approval-link host.

| call | shape sent | observed |
| --- | --- | --- |
| A | `gmail_list {q, max}` | message ids (alias `q` → `query`) |
| B / C | `gmail_read {id}` / `{message_id, format}` | full message / metadata |
| D | `google_api_get {url: https://gmail.googleapis.com/gmail/v1/users/me/labels}` | 25 labels (alias + URL strip) |
| E | `sheets_read_range {spreadsheet_id, range}` | FGAC's own not-exposed denial with approval link — reached the handler |
| F | `{spreadsheetId, spreadsheet_id: junk, range}` | identical to E; `junk` nowhere — canonical key kept |
| G / H | `request_access {resource_type, resource_id, resource_name}` / `{fileId}` | one guided paragraph naming `type`'s seven values and the per-kind id keys; no JSON, no values echoed; no link minted |
| I | `gmail_read {query}` | guided: names `messageId`, points at `gmail_list` |
| J | `sheets_update_range` with `values` as a string | guided: "must be array of arrays (rows of cells), not string" + the description |
| K | `gmail_read {messageId}` (control) | identical to B |

Every response was `200 text/event-stream` with the SDK's SSE framing (the
rewrite changed only the frame's text). PostHog, `environment = development`
and `preview`, within the run windows: each aliased call is a `$mcp_tool_call`
row with `arg_aliases` / `arg_alias_targets` / `arg_alias_count` (the control
and F carry none); G, H, I, J are `mcp_input_validation_failed` rows with
`guided: true`, the expected `first_issue_path` / `first_issue_code` /
`sent_keys`, and `arg_aliases: ['resource_type', 'resource_name']` on G — the
capability 16 A29 expectations verbatim. No double-counting by the tee.

Runner observations worth keeping: connections auto-approve into the Default
Profile on both tiers, so no dashboard step was needed; the built-in pane can
hold only one Clerk session at a time (the runner signed USER_B out first);
no `x-mcp-session-id` header on stateless `tools/call` without `initialize`.

## After

Compare in the next review: `mcp_input_validation_failed` by tool per week
(guided vs legacy) against 75 / 18, and `$mcp_tool_call` rows with
`arg_alias_count > 0` — the friction that moved from the first table to the
second. Queries in 7.10a.
