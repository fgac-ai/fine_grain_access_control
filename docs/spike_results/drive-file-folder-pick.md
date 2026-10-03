# Spike — folder pick under `drive.file`: what Google grants

Date: 2026-09-17 · Environment: local dev server, dev Clerk instance, QA
account USER_A (consumer Gmail), built-in browser throughout · Runner:
`qa-setup-driver` · Plan: `docs/implementation_plans/claude_great-dhawan-c05848_v2.md`

## Verdict

**Picking a folder grants the app the folder object only.** Children that
existed before the pick and children added after it stay unreachable
(`404`), including through `files.list` with `'<folder>' in parents`, which
returns an empty list even though the folder's own `capabilities` say
`canListChildren: true`. Folder grants are therefore **not** expressible with
`drive.file`; listing a folder's contents needs a restricted scope
(`drive.readonly`, `drive.metadata.readonly`, or `drive`).

## Method

1. Token check: `GET /api/auth/google-picker-token` → `hasDriveFileScope:
   true`, `appId` present, scope source `google-tokeninfo`; the token's only
   Drive scope was `drive.file`. No reconnect branch was entered.
2. Fixtures created in the Drive / Sheets **web UI** (so they are user-created,
   never app-created): a probe folder in My Drive and one spreadsheet inside
   it (`child-1`). Nothing in FGAC had touched them.
3. Baseline calls with the Picker token, then a Picker built in-page with
   `DocsView(ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true)`
   and our `setAppId`, folder picked, calls repeated with a fresh token.
4. A second spreadsheet (`child-2`) created in the folder after the pick;
   calls repeated immediately and again after 60 s.

## Results (ids redacted)

| phase | call | HTTP | response |
| --- | --- | --- | --- |
| baseline | `files.get` folder | 404 | File not found |
| baseline | `files.list` `'<folder>' in parents` | 200 | `files: []` |
| baseline | `files.get` child-1 | 404 | File not found |
| baseline | `spreadsheets.get` child-1 | 404 | NOT_FOUND |
| after pick | Picker callback | — | `action: picked`, `docs[0].id` = folder id, `type: folder` |
| after pick | `files.get` folder | **200** | name, `mimeType: …folder`, `capabilities { canListChildren: true, canAddChildren: true, canEdit: true, canShare: true, canDelete: true }` |
| after pick | `files.list` `in parents` | 200 | `files: []` |
| after pick | `files.get` child-1 | **404** | File not found |
| after pick | `spreadsheets.get` child-1 | **404** | NOT_FOUND |
| after pick | `files.list` (no `q`) | 200 | 61 files: the picked folder plus earlier QA fixtures; neither child |
| late child | `files.list` `in parents` (0 s and 60 s) | 200 | `files: []` |
| late child | `files.get` / `spreadsheets.get` child-2 | 404 / 404 | not found |

## Shared drive

Not testable with the QA accounts. USER_A has no shared drives; USER_B is a
read-only member of two, so no probe folder could be created there, and
creating a shared drive is outside what a QA run may do. The consumer-Drive
result is expected to hold (the grant model is per file id), but it is
unmeasured for shared drives.

## Picker driving notes (for the QA harness)

- The FOLDERS view listed the probe folder as the first tile; the `DOCS`
  fallback was not needed.
- The keyboard path (search click, Tab×4) focused the tile but Space/Enter did
  **not** select a folder tile and Select stayed disabled. A trusted
  `computer` click on the tile's visible position did select it, and a
  `computer` click on Select fired `picked`. This differs from the 2026-09-03
  file-tile note in CLAUDE.md ("pointer clicks never reach a tile"); the
  folder view, at least, accepts trusted clicks.
- Drive's New → Google Sheets opens a new tab, which the pane blocks; loading
  `docs.google.com/spreadsheets/create?folder=<id>` in-tab creates the sheet
  in place.
