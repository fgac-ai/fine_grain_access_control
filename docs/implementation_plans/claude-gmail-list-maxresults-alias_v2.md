# gmail_list `maxResults` alias + silently-dropped-key telemetry — v2

> v2: adds the live local validation results (no design change from v1).

Branch `claude/gmail-list-maxresults-alias`, from `main` @ 8ac8e16.

## Problem

`gmail_list` takes `max` (optional number) and maps it to Gmail's
`maxResults`. On 2026-09-30 a QA runner called it with `maxResults: 2`. Zod
stripped the unknown key, the call validated, and the tool returned the
default 10. The argument-tolerance layer (PR #160, `mcpArgumentGuidance.ts`)
only had aliases for keys measured from *validation failures*. A wrong name
for an optional argument never fails, so it never showed up there.

## What production data says (PostHog, 30 d to 2026-09-30)

| event / env | calls | people | aliased | aliases seen |
| --- | --- | --- | --- | --- |
| `$mcp_tool_call` gmail_list, production | 9,940 | 91 | 30 | `q` → `query` |
| `$mcp_tool_call` gmail_list, development | 84 | 2 | 1 | `q` |
| `$mcp_tool_call` gmail_list, preview | 57 | 2 | 1 | `q` |
| `mcp_input_validation_failed` gmail_list | 0 | 0 | — | — |

- How often agents send `maxResults` / `max_results` / `limit` to
  `gmail_list` **cannot be measured from existing telemetry**.
  `$mcp_tool_call` never recorded the keys sent, and the stripped key causes
  no failure row. That gap is the main finding.
- Agents *do* use Gmail-API spellings on this tool: 30 calls sent `q` (the
  API's name) for `query`. `maxResults` is the API's name for `max`, so the
  same habit is likely. That is inference, not a measurement.
- Across all tools, refused calls' `sent_keys` (30 d, production) show other
  optional-but-ignored keys sitting beside the real failure:
  `sheets_get_spreadsheet.include_grid_data` / `ranges`,
  `sheets_update_range.valueInputOption`, `google_api_get.fields`,
  `gmail_read.message_ids` / `messageIds` (batch reads). These rows only exist
  because something *else* failed. The same keys on successful calls are
  invisible.

## Changes

1. **Alias** — `ARGUMENT_ALIASES.max = ['maxResults', 'max_results', 'limit']`.
   `limit` is safe: `normalizeToolArguments` never moves a key that is
   canonical for the tool (gmail_read / sheets_* own `limit`), and `max`
   exists only on `gmail_list`. A canonical `max` the agent did send always
   wins.
2. **Description** — `max` now reads "Max messages to return (Gmail
   maxResults; default: 10). The parameter is named max.", matching the
   `messageId` wording already used to steer `gmail_read`.
3. **Telemetry for question (3)** — `unknownArgumentKeys()` lists keys left
   after aliasing that the schema does not have. The transport wrapper puts
   them on every `$mcp_tool_call` as `arg_unknown_keys` /
   `arg_unknown_key_count`, through the same request-props store as
   `arg_aliases`. Keys only, never values, ≤10 keys, ≤64 chars each.
4. **Tests** (`scripts/test-argument-guidance.ts`, in `mcp:lint`):
   each spelling → `max`; canonical wins; `q` + `maxResults` together;
   `limit` untouched on `gmail_read`; `maxResults` not invented on tools
   without `max`; `unknownArgumentKeys` caps/truncation; and a real-SDK
   check that the *un-aliased* `maxResults` call is accepted with `max`
   absent (the bug), while the aliased one reaches the handler with `max: 2`.
5. **Docs** — `analytics.md` `$mcp_tool_call` row; `monitoring.md` 7.10a gains
   the "silently dropped keys" query and reading guide.

## Question (3): other tools' silently-stripped keys

Decision: **measure first, alias per key; no strict schemas.**

- Making schemas strict (reject unknown keys) would turn working calls into
  -32602s, including clients that add harmless extra keys. It trades a quiet
  wrong-default for a loud refusal across every tool. Rejected.
- Appending a "you sent X, which this tool ignores" note to successful
  results would change tool output on every such call, with no data yet on
  how often it happens. Deferred until `arg_unknown_keys` shows a key with
  real reach.
- Speculative aliases for the keys above were not added. Most of them name
  a capability the tool lacks (`pageToken` / `fields` / `valueInputOption` /
  batch `messageIds`), not a different spelling. An alias cannot fix that,
  and pretending it can would hide a feature gap. Runbook 7.10a now says
  how to tell the two apart.

Follow-up after a week live: run the 7.10a "silently dropped keys" query.
Promote any key with ≥3 people whose meaning matches an existing argument.
Open a per-tool issue for keys that ask for a missing capability.

## Validation

- `npm run mcp:lint` (full bundle) — exit 0; `tsc --noEmit` — clean;
  `eslint` on changed files — clean.
- Live local check (dev server, isolated Neon branch
  `claude-gmail-list-maxresults-alias`, USER_A, real Gmail, run by a
  qa-setup-driver runner over a freshly minted MCP bearer), 2026-09-30:

  | `gmail_list` args (all with `query: in:inbox`) | messages | expected | `$mcp_tool_call` props (PostHog, env=development) |
  | --- | --- | --- | --- |
  | `maxResults: 2` | 2 | 2 | `arg_aliases ["maxResults"]` → `["max"]` |
  | `max_results: 3` | 3 | 3 | `arg_aliases ["max_results"]` → `["max"]` |
  | `limit: 4` | 4 | 4 | `arg_aliases ["limit"]` → `["max"]` |
  | `max: 5, maxResults: 2` | 5 | 5 | `arg_unknown_keys ["maxResults"]` (canonical won) |
  | `bogusKey: 1` | 10 | 10 | `arg_unknown_keys ["bogusKey"]` |
  | (none) | 10 | 10 | no alias / unknown props |

  All HTTP 200, no isError. Before the fix, the first row returned 10.
