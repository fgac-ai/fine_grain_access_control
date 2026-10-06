# Drive tree: Inherit snaps back to Write on files with legacy rules (v1)

## Report

Ken, on USER_A's Default Profile: setting **Demo Spreadsheet** to *Inherit* on the
Google Drive access card always popped back to *Write*.

## Evidence (read-only prod SELECT, 2026-10-05)

Two `access_rules` rows targeted the same file id, both assigned to the Default Profile:

| service | action_type | created |
| --- | --- | --- |
| `sheets` | `sheet_read_write` | 2026-07-27 (legacy per-file rule, pre-tree) |
| `drive` | `drive_read` | 2026-10-06 UTC (written by the tree card) |

## Root cause

`setDriveNodeAccess(…, 'inherit')` in `src/app/dashboard/actions.ts` selected only
`service = 'drive'` rules for the node. The legacy `sheets` rule survived, and both
the card (`settingOf` falls back to legacy settings when no tree setting exists) and
the guard (`effectiveDriveAccess` counts legacy rules at file level) read it as the
file's own setting. The optimistic UI showed Inherit for a moment, and then the page
revalidated with the legacy rule still in place. So the setting came back as Write,
and **enforcement really was Write**. The display was not lying.

Read/Write/Block were unaffected: a tree rule outranks a legacy rule on the same node.

## Fix

On Inherit for a `file` node, the legacy per-file rules for that file id
(`sheets`/`docs`/`slides`, by `targetResourceId` or the legacy `regexPattern`
fallback) are added to the candidate set. They then go through the same rules as
tree rules:

- detached from this profile, or deleted when no other profile uses them;
- if global, pinned to the other active profiles.

Folders and the pseudo-roots never carry legacy rules, so nothing changes for them.

Trade-off: if the user is later taken off the `drive_tree` flag, the file loses its
legacy grant. This is accepted, because the user explicitly asked for the file to
follow its folder.

## Validation

- Local: qa-setup-driver runner. Reproduce with a legacy Sheets write rule, choose
  Inherit, reload, check that it persists, and check that the DB rows are gone. Then
  run a regression on Read/Write/Inherit and on a folder setting.
- Preview: `/deploy-pr-preview`.
