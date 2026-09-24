# Argument-name tolerance for MCP tool calls — aliases before validation, guided refusals after — v1

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

## Validation

- Local: `npm run mcp:lint`, `tsc --noEmit`, eslint clean. Dev-server end-to-end
  (real bearer, curl) and preview: recorded in v2 with the observed texts and the
  PostHog rows (development / preview environment).

## After

Compare in the next review: `mcp_input_validation_failed` by tool per week
(guided vs legacy) against 75 / 18, and `$mcp_tool_call` rows with
`arg_alias_count > 0` — the friction that moved from the first table to the
second. Queries in 7.10a.
