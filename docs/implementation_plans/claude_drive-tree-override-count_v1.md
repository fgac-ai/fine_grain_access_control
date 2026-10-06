# Drive tree: the override count, Clear overrides and the agent's own files — v1

Branch `claude/drive-tree-override-count`, stacked on PR #185
(`claude/drive-legacy-create-autogrant` → #184 → main), because the auto-grant rows
this fixes come from #184/#185 and the files touched overlap.

## Symptom (PR #185 preview, 2026-10-05)
QA account, `drive_tree` flag on. The Drive tree card header read
"Read everything · 0 overrides", but two agent-created files (`qa-a22-copy renamed`,
`qa-a22-source`) showed **Write** as their own file-level setting.

## Root cause
Three places each had their own definition of "override", and none of them knew about
the agent's create auto-grant:

| place | counted / acted on | agent-created native (sheets/docs/slides rule) | agent-created other kind (`drive` rule) |
| --- | --- | --- | --- |
| card counter (`DriveAccessCard`) | nodes with a `source: 'drive'` setting | not counted | **counted** |
| `clearDriveOverrides` | `drive` rules assigned to the key | kept | **deleted**, which strands the agent's file under a Read default |
| `get_my_permissions` | `drive` settings | not counted | counted |

The preview files were the native kind, so the counter said 0 while the rows said
"Write, set here". With a text file, the counter would have said 1, and Clear would have
removed the agent's grant, bringing back the exact bug #184 fixed. The rows also tagged the
native agent files "per-file rule … set by the Picker or an approval link", which was wrong.

A second, latent case: `setDriveNodeAccess` updated the profile's own `drive` rule in
place. On an agent's text file, that rewrote the auto-grant into a user setting, so a later
Inherit or Clear deleted the agent's grant.

## Decision
- **Overrides = the settings the user made on the card**, which is exactly the set
  Clear overrides removes. The counter, Clear and `get_my_permissions` all use one pure
  definition (`countDriveSettings` / `isClearableDriveOverride` in `driveTreeAccess.ts`).
- **Agent-created auto-grants are neither counted nor cleared.** They are the agent's own
  output; clearing them would strand that output under a Read default. They are marked by
  the existing `Agent-created: ` rule-name prefix. Prod rows already carry it, and
  capability 19 A10 asserts it, so it is now a named constant
  (`AGENT_CREATED_RULE_PREFIX`, written through `agentCreatedRuleName`). No schema change
  was needed.
- **Legacy per-file rules** (Picker, approval links) stay uncounted and kept, as before.
- **A user setting on an agent's file outranks the auto-grant without deleting it.**
  `decidingSettings` gives same-node precedence in this order: user tree setting, then a tree
  auto-grant, then legacy. This extends the existing rule that a tree setting outranks
  legacy. The card never edits or deletes auto-grant rows, so a user Read or Block narrows
  the agent's file, and Inherit or Clear hands the file back to the auto-grant. Without the
  precedence, a user Read would have combined with the auto-grant's Write into Write.
- `clearDriveOverrides` now also handles global `drive` rules, which the counter included
  but Clear skipped (rules detached from every profile become global). A global rule is
  pinned to the other active profiles, the same way Inherit handles it.

## UI copy
- Header: `<default> · N overrides` (N = user settings only).
- Under the title, shown only when there is something to say: "Not counted as overrides, and
  kept by Clear overrides: N files the agent created (Read & write for it, so it can keep
  working on its own output); N per-file rules from the Picker or approval links."
- Row tag **created by agent** (tooltip explains it is kept by Clear and can be set
  here). The "per-file rule" tag is now limited to real legacy rules.
- The filter "Show overrides only" was renamed to "Show only items with a setting", because it
  has always shown agent and per-file settings too.
- `get_my_permissions`: "N folder/file setting(s) made by the user … Files this agent creates
  are Read & write for it unless the user sets them otherwise."

## Tests
`scripts/test-drive-tree-access.ts`: a new block covers classification, counts, the
user-over-auto-grant precedence (Block, Read, native kind), Clear leaving 0 overrides with
agent/per-file settings intact and the agent's files writable, and the server predicate
removing exactly the counted rules. QA: capability 22 draft **A23**.

## Validation
(recorded below as it happens)
