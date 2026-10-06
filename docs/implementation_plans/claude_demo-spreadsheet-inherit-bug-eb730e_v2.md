# Drive tree: Inherit snaps back to Write on files with legacy rules (v2)

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

- **Local: BLOCKED.** The built-in pane refuses localhost, and the Path B Chrome profile's
  Google session has lapsed (it shows a password prompt). The bootstrap did run: the
  dependencies were reinstalled, `CLERK_SECRET_KEY` was re-pulled and the database branch
  was migrated.
- **Preview `dtkbts0eg` (commit 219a811): PASS.** Run by qa-setup-driver as USER_A in the
  built-in browser.
  - The card first asked to re-enable full Drive access. The Clerk account was
    `verified`, so the in-place reauthorize applied; consent was accepted.
  - Fixture A: a drive Read rule on top of a legacy `sheet_read_write` rule (Demo
    Spreadsheet). Inherit removed both rules (0 left in the database). The card stayed on
    Inherit, with a dashed pill, across two full reloads.
  - Fixture B: a legacy-only Write rule, created through `exposeFilesFromPicker` +
    `setSheetRulePermission`. The card showed Write before. After Inherit, the rule was
    deleted and the card stayed on Inherit across two reloads.
  - Regression: Read, Write and Inherit on another file each persisted after a reload. A
    folder set to Read, then back to Inherit, also persisted.
