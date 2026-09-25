# Undeliverable owner notices: bounce ingestion, suppression, and a truthful stop — revision 1

Branch: `claude/festive-nightingale-9126ed` · revision 1 · 2026-09-25

## The case

On 2026-09-23 the dead-grant owner notice (PR #156) went to an own-mailbox
account on a Google Workspace domain two seconds after its first
`grant_revoked` refusal, and two seconds after that Google's own MTA returned
it: DSN `Action: failed`, `Status: 5.1.3`, "The email account that you tried
to reach does not exist". On a Workspace domain that is a deleted mailbox, so:

- `grant_revoked` there is not repairable — the reconnect link the agent is
  told to relay on every refusal is dead, and no owner email can ever land;
- the agent kept running (3 refused calls on 09-23, 1 on 09-24), each time
  handed the same dead link;
- the notice system had no way to know. Nothing in `src/` or `scripts/`
  handles undeliverable mail (verified 09-24 and 09-25).

One account so far; a former heavy Sheets user (hundreds of successful calls
a day through 09-17). This plan is a suppression feature: **no new outbound
email**.

## What was established

### 1. How the sender works, and where a bounce can be seen

- Every owner notice is a `gmail/v1/users/me/messages/send` call to FGAC's
  own proxy API, in-process, with the support profile's proxy key
  (`src/lib/approvalNotify.ts:136` `proxySend`; config
  `src/lib/approvalNotify.ts:98` `senderConfig`, env `SUPPORT_FGAC_PROXY_KEY`
  / `SUPPORT_SENDER_EMAIL`, kill switch `APPROVAL_LINK_EMAIL=off`).
- The sending provider is Gmail. There is no bounce webhook and no
  suppression list: Gmail's only bounce signal is the DSN message the
  receiving MTA mails back to the envelope sender.
- The envelope sender is the support address, which is a **send-as alias on
  the operator's own Workspace mailbox**, not a separate account
  (`docs/implementation_plans/claude_approval-email-from-support_v3.md`,
  "What Ken must provision"). So the DSN lands in the very mailbox the
  support key sends from — `users/me` under `SUPPORT_FGAC_PROXY_KEY`.
- **Ingestion path, therefore: a poller that reads that mailbox through the
  same key, through the same proxy route, in-process** — `GET
  gmail/v1/users/me/messages?q=…` and `messages/{id}?format=raw`. Why that
  credential is allowed: it is FGAC's own consent for FGAC's own mailbox
  (the same grant the send already uses), it goes through the same policy
  layer a customer gets (the proxy's read rules at
  `src/app/api/proxy/[...path]/route.ts:707-719` still apply — the
  reminders profile has no read rules, so DSNs pass), and it touches no
  user's Google grant (Ken, 2026-09-15). The poller reads **only** DSNs
  (`from:mailer-daemon` / `from:postmaster`) and parses only the
  delivery-status fields and the echoed original headers; it never logs a
  body and never touches the operator's human mail.

### 2. Do Clerk or Google say "user deleted" directly?

No. Google's token endpoint answers `invalid_grant "Token has been expired or
revoked."` for a revoked grant, a changed password, an aged-out grant AND a
deleted account alike; Clerk relays it as 400 `oauth_token_retrieval_error`
(`src/lib/googleTokenFailure.ts:92-103`, memory note on
`oauth_token_retrieval_error`). Clerk's own `users.getUser` only 404s when
the FGAC-side Clerk user is gone (`owner_not_found`), which is a different
event (the person deleted their FGAC account), and the Workspace admin
deleting a Google mailbox does not touch Clerk. The Directory API could
answer "user does not exist" but needs an admin-scoped grant on the
customer's Workspace, which FGAC will never hold. **The DSN is the only
signal that distinguishes a deleted mailbox from a revoked grant**, and it
is authoritative: Google's own MTA, 5.1.3, on the recipient's domain.

### 3. Bounces to date

Support-mailbox search for DSNs in the last 30 days against the three notice
recipients (`approval_link_notified` / `account_refusal_notified` /
`google_grant_dead_notified`): exactly one, the 09-23 dead-grant notice above.
The two other triggers have produced no bounce; both mail `users.email`,
which is the address the person signed in with, so they can bounce the same
way (a Workspace account deleted after sign-up) and get the same suppression.

## Design

Accepted from the candidate list, with one reshaping: the mark lives in one
**bounce ledger keyed by address** plus a denormalised mark on the
grant-failure row, rather than three parallel column pairs. A deleted mailbox
is a property of the address, not of a request row: one DSN must suppress
all three triggers for that person, and a per-row mark cannot do that for
rows that do not exist yet (the approval-link ledger mints a new row per
request).

### D1. Schema — migration `0018_email_bounces.sql`

New table `email_bounces` (`src/db/schema.ts`, after `googleGrantFailures`):

| column | meaning |
| --- | --- |
| `id` uuid pk | |
| `address` text not null | Final-Recipient, lower-cased (the ledger key; index) |
| `bounce_class` text not null | `mailbox_gone` (5.1.1 / 5.1.2 / 5.1.3 / 5.1.6 / 5.1.10 / 5.2.1: no such mailbox, or disabled — nobody can reconnect) or `rejected` (any other 5.x.x: the mailbox exists but refused FGAC's mail) |
| `dsn_status` text not null | e.g. `5.1.3` |
| `dsn_diagnostic` text | first 200 chars of `Diagnostic-Code`, one line |
| `notice_kind` text | `dead_grant` / `approval_link` / `account_refusal` from the echoed `X-FGAC-Notice` header (D3), `unknown` for notices sent before this PR |
| `user_id` uuid → users | the FGAC user the address resolved to (a `users.email` or a `google_grant_failures.account_email` owner), null when only the header matched |
| `gmail_message_id` text not null unique | the DSN message's id — re-sweeps are idempotent |
| `bounced_at` timestamp not null | the DSN's `internalDate` |
| `recorded_at` timestamp default now | |

Plus on `google_grant_failures` (`src/db/schema.ts:166`): `undeliverable_at`
timestamp, `undeliverable_class` text — set by the sweep for every row whose
`account_email` matches a permanent bounce, so the refusal path and the
7.30 ledger query see it without a join. Only 5.x.x (`Action: failed`) is
recorded; 4.x.x delayed notices are ignored.

### D2. The sweep — `src/lib/emailBounces.ts` + `src/app/api/cron/sweep-bounces/route.ts`

- `parseDsn(raw)` — pure: from a `format=raw` DSN, extract `Final-Recipient`
  (rfc822 address), `Action`, `Status`, `Diagnostic-Code`, and from the
  echoed original message its `X-FGAC-Notice` and `From`. Returns null unless
  `Action: failed` and `Status: 5.x.x`. Unit-tested against a fixture shaped
  like the 09-23 DSN with example.com addresses
  (`scripts/test-email-bounces.ts`, added to `mcp:lint`).
- `sweepBounces()` — lists `(from:mailer-daemon OR from:postmaster)
  newer_than:30d` through the proxy (`proxyGet`, the GET twin of `proxySend`
  in `src/lib/approvalNotify.ts:136`), skips ids already in `email_bounces`,
  fetches each new one raw, parses, and **records only when the bounce is
  ours**: the echoed `X-FGAC-Notice` header is present, OR the recipient is
  a known notice recipient (`users.email` or
  `google_grant_failures.account_email`). Anything else (the operator's own
  human mail bouncing) is counted as `unmatched` and never stored. Recording
  = insert `email_bounces` (on conflict do nothing) + mark matching
  `google_grant_failures` rows + `captureServerEvent(ownerClerkId,
  'notice_bounce_recorded', { notice_kind, bounce_class, dsn_status,
  hours_after_send })`. Best-effort throughout; one failure never stops the
  sweep.
- Cron `GET /api/cron/sweep-bounces`, hourly (`vercel.json`; the team is on
  Pro, which allows sub-daily crons), authorised exactly like
  `src/app/api/cron/renew-watches/route.ts:13` (`CRON_SECRET`). Returns
  `{ status: 'disabled' }` when the sender is not configured (local and
  preview by default), otherwise `{ listed, new, recorded, unmatched,
  transient, failed }`. Hourly because the agent behind a dead mailbox is
  refused on every call: a daily sweep would hand it the dead link for up
  to 24 h more. On the first production run the 30-day window backfills
  the 09-23 DSN.

### D3. Identify our own mail — `X-FGAC-Notice` header

`approvalEmailRaw` (`src/lib/approvalNotifyCopy.ts:138`) gains an optional
`notice` field and emits `X-FGAC-Notice: <kind>`; the three callers pass
`approval_link` / `account_refusal` / `dead_grant`. Google echoes the
original headers inside the DSN, which is how the sweep attributes a bounce
to a trigger without guessing from the subject. Notices sent before this
PR are matched by recipient instead (D2).

### D4. Suppression — `notify_status: 'skipped_undeliverable'`

- New `NotifyStatus` member `skipped_undeliverable`
  (`src/lib/approvalNotifyCopy.ts:24`).
- `recipientUndeliverableSql(address)` in `src/lib/emailBounces.ts`: `EXISTS
  (SELECT 1 FROM email_bounces WHERE address = $1)` (every stored row is a
  permanent bounce, so no class filter). Every claim adds `AND NOT` of it
  and reports `reason: 'undeliverable'` when it is what blocked the claim:
  `claimApprovalNotification` (`src/lib/approvalRequests.ts:157`, recipient
  = owner email), `claimAccountRefusalNotification`
  (`src/lib/accountRefusals.ts:102`, owner email),
  `claimGrantFailureNotification` (`src/lib/googleGrantFailures.ts:98`,
  mailbox address). The claim is atomic, so a bounce recorded between the
  ledger read and the claim still wins.
- Dead grant, steady state: `recordGrantFailure`
  (`src/lib/googleGrantFailures.ts:43`) returns `undeliverableAt` /
  `undeliverableClass`; `notifyOwnerOfDeadGrant`
  (`src/lib/approvalNotify.ts:346`) returns `skipped_undeliverable` before
  any claim when they are set, and surfaces the class to the route.
- The per-owner daily cap and the global breaker are unchanged; a suppressed
  notice never stamps `notified_at`, so it costs no budget.

### D5. The truthful stop — refusal text and `list_accounts`

- `src/lib/googleTokenFailure.ts`: new `undeliverableGuidance({ targetEmail,
  keyOwnerEmail, reason, bounceClass, dsnStatus, bouncedAt, dashboardUrl })`.
  For `mailbox_gone` the 🚫 replaces the reconnect text entirely: the
  mailbox no longer exists (FGAC's notice to it came back from Google as
  `5.1.3` on `<date>`), STOP, reconnecting is impossible and retrying will
  not help, remove the account from the task (and from the key's accounts
  on the dashboard for an own mailbox; the delegation for a delegated one),
  and a new address means a fresh FGAC sign-in. For `rejected` the reconnect
  link stays, but the line says the owner email was **not** delivered (the
  DSN code) so the agent must relay the link itself — the opposite of the
  current 📧 "no need to re-ask". `denial_code` stays
  `google_token_unavailable` (the series in §7.13a / §7.30c remains
  comparable) and the `$mcp_tool_call` row adds `mailbox_undeliverable:
  'mailbox_gone' | 'rejected'`.
- Route wiring at `src/app/api/mcp/route.ts:1983-2020`: build the guidance
  after `notifyOwnerOfDeadGrant` answers, so the undeliverable class is known.
- `list_accounts` (`src/app/api/mcp/route.ts:2555-2607`): one batched
  lookup of the accessible addresses against `email_bounces`. An entry
  whose token failure a reconnect would repair AND whose address is
  `mailbox_gone` reports `google_token_failure: 'mailbox_gone'`, `mailbox:
  'gone'`, `bounced_at`, and NO `reconnect_url` / `reconnect_by`;
  `next_steps.stop` replaces `next_steps.reconnect` for it, in the same
  imperative voice ("do not retry … remove this account from the task").
  A `rejected` address keeps its link and adds `owner_notice:
  'undeliverable'`.

### D6. Observability and docs

- `docs/analytics.md`: the new `notice_bounce_recorded` event row;
  `skipped_undeliverable` added to both `notify_status` lists;
  `mailbox_undeliverable` on `$mcp_tool_call`.
- `docs/monitoring.md` §7.30: `7.30e` bounces per week (event + ledger
  read), `7.30c` gains the new status, the "Healthy" paragraph names it, and
  the ledger query adds the two new columns.
- `scripts/env-check.ts:125`: the sender line also says the bounce sweep is
  on/off (same two variables).
- `docs/QA_Acceptance_Test/capabilities/18_google_reconnect.md`: A14 (sweep
  ingests a real DSN, idempotent, only ours) and A15 (an undeliverable
  mailbox suppresses the notice and the agent gets the stop).
- Daily review task file
  (`~/.claude/scheduled-tasks/fgac-user-behavior-review/SKILL.md`, step 4b):
  once this PR is live, a DSN that already has an `email_bounces` row is
  handled — report it once as "marked", never re-raise; only an unmatched
  or unrecorded DSN is a FLAG. Edited in this same session, per Ken's
  standing rule for recurring tasks.

### Rejected

- **Per-row `undeliverable_at` on all three ledgers as the primary mark.**
  Rejected: the approval-link ledger mints a new row per request, so a
  per-row mark would not suppress the next request's email. The address-
  keyed ledger does; the grant-failure row gets the denormalised copy only
  because the refusal path already holds that row.
- **Changing `google_token_fetch_failed.reason` to `mailbox_deleted`.** The
  reason is Clerk's classification and the series has been comparable since
  2026-08-20; the bounce is a second dimension, carried as its own property.
- **A user-facing "your account was deleted" email.** There is no one to
  send it to; the delegate on a delegated mailbox already sees the stop in
  the refusal.
- **Reading the mailbox with a separate service account or Directory API.**
  Not needed (the support key already reads the mailbox that receives the
  DSN) and would add a credential outside the product's own policy layer.

## Validation

- `npm run mcp:lint` (new `scripts/test-email-bounces.ts`: parser fixture
  in the 09-23 shape with example.com addresses, class mapping, the
  `skipped_undeliverable` status, `undeliverableGuidance` wording,
  `X-FGAC-Notice` header emission).
- Local: `npm run db:migrate` on the branch DB; `GET /api/cron/sweep-bounces`
  with the sender off → `disabled`; with USER_A standing in as sender
  (`.secrets/sender.env`, `fgac-dev-sender`) and a probe message carrying
  `X-FGAC-Notice` sent by USER_A's own key to a nonexistent gmail.com address
  → the sweep records one `mailbox_gone` row, a second sweep records nothing
  new, and the DSN for an address that is neither a header match nor a
  ledger recipient is `unmatched`.
- Suppression and the refusal wording cannot be produced end to end on the
  QA accounts (their mailboxes exist, and Rule 7 forbids writing the bounce
  row by hand); capability 18 A15 records that leg as covered by unit test.
- **The real end-to-end test is production**: after deploy the first hourly
  sweep must record the 09-23 DSN (7.30e shows one row, `notice_kind:
  unknown`, `bounce_class: mailbox_gone`), and the next refusal from that
  account's connection — it was still calling on 09-24 — must carry
  `notify_status: 'skipped_undeliverable'`, `mailbox_undeliverable:
  'mailbox_gone'` and the stop text (7.30c). Runbook 7.30e names both.
