# Folder-inherited access rules on the full `drive` scope — implementation plan v7

Branch: `claude/great-dhawan-c05848` · Date: 2026-09-19 · Status: plan, nothing implemented · Supersedes v6

## Decision (Ken, 2026-09-19)

Go for the full `drive` scope. Build rules by folder or file, where a user
exposes a folder once and every document inside it inherits the folder's
access level. This revives the folder idea from
`feature-google-drive-sheets-fgac_v1.md` (question 2 "Folder Path
Resolution", action type `drive_folder_scope`) that the `drive.file` decision
shelved. The research behind the decision is in v1–v6 of this plan; the
measured facts it rests on:

- A folder pick under `drive.file` grants the folder object only, so
  inheritance is impossible without a restricted scope (v2, §1.1).
- The full `drive` scope alone reads and writes Sheets, Docs and Slides, no
  content-API scope needed, bounded by the user's own sharing permission
  (v5, §1.5; `docs/spike_results/drive-scope-sheets-docs-edit.md`).
- Under `drive`, Google stops enforcing anything inside the user's Drive.
  FGAC's rule engine becomes the only gate, so every Drive endpoint must be
  guarded before the scope ships (v1, §1.5 item 1).

## 1. Rule model

### 1.1 Targets

`access_rules` today keys a file rule on `targetResourceId` with a per-kind
`service` (`sheets` / `docs` / `slides`) and per-kind action types. Folder
rules add one dimension, the **target kind**, and one service, `drive`, whose
actions apply to every file kind under the target:

| target_kind | targetResourceId | service | actionType | means |
| --- | --- | --- | --- | --- |
| `file` (existing rows, default) | file id | `sheets` / `docs` / `slides` | `sheet_read` … `slide_block` | unchanged |
| `folder` | folder id | `drive` | `drive_read` / `drive_read_write` / `drive_block` | every file whose lineage passes through this folder |
| `shared_drive` | drive id | `drive` | same three | every file in that shared drive |
| `all` | `*` | `drive` | same three | the user's whole Drive (My Drive + shared drives + shared with me) |

Schema change (migration `0015_drive_folder_rules.sql`): add
`target_kind text NOT NULL DEFAULT 'file'` to `access_rules`, an index on
`(user_id, target_kind, target_resource_id)`, and widen the documented
`service` / `actionType` enums. Existing rows are untouched. Profile scoping is
unchanged: a rule with no `key_rule_assignments` row is global, otherwise it
applies to the assigned keys only.

### 1.2 Precedence

Evaluation for a call on file F by key K:

1. Collect the rules visible to K (global + assigned).
2. Resolve F's lineage: `[F, parent, grandparent, …, root-or-drive]` (§2).
3. Walk the lineage from F outward. At the **first level with any matching
   rule**, decide there: `*_block` wins over any allow at that level;
   otherwise the strongest allow (read_write > read) applies. Stop.
4. If no level matches, try the `all` rule. If none, the file is **not
   exposed**: deny and mint an approval link (§4).

So a file rule beats its folder, a subfolder beats its parent, and a Blocked
subfolder inside a Read & Write tree stays blocked. A Blocked file rule inside
an exposed folder is the "everything in Finance except payroll.xlsx" case.
Writes need `read_write` at the deciding level; reads need `read` or better.

Two edge rules, decided here so they are not decided in a hurry:

- **Shortcuts** resolve to the shortcut's own lineage, never the target's. A
  shortcut in an exposed folder pointing at a file outside it grants
  nothing; the target file is evaluated by its real parents. (Prevents a
  confused-deputy grant by dropping a shortcut into an allowed folder.)
- **Multiple parents** (legacy files created before Drive's 2020
  single-parent change): evaluate every lineage; blocked anywhere wins, else
  allowed if any lineage allows.

### 1.3 Defaults after the scope flips

A user who has granted `drive` and has no rules is **not exposed everywhere**
by default; the first agent call mints the approval link as today, and the
approve page offers file, folder or whole-Drive grants (§4). At onboarding
(and in the dashboard's Google card) one checkbox creates the `all` /
`drive_read` global rule: "Let my agents read any file in my Drive; writing
still needs my approval per folder or file." Recommendation: **present it,
preselected on**. The measured pain is on reads (71 `sheets_expose` links
versus 30 `sheets_write` in a week; the healthcare user's complaint was about
reads), and write approval is the control worth keeping. Ken decides the
preselection.

## 2. Lineage resolution

`src/lib/driveLineage.ts` (new, pure resolver + cache):

- `files.get(F, fields=id,name,mimeType,parents,driveId,shortcutDetails,trashed)`
  then repeat on each parent until `parents` is empty (My Drive root, or the
  shared drive root, whose id equals `driveId`). Cap at 20 hops; deeper trees
  deny with `lineage_too_deep` (never seen in practice; the cap is a
  safety net).
- Cache per `(clerkUserId, fileId) → lineage` for 15 minutes, in a small
  table `drive_lineage_cache` (user_id, file_id, lineage jsonb, fetched_at)
  so Vercel instances share it, plus an in-process map for the hot path.
  Cost model: first call on a file costs one Google round trip per hop
  (typically 2–4, ~80 ms each, measured `google_ms` p50 on files.get), later
  calls cost one SELECT. Moves the agent performs through FGAC invalidate the
  moved file's entry; moves made elsewhere are seen within 15 minutes, which
  is the documented staleness bound.
- Uses the user's own token, so a file the user cannot see 404s and reads as
  not exposed — Google's sharing boundary stays underneath FGAC's.

## 3. Enforcement: every Drive door, not just Sheets and Docs

Today the MCP passthrough forwards `PATCH drive/v3/files/{id}`,
`…/permissions`, `files.list`, `files.export`, `alt=media` downloads and
non-Google file types with no per-file check, because `drive.file` made
Google the gate. Under `drive` each of these reaches the user's entire Drive.
Before the scope is requested from a single production user:

1. **One choke point.** `checkFilePermission(kind, …)` becomes
   `checkDriveAccess(fileId, isMutating, …)`; the per-kind file rules are
   evaluated as level 0 of the lineage walk, so nothing existing changes
   behaviour. Every classified kind that names a file id (`sheets`, `docs`,
   `slides`, `file_comments`, `drive_copy`, `drive_file`, exports,
   downloads, permissions) goes through it. The REST proxy route calls the
   same function.
2. **Listing is filtered, not forwarded.** `files.list` and the new
   `drive_list_files(folderId?)` tool: when the query names a parent folder,
   the folder itself must be exposed (that one check covers every child);
   without a parent filter, results are post-filtered through the resolver
   (cache makes the second page cheap) and the response says how many items
   were withheld. `sharedWithMe` and full-text search behave the same way.
3. **Sharing and trashing** (`permissions.*`, `PATCH {trashed:true}`,
   `files.update` parents) require `read_write` at the deciding level, and
   sharing additionally requires the profile's existing send-style
   allowance, since sharing is how data leaves.
4. **Deletion** stays never available (product guarantee); the method enum
   already enforces it and `drive` does not change that.
5. **Agent-created files** keep the auto-grant from PR #143 as a file rule,
   but a file created inside an exposed folder needs no rule at all; the
   auto-grant is written only when the parent is not already exposed.

Denial codes gain `drive_not_exposed`, `drive_blocked`, `drive_read_only`,
`lineage_unavailable` (Google error while resolving; fail closed) and
`$mcp_tool_call` gains `rule_match_level` (`file` / `folder` / `shared_drive`
/ `all` / `none`), `lineage_hops`, `lineage_cache_hit`, so time-to-first-
success and folder adoption are queryable the day it ships.

## 4. Approvals and the MCP surface

- `request_access` accepts `folderId` (and `driveId`) as well as file ids;
  the denial-minted link for an un-exposed file carries the file's nearest
  folder name (from the lineage, which we can now read) so the approve page
  offers three buttons: **this file**, **its folder "<name>"**, **all of my
  Drive (read)**. The measured 12-links-in-8-seconds burst becomes one
  folder approval; the batch-link design from v4 still applies for files
  scattered across folders.
- The Picker stays as the chooser UI for the dashboard, with a Folders view
  and `setSelectFolderEnabled(true)` (the FOLDERS view accepts trusted
  clicks; keyboard select did not work for folder tiles, measured 09-17).
  Under `drive` the Picker no longer creates a Google-side grant, so the
  `appId` dependency and the grant-verification loop
  (`driveFileGrantCheck.ts`) become dead code for `drive` users; keep them
  behind the scope check until `drive.file`-only users are gone.
- `get_my_permissions` lists folder rules with names and the effective level
  for the whole tree; the Sheets/Docs tool descriptions change from "granted
  per sheet" to "granted per file or folder".

## 5. Scope rollout

Google requires verification **before** code uses a new restricted scope
(`support.google.com/cloud/answer/13464018`); using it earlier shows the
unverified screen and applies the 100-user cap. Sequence:

| step | owner | notes |
| --- | --- | --- |
| Confirm the current CASA Letter of Assessment for `gmail.modify` and its renewal date | Ken | If absent, Gmail is already out of compliance and must be fixed in the same submission |
| Add `…/auth/drive` to the production consent screen, submit scope justification + demo video showing the consent screen and folder rules in use | Ken | Argue "Productivity and education" app type; cite Limited Use compliance |
| CASA (annual): lab scan and Letter of Assessment | Ken + lab (TAC Security $540–1,800, 1–3 weeks) | Restricted Drive data now transits FGAC's servers; the assessment already applies to Gmail |
| Build §1–§4 behind `FGAC_DRIVE_RULES` and test on the dev client, which accepts `drive` for test users with the unverified interstitial (spike, 09-18) | code | No production user sees anything |
| Beta: per-user opt-in via `reauthorize({ additionalScopes: ['…/auth/drive'] })` for up to 100 users behind the unverified screen | code + Ken's invite list | Same mechanism the spike used; opted-in users get folder rules, others stay on `drive.file` |
| After approval: request `drive` at connect for new users; prompt existing users to upgrade from the dashboard's Google card | code | The scope pre-flight (`googleTokenScopes.ts`) already reads the live token, so mixed populations work |
| Retire `drive.file`-only paths once the upgrade share passes ~90% | code | Picker `appId`, grant verification, recovery pages |

**Scopes after the change:** `gmail.modify`, `drive`, OpenID basics. Drop
`drive.file` from the request once the transition ends; a token carrying both
is harmless but the consent screen shows two Drive lines. No Sheets, Docs or
Slides scope is ever requested.

## 6. Phases and estimates

| phase | scope | size |
| --- | --- | --- |
| P1 | Schema + resolver + cache + `checkDriveAccess` with level-0 compatibility; unit tests on precedence, shortcuts, multi-parent, cache TTL | 1 week |
| P2 | Every MCP and proxy Drive door through the choke point; list filtering; denial codes and analytics | 1 week |
| P3 | Approve page with file / folder / all-Drive choices; `request_access` folder support; dashboard folder Picker and rule editor; onboarding checkbox | 1 week |
| P4 | Beta opt-in flow, dashboard upgrade card, QA capability docs (new capability: **folder rules**), monitoring 7.28 (folder adoption, `rule_match_level` mix, lineage cost) | 3–4 days |

Verification and CASA run in parallel with P1–P3 and gate P4's production
default. The batch-approval items from v4 remain worth doing regardless and
are folded into P3.

## 7. Open decisions for Ken

1. Preselect "read all of my Drive" at onboarding, or leave it off (§1.3).
2. Beta population for the 100-user window: the multi-file cohort from v2
   §1.4 (18 people with links for 5+ files in 30 days) is the obvious list.
3. Whether sharing (`permissions.create`) should require an explicit per-
   profile allowance beyond `read_write`, as recommended in §3.3.
4. Whether to keep Picker as the folder chooser or build an FGAC-native tree
   browser on `files.list` now that listing is possible (Picker for P3; the
   native browser is a later polish).
