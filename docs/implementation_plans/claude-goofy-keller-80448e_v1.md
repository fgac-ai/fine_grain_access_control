# Directory disconnect rate: is `called_then_silent_7d` a regression? — v1

Branch: `claude/goofy-keller-80448e` (off `main` @ 8ac8e16, 2026-09-30).
Runbook: `docs/monitoring.md` §7.17 (model + query), new §7.17b (flow query).
Daily review: `~/.claude/scheduled-tasks/fgac-user-behavior-review/SKILL.md`,
DIRECTORY DISCONNECT RATE paragraph (edited in the same session, see §5).

## 1. Question

§7.17 counts connected accounts that made ≥ 1 `$mcp_tool_call` and then sent
no `mcp_client_initialize` / `$mcp_tool_call` for 7+ days. On 2026-09-08 it
read 0 for the listing's whole life and the runbook declared "≈ 0, a non-zero
value is a real regression". On 2026-09-27 it read 18 across a 6-week window,
with 4 of the 5 heaviest having hit a Sheets/Docs exposure gate or the
account gate shortly before going quiet. Is that a product regression (a
denial the agent could not resolve, an upstream 400 loop) or dormant Claude
use, and what should the runbook say?

All figures below are production PostHog (project 343912), the five
internal/QA accounts excluded, queried 2026-09-30 ~04:40–05:30 UTC. Per-person
detail stays in the session; this file carries aggregates only.

## 2. Established

### 2.1 The jump is real as a count, but the metric is a stock, not a flow

Same 6-week window, same 7-day silence rule, evaluated as of four dates:

| as of | people | ever_called | called_then_silent_7d |
| --- | --- | --- | --- |
| 2026-09-08 | 177 | 119 | **0** (reproduces the baseline) |
| 2026-09-15 | 210 | 152 | 5 |
| 2026-09-22 | 246 | 183 | 11 |
| 2026-09-30 | 167 | 143 | 17 |

(The 09-30 row has fewer people because the window start moved past the
2026-08-16 launch; the 08-10 week row in the 09-27 table has aged out, which
is why 18 became 17.)

Like-for-like with the 09-08 reading (a 23-day window, the listing's age on
09-08): 8 silent of 76 ever-called in the cohorts since 09-07. So the
non-zero value is not a 6-week-versus-3-week artifact. It is a **stock**: a
caller who stops is counted every day until their connect week leaves the
window, so the figure can only grow from zero until cohorts age out. "≈ 0"
was a property of a 23-day-old listing, not a steady state.

Three facts that settle the mechanics:

- **Not re-installs.** Every one of the 18 has exactly one person id, and
  none has an `mcp_connection_created` after their last call. Four had 2–3
  connections, all created before the last call.
- **The set churns.** Between the 09-27 list and 09-30, 6 of the 18 left (3
  because their connect week aged out of the window, 3 because the connector
  pinged again — one on 09-29, one on 09-28, one on 09-30 — i.e. still
  installed) and 5 entered. Of the 11 silent on 09-22, 2 pinged again by
  09-30 and 0 called again.
- **Silence is sticky for calls, not for installs.** Of the 18, 10 kept
  sending `mcp_client_initialize` for 3–44 days after their last call (the
  connector stayed installed while the person used Claude without it); 8 went
  quiet within a day of the last call (a single-session trial, or a removal
  we cannot distinguish from Claude dormancy).

### 2.2 Heavy accounts: how the last session ended

Full per-day timelines (calls by outcome, denials, links minted / opened /
approved, Picker picks, dashboard pageviews, owner emails, initializes) for
2026-09-01 onward, plus the last 25 calls of each:

| account (calls / ok) | last call | last ping | how the last session ended |
| --- | --- | --- | --- |
| 722 / 710 | 09-14 | **09-29** | 51 of 51 successes on 09-14. The 09-13 errors were 4 of 285 (two Sheets 400s, two null-status errors), all before PR #155's `bad_request_kind` copy deployed on 09-19, and the next day's session was clean. Not a 400 loop. **No longer silent** on 09-30. |
| 333 / 320 | 09-15 | 09-17 | One `account_not_permitted` denial on `gmail_get_attachment`, then the agent corrected the account and made 7 successful calls to the same tool in the next 8 minutes. Ended on success. (The 09-27 note "last call ever" for the denial was off by 8 minutes.) 9 and 12 initializes on the two following days, then nothing. |
| 215 / 190 (university) | 09-06 | 09-14 | Ended on a `docs_not_exposed` denial whose link was never opened — from a person who had opened 6 and approved 27 links in the previous three weeks. The only heavy account whose last call was a denial. 09-04/05 were 89 successes. Aged out of the window on 09-30. |
| 103 / 102 (3-operator org) | 09-10 | 09-11 | 102 of 103 successes, two delegations created that day, one initialize the next day. Ended on success; the whole org went quiet together. |
| 50 / 48 (company, Claude Code) | 09-10 | 09-10 | Two denials earlier that day (`docs_not_exposed`, link not opened; `gmail_settings_unsupported`), then 31 of 33 successes ending on a `gmail_read` success. |

The five that entered the set between 09-27 and 09-30 (352, 146, 11, 8 and
6 calls) all ended on successful calls as well; the 352-call account did its
whole 352 calls in one day and never pinged again, the 146-call account last
called on 08-26 and kept pinging until 09-23.

**Reading:** 4 of the 5 heavy accounts, and 10 of 10 activated accounts in
the 09-30 set, ended their last session normally. The exposure-gate pattern
in the 09-27 note was real (the denials happened) but did not precede the
silence — successes did.

### 2.3 Owner emails: none were sent to any of the 18

`approval_link_notified`, `account_refusal_notified` and
`google_grant_dead_notified` exist in production (1–5 per day since 09-16),
but **zero** rows carry any of the 18 persons. The triggers went live 09-16
(approval-link repeat mint), 09-17 (3rd account refusal) and 09-23 (dead
grant); the one account that hit `account_not_permitted` hit it once, and the
two dead-grant accounts failed on 08-21 and 09-08. So "emails are not read"
cannot be concluded from this cohort — there was nothing to read.

### 2.4 The directory badge

Not available to this session. Upper bound from our events: (17 silent
callers + 9 never-called silent) / 246 accounts messaging in 30 days = 10.6%
if every silent account had clicked disconnect, which the 3 that pinged again
demonstrably had not. **Ken reads the badge; the plan does not infer it.**

### 2.5 The light accounts are the activation leak, re-labelled

13 of the 18 made ≤ 20 calls. Last-call classification:

| ended on | n | what shipped since |
| --- | --- | --- |
| success, then dormant (connector pinged for 9–44 more days, or one-session trial) | 4 | — |
| `google_scope_missing` / `drive_file_scope_missing` (link never opened or none minted) | 3 | PR #166 scope-missing owner notice (in the 09-25 train) |
| dead Google grant (`google_token_fetch_failed`, reads failed, never fixed) | 2 | PR #156 dead-grant owner notice, live 09-23 |
| approval link opened, Picker cancelled or abandoned — one of them opened a link minted under the person's *other* Google account 12 times and was refused each time | 2 | PR #123 Picker cancel recovery; PR #158 second-account pairing, live 09-23 |
| first call 404 / error, never retried (one still pinging 6 weeks later) | 2 | — |

Every one of these went quiet **before** the fix that targets their wall
deployed. They are the §7.18 `sheets_docs_tried_never_succeeded` population,
showing up in §7.17 because a single call counts as "called".

## 3. Candidate directions — verdicts

- **Exposure gate precedes silence → change the denial text.** Rejected for
  the heavy accounts (4 of 5 ended on success; the fifth had approved 27 links
  before). For the light accounts the gate is real but the losses are at the
  scope, grant and Picker steps, each already owned by a shipped or in-train
  PR; a second denial-text rewrite has no evidence behind it. The "surface the
  pending approval in the NEXT call's response" idea has no case here: the
  one unresolved-link ending was the person's last call, so there was no next
  call to carry it.
- **Upstream 400 loops.** Rejected: 4 errors in 285 calls, a clean 51-call
  session the next day, and the connector still pinging on 09-29.
- **Dormant Claude use, normal last sessions.** Accepted for every activated
  account in the 09-30 set. No product change; correct the runbook and the
  daily review's flag rule (this PR), and set the baseline.
- **Win-back email.** Not warranted and not drafted: nothing in the data says
  these people hit something FGAC could apologise for, and Ken's rule is one
  email per event with no cadences.

## 4. Changes in this PR

1. `docs/monitoring.md` §7.17 — the "Healthy" paragraph replaced with the
   corrected reading (stock vs flow, the as-of series, re-install check, set
   churn, badge upper bound, the no-owner-email finding) and a new **§7.17b**
   query: silence by week of last call, split `activated` (≥ 5 successful
   calls) vs `bounced`, with `activated_silent_ended_on_failure`. Baseline
   2026-09-30 recorded next to it.
2. This plan.

No source, schema or config change. No preview QA: nothing in the deployment
changes, so a preview build would validate nothing — stated rather than
skipped silently.

## 5. Changes outside the repo (same session)

- Daily review task definition
  (`~/.claude/scheduled-tasks/fgac-user-behavior-review/SKILL.md`, the
  DIRECTORY DISCONNECT RATE paragraph): "a NON-ZERO called_then_silent_7d is
  a real regression and goes to FLAGS" replaced with the 7.17b rule — flag
  only when a settled week's (≥ 14 days old) `activated_now_silent` exceeds 5
  or 20% of that week's `activated`, or `activated_silent_ended_on_failure`
  > 0; bounced-then-silent is reported under activation.
- Memory `directory-disconnect-rate` updated with the correction.

## 6. New healthy baseline (2026-09-30)

7.17b by `last_call_week` — callers / activated / activated_now_silent /
bounced / bounced_now_silent:

| week | callers | activated | act. silent | bounced | bounced silent |
| --- | --- | --- | --- | --- | --- |
| 08-24 | 8 | 5 | 2 | 3 | 0 |
| 08-31 | 8 | 3 | 1 | 5 | 2 |
| 09-07 | 14 | 9 | 3 | 5 | 3 |
| 09-14 | 17 | 10 | 1 | 7 | 2 |
| 09-21 | 29 | 26 | 3 | 3 | 0 |
| 09-28 | 67 | 67 | 0 | 0 | 0 |

Activated-then-silent: 10 of 120 (8%), 0 of 10 ended on a failure. The
current week always reads 0 and the previous week is still settling.

## 7. Figures from the 09-27 note that did not reproduce as stated

- The 08-10 connect-week row (28 people) is gone: the 6-week window now
  starts 08-19. The 08-17 row is 17 people, not 86, for the same reason.
- "18" is 17 on 09-30 with a different membership (6 out, 5 in, §2.1).
- The 333-call account's last call was not the `account_not_permitted`
  denial; seven successful calls followed it within 8 minutes.
- The 722-call account is not silent: it pinged on 09-29.
- Everything else (per-account call counts, last-call dates, denial codes,
  the 09-13 400s) reproduced.

## 8. Open for Ken

- The badge value on the listing dashboard, to compare with the 10.6% upper
  bound.
- Whether the daily review should also list activated-then-silent accounts by
  domain family (§7.20a lens) when an org goes quiet together, as the
  3-operator org did on 09-10/16. Not added: one instance.
