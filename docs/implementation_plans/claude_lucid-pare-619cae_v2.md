# Dead Google Grant → Tell the Mailbox Owner — v2 (one notice, guarded)

> Branch: `claude/lucid-pare-619cae`, PR #156 — v2 (implemented, unit-tested;
> v1 was QA'd end to end locally and on the preview, see the PR comments)
>
> **v2 changes (2026-09-21, Ken's review of v1):** "I'm not sure I want to email
> someone 3 times for an event that occurred once." Ken chose option 1 — ONE email
> per episode, no repeats — and asked for proactive monitoring so the notice can
> never turn into spam. This revision makes three changes to v1 and leaves the
> trigger, recipient, CC and ledger as they were.

## 1. What changed from v1

| | v1 | v2 |
| --- | --- | --- |
| notices per episode | first + repeat at ≥ 7 d + repeat at ≥ 14 d (max 3) | **exactly one** (`GRANT_DEAD_NOTICES_PER_EPISODE = 1`) |
| repeat interval | `GRANT_DEAD_REPEAT_AFTER_MS` (7 d) | removed |
| new episode | failure ≥ 14 d after the previous one | unchanged (a repaired grant that dies again gets a fresh single notice) |
| email closing line | "will email you again only if it is still failing in a week (at most N more times)" | "This is the only email FGAC will send about this account unless it is repaired and disconnects again." |
| subject | "is disconnected" / "is still disconnected" | "is disconnected" only |
| event props | `trigger first\|repeat`, `notice_number`, `max_notices` | `trigger: 'first_failure'`; the two counters dropped |
| global guard | none | **circuit breaker: 10 dead-grant notices per rolling hour across ALL owners**, inside the atomic claim; skipped refusals stamp `notify_status: 'skipped_global_capped'` |
| monitoring | 7.30a–c | 7.30a–d (d = per-recipient emails/day across all three triggers) and **step 0.8 of the daily review task** |

Why the breaker: the dead-grant classes are deterministic by Clerk error code
(that is what makes the trigger safe to fire on the first refusal), so an
auth-provider or Google token-endpoint incident would classify every account as
revoked at the same time and, with first-failure semantics, email every active
owner within minutes. Ten an hour is an order of magnitude above the organic rate
(six affected mailboxes in the 30 days measured) and low enough that an incident
sends a handful of emails, not hundreds. The per-person 3-a-day cap from PR #142
still applies on top, shared across all three notice ledgers.

Why one email is enough: the refusal itself recurs on every agent call, and the
agent's 🚫 text carries the link every time; the delegate is CC'd on a delegated
mailbox and can nudge the owner directly; the dashboard card now reads "Reconnect
Google" for anyone who logs in. An owner who ignores one clear email is not
better served by a second.

## 2. Proactive monitoring (the part that keeps it from becoming spam)

Two layers, both added in this revision:

1. **Runbook 7.30 in `docs/monitoring.md`** is now a spam watch: 7.30a (one row
   per owner + mailbox, `days_dead = 0`, no hour with 5+ rows), 7.30c (guard
   outcomes — `skipped_global_capped` must stay zero, `disabled` absent), 7.30d
   (emails per recipient per day across all three triggers — should return
   nothing), 7.30b (did the owner reconnect).
2. **The daily review task** (`~/.claude/scheduled-tasks/fgac-user-behavior-review/SKILL.md`,
   local, not in the repo) gained an "OWNER EMAIL VOLUME WATCH" section run
   fifth every morning and a report line 0.8. It reports one line when inside
   baseline and FLAGS any recipient over 1 email/day or 3+ days/week, any
   breaker trip, any `disabled`/`failed` climb, and any (owner, mailbox) emailed
   twice in 14 days. Baselines recorded in the task file: link reminders 1–3/day,
   refusal notices ≤ 1/day, dead-grant ≤ 1/day.

## 3. Applied to the measured cases

- The 30-day delegated case: one email to the owner (CC the delegate) on
  2026-09-06, the first day PR #127 classified the failure `refresh_failed`, and
  nothing further while the mailbox stayed dead. The delegate learns which
  mailbox to drop from the task on day one.
- The own-mailbox owner who went dark on 2026-09-17: one email at 22:21 UTC,
  within the same second as the refusal.

## 4. Validation

- `scripts/test-google-grant-notify-copy.ts` re-pinned: one per episode (a
  week later and 90 days later are both "not due"), breaker constant, new
  closing line, `skipped_global_capped` adds no agent-facing line. `tsc`,
  eslint, `mcp:lint` green.
- v1 QA (capability 18 A12/A13, 16 A29) exercised the first-notice path, the
  ledger, the per-(owner, mailbox) suppression on the delegated leg, and the
  preview as USER_A. v2 changes the second-notice path (now unreachable) and
  the copy's closing line; the preview redeploys from this commit. The breaker
  cannot be reached with two QA accounts and is covered by the unit pin.
- Still open from v1: USER_B's dev Google grant is revoked (the QA fixture) until
  Ken signs USER_B in once and accepts Google's consent; the dashboard
  "Reconnect Google" card was not seen live for the same reason.
