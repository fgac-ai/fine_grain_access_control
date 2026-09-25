# ADR-002: Integration trains — land features on one branch, validate once, deploy once

## Status

**PROPOSED** — 2026-09-25. Pilot: `integration/2026-09-25` (PRs #161, #162, #163,
#165, #166 landed as one release; see
`docs/implementation_plans/integration_2026-09-25_v1.md`).

## Context

Every task today follows the same path: worktree → feature branch → PR → Vercel
preview → QA runbooks → merge to `main`. It is simple and it is what the QA
architecture assumes, but at the current rate it produces three costs that scale
with the number of PRs, not with the amount of change:

| measured 2026-09-25 | value |
| --- | --- |
| PRs merged to `main`, last 30 days | 64 |
| "merge origin/main into <branch>" sync commits, last 30 days | 24 |
| open feature branches ahead of `main` | 11 |
| Vercel deployments, last 9 days | 100 (86 preview, 14 production) |
| billable build compute per preview | ~8 CPU-minutes (54 s build × 4 vCPU + post-build) |

1. **Build compute.** Roughly ten preview builds a day, almost all of them for a
   single feature branch that is re-pushed two or three times before it merges.
   Each preview also creates a `preview/<branch>` Neon branch that lives until the
   pruner catches it.
2. **Merge-conflict churn.** Every merge to `main` invalidates every other open
   branch. The five PRs consolidated in the pilot touched eight of the same files
   between them, and three of the collisions were *sequence numbers* in
   append-only registries: two PRs both wrote capability-16 assertion `A30`, two
   both wrote runbook section `7.31`, and all five appended to the `mcp:lint`
   script list in `package.json`. None of those were resolvable by git; each
   needed a human-style renumber and a sweep of cross-references.
3. **QA collisions.** Runners share one dev server, one set of QA Google
   accounts, the shared dev Clerk instance and a Neon branch cap. Two agents
   validating two PRs at the same time trip over each other's account state,
   grants and proxy keys, and the lifecycle capabilities (key lifecycle, Google
   reconnect) mutate exactly the state the other run is asserting on.

The per-PR preview and per-PR QA run were the right shape when there was one
agent. With several agents working in parallel they are the bottleneck and the
cost centre.

## Decision (proposed)

Adopt a **release-train** model with three tiers of branch:

```
main                      ← production; receives ONLY train merges (+ hotfixes)
 └─ integration/<date>    ← the train: one open "release PR", one preview, one QA run
     ├─ claude/feature-a  ← pushed, validated locally, NO PR
     ├─ claude/feature-b
     └─ …
```

### Feature branches: push, don't PR

- Branch from `main` as today (from the train only when the feature depends on
  something already landed there).
- Validate **locally only**: `tsc`, `npm run mcp:lint`, the branch-DB scripts the
  change adds, and the built-in browser against the local dev server on the
  branch's own Neon branch. Record that in the plan file as it is recorded now.
- Push the branch (backup, review, `git log main..claude/feature-a`), but **do not
  open a PR and do not trigger a preview**. Vercel stops building these branches
  via an Ignored Build Step (below). A commit message containing `[preview]`
  opts a single feature back in when it genuinely needs a deployed URL (OAuth
  redirect work, Picker flows, anything Google must be able to call back to).

### Landing: `/land` (new command)

`/land` moves a finished feature onto the open train. It is where conflicts are
resolved — once, serially, against a branch that already contains every earlier
feature — instead of N times against a moving `main`:

1. `git fetch`; `git merge --no-ff <feature>` into `integration/<date>`
   (`--no-ff` keeps each feature a single revertable unit inside the train:
   `git revert -m 1 <feature merge>` backs one feature out without touching the
   rest).
2. Resolve conflicts here. Three registries get a deterministic rule:
   - **capability assertions** (`### A<n>:`) and **runbook sections** (`7.<n>`):
     the train owns the sequence; the landing step takes the next free number and
     rewrites the feature's cross-references (plan, analytics.md, QA doc, code
     comments). `qa-coverage-check.ts` gains a duplicate-id check so a collision
     fails loudly instead of silently double-counting.
   - **`mcp:lint`**: replace the hand-maintained `&&` chain with a glob runner
     (`scripts/run-unit-checks.ts` over `scripts/test-*.ts`, with `*.db.ts` /
     an explicit skip list for the branch-DB scripts). `package.json` then never
     conflicts on a new test again.
   - **migrations** (`NNNN_*.sql` + drizzle journal): land migration-bearing
     features one at a time; the second regenerates its migration on top of the
     train (`npm run db:generate`) rather than merging a renumbered file.
3. `tsc` + `npm run mcp:lint` on the train; push the train. No preview yet.
4. Append the feature to the train manifest (below).

### The train manifest

`docs/trains/<date>.md` — one row per landed feature: branch, plan file, the
capabilities and assertion ids it touches, whether it carries a migration, and
its local validation status. The manifest is the release PR's description, the
QA scope (union of the capability rows), and the review index for a reader who
would previously have had five PRs to open. `docs/trains/CURRENT` names the open
train so `/land` and the QA orchestrator agree on where work goes.

### Validate and deploy once: `/deploy-train`

`/deploy-pr-preview` becomes `/deploy-train` and refuses to run on a branch that
is not `integration/*` (a `--solo` flag keeps the old behaviour for a hotfix):

1. Push the train; open **one** release PR (`integration/<date>` → `main`) whose
   body is the manifest.
2. One preview build, one `deploy-watcher`.
3. One QA pass, dispatched to `qa-env-runner` and scoped to the manifest's
   capability union — the rest of the suite as `skip`, exactly as targeted
   re-tests are scoped today. Because there is one train, there is one runner
   sequence at a time on the shared QA accounts by construction.
4. `qa-coverage-auditor` over the results; fix-and-retest rounds land as
   ordinary commits on the train.
5. Hand back with the review-ready summary; the user runs `/deploy-prod`, which
   merges the release PR.

### Hotfixes

An urgent production fix branches from `main`, uses `--solo`, merges, and the
train syncs `main` once (`git merge origin/main` on the train, not on every
feature).

### Vercel: Ignored Build Step

`vercel.json`:

```json
{ "ignoreCommand": "bash scripts/vercel-should-build.sh" }
```

```bash
#!/usr/bin/env bash
# exit 1 = build, exit 0 = skip (Vercel's convention)
ref="${VERCEL_GIT_COMMIT_REF:-}"
msg="${VERCEL_GIT_COMMIT_MESSAGE:-}"
[[ "$ref" == "main" || "$ref" == integration/* ]] && exit 1
[[ "$msg" == *"[preview]"* ]] && exit 1
exit 0
```

Production and trains always build; feature branches build only on request.
Fewer previews also means fewer `preview/<branch>` Neon branches for the pruner
to carry.

## Consequences

**Wins**

- Preview builds drop from roughly one per push per feature to one per train
  (plus retries). At the measured rate that is the difference between ~86
  preview builds and ~10–15 over the same nine days, and the same ratio for
  preview Neon branches.
- Conflicts are resolved once per feature, at land time, by the agent that
  knows the feature, against a branch that will not move underneath it until the
  next landing. `main` only moves when a train merges.
- The shared QA state (accounts, grants, keys, the dev Clerk instance) is
  touched by one runner sequence at a time without any locking protocol — the
  train *is* the lock.
- A feature that turns out to be wrong after the train's QA is reverted with one
  `git revert -m 1` on the train, not by racing a fix through `main`.

**Costs and risks**

- **Latency to production.** A finished feature waits for the train to cut.
  Mitigation: cut cadence is a policy knob (daily, or "when a change is
  needed"), and `--solo` exists for hotfixes. Today's train is five features in
  one day, which is the natural size.
- **Bigger blast radius per deploy.** One bad feature blocks four good ones
  until it is reverted from the train. Mitigation: `--no-ff` landings make that
  revert a one-liner; the manifest says which feature owns which assertion.
- **Review changes shape.** No per-feature PR means review happens on the
  release PR. Mitigation: the manifest + `git log --first-parent` give a
  per-feature table of contents, and every feature branch is still on GitHub
  with a compare link.
- **Two features that both need a deployed URL** (Google callbacks) still need
  either `[preview]` on one of them or serial landing. This is the one case the
  train does not remove work from.
- **Neon prune timer.** A train branch's local `db:branch` twin ends when the
  release PR merges (existing rule). Finish the train's QA before merging, as
  today.

## Rollout

1. **Pilot (done, this ADR's date):** `integration/2026-09-25` carries the five
   PRs; validation evidence in the plan file. It was assembled by hand with
   exactly the conflict rules above, which is what surfaced the three
   registry collisions.
2. **Tooling PR (next train):** `scripts/vercel-should-build.sh` + `vercel.json`,
   `scripts/run-unit-checks.ts` replacing the `mcp:lint` chain, the duplicate-id
   guard in `qa-coverage-check.ts`, `docs/trains/`, `.claude/commands/land.md`,
   and `deploy-pr-preview.md` → `deploy-train.md` with `--solo`.
3. **Rule changes:** CLAUDE.md General Workflow steps 1 and 6 (branch from
   `main`, validate locally, `/land`; preview + QA are train steps), and the
   QA Subagent Architecture note that runners are dispatched per train, not per
   PR.
4. **Retire the five source PRs** once the train merges (close with a comment
   pointing at the release PR); the other 11 open branches land on later trains
   the same way.

## Alternatives considered

- **Keep per-PR previews, add a QA mutex.** Fixes collisions, saves nothing on
  builds or conflicts. Rejected.
- **Stacked PRs (each feature based on the previous).** Serialises agents and
  makes every rebase cascade. Rejected.
- **Squash-merge trains.** Loses the per-feature revert unit and the
  `--first-parent` table of contents. Rejected in favour of `--no-ff` landings.
