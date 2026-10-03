# Drive tree access behind a feature flag — plan v4 (preview validation, findings, fixes)

Branch: `claude/google-drive-permissions-ux-427163` · Date: 2026-10-03 · Supersedes
v2's validation section and adds the fixes below; v1 (design), v3 (PostHog flag)
stand.

## Preview validation (qa-setup-driver, built-in browser + curl, 2026-10-03 ~14:00–14:40Z)

Target: preview alias `fine-grain-access-control-git-f8890e-…vercel.app`, commit
`ea20c06` (PostHog flag `drive_tree`, USER_A on it, USER_B not).

### New path (USER_A, flag on) — every step PASS

| step | result |
| --- | --- |
| B1 enable card before widening | "Google Drive access · Beta" card above the three legacy cards; `/api/drive/flag` `{flagOn:true}`; `/api/drive/children` 403 `drive_scope_missing` |
| B2 Enable full Drive access | consent (unverified-app warning → Continue; no checkboxes, Google already held the grant) → return leg → tree card within ~5 s, legacy cards gone; tokeninfo lists `…/auth/drive` |
| B3 card | expand, folder view with breadcrumb + strip + control, search "probe" (folders first, paths, Open folder / Show in tree), folder→Write + file→Block (solid pills, siblings dashed "from <folder>", Saved tick), persist across reload, Clear overrides (2) → 0; the legacy Demo Spreadsheet row shows "per-file rule" and is not counted |
| B5 REST proxy | a read 200 · b write 403 "Write denied … by the profile's default (Read everything)" · c folder Write → 200 (reverted) · d Block → 403 "Blocked … invisible … reads included" · e Only files I allow → 403 naming the default · f Read & write everything → 200 (warning strip rendered) · g listing carries `withheld` (0; 1 with the sheet Blocked, sheet omitted) · h nonexistent id → 404 "Google Drive reports no file …" |
| B6 MCP (bearer minted against the preview) | `defaults.drive` "READ EVERYTHING — …" and no per-kind lines · read ok · write 🚫 with ONE link and the relay line naming the spreadsheet by TITLE · listing `withheld` · folder Block → 🚫 "by the folder '<name>'" · nonexistent id → 🚫 no link · A8 variant: Only files I allow → 🚫 `sheets_expose` link, `defaults.drive` "ONLY FILES I ALLOW — …" |
| B7 restore | Read everything, 0 overrides, fixture cell cleared, USER_A left widened |

### Legacy path (USER_B, flag off) — BLOCKED, partial coverage

USER_B's Google session has lapsed in both the built-in pane (chooser → U-M
Okta SSO wall) and the Path B Chrome profile (identifier/password page). Nothing
was typed. **USER ACTION REQUIRED: re-auth USER_B in the built-in pane (or the
CDP Chrome window), then re-run Part A** — assertions A1 (flag-off rendering,
`/api/drive/*` 404) and A2 (legacy denial shape under a flag-off account).

What WAS observed, with USER_A while its token had narrowed (flag on, no `drive`
scope — the engine-inactive branch the flag-off path also takes): the three
legacy cards and the Gmail cards render exactly as production beneath the
enable card; `get_my_permissions.defaults` has the per-kind lines and no
`drive` key; `sheets_read_range` on a never-exposed sheet is the capability-09
`sheets_not_exposed` denial with ONE `sheets_expose` link; the new relay line
reads "FGAC needs your approval for spreadsheet <id> before I can continue:
…" (id, not title — the legacy path cannot see the title); a legacy-exposed
sheet reads fine. The MCP endpoint shown on the card still says
`https://fgac.ai/api/mcp` on previews (pre-existing).

## Findings and what changed

1. **Widened grant narrowed back ~28 min after enabling** (runner finding 1). At
   14:33Z the live token no longer carried `drive`; Clerk's record still
   claimed it (`approvedScopes` wide, tokeninfo narrow — the narrow-refresh-
   token class in `google-sign-in-narrows-clerk-grant`, and USER_A's known
   hourly quirk on the dev instance). The dashboard silently showed the enable
   card again and MCP calls silently fell back to per-file denials; the quick
   option the user had just saved survived. Re-enabling restored everything in
   one pass. Fixes on this branch:
   - **MCP**: `driveTreeScopeLostDenial` runs ahead of the drive.file
     pre-flight at every Drive door: flag on + the profile uses the tree
     model (a quick option saved, or any drive setting) + token without
     `drive` → 🚫 `drive_tree_scope_lost` naming the account and the one-click
     "Re-enable full Drive access" button, settings kept, Gmail unaffected.
     No silent downgrade to "expose this file" links. Event
     `drive_tree_scope_lost{via}`.
   - **Dashboard**: the enable card has a `reenable` variant ("Google Drive
     access needs re-enabling · Action needed", warning border) when the
     profile is tree-configured; a successful enable now saves the quick
     option (even when it is still the default) so the profile counts as
     configured from then on.
   - Still open: a clean-sign-in repro with `prompt=consent` on the enable
     leg before any production beta (the consent screen Google showed had no
     checkboxes, which is the "Google already holds the grant" case; whether
     a fresh consent yields a wide refresh token that Clerk keeps is the
     question).
2. **Row grid hid file names between the md and xl breakpoints** (runner
   finding 2: at 1024 px the name column resolved to 0 px). The three-column
   grid now starts at `xl` (1280 px); below it rows stack (name, then pill,
   then control) with the same 52 px indent.
3. **Truncation** (finding 3): the source text and search-result paths wrap
   (two-line clamp / break-words) instead of truncating; the effective
   column is 200 px.
4. **Test hooks** (finding 4): `Card` forwards `testId` → `data-testid`
   (`drive-access-card`, `enable-drive-access`).
5. **`list_accounts.next_steps`** (finding 5): when the owner's token carries
   `drive` and the flag is on, the per-kind "granted per spreadsheet" lines
   are replaced by one `drive` line describing folder-scoped access.
6. Pre-existing, not touched (finding 6): preview denial links point at
   `https://fgac.ai/dashboard`; the Connected Agents row shows the DCR
   client id for a client that sent no name.

## Validation of the fixes

- `npx tsc --noEmit` clean; `npm run mcp:lint` exit 0; `npx eslint` clean on
  the changed files.
- Re-check on the preview (runner, after the push): rows readable at 1024 px
  and 1440 px; the re-enable card and the `drive_tree_scope_lost` refusal when
  USER_A's token is narrow; `list_accounts.next_steps.drive` when it is wide.
  Results in v5.

## Hand-off

Branch pushed; lands on the next integration train. Flag `drive_tree` (PostHog
id 929626) decides who is on the beta; `fgac-dev-drive-tree` forces it on
locally. Google verification of the restricted scope remains the prerequisite
for a production beta beyond listed test users.
