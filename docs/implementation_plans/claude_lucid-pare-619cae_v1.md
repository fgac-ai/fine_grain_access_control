# Dead Google Grant → Tell the Mailbox Owner

> Branch: `claude/lucid-pare-619cae` — v1 (implemented, unit-tested; local QA and
> preview validation recorded in the PR)
>
> When Clerk can no longer hand FGAC a Google token for a mailbox, every agent
> call on that mailbox is refused with a reconnect link bound to the mailbox
> OWNER — and until this branch the agent was the only party told. This adds the
> third member of the owner-notice family (after the approval-link reminder,
> PR #142, and the account-refusal notice): an email to the owner from FGAC's
> support mailbox on the first reconnect-repairable failure, weekly while it
> persists, at most three per episode.

## 1. Evidence (PostHog, `environment = 'production'`, re-verified 2026-09-20)

All numbers were re-run against the production project before building; the
review's load-bearing claim (same delegated mailbox all 30 days) held up once the
denial rows were joined at the same second instead of relying on the
`account_email` column, which is NULL on the older `clerk_error` rows.

**Delegated, daily, 30 days.** One key owner's scheduled job calls `gmail_list`
on a delegated mailbox once a day at ~13:25Z. That mailbox: 0 successes and 1
`google_token_unavailable` refusal on every one of the 30 days 2026-08-21 →
09-19 (`clerk_error` to 09-05, `refresh_failed` from 09-06 when PR #127 sharpened
the class — the failure never changed). The same job's OTHER delegated mailbox
succeeds 1–17 times a day, every day. The mailbox owner is a different person on
a different domain, is the only one who can run the reconnect, and has never
been told. The 2026-09-04 header comment in `googleTokenFailure.ts` about "the
account producing one failure a day is healthy" described this job's healthy
mailbox; the dead one has been dead the whole time.

**Own mailbox, went dark.** Five owners hit a non-retryable class in 30 days:

| owner | reason | first failure | recovered | how |
| --- | --- | --- | --- | --- |
| A | grant_revoked | 09-10 05:34 | 09-10 14:11 (8.6 h, 5 refusals) | dashboard visit, `google_reconnect_*` |
| B | grant_revoked | 09-10 09:30 | 09-14 07:58 (4 d, 8 refusals) | 15 pageviews, reconnect events |
| C | refresh_failed | 09-12 13:51 | 09-13 15:50 (26 h, 3 refusals) | reconnect events |
| D | grant_revoked | 09-17 16:32 | never | ONE refusal, 0 pageviews, agent stopped |
| E | grant_revoked | 09-17 22:21 | never (821 calls the 4 days before) | ONE refusal, 0 pageviews, one `mcp_client_initialize` next day, nothing since |

Every recovery went through the dashboard. The two who did not recover each got
exactly one refusal — so any rule that waits for a second failure emails
neither of them. That decides the trigger.

**Volume.** 30-day shape of reconnect-repairable failures: 1/day delegated (the
case above), own-mailbox bursts of 4–8 on three days from two people, singles
otherwise; `no_token` 0; `via = 'proxy'` 0 (the REST proxy path is left out of
scope on that evidence); `grant_check` 6 on one day (the Picker grant check —
not a refusal path, left out).

## 2. Decisions

**Trigger: the first reconnect-repairable refusal.** `reconnectRepairs(reason)`
already defines the set (`no_token` / `refresh_failed` / `grant_revoked`) —
the same predicate `list_accounts` uses to mint a link. `clerk_error` and
`timeout` are retried and hedged as ❌; `owner_not_found` and
`delegation_inactive` have nothing to reconnect. The notice fires ONLY from the
actual refusal in `resolveAccountAndToken`, never from the quiet `list_accounts`
probes (which would notify on every first tool call for every account) and
never from the proxy path (zero cases).

**Recipient: the mailbox owner, CC the delegate when delegated.** `getGoogleToken`
already resolves the token owner (the key owner for an own mailbox, the
`users` row matching the delegated address for a delegation); it now returns
that row on failure. The owner's FGAC address IS the mailbox address, and the
minted `reconnectLink(targetEmail)` is bound to it (`for=`), so the email
carries exactly the link the agent got. On a delegated mailbox the key owner —
the one paying the daily refusal, who cannot fix it from their own page — is
CC'd on the SAME message (one send, one cap slot, one claim; the two already
know each other's addresses through the delegation), and the body has a
paragraph addressed to them. The delegate is never emailed alone.

**Cadence and cap.** Per (owner, mailbox) ledger row (`google_grant_failures`):
notice 1 on the first refusal of an episode; a repeat only if a refusal arrives
≥ 7 days after the previous notice (the daily delegated job argues for weekly:
still refused, owner still unreachable through the agent); at most 3 notices
per episode (an owner who ignores three weekly emails does not want the mailbox
reconnected — the delegate has been told three times which mailbox to drop). A
refusal more than 14 days after the previous one starts a new episode (the
grant was repaired and died again; the gap is longer than the repeat interval so
a still-failing daily job can never reset itself). All three notice ledgers
share Ken's 3-emails-per-person-per-day cap, enforced inside the atomic claim.

**Applied to the two cases.** The delegated job: email to the owner (CC the
delegate) on 2026-09-06 — the first day the failure classified `refresh_failed`
(under `clerk_error` it is retried and never notifies) — again 09-13 and 09-20,
then silence; three chances for the owner to click one link, and the delegate
told three times. Owner E: emailed at 22:21Z on 09-17, within the same second
as the refusal.

**Agent text.** The 🚫 refusal is unchanged; a 📧 line is appended for `sent` /
`already_sent` only, telling the agent the owner has been emailed and not to
re-ask. `notify_status`, `grant_failure_count`, `grant_days_dead` ride on the
`$mcp_tool_call` row.

**Dashboard.** The amber card already rendered for a dead grant
(`checkGoogleAccess` → NO_ACCESS → `ConnectGoogleWarning`), but with first-time
copy ("Connect Google Account" / "Sign in with Google"). `GoogleAccess` now
carries `disconnected: true` when a verified Google account is linked but no
usable token came back, and the card says "Action Required: Reconnect Google"
with the revoked / password / aged-out causes. The emailed link auto-fires the
reconnect on the Accounts page as before.

## 3. Changes

| file | change |
| --- | --- |
| `src/db/schema.ts`, `src/db/migrations/0015_google_grant_failures.sql` | ledger `google_grant_failures` (owner + mailbox unique; `first/last_failed_at`, `failure_count`, `last_reason`, `notified_count`, `notified_at`) |
| `src/lib/googleGrantNotifyCopy.ts` (new, pure) | constants (7 d repeat, 3 max, 14 d episode gap), `grantNoticeDue`, subject/body/cause copy, `deadGrantDenialLine` |
| `src/lib/googleGrantFailures.ts` (new) | `recordGrantFailure` (upsert with episode reset), atomic `claimGrantFailureNotification` (max, interval, shared cap in one UPDATE), release on definite non-send |
| `src/lib/approvalNotify.ts` | trigger 3 `notifyOwnerOfDeadGrant`; event `google_grant_dead_notified` captured for the OWNER |
| `src/lib/approvalNotifyCopy.ts` | `approvalEmailRaw` gains an optional sanitized `Cc` |
| `src/lib/approvalRequests.ts` | `recentNotificationCountSql` counts the third ledger |
| `src/app/api/mcp/route.ts` | `getGoogleToken` returns the token owner on failure; `resolveAccountAndToken` notifies and appends the 📧 line |
| `src/app/dashboard/googleAccess.ts`, `src/lib/googleScopeCopy.ts` | `disconnected` state → "Reconnect Google" card copy |
| `scripts/test-google-grant-notify-copy.ts` (+ `mcp:lint`), `scripts/test-google-scope-copy.ts` | pins |
| `docs/analytics.md`, `docs/monitoring.md` §7.29 (+ pointer in §7.13a) | event row, runbook (7.29a sent, 7.29b did it work, 7.29c delivery health) |
| `docs/QA_Acceptance_Test/capabilities/18_google_reconnect.md` A13, `16_analytics_events.md` A27, `14_magic_link_approvals.md` A16 headroom | QA assertions |

## 4. Out of scope, deliberately

- REST proxy path (`fetchClerkGoogleToken`): 0 reconnect-repairable failures
  in 30 days; the classifier is shared, so wiring it later is a call site.
- Picker grant check (`getOwnerGoogleToken`): a dashboard flow the owner is
  already looking at.
- A dashboard "pending notices" surface: the Accounts page already shows the
  card and auto-fires the reconnect from the emailed link.
- Emailing the delegate ALONE, or a separate delegate email: one CC'd message
  covers it without a second cap slot or a second sender path.

## 5. Validation

- `npm run mcp:lint` (includes the new pin), `tsc --noEmit`, eslint: green.
- Migration generated, renamed, journal tag fixed, `npm run db:migrate` applied
  on the branch DB (`claude-lucid-pare-619cae`).
- Local QA: capability 18 A13 (own + delegated legs, ledger, cap, never-cases)
  and 16 A27, with USER_A as the stand-in sender — results in the PR.
- Preview: `/deploy-pr-preview`; note (cap 18 A12) that every delegated mailbox
  on a preview reads `owner_not_found` (production Clerk ids against the dev
  instance), which is NOT a reconnect-repairable class and must not notify.
