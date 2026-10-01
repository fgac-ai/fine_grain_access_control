# Scope-missing refusals email the mailbox owner — v1

> Branch: `claude/funny-montalcini-d812e6`. The follow-up that PR #156's review
> addendum (`claude_lucid-pare-619cae_v3.md` §2) left open: the dead-grant owner
> notice covered `refresh_failed` / `grant_revoked` / `no_token`; the
> scope-missing refusals kept the reconnect link inside the agent's tool result.

## 1. What was established first (production, 2026-09-25)

Sources: PostHog (external accounts, `environment = 'production'`), the Clerk
Backend API read through `.secrets/prod.env` (pulled and deleted; a scratch
script that printed created/last-sign-in/grant-scopes/live-token per account,
counts only in what follows), and `npm run google:scope-sweep -- --prod`.

**1a. First consent vs re-sign-in narrowing — neither, for eight of nine.**
The sweep shows drive.file is in the production sign-in scope set now (33 of
the 37 grants last written by a sign-in carry it; 2 do not), so §7.12's
"a plain sign-in strips drive.file" no longer describes new sign-ins. Of the
nine people refused for drive.file in the week:

| case | people | evidence |
| --- | --- | --- |
| Launch-cohort account, ONE sign-in ever (created 2026-08-16 → 20 = last sign-in), Clerk grant record `[]` or `[gmail.modify]`, live token lacks drive.file | 8 | the permission was never requested: they connected before drive.file joined the sign-in set and never used the Picker. Not narrowing (no second sign-in), not an unchecked box (the box was not on their screen) |
| Same-day sign-up (2026-09-24), record `[]`, live token lacks BOTH scopes | 1 | both consent boxes left unchecked at first consent; then `google_reconnect_started` (agent_link, 40 s after the refusal) → `returned` 7 s later → `incomplete {missing: [gmail.modify, drive.file]}`, and again from the Accounts button 20 s later, same result |
| Re-sign-in narrowing | 0 | every one of the nine has `last_sign_in_at = created_at` except the one who reconnected (that sign-in IS the reconnect) |

A tenth person (signed up 2026-09-25 10:39, refused 10:40, `hasDriveFileScope:
true` on the token bridge by 10:43, then ordinary `sheets_not_exposed` approval
denials) recovered by themselves inside three minutes.

**1b. Does the agent surface the link?** Proxy = `google_reconnect_started`
within 24 h of the first refusal: 2 of 9 (both `source: agent_link`, 40 s and
4 min after the refusal — the link was shown and clicked). 30-day baseline for
the drive.file population: 45 people refused, 22 started a reconnect, 9
verified, 27 opened the dashboard afterwards, 4 refused on 3+ distinct days.
The 30-day reconnect funnel overall: 51 starts (28 people via `agent_link`, 15
via the Accounts button), 43 returns, 37 verified, 4 `incomplete` (3 people) —
so most reconnects work, and the failure mode is specific: a consent pass that
comes back with the same scopes missing. Gmail scope, 30 d: 10 people, 69
refusals, one scheduled Claude Code job refused on 12 distinct days with zero
dashboard visits — the case PR #156's addendum called the strongest argument.

**1c. What the reconnect link does for a never-granted scope.** Read from the
code, no live consent driven from this session: `?reconnect=1&for=<owner>` on
the Accounts page auto-fires `startGoogleReconnect` (`src/app/dashboard/googleReconnect.ts:49`)
on a `verified` external account with `reauthorize({additionalScopes:
[gmail.modify, drive.file], oidcPrompt: 'consent'})` — a full consent screen,
which is right for a scope Google never held. The trap is Google's granular
consent: a permission the account declined before comes back UNCHECKED on the
next screen, so "Continue" alone changes nothing. That is the 7-second
start → returned → incomplete pair in 1a, twice. The A7 failure copy said
"approve every permission"; it now says tick the box, and why.

## 2. Decision

Ship the owner notice for scope-missing refusals (both scopes) as a fourth
trigger of the existing family, plus the two copy fixes the data called for.
Rejected: "fix the top of the funnel instead" as the sole change — for 8 of 9
the top of the funnel was August; nothing at connect time reaches an account
that connected before the scope existed, and `list_accounts` already reports
`drive_file: 'missing'` with a `reconnect_url` (`src/app/api/mcp/route.ts:2576`)
to an agent whose user is not reading it. The email is the only channel that
reaches the eight. The denial-copy and consent-copy fixes ride along because
they are what the ninth person needed.

## 3. Mechanism (file:line on this branch)

- **Reasons and copy** — `src/lib/googleGrantNotifyCopy.ts:57` `ScopeMissingReason`
  (`gmail_scope_missing` | `drive_file_scope_missing`, the refusal's
  `denial_code`), `GrantNoticeReason`, `grantNoticeClass` (dead | scope),
  `missingScopeOf` (joins to `google_scope_missing.scope`). Cause paragraphs at
  `:151` lead with the measured cause (pre-drive.file connection, then the
  checkbox; never a sign-in). Subject at `:179` says "is missing the Google
  Drive file permission" instead of "is disconnected". Body at `:197` uses the
  permission framing, names the failing surfaces, keeps the owner-bound link,
  and at `:229` tells the owner to tick the box and why. Closing line: only
  email "unless it is granted and goes missing again"; decline = do nothing.
  Constants unchanged: one notice per episode, 14-day gap (`:93`), 10/h global
  breaker (`:103`), 3-a-day per-recipient cap shared across the three ledgers
  (`src/lib/approvalRequests.ts:140`).
- **Ledger** — `src/lib/googleGrantFailures.ts:49` `recordGrantFailure` accepts
  the scope reasons; the episode resets when the previous failure is older
  than the gap OR of the other class (`:58` `classChanged`, `last_reason IN
  (scope reasons) IS DISTINCT FROM <new is scope>`). The two scope reasons are
  one class: a mailbox missing both scopes is emailed once and the reconnect
  grants both. No schema change — `last_reason` is `text`
  (`src/db/migrations/0017_google_grant_failures.sql:5`); the column comment in
  `src/db/schema.ts` names the new values. The claim (`:107`) is untouched:
  same atomic stamp, same caps.
- **Trigger** — `src/lib/approvalNotify.ts:359` `notifyOwnerOfDeadGrant` takes
  `GrantNoticeReason`; the capture at `:424` stays on
  `google_grant_dead_notified` (so the volume watch's `event IN (…)` sums it
  unchanged) with `trigger: 'scope_missing'`, `reason`, `missing_scope`.
- **Route** — `src/app/api/mcp/route.ts:584` `getGoogleToken` now returns the
  mailbox `owner` on success (it already did on failure), carried on
  `ResolvedAccount`. `gmailScopeDenial` (`:2061`) and `driveFileScopeDenial`
  (`:2122`) are async and call `notifyOwnerOfMissingScope` (`:2090`) — same
  props as the dead-grant path at `:2007` (`notify_status`,
  `grant_failure_count`, `grant_days_dead`) and the same 📧 line
  (`deadGrantDenialLine`). 18 call sites gained `await`. The drive refusal
  text no longer opens with "signed in to FGAC with Google again"; STOP leads,
  as in the Gmail text (one agent sent six identical `docs_read_document`
  calls in eight minutes against the old text). The quiet `list_accounts`
  probes never reach the denial helpers, so they never email. The proxy-path
  Gmail scope refusal (`src/app/api/proxy/[...path]/route.ts:642`) is left
  alone: 0 proxy scope refusals in 30 d.
- **Consent copy** — `src/app/dashboard/accounts/ReconnectGoogleButton.tsx:33`
  (the `?reconnected=1` failure state) and `src/lib/googleScopeCopy.ts:40`
  (the dashboard card's drive.file gap) say the account was connected before
  FGAC asked or the box was unchecked, and to tick the box. Tests updated
  (`scripts/test-google-scope-copy.ts`).
- **Tests** — `scripts/test-google-grant-notify-copy.ts` pins the class rule,
  the `missing_scope` join, both cause paragraphs, both subjects, the drive
  own-mailbox body, the Gmail delegated body, and that the dead-grant body is
  unchanged. Part of `npm run mcp:lint`.

## 4. Docs

- `docs/analytics.md`: `$mcp_tool_call` `notify_status` on the scope denials;
  `google_grant_dead_notified` `trigger` / `reason` / `missing_scope`;
  `google_scope_missing` cross-reference.
- `docs/monitoring.md` §7.30: 7.30e (per-refusal notice outcome for the scope
  denial codes, with the class-change note) and 7.30f (did the scope email
  work, with the before-figures).
- `docs/QA_Acceptance_Test/capabilities/18_google_reconnect.md` A14 (fixture:
  reconnect with the Drive box unticked — a real Google surface, never a DB
  edit; own-mailbox, delegated, Gmail, class-change, ledger, dashboard, cap,
  never-cases) and `16_analytics_events.md` A30.
- Daily review task file `~/.claude/scheduled-tasks/fgac-user-behavior-review/SKILL.md`
  OWNER EMAIL VOLUME WATCH: the trigger list names `trigger = 'scope_missing'`;
  step 3 splits rows by trigger and treats one dead-grant row followed by one
  scope row on the same mailbox as the designed class-change reset; step 5
  reports scope → reconnect conversion separately with the before-figure;
  step 0.8 and the one-line summary carry the fourth count.

## 5. Volume guard (Ken's standing rules)

One email per event; no reminder cadence (the body promises none). Caps: the
same 3-per-recipient-per-24 h claim, the same 10-per-hour global breaker (a
tokeninfo or Clerk incident that mis-reads every token as scope-less would
otherwise email everyone — the breaker holds it to ten and 7.30e shows
`skipped_global_capped`). Expected organic volume: about 9 drive.file + 4 Gmail
first-refusals a week at today's rate, one email each, fewer once the August
cohort has been told once (the 14-day gap means a still-refused account is
not re-emailed). The class-change reset is the one deliberate second email:
an owner who reconnects a dead grant with a box unchecked, inside 14 d, gets
the scope email — the reconnect was their own new action.

## 6. Validation

- `tsc --noEmit`, eslint on the touched files, and the three copy test
  scripts: green locally.
- Local QA (capability 18 A14, own-mailbox leg, drive.file fixture arranged by
  a real reconnect with the Drive box unticked; sender = USER_A's key per 14
  A16): dispatched to `qa-setup-driver`; result recorded in v2.
- Preview: `/deploy-pr-preview`; result recorded in v2.
- After deploy: run 7.30e daily for a week, then 7.30f against the
  before-figures (2 of 9 started / 1 verified in the week; 22 of 45 / 9 over
  30 d).
