# Capability: Google Sheets Management (Expose, Discover, Access)

## Overview
Covers the full sheets lifecycle from both sides: the dashboard UX for exposing a
sheet to a profile (Google Picker flows, including the first-time drive.file consent
round-trip), and the agent-side API surface for discovering and reaching exposed
sheets. Written after two field reports: users being detoured to the Accounts page
instead of getting the picker, dropped back with no picker after first-time consent —
and an agent stranded with a sheets rule that carried no spreadsheet id while Drive
listing returned empty.

## Pre-requisites
* `/qa-setup` complete; dev server running; USER_A signed in on the dashboard.
* At least one proxy key (Agent Profile) exists with a known bearer token.
* UI assertions (A1-A4): built-in browser, signed-in session. API assertions
  (A5-A7): curl with the profile's `sk_proxy_` bearer against the proxy endpoints.

## Harness note — automating the Google Picker
The picker modal renders inside a cross-origin `docs.google.com` iframe. The built-in
browser can OPEN it and see it in screenshots (allow ~10s to paint), but its input
events do not route into the iframe — tiles cannot be clicked from this harness
(verified empirically). Two sanctioned ways to cover the post-pick assertions:
1. **App-API seam (default)**: A1/A2 prove the picker opens; for A3/A4, drive the same
   code path the picker callback invokes — `POST /api/rules/grant-sheets-access` (or the
   `exposeSheetsFromPicker` action) as the signed-in user with a known fixture
   spreadsheet id. This is the application's own API, allowed by Database Rule 7; only
   Google's own picker UI (not our code) goes unexercised.
2. **Playwright CDP path (full-fidelity) — CONFIRMED WORKING (2026-07-26)**: the
   Playwright CLI's snapshots expose the picker iframe's contents as frame refs
   (`f<N>e<M>`), tiles are clickable, and a full pick-to-rule flow was executed end to
   end (tile → Select → rule row with Read Only default). Requires the one-time manual
   Google sign-in of the `.playwright_user_data` Chrome profile at the MAIN clone. Use
   for release-level verification of the actual pick interaction, including the
   real first-time drive.file consent round-trip (also verified live).

## Harness note — mutating the fixture file AS the owner (renames, A10)
No Drive UI, Picker, or extra connector is needed to act on a granted file as
USER_A: the signed-in dashboard session can mint the owner's own Google token via
`GET /api/auth/google-picker-token` (`accessToken`; requires `hasDriveFileScope:
true`), and that token's per-file `drive.file` grant covers writes to the granted
fixture. Rename from the page context (keeps the token out of transcripts):

```js
const { accessToken } = await (await fetch('/api/auth/google-picker-token')).json();
await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SID}:batchUpdate`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requests: [{ updateSpreadsheetProperties:
    { properties: { title: NEW_TITLE }, fields: 'title' } }] }),
});
```

This is the real user flow (an owner renaming their file in Drive), not a DB
shortcut, so Database Rule 7 is satisfied. **Always rename back to the fixture
title afterwards** — the Google file is shared by every environment (dev branches,
previews, prod QA), even though `resource_name` write-backs stay in the current
environment's DB branch. Verified end to end on a Vercel preview 2026-08-30.

## Assertions

### A1: "+ Expose a sheet" on a profile opens the Google Picker directly
- On `/dashboard`, select any profile tab and click **+ Expose a sheet** in the
  Google Sheets Rules card.
- **Expected**: The Google Picker modal (`.picker-dialog` with a
  `docs.google.com/picker` iframe) opens on this page. No popover pointing at the
  Accounts page, no navigation, no dead-end message. (If the drive.file grant is
  missing, a redirect to Google consent is acceptable — see A2 for the return leg.)
  Two views (since 2026-09-09): the first is the flat list of every
  spreadsheet the user can open, selected on open and listing files at the
  root WITHOUT a search (the Demo Spreadsheet is visible there); the second is
  a "Shared drives" view (`DocsView.setEnableDrives(true)`, the only way the
  Picker lists shared-drive files — the base `View` never can). A Workspace
  account (USER_B) sees its shared drives under that second view, folders
  are navigable but not selectable, and only spreadsheets can be picked. A
  single drives-enabled view is a regression: it roots the dialog at Shared
  drives and a personal account opens to "No spreadsheets."

### A2: First-time consent round-trip returns to the same page and auto-opens the picker
- Deterministic proxy for the return leg (works without revoking any grant):
  navigate directly to `/dashboard?autoOpenPicker=true&pickerContext=<profileId>`.
- **Expected**: The URL is cleaned (params consumed) AND the Google Picker modal
  opens on `/dashboard` — not a silent landing. Same check on
  `/dashboard/accounts?autoOpenPicker=true` for the Accounts-page flow. The consent
  redirect URL must target the page the flow started on (`location.pathname`), never
  a hardcoded route.

### A3: A sheet picked from a profile is scoped to that profile without narrowing others
- With a sheet exposed from profile P's card, check the rules state (dashboard or
  `GET /api/rules/grant-sheets-access`).
- **Expected**: The new rule carries the spreadsheet's `targetResourceId` and
  `resourceName`, defaults to Read Only, and is assigned to P. Pre-existing global
  sheet rules remain global (picking the same sheet again must NOT restrict it), and
  other profiles' assignments are untouched.

### A4: Accounts-page "Add Google Sheet +" still works and creates a global rule
- On `/dashboard/accounts`, click **Add Google Sheet +**.
- **Expected**: Picker opens directly; a picked sheet appears in the table with its
  ID shown; the rule is global (applies to all profiles).

### A5: get_my_permissions carries the spreadsheet id for sheets rules
- As an agent (MCP `get_my_permissions` with the profile's connection, or the
  equivalent proxy call), inspect the returned rules.
- **Expected**: Every sheets rule includes `spreadsheetId` (the
  `targetResourceId`) and `resourceName` — an agent must be able to go from the rule
  straight to a Sheets API call without asking the user to paste a URL. A sheets
  rule with a null spreadsheet id reaching an agent is a failure.

### A6: get_my_permissions returns only rules applicable to the calling key
- Create a rule assigned ONLY to a different profile, then call
  `get_my_permissions` as this profile.
- **Expected**: The other profile's rule is absent. Global rules and this key's
  rules are present, each labeled with its scope (`global` / `this-key`). The
  owner's full rule set leaking to every agent is a failure.

### A8: Write succeeds with Read & Write permission — and only then
- Set the exposed sheet's FGAC permission to **Read & Write** (dashboard dropdown, or
  the app's own `grant-sheets-access` API as the signed-in user), then write a
  QA-tagged row via MCP (`sheets_append_rows` or `sheets_update_range`) AND via the
  raw API proxy (PUT/POST on the Sheets values endpoint).
- **Expected**: Both writes succeed against the real Google Sheet, and the written
  values read back correctly. Cleanup is part of the assertion: restore the
  permission to **Read Only** and confirm the same write is blocked again with the
  Read-Only error — proving the permission toggle is live in both directions.

### A9: sheets_edit applies batchUpdate under the same write matrix (2026-08-23 reshape)
- With the exposed sheet at **Read Only**: call `sheets_edit` with a harmless
  formatting request (e.g. `repeatCell` setting a background color on one QA cell).
- **Expected**: 🚫 denied with `denial_code=sheets_read_only` and a `sheets_write`
  approval link. After flipping to **Read & Write**: the same `sheets_edit` call
  succeeds against the real sheet (Google returns the batchUpdate reply), and an
  `addSheet` request creates a QA-tagged tab visible via `sheets_get_spreadsheet`.
  Cleanup: delete the QA tab (`deleteSheet` request) and restore **Read Only**.
  The success response of a values write (`sheets_update_range`) carries an
  `fgac_hint` naming `sheets_edit` (capability 10 A10 cross-check).

### A10: Drive renames surface live in the rule list and write back to FGAC
- With the Demo Spreadsheet exposed and its Google grant healthy
  (`/api/rules/verify-sheets-access` → `state: "ok"`), rename the file at Google
  as the owner (see the "mutating the fixture file AS the owner" harness note —
  picker-token + `updateSpreadsheetProperties`; no FGAC edit of any kind), then
  reload the profile's dashboard page.
- **Expected**: (a) the rule row shows the NEW title without any FGAC-side edit —
  the verify endpoint's `grants` map carries `title` and the UI prefers it over
  the stored `resource_name`; (b) the verify call also writes the new title back:
  `/api/rules/grant-sheets-access` (and `get_my_permissions`) now return the new
  name as `resourceName`; (c) a grant in `missing`/`unknown` state changes NO
  stored name (write-back only runs on `state: "ok"` with a title). Rename the
  fixture back to `Demo Spreadsheet` and confirm both the row and the stored name
  restore — the restore is itself a second write-back check.
- **Regression**: 2026-08-30 support report — renames in Drive never propagated;
  the live title was fetched on every dashboard load and discarded client-side,
  so the rule list, `get_my_permissions`, and approval-page copy showed the
  grant-time name forever.

### A11: Malformed spreadsheet ids are refused without an approval link; URLs are normalized
- Call `sheets_get_spreadsheet` (and `request_access` with `type=sheets_read`)
  with (a) `<unexposed sheet id>/edit#gid=0`, (b) the full
  `https://docs.google.com/spreadsheets/d/<unexposed sheet id>/edit?usp=sharing`
  URL, (c) a junk value such as `Q3 Budget` or `abc123`, and (d) a Docs URL
  (`https://docs.google.com/document/d/<fixture doc id>/edit`). Also
  `google_api_get` with path `v4/spreadsheets/abc123`.
- **Expected** (drive-file-id hardening, 2026-09-09): (a) and (b) are denied
  exactly as the bare id is — `denial_code=sheets_not_exposed` and the SAME
  deterministic approval link the bare id produces (`r=<id>`, never
  `r=<id>%2Fedit`), the tool-call event carrying `file_id_input=suffixed` /
  `url` and `file_id=<bare id>`. (c) and the raw-path variant are 🚫 with
  `denial_code=file_id_malformed`, the text naming the expected shape (20–80
  chars of `A-Za-z0-9_-`), and NO link: no `approval_link_minted`, no
  `approval_request_id`, no new `approval_requests` row. (d) is 🚫
  `file_id_wrong_kind` naming `docs_read_document` and the extracted id, also
  link-free. A link minted for a value Google can never verify is the failure
  this guards against.

### A12: Google 400s on sheets tools name the cause, list the tabs, and say STOP (2026-09-18)
- On the exposed fixture sheet at **Read & Write**, five calls that Google
  rejects as malformed (none of them writes anything — Google validates
  before applying):
  (a) `sheets_read_range` with range `'No Such Tab'!A1:C3`;
  (b) `sheets_append_rows` with range `No Such Tab` and values `[["x"]]`;
  (c) `sheets_update_range` with range `<real tab>!A1:B1` and values
  `[[1,2,3]]` (values wider than the range);
  (d) `sheets_edit` with requests
  `[{"repeatCell":{"range":{"sheetId":0},"cell":{}}}]` (no `fields` mask);
  (e) `sheets_update_range` with range `<real tab>!A1` and values
  `[[["x"]]]` (a nested cell — passes the tool's `array of arrays` input
  schema, so it reaches Google; a bare `["x"]` never does: the MCP SDK
  rejects it with `-32602 Input validation error` before FGAC's handler
  runs, no Google call and no `$mcp_tool_call` event — verified 2026-09-18).
- **Expected**: every response is `isError` (event `outcome=error`,
  `error_status=400`, `error_reason=INVALID_ARGUMENT`, no `denial_code`, no
  approval link) and its text starts `❌ Google API error (400): ` followed by
  Google's own message. Then, per case: (a) and (b) carry
  `Tabs in this spreadsheet: '<real tab>' (N rows × M cols)`, the example
  `'<real tab>'!A1:C10`, and the words `never assume a tab called 'Sheet1'`;
  (c) says to widen the range or trim `values`; (d) names `requests[0]`,
  says NONE of the requests were applied, and mentions the `fields` mask and
  `sheetId`; (e) says `values` must be a 2-D array of scalar cells, with Google's
  protobuf dump collapsed onto one line. Every
  text ends with the STOP line (`do not retry this call unchanged`). Event
  props: `bad_request_kind` = `range_parse`, `range_parse`,
  `values_overflow`, `request_index` (with `bad_request_index=0`),
  `values_shape` respectively; `sheet_tabs_listed=1` on (a) and (b) only
  (the fixture has one tab). Read `<real tab>!A1:B1` back afterwards: unchanged.
  The pre-change text was Google's message alone, with no remedy and no stop
  (monitoring 7.28 has the production baseline).

### A13: snake_case and synonym argument names are accepted (2026-09-23)
- Through the environment's MCP client, call `sheets_read_range` with
  `{"spreadsheet_id": "<exposed fixture sheet id>", "range": "<tab>!A1:B2"}`
  (the key `spreadsheet_id` in place of `spreadsheetId`), then
  `sheets_get_spreadsheet` with `{"spreadsheet_id": "<same id>"}`, then
  `gmail_list` with `{"q": "is:unread", "max": 1}`.
- **Expected**: every call reaches FGAC and behaves exactly as the
  canonical spelling does — the read returns cell values, the metadata call
  returns the tab list, the list call returns messages (or the same FGAC
  denial the canonical call would produce; never an `isError` result whose
  text starts `MCP error -32602`). Each call's `$mcp_tool_call` event
  carries `arg_aliases` (`['spreadsheet_id']`, `['spreadsheet_id']`,
  `['q']`), `arg_alias_targets` (`['spreadsheetId']`, …) and
  `arg_alias_count: 1`; a call made with the canonical names carries none
  of the three. A canonical key the agent DID send is never overwritten:
  `{"spreadsheetId": "<exposed id>", "spreadsheet_id": "junk", "range":
  "<tab>!A1:B2"}` reads the exposed sheet.
- **Regression guard**: a `-32602` result for `spreadsheet_id` is the
  pre-2026-09-23 behaviour returning — the transport-layer alias pass
  (`prepareToolCall` in `route.ts`) has stopped running before the SDK.

### A7: Drive listing is Google-native; per-file Drive access respects sheet rules
- `GET {proxy}/drive/v3/files` with the profile's bearer token, then
  `GET {proxy}/drive/v3/files/<id>` for (a) an exposed sheet, (b) a sheet with a
  `sheet_block` rule, and (c) an unexposed id.
- **Expected**: The LIST passes through to Google untouched — a well-formed
  `drive#fileList`, even if empty (empty is legitimate `drive.file`-scope behavior for
  picker-granted files; FGAC does not override native discovery — agents get sheet ids
  from `get_my_permissions`, per A5). Per-FILE access is guarded: (a) succeeds, (b) and
  (c) return 403 with the FGAC error text; a write-shaped request (POST/PATCH) on a
  Read-Only sheet also 403s. Drive get/export must never be a bypass around the Sheets
  rules.
