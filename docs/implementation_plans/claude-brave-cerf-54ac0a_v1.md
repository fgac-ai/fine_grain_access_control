# Pin the Neon CLI and make a failed prune delete non-fatal — v1

Branch: `claude/brave-cerf-54ac0a` · 2026-09-30

## Problem

The daily `neon-branch-prune` task runs `bash scripts/cleanup-neon-branches.sh`.
On 2026-09-26 09:36Z it died on its FIRST delete:

```
🗑️  Deleting stale Neon branch: preview/claude/great-dhawan-c05848 (br-square-shape-adw66ebv) — created 44.4h ago, idle 44.4h
ERROR: Not enough non-option arguments: got 0, need at least 1
❌ Neon CLI error executing: branches delete br-square-shape-adw66ebv --project-id young-lake-60767275
```

Because `runNeonCmd` called `process.exit(1)` on any CLI error, the run aborted
before the 📋 kept table and the 💰 cost line — the two things the task relays.
That day the project had 17 branches, 7 billable.

## What was established (not assumed)

**1. Version drift is real and fast.** `npx --yes neonctl` was unpinned in every
script. Registry publish dates: 5.0.0 (09-18), 5.0.1 (09-22), 6.0.0 (09-23),
6.1.0 / 6.2.0 / 6.2.1 (09-25), 6.2.2 / 6.2.3 (09-26), 6.2.4 (09-28), 6.3.0 /
6.4.0 / 7.0.0 / 7.0.1 (09-29). Twelve releases, three majors, in eleven days —
each daily run used a different CLI. Today unpinned resolves to **7.0.1**.

**2. No single release reproduces the error after the fact.** Every one of
those twelve versions was run with the script's exact command form against a
bogus branch id (a safe 404). All twelve answered `ERROR: Branch … not found`,
i.e. the positional `<id|name>` was parsed. The 09-26 failure was therefore a
transient install state of a dependency that was being replaced underneath the
job — which is exactly the condition a pin removes, and exactly why it cannot
be bisected later. The 09-27 scheduled run (whatever it resolved to that
morning) deleted all 16 stale branches at 09:37Z, two seconds apart; the 09-29
run deleted one more. The delete machinery is not broken today; it was broken
for one run and is unprotected against the next.

**3. Every subcommand the repo scripts use still works on 7.0.1**, verified
against the real project: `projects list` (array), `branches list` (array),
`branches create --compute`, `branches delete <id>` (positional, see probe
below), `connection-string --branch <name> --project-id … --pooled` — the
`--branch` flag is no longer in 7.0.1's help (branch is now a positional) but
is still honoured and resolves to the branch's own endpoint host, not main's —
and `api <path>` (used for `/endpoints`; 7.0.1 adds `-X` for other methods).

**4. The other call sites share the risk.** `scripts/branch-db.ts`
(`npm run db:branch`, three wrappers), `scripts/report-branch-creation.ts`, and
the home-directory `~/.claude/fgac-usage-budget.sh` all called neonctl unpinned.

**5. Error handling.** `set -euo pipefail` in the `.sh` wrapper is irrelevant
(it `exec`s into tsx); the abort was `runNeonCmd`'s `process.exit(1)`. Also
`main().catch(console.error)` exited **0** on an unhandled rejection.

## Decision

- **Pin `neonctl@7.0.1`** in one place, `scripts/lib/neonctl.ts`
  (`NEONCTL_VERSION`, `NEONCTL_SPEC`, `neonctl(args)`), and route all four repo
  call sites through it. 7.0.1 is what unpinned resolves to today, so this is a
  freeze with zero behaviour change, not a downgrade to 4.16.0 (three majors
  back). The budget script gets the same literal pin.
- **Keep `branches delete <id>`** rather than switching to `api … -X DELETE`:
  with the pin both are stable, and the CLI's error text (`Branch … not found.
  Available branches: …`) is the more useful one in a daily report.
- **A failed delete is non-fatal.** New `tryNeonCmd` returns the error instead
  of exiting; success is the exit code (the `-o json` body is deliberately not
  parsed, so a CLI that prints nothing after a successful delete cannot be
  misreported as a failure). The loop logs `❌ Could not delete …`, records it,
  and continues. The summary line, the 📋 kept table and the 💰 line always
  print; failures are listed after the table with the first line of the CLI
  error; the process exits 1 at the end if anything failed, so the scheduled
  task still sees a non-zero run. `main().catch` now exits 1.
- The report prints `CLI: neonctl@7.0.1 (pinned …)` under the policy line so a
  future drift report carries the version.
- Scheduled task `SKILL.md` untouched: flags did not change.

## Verification (2026-09-30, from this worktree, no `.env.local` → exercises the `projects list` fallback)

| check | result |
| --- | --- |
| `npx tsx scripts/test-neon-branch-cleanup.ts` | all classifier tests pass |
| project `tsc --noEmit` | no errors in touched files (two pre-existing errors elsewhere, unchanged) |
| `bash scripts/cleanup-neon-branches.sh --dry-run` | policy + CLI line, 147 merged refs, 3 keeps, 📋 table, 💰 line, exit 0 |
| `bash scripts/cleanup-neon-branches.sh` (real) | same; 0 eligible candidates today, 💰 `4 remain — 0 billable` |
| live delete probe | created throwaway `qa/pruner-delete-probe-2026-09-30` (`--no-compute --no-secrets`), deleted it with the script's exact pinned command form: exit 0, JSON body with `pending_state: storage_deleted`, gone from `branches list` |
| non-fatal path | same `execSync` shape against a bogus id returns `ERROR: Branch br-bogus-000000 not found.` without throwing |

The candidate the 09-26 run died on (`preview/claude/great-dhawan-c05848`) was
already deleted by the 09-27 run, and nothing is eligible today (all branches
under 24h), so a pruner-driven `Deleted …` line could not be produced in this
session. The first scheduled run with an eligible branch will show it; the
`CLI:` line in that report confirms the pinned path ran.

## Rollback

Revert the PR. Nothing persists outside the repo except the one-line pin in
`~/.claude/fgac-usage-budget.sh`.
