# Capability: Drive Folder Rules on the Full `drive` Scope (DRAFT — align before build)

> Plan: `docs/implementation_plans/claude_great-dhawan-c05848_v8.md`. Status:
> **draft for alignment** — nothing here is implemented yet. The assertions are
> the contract the build must satisfy; edit them first, code second.
> It lives in `capabilities/drafts/` so `scripts/qa-coverage-check.ts` (which
> inventories `capabilities/NN_*.md` only) does not demand these assertions from
> today's runs; it moves up to `capabilities/21_drive_folder_rules.md` in the PR
> that ships the engine, and the four `agents/` runbooks gain a section then.

## Overview
With the full `drive` OAuth scope, Google stops gating access inside a user's
Drive and FGAC's rule engine becomes the only gate. This capability covers the
feature-flagged engine: (1) Sheets, Docs and Slides work on files the user never
picked in the Picker; (2) the Default profile's posture is **read everything,
write nothing**; (3) a folder rule is inherited by files in that folder, its
sub-folders and sub-sub-folders — **three levels up from the file and no
further**, so a grant on a very high folder does not silently reach a deep
file, and the denial says so; (4) a one-click per-profile "Full Drive access
(read & write)" grant, the Drive twin of Gmail's "Send to Anyone"; (5) the flag
off, or the user's token lacking the `drive` scope, means every existing
`drive.file` behaviour (capabilities 09, 17, 19) is unchanged.

## Feature flag and per-user gate
Two conditions must BOTH hold for the new engine to apply to a call:
* Server flag `FGAC_DRIVE_RULES=1` (Vercel dev env → `.env.local`; unset in
  production until the beta).
* The calling user's live Google token carries `https://www.googleapis.com/auth/drive`
  (the existing tokeninfo pre-flight in `googleTokenScopes.ts` decides; Clerk's
  record is never trusted alone).

With the flag on, the dashboard's Google card shows **"Enable full Drive access
(beta)"**, which runs the in-place Clerk `reauthorize({ additionalScopes: [drive] })`
consent (the mechanism measured in `docs/spike_results/drive-scope-sheets-docs-edit.md`).
Nothing in the dev Clerk connection's scope list changes; the widening is per
QA account and reversible (Google account permissions → Remove access, then
Reconnect).

## Pre-requisites
* `/qa-setup` complete; dev server running with `FGAC_DRIVE_RULES=1`; USER_A
  signed in on the dashboard.
* USER_A's Google grant widened to `drive` via the dashboard beta button (A2).
  Restore the narrow grant at the end of the run (A21) so other capabilities
  keep their `drive.file` baseline.
* Drive fixtures owned by USER_A, created in the Drive/Docs web UI (never
  through FGAC, never picked in the Picker) — names below, ids in the runner's
  local notes only (see `setup/03_rules_configuration.md` → "Drive folder
  fixtures"):

  ```
  Test Folder A/
    DinA                      (Google Doc)
    Shortcut to K             (Drive shortcut → K)
    Test Folder B/
      CinBinA                 (Google Doc)
      Test Folder C/
        Test Folder D/
          DeepInD             (Google Doc — 4 levels below A)
  Test Folder K/
    K                         (Google Doc)
  S-unpicked                  (Google Sheet, My Drive root)
  P-unpicked                  (Google Slides, My Drive root)
  ```
* One profile with a known bearer (the **Default profile** for A3–A6, A9; a
  second profile "Drive RW" for A13). Rules for folders are created on the
  dashboard's Drive card (Picker Folders view) or via `POST /api/rules/drive`.

## Assertions

### A1: Flag off → legacy `drive.file` behaviour is unchanged
- With `FGAC_DRIVE_RULES` unset (or the user's token lacking `drive`), call
  `sheets_read_range` on `S-unpicked`.
- **Expected**: Denied with `sheets_not_exposed` and a `sheets_expose`
  approval link exactly as capability 09 A6 specifies. No folder rule UI is
  rendered; `get_my_permissions.defaults` has no `drive` entry.

### A2: Beta button widens the grant in place, and the engine turns on per user
- Flag on; on `/dashboard` click **Enable full Drive access (beta)**, complete
  Google consent (the added line reads "See, edit, create, and delete all of
  your Google Drive files").
- **Expected**: `GET /api/auth/google-picker-token` reports the live token
  carrying `drive`; the card now reads "Full Drive access: on (beta)";
  `get_my_permissions.defaults.drive` = `read: all, write: none`. The Clerk
  external account stays `verified` (no destroy/recreate).

### A3: Sheets API works on a never-picked spreadsheet (read) with no UI grant
- `sheets_get_spreadsheet` and `sheets_read_range` on `S-unpicked`, then raw
  `google_api_get v4/spreadsheets/<id>?fields=properties.title`.
- **Expected**: All succeed. `$mcp_tool_call` carries `rule_match_level: 'default'`.

### A4: Docs API works on a never-picked document (read) with no UI grant
- `docs_read_document` on `K`, then raw `google_api_get v1/documents/<id>?fields=title`.
- **Expected**: Both succeed; `rule_match_level: 'default'`.

### A5: Slides API works on a never-picked presentation (read) with no UI grant
- `slides_get_presentation` on `P-unpicked`, then raw
  `google_api_get v1/presentations/<id>?fields=title`.
- **Expected**: Both succeed; `rule_match_level: 'default'`.

### A6: Default posture denies every write, and the denial explains the three-level rule
- On the Default profile with no Drive rules: `sheets_update_range` on
  `S-unpicked`, `docs_edit` insertText on `K`, `slides_edit` createSlide on
  `P-unpicked`, and raw `PATCH drive/v3/files/<K> {"name":"x"}`.
- **Expected**: All denied with `denial_code: 'drive_read_only'`. The message
  names the file, says no Read & Write rule covers **the file, its folder
  "Test Folder K", or the two folders above it** ("FGAC checks three folder
  levels up"), and carries ONE approval link whose page offers: this file /
  folder "Test Folder K" / full Drive read & write for this profile. Nothing
  changed at Google (re-read confirms).

### A7: Read & Write on Folder A → DinA is editable (inherit, one level)
- Grant `drive_read_write` on `Test Folder A` to the Default profile. Run
  `docs_edit` insertText on `DinA`, read back, then revert.
- **Expected**: 200; body shows the text; `rule_match_level: 'folder'`,
  `lineage_hops: 1`. `get_my_permissions` lists the folder rule with its name
  and level.

### A8: CinBinA in Folder B inside A is editable (inherit, two levels)
- With only the A7 rule in place, `docs_edit` on `CinBinA`; revert.
- **Expected**: 200; `lineage_hops: 2`, `rule_match_level: 'folder'`, and the
  deciding rule reported is Folder A's.

### A9: K, outside any granted folder, cannot be edited; the message states the depth limit
- With only the A7 rule, `docs_edit` on `K`.
- **Expected**: Denied `drive_read_only`; the message names "Test Folder K"
  as the file's folder and states that only the file, its folder and the two
  folders above were checked. Read of `K` still succeeds (A4).

### A10: Depth cap — DeepInD is NOT covered by Folder A even though it is inside A's tree
- With only the A7 rule, `docs_edit` on `DeepInD` (A → B → C → D → file: the
  deciding folder is four levels up).
- **Expected**: Denied `drive_read_only` with `lineage_checked: 3` and
  `lineage_truncated: true` on the event; the message says "Test Folder A is
  higher than the three levels FGAC checks — grant "Test Folder D", "Test
  Folder C" or "Test Folder B" instead", naming the nearest checked folders.
  Then grant `drive_read_write` on `Test Folder B` → the same edit succeeds
  (`lineage_hops: 3`). Remove the B rule afterwards.

### A11: Blocked beats inherited allow, for writes AND reads
- With the A7 rule, add `drive_block` on `Test Folder B`. Call `docs_edit`
  and `docs_read_document` on `CinBinA`; then `docs_read_document` on `DinA`.
- **Expected**: Both calls on `CinBinA` denied `drive_blocked` (the block on B
  overrides A's Read & Write and the default read-all); `DinA` still reads and
  writes. Remove the block afterwards.

### A12: A file rule beats its folder's rule
- With the A7 rule, add a `doc_read` (Read Only) file rule on `DinA`. Call
  `docs_edit` on `DinA`, then on `CinBinA`.
- **Expected**: `DinA` write denied `drive_read_only` with `rule_match_level:
  'file'`; `CinBinA` still writes (folder level). Remove the file rule.

### A13: One-click "Full Drive access (read & write)" per profile, like Gmail's "Send to Anyone"
- On profile "Drive RW" click **Full Drive access** (confirm dialog names the
  consequence). Then `docs_edit` on `K` with that profile's bearer, and with
  the Default profile's bearer.
- **Expected**: "Drive RW" edits `K` (200, `rule_match_level: 'all'`); the
  Default profile is still denied (A6) — the grant is per profile. The rule
  row is `service='drive'`, `target_kind='all'`, `actionType='drive_read_write'`,
  assigned to that profile only. Toggling it off restores the denial. The
  approval-link page from A6 offers the same one-click with the same effect.

### A14: get_my_permissions describes the Drive posture completely
- Call `get_my_permissions` on each profile.
- **Expected**: `defaults.drive = { read: 'all', write: 'none' }`; every folder /
  shared-drive / all rule appears with `folderId` (or `driveId` / `*`),
  `resourceName`, level, and the sentence "rules on a folder apply to files up
  to three levels below it"; `rawApi` states which Drive write endpoints
  require Read & Write.

### A15: Listing withholds blocked subtrees and says so
- With `drive_block` on `Test Folder B`, run raw
  `GET drive/v3/files?q='<Folder A id>' in parents` and the same for Folder B,
  and `drive_list_files` if the tool ships.
- **Expected**: Folder A listing succeeds and includes `Test Folder B` as an
  entry but the Folder B listing is denied `drive_blocked`; a full-Drive
  `files.list` (no `q`) omits files whose lineage is blocked and the response
  reports `withheld: <n>`. Remove the block afterwards.

### A16: Sharing and trashing need Read & Write; deletion stays impossible
- Default profile: raw `POST drive/v3/files/<K>/permissions` (anyone-with-link
  reader), `PATCH drive/v3/files/<K> {"trashed":true}`, `DELETE drive/v3/files/<K>`.
- **Expected**: permissions and trash denied `drive_read_only`; `DELETE` denied
  by the method rule (capability 10) — unchanged. With the A7 rule on Folder A,
  the same `PATCH trashed` on `DinA` succeeds and is reverted (`trashed:false`).

### A17: Shortcuts never carry a grant
- With the A7 rule, `docs_edit` on `K` addressed through `Shortcut to K`'s id
  and through K's own id.
- **Expected**: Both denied `drive_read_only`; the shortcut's lineage (inside A)
  grants nothing to its target; the message names "Test Folder K".

### A18: Agent-created files inherit from their folder; elsewhere the auto-grant row still appears
- With the A7 rule: raw `POST drive/v3/files {name, mimeType: sheet, parents:[Folder A]}`
  then `sheets_update_range` on it; then create another sheet with no parent
  and write to it.
- **Expected**: Both writes succeed. The first creates NO `access_rules` row
  (`rule_match_level: 'folder'`); the second creates the PR #143 auto-grant
  file rule (`rule_match_level: 'file'`). Trash both fixtures via `PATCH`.

### A19: REST proxy parity
- Repeat A7 (success) and A9 (denial) through the proxy route with the
  profile's `sk_proxy_` bearer (`/api/proxy/v1/documents/<id>:batchUpdate`).
- **Expected**: Identical outcomes and identical denial text to the MCP path.

### A20: Analytics carry the new fields
- Query `$mcp_tool_call` for the run (or local PostHog capture log).
- **Expected**: Every Drive-gated call has `rule_match_level` in
  {`file`,`folder`,`shared_drive`,`all`,`default`,`none`}, `lineage_hops`,
  `lineage_cache_hit`; denials use `drive_read_only` / `drive_blocked` /
  `lineage_unavailable`; A10's event has `lineage_truncated: true`.

### A21: Removing the `drive` scope returns the user to legacy behaviour with the flag still on
- Google account permissions → Remove access for the dev app → dashboard
  **Reconnect Google** (narrow consent). Then repeat A1's call.
- **Expected**: tokeninfo shows `drive.file` + Gmail only; the call is denied
  `sheets_not_exposed` (legacy path); the dashboard card offers the beta button
  again. This is also the mandatory restore step for the QA baseline.

## Out of scope for this capability
* Verification / CASA submission (user action, plan v8 §5).
* Shared-drive fixtures (the QA accounts cannot create in one; a
  `shared_drive` target is covered by unit tests until a fixture exists).
* Slides tool coverage beyond A5/A6 (capability for Slides tools lives with
  PR #153's docs).
