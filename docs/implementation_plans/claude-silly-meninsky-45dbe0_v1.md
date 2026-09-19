# `mcp_input_validation_failed` — decode the rejected argument, then tighten what the data says — v1

Branch `claude/silly-meninsky-45dbe0`, 2026-09-17. Repo is public: no customer ids,
emails, keys, or ids appear here — counts only.

## Problem

The MCP SDK validates `tools/call` arguments against each tool's Zod shape before
FGAC's callback runs. A rejection comes back as a 2xx `isError` tool result with the
text `MCP error -32602: Input validation error: Invalid arguments for tool <name>:
<ZodError.message>`, and never reaches `withToolAnalytics`. Since PR #114 a tee of
the POST response body (in `after()`, so the client is never delayed) captures it as
`mcp_input_validation_failed`.

Measured in PostHog (project 343912, production, internal/QA accounts excluded,
trailing 7 d to 2026-09-17): 112 events, 15 people. By tool: `gmail_read` 38 (8
people), `google_api_modify` 34 (4), `sheets_update_range` 26 (1), `request_access`
6 (3), `google_api_get` 5 (5), `sheets_append_rows` 5, `sheets_read_range` 4,
`sheets_edit` 3, `gmail_send` 2, `sheets_get_spreadsheet` 1, plus one
`unknown_tool` for `gmail_search`. 30 d: `gmail_read` 45 across 10 people.

Every row's `message` ends at `Invalid arguments for tool <name>: [`. The event can
count failures but not say which argument was wrong.

## Established (not assumed)

1. **The -32602 body, end to end.** Verified against the installed SDK
   (`@modelcontextprotocol/sdk` 1.26.0) and Zod 4.3.6 by driving a real
   `McpServer` + `Client` over `InMemoryTransport` with the route's own shapes
   (`scripts/test-validation-failure-capture.ts`):
   - `validateToolInput` → `getParseErrorMessage(error)` returns `error.message`
     when present; Zod 4's `ZodError.message` is `JSON.stringify(issues, null, 2)`
     — a **pretty-printed JSON issue array**.
   - Issue fields: `code`, `path` (array of segments), `message`, and per code:
     `expected` (`invalid_type`), `values` (`invalid_value`, the enum literals),
     `errors` (`invalid_union`, one nested issue list per branch). Zod 4 carries
     **no `received` field**; what arrived is only in the message text
     (`Invalid input: expected string, received undefined`).
   - The transport writes the result as an SSE frame (`event: message\ndata:
     {json}`), so the pretty-printed text is JSON-encoded and its first newline
     becomes the two characters `\n`. The old capture, `[^"\\]{0,300}` after the
     tool name, ends at that backslash — hence `: [` on every row. Our regex, not
     the SDK, was the truncation.
2. **Which field per tool.** Not measurable backwards — no row carries a field.
   From the shapes, the failure modes the SDK text can express:
   - `gmail_read`: `messageId` missing (`id`/`message_id` sent instead — Zod
     strips unknown keys, so this reads as `received undefined`), `format`
     upper-cased (`invalid_value`), `offset`/`limit` as strings.
   - `google_api_modify`: `method` lower-cased or `GET`/`DELETE`
     (`invalid_value`), `body` sent as a bare array (`invalid_union`, both
     branches fail) — the natural mistake for a batchUpdate `requests` array.
   - `sheets_update_range` / `sheets_append_rows`: `values` as a JSON string
     (`received string`) or a flat list (`values.0` received number/string).
   - `request_access`: `type` outside the enum; `resourceName` > 200 chars.
3. **Self-correction vs abandonment (30 d, per person, per tool, next event on
   the same tool after each failure):**

   | tool | next = another validation failure | next = success | note |
   | --- | --- | --- | --- |
   | `gmail_read` | 34 (6 people, ~2 s apart) | 11 (10 people, ~3 s) | every one of the 10 people who failed reached a success at least once — the SDK's message is enough here; the 34 are rapid retries by 6 of them |
   | `google_api_modify` | 21 (1 person, ~14 min apart) | 4 (1 person, later sessions) | one agent repeating the same rejected shape across a long session |
   | `sheets_update_range` | 24 (1 person, ~10 s apart) | 3 (2 people, >1 day later) | same: one person, one shape, no in-session recovery |
   | `sheets_append_rows` | 4 (1 person) | 1 (days later) | same person as above |
   | `google_api_get` | 0 | 8 (4 people) | immediate self-correction |
   | everything else | ≤1 | mostly success within seconds | |

   Every failure in 30 d came from `Claude-User` user agents (claude.ai and
   Claude Code clients). So: **descriptions matter for the two hammering tools;
   for `gmail_read` the win is fewer retries, not rescue.** Which shape the two
   hammering agents sent is exactly what the fixed capture will show.

## Ship

### 1. Capture (accepted)

`src/lib/mcpClientSignals.ts`:
- `parseValidationFailure(body)` — reads the JSON-RPC messages out of the SSE
  frames (or a plain/batch JSON body), finds the `isError` result whose text
  matches the SDK's -32602 formats, and decodes the issue array. Per issue:
  dotted `path` (`values.0`), `code`, `expected` (type, or enum literals joined
  by `|`, or union branch expectations joined), `received` (parsed from the
  message text), `message` (≤200). Non-JSON tails are counted with
  `issues_parsed: false`. Returns undefined for our own `isError` results.
- `validationFailureProps(failure, sentKeys)` — the flat event shape:
  `first_issue_path/code/expected/received/message` scalars (GROUP BY-able),
  `issue_paths`/`issue_codes` arrays (≤10), `issue_count`, `issues_parsed`,
  `sent_keys`/`sent_key_count`, `message` whitespace-collapsed and capped at 300.
- `parseRpcEnvelope` now also records `argumentKeys` — the top-level **keys**
  of `params.arguments` on the tools/call (≤20, names only, never values). This
  is the only way to see `id` vs `messageId`: Zod strips the unknown key before
  reporting. Also present on `unknown_tool` rows.

`src/app/api/mcp/route.ts`: the tee calls the parser; `after()` and the
never-buffer-GET design are unchanged; 300-char cap on free text kept.

Privacy: no argument values reach PostHog. Issue objects from Zod 4 carry no
input (Zod 4 omits `input` unless `reportInput`), `invalid_value.values` are
schema literals, and `sent_keys` are parameter names. The test asserts this.

Test: `scripts/test-validation-failure-capture.ts` (chained into `npm run
mcp:lint`) drives the real SDK so an SDK/Zod format change fails CI rather than
silently reintroducing `issues_parsed: false` rows.

### 2. Descriptions (accepted where the ambiguity is visible from the schema text alone)

Parameter-level `.describe()` text (the 1500-char lint cap applies to the tool
description, not parameters; `gmail_list`'s tool description grew 96 chars and
stays under the cap):

| tool.param | before | after (gist) |
| --- | --- | --- |
| `gmail_read.messageId` | "Gmail message ID" | the `id` of a gmail_list entry, not the threadId; the parameter is named `messageId` |
| `gmail_read.format` | "Response format. "full" (default)…" | lowercase; names all three values |
| `sheets_update_range.values` | "2D array of cell values" | array of rows, each an array of cells, with an example; real JSON array, not a string, not a flat list |
| `sheets_append_rows.values` | "2D array of rows to append" | same, with "one inner array per row, even for a single row" |
| `google_api_modify.method` | "HTTP method (default: POST)" | uppercase POST/PUT/PATCH; GET → google_api_get; DELETE never |
| `google_api_modify.body` | "Request body (JSON object or string)" | object preferred, or pre-serialized string, never a bare array; batchUpdate takes `{"requests":[…]}` |
| `gmail_list` (title + description) | "List Gmail messages" | "Search or list Gmail messages … this is the Gmail search tool" — claims the word the `gmail_search` caller was looking for |

**Rejected: aliases.** Accepting `id` for `messageId`, or parsing a JSON string
into `values`, would make the failures disappear from this event without
telling us whether the descriptions work, and would teach agents a shape that
no other Google connector accepts. If 7.10a shows one alias would absorb most
of a tool's failures after the descriptions ship, that is a separate decision
with numbers attached.

### 3. Docs

- `docs/analytics.md`: event row lists every new property and the pre/post
  2026-09-17 reading of `message`.
- `docs/monitoring.md` 7.10a: "validation failures by tool and field, 7 d",
  with how to read `received undefined` + `sent_keys`, and the self-correction
  finding above.
- `docs/QA_Acceptance_Test/capabilities/16_analytics_events.md` A26: three
  deliberately malformed calls and the expected rows.

## Validation

- Local: `npm run mcp:lint` (38 new checks, all passing), `tsc --noEmit` clean,
  eslint clean on the changed files (`test/testclaw/*.js` has pre-existing
  `require()` errors untouched by this branch).
- Preview (`/deploy-pr-preview`): a runner mints a preview bearer as a QA account
  and fires the A26 calls; the rows are confirmed in PostHog with
  `environment = 'preview'` via HogQL.
- Production: report the per-tool field breakdown (7.10a) once a day of data
  exists after the merge. The PR is the deliverable.

## Open

- Whether the two hammering agents were sending a JSON-string `values` / bare
  `body` array — 7.10a answers it within a day of production traffic.
- `offset`/`limit` as strings across the windowed tools: not addressed in
  descriptions; wait for the field data.
