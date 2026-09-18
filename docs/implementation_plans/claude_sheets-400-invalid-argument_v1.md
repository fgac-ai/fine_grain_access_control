# Google 400 INVALID_ARGUMENT on Sheets/Docs tools — Implementation Plan (v1)

**Branch**: `claude/sheets-400-invalid-argument`
**Status**: Implemented on the branch; unit tests green; local/preview QA pending.
**Pattern source**: the denial-copy module (`src/lib/denialCopy.ts`) and the
cross-mailbox 404 change (monitoring 7.23) — pure copy modules pinned by a
script in `mcp:lint`, assembled by the route.

## 0. Why now

PostHog `$mcp_tool_call`, production, external users, 7 d to 2026-09-18
(re-verified this session with the same HogQL pass as the finding):

| tool | 400s | people | files |
| --- | --- | --- | --- |
| `sheets_update_range` | 29 | 9 | 11 |
| `sheets_read_range` | 27 | 11 | 14 |
| `sheets_edit` | 9 | 8 | 8 |
| `sheets_append_rows` | 7 | 2 | 3 |
| `docs_read_document` | 7 | 1 | 2 |
| `docs_edit` | 6 | 3 | 4 |
| `google_api_modify` | 6 | 3 | 2 |
| `google_api_get` | 3 | 3 | 3 |

`error_status=400`, `error_reason=INVALID_ARGUMENT` — the largest
tool-error class of the week. The route's text for it was
`❌ Google API error (400): <Google's message>.` with no remedy and no stop
line, while 401/403/404 each had tailored guidance.

## 1. What was established (do-not-assume items)

**Q1 — what Google actually says.** The events do not carry the message, and
the route does not log it, so it was reproduced directly against Google
(dev GCP project, the QA account's Clerk-issued token, the standing fixture
sheet and doc; every probe fails validation before any write). The texts,
now the fixtures in `scripts/test-google-bad-request-copy.ts`:

| shape | Google's message |
| --- | --- |
| tab does not exist / bad A1 | `Unable to parse range: 'Data Tab'!A1:C10` |
| past the grid (writes only; reads clip to 200) | `Range (Sheet1!A100000) exceeds grid limits. Max rows: 1000, max columns: 26` |
| values wider/taller than range | `Requested writing within range [Sheet1!A1:B1], but tried writing to column [C]` / `… row [2]` |
| values not a 2-D array of scalars | `Invalid value at 'data.values[0]' (…ListValue), "x"` / `Invalid values[3][0]: list_value …` |
| batchUpdate request rejected | `Invalid requests[0].repeatCell: At least one field must be listed in 'fields'…`, `Unknown name "x" at 'requests[0]'`, `Invalid requests[1].deleteContentRange: …`, `Invalid requests[0].insertText: Index N must be less than the end index of the referenced segment, M.` |
| bad `fields` mask (Docs GET, Sheets GET) | message is the generic **`Request contains an invalid argument.`**; the cause — `Error expanding 'fields' parameter. Cannot find matching fields for path 'content'.` — is only in `error.details[].fieldViolations[].description`, which the route discarded |

The event prop `response_chars` (text length) dates each production row to
one of these: the route prefix + trailing period is 27 chars, so the org
sign-up user's six `sheets_append_rows` 400s at 56 chars are exactly
`Unable to parse range: ` + a 6-char range — `Sheet1` — and the one at 60
chars is `Sheet1!A:D`; the single docs user's seven `docs_read_document`
400s at 63 chars are exactly the generic 36-char message, i.e. the agent was
shown no cause at all and guessed masks until one worked.

**Q2 — bad ranges vs bad bodies.** Both, split by tool: `sheets_read_range`
and `sheets_append_rows` 400s are range parses (the only 400 a values GET can
produce; appends of a guessed tab name); `sheets_update_range` 400s are
body/range shape (67–128-char details match the overflow / grid / shape
texts, never the 29-char parse); `sheets_edit` / `docs_edit` are request-index
rejections; `docs_read_document` is the `fields` mask. The fix therefore has
one generic layer (violations + STOP) and per-kind remedies, not one message.

**Q3 — did the org sign-up user's approvals work?** Yes. Their timeline
(09-16 17:49 → 09-17 07:50 ET): three `rule_saved` for three spreadsheets
via the Picker; every later 400 was on a spreadsheet whose rule had been
saved minutes earlier, and each was followed by a **success on the same
spreadsheet** 4–13 s later — after a `sheets_get_spreadsheet` read in four
of six cases. Each 400 sat right after an `mcp_client_initialize`: a new
conversation, the same guessed `Sheet1`, the same recovery. The "12 mints in
8 s" were twelve *different* unexposed spreadsheets the agent enumerated in
one turn (7.22's batch signature), not a retry loop. The approval funnel is
not the problem here; the tab name is.

Across all external users, every (person, file) with a 400 also had
successes on that file (e.g. 11 read-range 400s against 340 successes on one
heavy user's sheet), and the call after a 400 was a success on the same file
within 1–21 s in the large majority of cases. Two exceptions worth the STOP
line: a scripted writer that sent an identical `sheets_update_range` payload
three times at 1-s cadence, and one person's 2-then-success cadence.

## 2. Design decisions

### D1 — One pure module, assembled at two layers
`src/lib/googleBadRequestCopy.ts` holds the classifier
(`classifyGoogleBadRequest` → `range_parse` / `grid_limits` /
`values_overflow` / `values_shape` / `request_index` / `fields_mask` /
`unknown`, plus the 0-based `requestIndex`), the `fieldViolations`
extractor, the merged detail, the per-kind guidance, and `renderBadRequest`.
`googleFetch` classifies every 400, stamps `bad_request_kind` /
`bad_request_index`, and renders family-aware text (family from the URL
host: sheets / docs / slides / other), so raw `google_api_*` and comment
calls get the generic improvement for free. The sheets typed tools'
`sheetsErrorResult` re-renders with the tab list on `range_parse` /
`grid_limits`.

### D2 — The tab list is fetched only after a range 400
One `GET spreadsheets/{id}?fields=sheets.properties(title,gridProperties)`
per range-400. It is already permitted (FGAC's rule check passed and the
token just worked) and replaces the agent's own `sheets_get_spreadsheet`
round trip. Best-effort: a failed lookup leaves the pointer at
`sheets_get_spreadsheet`; `sheet_tabs_listed` counts how often the list was
shown (0 = lookup failed). No lookup on every call — only on the failure.

### D3 — Outcome stays `error`
A 400 is a real tool error, not a policy refusal; `isError` and the ❌ prefix
are unchanged so the directory error-rate math stays honest (contrast the 🚫
grant-recovery branch). The change is measured by the count falling, not by
reclassification.

### D4 — Prevention in the parameter descriptions
The three `range` descriptions said `(e.g. 'Sheet1'!A1:D20 or 'Sheet1')` —
literally the guess the data shows. They now state the quoting rule, that the
range must cover `values`, and that tab names come from
`sheets_get_spreadsheet` rather than assuming `'Sheet1'`. Tool descriptions
(`toolDefs.ts`) are untouched, so the directory listing is unchanged.

### D5 — Google's words stay first; guidance is appended
Same invariant as `denialCopy.ts`: the agent quotes Google's sentence to the
user; the remedy and the STOP line follow it and never replace it.

## 3. Files

- `src/lib/googleBadRequestCopy.ts` — new (D1).
- `scripts/test-google-bad-request-copy.ts` — new; reproduced texts as
  fixtures; added to `mcp:lint` in `package.json`.
- `src/app/api/mcp/route.ts` — `describeGoogleError` 400 branch;
  `googleFetch` classification + props + family; `GoogleFetchResult.badRequest`;
  `sheetsErrorResult` (async, tab lookup) + `listSheetTabs`; four sheets
  call sites pass the token context; three `range` descriptions.
- `docs/monitoring.md` §7.28 — before/after measure (per-tool daily 400s,
  kind mix, unchanged-retry bursts) with the baseline table.
- `docs/analytics.md` — `bad_request_kind`, `bad_request_index`,
  `sheet_tabs_listed` on `$mcp_tool_call`.
- `docs/QA_Acceptance_Test/capabilities/09_sheets_management.md` A12,
  `19_docs_management.md` A15.

## 4. Testing & rollout

- `npm run mcp:lint` (includes the new script), `tsc --noEmit`, eslint.
- Local QA (runner, this worktree's dev server, USER_A, fixture sheet/doc):
  capability 09 A12 and 19 A15 — the exact texts and event props.
- `/deploy-pr-preview`, then the same two assertions against the preview.
- After merge: monitoring 7.28a per tool for the 7 d after deploy vs the
  table in §0; 7.28c should be empty; 7.28b `unknown` stays a small tail.

## 5. Risks

- **A Google text the classifier has not seen** lands as `unknown`: the agent
  still gets the message, the violations, and the STOP line — strictly more
  than before. 7.28b surfaces it; the fix is one fixture + one regex.
- **The tab lookup adds one Google call on range 400s only.** It cannot
  loop: it runs once per failing tool call and its own failure is swallowed.
- **`values_overflow` on `sheets_update_range` is atomic at Google** (nothing
  written), so telling the agent to widen the range and resend is safe; for
  batchUpdate the text says none of the requests applied, which is Google's
  documented behaviour and matched every reproduction.
