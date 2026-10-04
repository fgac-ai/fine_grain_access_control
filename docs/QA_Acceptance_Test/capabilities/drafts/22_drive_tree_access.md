# Capability: Drive Tree Access on the Full `drive` Scope (feature-flagged)

> Plan: `docs/implementation_plans/claude_google-drive-permissions-ux-427163_v1.md`.
> Supersedes the draft `21_drive_folder_rules.md` from PR #152 (the UX approved on
> 2026-09-30 changed two of its rules: the nearest setting wins in both
> directions, and there is no depth cap). It lives in `capabilities/drafts/` so
> `scripts/qa-coverage-check.ts` does not demand these assertions from today's
> runs while the feature is flag-off in production; it moves up to
> `capabilities/22_drive_tree_access.md` when the flag goes to beta, and the
> four `agents/` runbooks gain a section then.

## Overview
With the full `drive` OAuth scope, Google stops gating access inside a user's
Drive and FGAC's engine becomes the only gate. Behind the feature flag, a
profile gets a **default** for every Drive file — Read everything (the
default), Read & write everything, or Only files I allow — and any folder,
file, shared drive, or one of the two pseudo-roots (Shared with me, Shared
drives) can carry a **setting**: Read, Write (Read & write) or Block. A file's
effective access is the **nearest setting on its lineage** (the file itself,
then its folder, its folder's folder, … up to the root); with none, the default
applies. Nearest wins in both directions. Blocked files are invisible (reads
denied, listings withhold them). Legacy per-file rules (Picker, approval links,
agent-created files) are honoured as file-level settings.

## Feature flag and per-user gate
Two conditions must BOTH hold for the engine to apply to a call:
* The PostHog feature flag `drive_tree` is on for the user (a release
  condition on the person property `email`, or on the Clerk id as distinct
  id). People are added and removed in PostHog, no deploy; the verdict is
  cached per user for 60 s and fails closed. Env overrides for local dev and
  CI only: `FGAC_DRIVE_TREE=1` (everyone) or `FGAC_DRIVE_TREE_USERS` (Clerk
  ids and/or emails) — the `fgac-dev-drive-tree` launch configuration sets
  the first, so local QA never depends on PostHog.
* The calling user's live Google token carries
  `https://www.googleapis.com/auth/drive` (tokeninfo decides, never Clerk's
  record).

The `drive` scope is requested only for flagged users: by the profile page's
"Enable full Drive access" card (in-place `reauthorize`, consent prompt) and
by the nav UserButton's connect-account scopes (via `/api/drive/flag`).

## Pre-requisites
* `/qa-setup` complete; dev server started with `fgac-dev-drive-tree`; USER_A
  signed in on the dashboard, Default Profile selected.
* Drive fixtures owned by USER_A, created in the Drive/Docs web UI (never
  through FGAC, never picked in the Picker); names below, ids in the runner's
  local notes only:

  ```
  Test Folder A/
    DinA                      (Google Doc)
    Test Folder B/
      CinBinA                 (Google Doc)
      Test Folder C/
        Test Folder D/
          DeepInD             (Google Doc — 4 levels below A)
  Test Folder K/
    K                         (Google Doc)
  S-unpicked                  (Google Sheet, My Drive root)
  ```
* The Default Profile's bearer / `sk_proxy_` key.
* Restore USER_A's narrow grant at the end (A20).

## Assertions

### A1: Flag off → legacy behaviour is unchanged (one deliberate, non-gated copy change)
- Known and intended difference from the pre-branch build, for EVERY account:
  the "Suggested wording to relay" line in linked denials now says what is being
  approved — "FGAC needs your approval for spreadsheet <id> before I can
  continue: <link> — …" (the file's title when the denial knows it) instead of
  "FGAC is blocking this until you approve it here: <link> — …". Everything
  else in the denial (header, link, signed-in-as line, IMPORTANT block) is
  identical. Verified on the preview as USER_B, 2026-10-03.
- Start the server with `fgac-dev` (flag unset). Load the Default Profile page;
  call `sheets_read_range` on `S-unpicked`.
- **Expected**: The three per-kind cards render, no "Google Drive access"
  card, no "Enable full Drive access" card; `/api/drive/children` answers 404;
  the call is denied `sheets_not_exposed` with the capability 09 approval link;
  `get_my_permissions.defaults` has the per-kind lines and no `drive` entry.

### A2: Flag on, token still `drive.file` → legacy cards plus the enable card; nothing else changes
- Start with `fgac-dev-drive-tree`; load the profile page before widening.
- **Expected**: "Google Drive access (Beta)" card with **Enable full Drive
  access** ABOVE the unchanged per-kind cards; the same `sheets_not_exposed`
  denial as A1; `/api/drive/children` answers 403 `drive_scope_missing`.

### A3: Enable full Drive access widens the grant in place; the tree card takes over
- Click **Enable full Drive access**, complete Google consent (the added line
  reads "See, edit, create, and delete all of your Google Drive files").
- **Expected**: Return to the profile URL; "Confirming Google permissions…"
  then the page re-renders with the **Google Drive access** card (quick
  options, My Drive expanded, Shared with me, Shared drives) and WITHOUT the
  per-kind cards; `GET /api/auth/google-picker-token` reports the token
  carrying `…/auth/drive`; the Clerk external account stays `verified`.
  Events: `drive_scope_enable_started`, `drive_scope_enable_returned`,
  `drive_scope_enabled`.

### A4: Default read-everything: reads work on never-picked files, writes deny with the write link
- Default Profile, no settings. `sheets_read_range` on `S-unpicked`,
  `docs_read_document` on `K`; then `sheets_update_range` on `S-unpicked` and
  `docs_edit` on `K`.
- **Expected**: Both reads succeed with `drive_tree: true`,
  `rule_match_level: 'default'`. Both writes denied `denial_code:
  'drive_read_only'`; the text names the file and "the profile's default (Read
  everything)" and carries ONE approval link whose page offers write access
  to that file. Nothing changed at Google.

### A5: A folder setting is inherited to any depth, and the tree shows the chain
- On the card, search "Test Folder A", set it to **Write**. Then `docs_edit`
  on `DinA`, `CinBinA` and `DeepInD`; revert each.
- **Expected**: All three succeed (`rule_match_level: 'folder'`,
  `lineage_hops` 1, 2, 4). On the card, opening Test Folder D shows the
  breadcrumb My Drive › Test Folder A › Test Folder B › Test Folder C › Test
  Folder D with a solid Read & write pill on Test Folder A only, and the strip
  "Everything in Test Folder D inherits Read & write from Test Folder A, 4
  levels up". Each row's effective pill is dashed with "from Test Folder A".

### A6: Nearest wins, both directions
- With A5's setting: set `CinBinA` to **Read** (file inside a Write folder);
  set Test Folder B to **Block** and `DeepInD` to **Write** (file inside a
  Blocked folder).
- **Expected**: `docs_edit` on `CinBinA` denied `drive_read_only` with
  `rule_match_level: 'file'`; `docs_read_document` on `DeepInD`'s sibling
  `CinBinA`… (read still allowed, Read setting). `docs_edit` on `DeepInD`
  succeeds (`rule_match_level: 'file'`) although Test Folder B is Blocked;
  `docs_read_document` on `CinBinA` with Block on B: allowed? No — `CinBinA`'s
  own Read setting is nearer than B's Block, so the read succeeds; a file in B
  with NO setting (create `NoSetInB` for this) is denied `drive_blocked`.
  Remove the three settings afterwards.

### A7: Blocked files are invisible: reads, listings, search
- Set Test Folder K to **Block**. `docs_read_document` on `K`; raw
  `google_api_get drive/v3/files?q='<K folder id>' in parents`; raw
  `drive/v3/files?q=name contains 'K'`.
- **Expected**: The read is denied `drive_blocked` ("blocked files are
  invisible to the agent, reads included"); the folder listing returns no
  files and `withheld: 1`; the search listing omits `K` and reports
  `withheld` ≥ 1; the REST proxy `GET /api/proxy/drive/v3/files?q=…` returns
  the same filtered body. `$mcp_tool_call` rows carry `drive_list_total` and
  `drive_list_withheld`. Remove the setting afterwards.

### A8: Only files I allow
- Quick option **Only files I allow**; no settings. `sheets_read_range` on
  `S-unpicked`; then set `S-unpicked` to **Read** on the card and repeat.
- **Expected**: First denied `sheets_not_exposed` (so the ordinary expose link
  applies), text names the default "Only files I allow"; after the setting the
  read succeeds with `rule_match_level: 'file'`. The card shows every other row
  greyed with a dashed Blocked pill "default: Only files I allow". Restore
  **Read everything**.

### A9: Read & write everything + the warning strip
- Quick option **Read & write everything**. `docs_edit` on `K`.
- **Expected**: Succeeds (`rule_match_level: 'default'`); the card shows the
  warning strip ("…including files other people shared with you…"). Restore
  **Read everything**.

### A10: Shared roots inherit the default and can be set
- With Read everything, set **Shared with me** to **Block**. Pick a file
  another account shared with USER_A (USER_B shares one doc for the run) and
  `docs_read_document` it; then set Shared with me back to Inherit.
- **Expected**: Denied `drive_blocked` with `rule_match_level:
  'shared_with_me'`; after Inherit the read succeeds (`'default'`).

### A11: Legacy per-file rules are file-level settings; a tree setting on the same node outranks them
- Expose `S-unpicked` through the Picker as Read Only (legacy `sheet_read`
  rule) on a flag-off server, then switch to the flag-on server with Read &
  write everything.
- **Expected**: `sheets_update_range` on `S-unpicked` denied `drive_read_only`
  with `rule_match_level: 'file'` (the legacy rule is nearer than the default);
  the card marks the row "per-file rule". Setting the row to **Write** on the
  card makes the write succeed; Inherit returns to the legacy rule's Read.

### A12: Search finds folders and files with their paths; Open folder and Show in tree
- Type "Test Folder" in the card's search.
- **Expected**: Folder results first; each result shows its path (My Drive ›
  Test Folder A › …), the effective pill and the Setting control; "Open folder"
  opens the folder view with the breadcrumb chain; "Show in tree" clears the
  search and expands the tree down to the node.

### A13: get_my_permissions describes the posture
- Call `get_my_permissions` with A5's setting in place.
- **Expected**: `defaults.drive` starts with "READ EVERYTHING — this profile's
  default for every file …", mentions nearest-wins and that blocked files are
  invisible, and counts 1 setting; the rules list carries the Test Folder A
  rule with `nodeId`, `nodeKind: 'folder'`, `resourceName` and `covers`.

### A14: Agent-created files are Read & write for the key; a file created inside a Blocked folder is still the agent's
- With Test Folder K Blocked, raw `POST drive/v3/files {name, mimeType: sheet,
  parents:[K folder]}`, then `sheets_update_range` on the new file.
- **Expected**: The create succeeds and the auto-grant file rule is written
  (PR #143 behaviour); the write succeeds with `rule_match_level: 'file'`
  (the file-level auto-grant is nearer than the folder Block). Trash the
  fixture via `PATCH` (allowed by its own file rule). Remove the setting.

### A15: REST proxy parity
- Repeat A4 (read ok, write denied) and A5's `DinA` write through the proxy
  with the Default Profile's `sk_proxy_` key
  (`/api/proxy/v1/documents/<id>:batchUpdate`).
- **Expected**: Identical outcomes; denial bodies carry the same text as the
  MCP path minus the leading emoji; the `proxy_request` event's
  `error_status` is `drive_read_only` on the denial.

### A16: Delegated mailboxes stay on the legacy path
- With USER_B delegated to USER_A, call `sheets_read_range` on a never-picked
  USER_B sheet with `account: <USER_B>`.
- **Expected**: `sheets_not_exposed` (legacy per-file path); no `drive_tree`
  property on the event.

### A17: Lineage failures fail closed
- `docs_read_document` on a well-formed id that does not exist.
- **Expected**: 🚫 "Google Drive reports no file … visible to this Google
  account", `denial_code: 'file_not_found'`, no approval link minted.

### A18: Settings persist per profile and survive reload; Clear overrides
- Make three settings on the Default Profile; reload; switch to a second
  profile; back; click **Clear overrides (3)**.
- **Expected**: The settings re-render from the server after reload; the
  second profile shows none of them (and its own default); Clear removes the
  three, the count reads 0, `drive_tree_settings_cleared{count: 3}` captured.

### A19: Analytics
- Query `$mcp_tool_call` for the run.
- **Expected**: Every engine-gated call has `drive_tree: true`,
  `rule_match_level` ∈ {file, folder, shared_drive, shared_with_me,
  shared_drives, default}, `lineage_hops`, `lineage_cache_hit`,
  `drive_default`, `file_mime_type`; denials use `drive_blocked` /
  `drive_read_only` / `<service>_not_exposed` / `file_not_found` /
  `lineage_unavailable`. Dashboard: `drive_tree_default_changed`,
  `drive_tree_setting_changed{node_kind, access}`, `drive_tree_settings_cleared`.

### A20: Removing the `drive` scope returns the user to the enable card with the flag still on
- Google account permissions → Remove access for the dev app → dashboard
  **Reconnect Google** (narrow consent). Reload the profile page.
- **Expected**: tokeninfo shows `drive.file` + Gmail only; the enable card and
  the per-kind cards are back; A1's call denies `sheets_not_exposed`. This is
  also the mandatory restore step for the QA baseline.

### A21: A full-scope token outside the engine fails closed
- Precondition: USER_A (flagged) holds the full `drive` scope (tokeninfo
  shows `.../auth/drive`) and delegates their mailbox to USER_B. Using a
  USER_B key that reaches USER_A's mailbox:
  1. `google_api_get` `drive/v3/files` with `account: <USER_A>`;
  2. `google_api_get` `drive/v3/files/<id>?alt=media` on a USER_A PDF or
     image no rule names, with `account: <USER_A>`.
- **Expected**: both 🚫 with `denial_code: 'drive_full_scope_unconfined'` and
  `drive_scope_unconfined: true` (call 2 also `drive_file_gate: 'unconfined'`);
  no file names or bytes in the response. A USER_A Sheet exposed to the key
  by a per-file rule still reads normally. Before 2026-10-03 call 1 listed
  USER_A's whole Drive and call 2 returned the file (`mime_other`).
- Same refusal on USER_A's OWN mailbox if USER_A is removed from the flag
  while still holding the full scope; on the REST proxy that case answers
  `GET /api/proxy/drive/v3/files` 403 (`error_status`
  `drive_full_scope_unconfined`). The proxy has no delegated-mailbox path.

## Out of scope for this capability
* Google verification / CASA for the restricted scope (user action).
* Shared-drive fixtures (the QA accounts cannot create one; the
  `shared_drive` level is covered by `scripts/test-drive-tree-access.ts`).
* Sharing-requires-send parity and a typed `drive_list_files` tool (plan v7
  §3, later train).
