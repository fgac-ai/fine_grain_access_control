# Integration train 2026-10-01 — approve-page wall sign-up fix + directory-gap record as one release (v1: local validation)

Branch: `integration/2026-10-01` (from `origin/main` at `464e0e7`, train #173 merged).
Architecture: `docs/adr/002_integration_trains.md` (third train).

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | change | capabilities / ids | migration |
| --- | --- | --- | --- | --- |
| PR #172 | `claude/silly-varahamihira-6e9c5e` | `/dashboard/approve` provisions the signed-in visitor's `users` row with the dashboard's own `resolveDbUser` call, so a brand-new account created by the sign-in wall's Google chooser reaches the wrong-account card and PR #158's one-click delegation instead of "Invalid link"; `invalid` carries `invalid_reason` (`signed_out` / `unprovisioned` / `signature`) | 14 **A20** (new); A5, A7, A19 regression; runbook 7.25 addendum ("Wall sign-ups that saw 'Invalid link'") | none |
| (no PR) | `claude/suspicious-lederberg-bef39d` | investigation record of the 2026-09-27..30 directory-connection gap — every FGAC/Clerk hop verified, no code change; runbook **7.33** for the next time connections stop while everything else is green | none (docs) | none |
| train-owned | — | fold-in of PR #171's additive instrumentation (see "Superseded" below): `visitor_row_provisioned` + `visitor_account_age_s` on `approval_link_opened`, `visitor_row_provisioned` + `account_age_s` on the wall's `delegation_prompt_shown`, runbook **7.29d**, `docs/analytics.md` rows, A20 names the property | 14 A20 (property); runbook 7.29d | none |

Plan files: `claude_silly-varahamihira-6e9c5e_v1.md` (fix; local pre-/post-fix
repro and the PR #172 preview pass), `claude_suspicious-lederberg-bef39d_v1.md`
(investigation record).

## Superseded: PR #171 (`claude/funny-easley-11ccbe`)

Opened 2026-10-01 00:18Z by a parallel session for the same defect, with the
same mechanism (`resolveDbUser` on the approve page, wrong-account path
unchanged) and a different instrumentation choice (`visitor_row_provisioned`
+ account age instead of `invalid_reason`). It edits the same function, the
same page, assertion **A20** and a new runbook section, so the two cannot both
merge. The train carries #172's implementation because it is the validated
one (local pre-/post-fix repro, preview A20 + A5 owner control + A7 tamper
control, PostHog rows confirmed — plan file above); #171's plan records no
completed validation round. #171's instrumentation is strictly additive and
useful (it makes "the row was created by this open" countable), so the train
folds it in as a train-owned commit and keeps its 7.29d query. Nothing in
#171 is lost; it can be closed as superseded by the release PR. Its
follow-up idea (a "this link looks cut short" card for truncated signatures)
stays a follow-up.

## Conflicts

None. Both features merged cleanly (`docs/monitoring.md` auto-merged: the fix
inserts under 7.25, the record appends 7.33 after 7.32). Registry check after
landing and after the fold-in: no duplicate monitoring section ids (last four:
7.30, 7.31, 7.32, 7.33; 7.29d sits between 7.29c and 7.30), no duplicate
assertion ids in any capability file, migrations contiguous (0016–0018) with
no new file on this train.

Runtime code on the train = PR #172's validated head + the fold-in commit
(`git diff origin/claude/silly-varahamihira-6e9c5e HEAD -- src`): two extra
event properties computed from the Clerk user the page already loads, one
`console.log` on the provisioning path, and a `visitor` field on the resolver's
return type. No control-flow change, so #172's preview QA carries over; the
train's own preview run re-executes A20 and the controls anyway.

## Validation

Local (this worktree, Neon branch `integration-2026-10-01`, Node 22):

| check | result |
| --- | --- |
| `npm run db:branch` | branch created from main |
| `npm run db:migrate` | 0018 applied (7 statements); 0001–0017 idempotent skips |
| `npx tsc --noEmit` | clean |
| `npx eslint` on the two changed source files | clean |
| `npm run mcp:lint` | exit 0, 1,390 checks |
| registry check (duplicate `7.<n>` sections, duplicate `### A<n>:` ids) | none |

Preview (release PR `integration/2026-10-01` → `main`): filled in below once
the build is Ready — scope is capability 14 A20 with the A5 owner control and
the A7 tamper control (the only runtime change on the train), plus a run of
the 7.33 query against production PostHog to prove the new runbook section
executes as written.
