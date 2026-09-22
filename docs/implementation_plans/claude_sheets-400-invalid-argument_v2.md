# Google 400 INVALID_ARGUMENT on Sheets/Docs tools — Implementation Plan (v2)

**Branch**: `claude/sheets-400-invalid-argument` · **PR**: #155
**Status**: Implemented; local QA complete (09 A12, 19 A15); preview build Ready.
**Supersedes**: `claude_sheets-400-invalid-argument_v1.md` (sections 0–5 unchanged
except where noted below; this revision records the QA state and two follow-ups).

## 6. Local QA (2026-09-18, this worktree's dev server, USER_A, built-in browser only)

Runner: `qa-setup-driver`. Setup: both fixtures exposed at Read & Write on the
Default Profile via the app-API seam (`POST /api/rules/grant-sheets-access` /
`grant-docs-access`, capability 09 harness note); a local MCP bearer minted by
DCR + PKCE; every call over JSON-RPC to `/api/mcp`.

| assertion | case | isError | verdict |
| --- | --- | --- | --- |
| 09 A12 | (a) read_range, tab that does not exist | true | pass — tab list, `'Sheet1'!A1:C10` example, STOP |
| 09 A12 | (b) append_rows, tab that does not exist | true | pass — same shape |
| 09 A12 | (c) update_range, values wider than range | true | pass — widen/trim guidance |
| 09 A12 | (d) sheets_edit, repeatCell without `fields` | true | pass — `requests[0]`, atomic, `fields`, `sheetId` |
| 09 A12 | (e) update_range, bare-scalar `values` | — | **assertion was wrong**: the tool's `array of arrays` schema rejects `["x"]` with `-32602` before FGAC runs; no Google call, no event. Re-run with a nested cell `[[["x"]]]`: pass — `values_shape` text |
| 19 A15 | (a) docs_read_document `fields=content` | true | pass — the hidden `Cannot find matching fields for path 'content'` cause is in the text |
| 19 A15 | (b) docs_edit index past end | true | pass — `requests[0]`, re-read with docs_read_document |
| 19 A15 | (c) docs_edit second request inverted | true | pass — `requests[1]` |

Analytics (`environment=development`, within ~1 min): every row `outcome=error`,
`error_status=400`, `error_reason=INVALID_ARGUMENT`, no `denial_code`;
`bad_request_kind` = `range_parse`, `range_parse`, `values_overflow`,
`request_index` (index 0), `values_shape`, `fields_mask`, `request_index`
(index 0), `request_index` (index 1); `sheet_tabs_listed=1` on (a) and (b)
only. Read-backs: the fixture sheet's `A1:B1` stayed empty and the doc body
was unchanged (batchUpdate is atomic, as the text claims).

## 7. Changes after local QA

- **09 A12 (e)** now specifies the nested-cell payload and records that a bare
  scalar is a schema rejection (`-32602`), not a Google 400.
- **Whitespace in Google's protobuf dump.** The `values_shape` message embeds a
  multi-line `list_value { … }` dump; `badRequestDetail` now collapses runs of
  whitespace so the agent-facing sentence stays on one line (pinned in the
  test script).

## 8. Preview

Build for the PR commit deployed Ready (~50 s). Home 200, `/api/mcp` 401
unauthenticated, server card lists 21 tools. The preview-side tool-text check
needed the two fixtures exposed on the preview's Neon branch (a copy of
production, where only one spreadsheet is exposed for USER_A); writing rules
on the preview origin was permission-gated for the runner, so the preview
probe is limited to the spreadsheet already exposed there (result recorded in
the PR hand-back). The code path is identical to the locally verified one.
