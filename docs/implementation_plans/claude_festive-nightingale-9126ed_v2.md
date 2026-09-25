# Undeliverable owner notices — revision 2: validated, one hardening, one production prerequisite

Branch: `claude/festive-nightingale-9126ed` · revision 2 · 2026-09-25 ·
PR fgac-ai/fine_grain_access_control#167. Everything in v1 stands; this
revision records what validation found and what changed because of it.

## Changes since v1

1. **Address retention narrowed (QA finding).** v1 kept the Final-Recipient
   on every ledger row except `unmatched`; the local run showed three 4.x.x
   rows of the QA sender's own correspondence stored with their recipient.
   The sweep now decides "ours" for EVERY parsed DSN (echoed `X-FGAC-Notice`
   header, or a recipient a notice ledger knows) and `recordBounce` keeps
   the address only when it is ours — whatever the class
   (`src/lib/emailBounceSweep.ts`, `src/lib/emailBounces.ts`
   `RecordBounceInput.ours`). The operator's mail never lands in FGAC's
   database, not even as a delayed notice.
2. **Merged main's PR #164** (serialised notice claims under an advisory
   lock, one link reminder per agent turn). Both sides added to the three
   claims: main's lock and `burst` rule, this branch's bounce check and
   `recipient` argument. `scripts/test-notify-claim-race.ts` passes with the
   new argument (12/12 on the branch DB).
3. **Production prerequisite found: `CRON_SECRET` is not set in the Vercel
   Production environment.** Every `/api/cron/*` route (the two existing
   crons included) answers 401 to Vercel's scheduler without it
   (`docs/partner_onboarding_runbook.md` step 2 already says so). Until Ken
   sets it, the hourly sweep never runs in production and the 09-23 DSN is
   never filed. Documented in runbook 7.30e as the first thing to check
   when the section stays empty. Setting an env var is a user action:

   ```bash
   npx vercel env add CRON_SECRET production
   ```

   (any long random string, pasted without quotes; then redeploy).
4. A14 no longer asks the runner to assert the sweep's `User-Agent` from
   telemetry: the request carries `fgac-bounce-sweep`, but the
   `proxy_request` event records no user-agent property.

## Validation

| leg | where | result |
| --- | --- | --- |
| `npm run mcp:lint` (incl. `scripts/test-email-bounces.ts`, 40 checks) | local, merged tree | green |
| `npx tsc --noEmit`, eslint on touched files | local | clean |
| migration `0018_email_bounces.sql` | branch DB, `npm run db:migrate` | applied (7 statements) |
| `scripts/test-notify-claim-race.ts` (DB-backed, main's race test) | branch DB | 12/12 |
| capability 18 **A14** — sweep files a real DSN once, attributes it, ignores mail that is not ours | local, `fgac-dev-sender`, USER_A standing in as sender (profile recreated per capability 14 A16 — the stored key was a previous branch's) | **PASS**: two real Google DSNs (5.1.1) produced by sending through FGAC's proxy to two random nonexistent gmail.com addresses; sweep 1 `listed 12, fresh 2, mailbox_gone 1 (tagged probe, notice_kind dead_grant, address lower-cased, diagnostic on one line, no user), unmatched 1 (untagged, empty address)`; sweep 2 `fresh 0`, nothing recorded; server log lines as documented |
| capability 18 **A15** — suppression and the truthful stop | unit test (`mailbox_gone` text: 🚫, no link, STOP, remove the account; `rejected` text: link kept, "owner has NOT been told") | covered by unit test; end-to-end is the production observation leg below |
| preview build for every push | Vercel, confirmed by commit SHA | Ready; `GET /api/cron/sweep-bounces` on the preview answers `{ status: 'disabled' }` (sender variables are production-only, as designed); MCP endpoint 401 unauthenticated; home 200 |

Preview (final commit): see PR #167 — the watcher's READY URL for
`58e6220`.

### What production must show after deploy (A15's observation leg)

1. Within an hour of the deploy **and** `CRON_SECRET` being set: runbook
   7.30e shows one `notice_bounce_recorded` row — `notice_kind: unknown`
   (sent before the header existed, matched by recipient), `bounce_class:
   mailbox_gone`, `dsn_status: 5.1.3`, `grant_rows_marked: 1`. Ledger:
   one `email_bounces` row for that address; its `google_grant_failures`
   row carries `undeliverable_at` / `undeliverable_class: mailbox_gone` /
   `undeliverable_status: 5.1.3`.
2. The next refusal from that account's connection (it was still calling on
   09-24) stamps `notify_status: 'skipped_undeliverable'`,
   `mailbox_undeliverable: 'mailbox_gone'`, `denial_code:
   'google_token_unavailable'` (7.30c) and its text is the stop with no
   reconnect link. `list_accounts` on that key reports `google_token_failure:
   'mailbox_gone'`, `mailbox: 'gone'`, no `reconnect_url`, `next_steps.stop`.
3. No `google_grant_dead_notified` / `approval_link_notified` /
   `account_refusal_notified` row for that person ever follows the bounce.
4. The 30-day backfill will also file the support mailbox's older DSNs
   (Ken's own correspondence bouncing): expect a handful of `unmatched` and
   `transient` rows with empty addresses and no events — that is the
   sweep's memory, not a finding.

## Runner observations outside this feature's scope (not fixed here)

- The dashboard briefly showed "Action Required: Connect Google Account" for
  USER_A while Clerk held a live token with every scope; it cleared after
  the first server action. The Clerk external account was `unverified`
  (dev instance), so the runner correctly did not click Reconnect.
- On the profile-create form, a `computer` click on the mailbox checkbox
  did not register once, letting a profile be created with zero mailboxes;
  the profile page then has no way to add one. `form_input` worked.
  Worth a look as a UI hardening item (a profile with no mailbox is inert).
- The QA sender stand-in key in `.secrets/sender.env` is a branch-DB
  artefact; every fresh branch needs the "FGAC reminders (QA)" profile
  recreated. Recorded in memory.
