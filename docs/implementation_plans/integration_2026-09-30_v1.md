# Integration train 2026-09-30 — PRs #170, #169, #165, #167 as one release

Branch: `integration/2026-09-30` (from `origin/main` at `8ac8e16`, train #168 merged).
Architecture: `docs/adr/002_integration_trains.md` (second train).

## What landed (in landing order, each a `--no-ff` merge)

| PR | branch | change | capabilities / ids | migration |
| --- | --- | --- | --- | --- |
| #170 | `claude/brave-cerf-54ac0a` | `neonctl@7.0.1` pinned in `scripts/lib/neonctl.ts` for every repo call site; a failed prune delete is logged and skipped instead of aborting the run | none (scripts only, not in the deployed app) | none |
| #169 | `claude/goofy-keller-80448e` | monitoring 7.17 `called_then_silent` documented as a stock; new 7.17b activated-vs-bounced reading | none (docs) | none |
| #165 | `claude/elegant-engelbart-8cebb0` | residual only — the feature merged in train #168; the branch carried two later docs commits (Grok activation status, Cursor availability check is install-time) and a comment in `mcpClientSignals.ts` | none (docs + comment) | none |
| #167 | `claude/festive-nightingale-9126ed` | hourly bounce sweep of the support mailbox; undeliverable owner notices suppressed; deleted mailboxes get a truthful stop with no reconnect link (`list_accounts` + refusals) | 18 **A15**, **A16**; runbook 7.30g; `notify_status: skipped_undeliverable` | **`0018_email_bounces.sql`** (new `email_bounces` table + `google_grant_failures` undeliverable columns) |

Plus one train-owned fix: `16_analytics_events.md` had two `### A29:` headings since
PRs #156/#160 (flagged by the 09-25 train). The dead-grant owner-notice assertion is
renumbered **A32**; the argument-alias assertion keeps A29. Only historical plan files
referenced the old id, so no cross-references changed.

## Conflicts

None. All four merged cleanly; registry check after landing: no duplicate monitoring
section ids, no duplicate assertion ids (after the A32 fix), migrations contiguous
(0016, 0017, 0018) with the journal in step.

Runtime code on the train is identical to #167's validated head except the
comment-only hunk from #165 (`git diff origin/claude/festive-nightingale-9126ed HEAD --
src vercel.json package.json`), so #167's own QA (capability 18 A15 pass with two real
DSNs, A16 unit-covered) carries over unchanged.

## Validation

Local (worktree, Neon branch `integration-2026-09-30`, Node 22):

| check | result |
| --- | --- |
| `npm run db:branch` | branch created through #170's pinned `neonctl@7.0.1` |
| `npm run db:migrate` | 0018 applied (7 statements); 0001–0017 idempotent skips |
| `npx tsc --noEmit` | clean |
| `npm run mcp:lint` | exit 0, 1,394 checks, incl. #167's `test-email-bounces.ts` |
| `scripts/test-grant-failure-episodes.ts`, `scripts/test-notify-claim-race.ts` (branch-DB) | all pass |
| `npm run env:check` | DB + Clerk consistent (dev); sweep off locally (no sender vars), as designed |
| `bash scripts/cleanup-neon-branches.sh --dry-run` (#170) | exit 0; full kept table + cost line printed |

Code review of #167's runtime risk points: the cron route refuses without
`CRON_SECRET` in production; `lookupUndeliverable` (now awaited by every
`list_accounts`) catches and logs DB errors and returns an empty map, so a ledger
failure degrades to today's behaviour rather than breaking the tool.

Production prerequisites (checked with `vercel env ls production`, read-only):
`CRON_SECRET`, `SUPPORT_SENDER_EMAIL`, `SUPPORT_FGAC_PROXY_KEY` are all set in
Production — #167's v2 blocker (`CRON_SECRET` missing) was cleared on 2026-09-25.
The team is on Vercel Pro, so the hourly `30 * * * *` cron schedule is allowed.

Preview: see v2.

## After deploy

Follow #167's v2 "What production must show" list (runbook 7.30g): within an hour, one
`notice_bounce_recorded` row for the 09-23 deleted mailbox (`mailbox_gone`, 5.1.3), then
`skipped_undeliverable` on that connection's next refusal. The first sweep's 30-day
backfill also files a handful of `unmatched` / `transient` rows from the support
mailbox's own history — expected, not a finding.

The four source PRs close with a pointer to the release PR once it merges
(ADR-002 rollout step 4).
