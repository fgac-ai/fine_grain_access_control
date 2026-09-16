# Approval-link reminder email — revision 4: the refusal that mints no link

Branch: `claude/approval-email-from-support` · revision 4 · 2026-09-16
Adds one trigger to v1–v3; everything there stands. Evidence: the daily
review's local enrichment for this PR (customer identifiers stay in that
file; this document names accounts only by role).

## The gap v2 claimed was covered

v2 said "the scope-less hourly job is now covered". It is not. The job that
motivated the feature has, since 2026-09-09, been refused with
`denial_code: account_not_permitted` on every run — the caller passes an
`account` value the key cannot use — and that path returns
`accountNotPermittedByCaller` (`src/lib/denialCopy.ts`), which by design
mints nothing: "no approval link exists for it". No mint ⇒
`notifyOwnerOfApprovalLinks` never runs ⇒ the v1–v3 email never fires for
this person, whose last dashboard visit was 2026-09-05.

## Established before designing (production, read-only, 2026-09-16)

1. **What the task passes vs. what the key can use.** Not recoverable from
   analytics: `$mcp_tool_call` carries `account_email` only on a RESOLVED
   call; a refused call carries `denial_code` and nothing about the value
   that was refused. The refusal text's `response_chars` (566, constant)
   minus the fixed copy and the key's one usable address implies the
   refused value is 20 characters long — a different address, not a case
   or whitespace variant of the usable one (21 characters). The value
   itself is logged nowhere. This revision records it (DB row + analytics
   property) so the next diagnosis does not need arithmetic.
2. **Was that mailbox ever on the key?** No. The account has one key
   (the Default Profile) with exactly one access row (its own address),
   and zero delegation rows as owner or delegate, ever. Every resolved
   call in 30 d resolved to the own address (`account_delegated: false`).
   So the fix is not "re-add a revoked mailbox"; it is either change the
   task or connect that other account and delegate it.
3. **Who hits this repeatedly (30 d, `denial_code: account_not_permitted`,
   the caller-chosen 🚫 form):**

   | caller | refusals | distinct days | shape |
   | --- | --- | --- | --- |
   | the scheduled-job account | 53 | 6 | 7–11 a day, 1–3 h cadence, one client (Anthropic/Toolbox), never a retry without the parameter since 09-11 |
   | a second account (ClaudeAI) | 1 (+7 on 08-31 in the pre-graduation ❌ form) | 1 | each refusal followed within seconds by a retry on the right account — self-correcting |
   | six others (incl. the QA account) | 1–2 | 1–2 | one-off exploration |

   Any threshold from 3 to 7 refusals in 24 h separates the same two
   callers from the rest; **3** is chosen because it emails earliest
   (the job would have been emailed ~3 h into 09-09 instead of never).
   The 08-31 self-correcting case is the known false positive: one email
   in 30 d, and the same misconfiguration recurred there on 09-16, so the
   email would not have been wasted.
4. **"No dashboard pageview since the first refusal" — rejected.** On
   09-05 the job's owner had a dashboard session (approve page, accounts
   page, a Google reconnect) starting 66 s AFTER the first
   `account_not_permitted` refusal, and the refusals continued for 11
   days. The dashboard cannot show what the task passes, so a visit is
   not evidence the person knows; the condition would have suppressed the
   email in exactly the case that needs it. It is also not knowable
   server-side without querying analytics from the request path.
5. **PR #137's copy change did not reach this caller — and removed the
   one path that used to mint.** Until 09-10 the job sometimes retried
   without the parameter, which resolved to the own address and minted
   (mint_count reached 6 and 9). Since the 🚫 text says "do not retry",
   zero calls have resolved: the copy stopped the retries without changing
   the task. Text-only is therefore rejected as the fix; it was measured.

## Design: a second trigger for the same sender

`notifyOwnerOfAccountRefusal` (`src/lib/approvalNotify.ts`), called from
`resolveAccountAndToken` on the caller-chosen `account_not_permitted`
branch only (the default form — no `account` given, owner's own address
not on the key — is a different misconfiguration with no repeat evidence).

- **Ledger**: new table `account_refusals`, one row per
  `(proxy_key_id, requested_email)` (lower-cased, 254-char cap):
  `refusal_count` (ever), `window_started_at` / `window_count` (the
  rolling 24 h window resets when the previous refusal is older than 24
  h), `first_refused_at`, `last_refused_at`, `last_tool`, `notified_at`.
  Every refusal is one upsert (the hourly job costs one row, updated). A
  row keyed on key + requested account is chosen over a column on
  `approval_requests` because there is no approval request here to hang
  it on, and over `proxy_keys` because two different wrong values on one
  key are two different problems. Migration 0014.
- **Trigger**: the upsert returns the window count; at
  `ACCOUNT_REFUSAL_NOTIFY_AFTER` (3) or more with `notified_at` NULL, claim
  it. **Once ever per (key, requested account)**: `notified_at` never
  clears except on a definite non-send (4xx), exactly like the link
  ledger.
- **Cap**: the same 3-per-person-per-rolling-day cap, now counting
  `notified_at` stamps across BOTH ledgers inside each claim statement
  (`recentNotificationCountSql`), so the two triggers share one budget.
- **Sender, transport, kill switch**: unchanged — the support profile's
  key through FGAC's own proxy API; `SUPPORT_FGAC_PROXY_KEY` /
  `SUPPORT_SENDER_EMAIL` absent = off; `APPROVAL_LINK_EMAIL=off` = off.
- **Email**: names the agent, the count and first time, the account the
  task passes, the accounts the key can use, and both fixes (change the
  task / connect and delegate that account, with the accounts page URL).
  Says plainly that no approval link exists and that FGAC will not email
  about this account again. Reply-To support.
- **Denial text**: the 🚫 refusal gains a 📧 line only when an email was
  sent (or already had been), mirroring `notifyDenialLine`.
- **Analytics**: the refusal's `$mcp_tool_call` row gains
  `account_requested`, `account_refusal_count` (window) and
  `notify_status` (`sent` / `already_sent` / `not_due` /
  `skipped_rate_capped` / `failed` / `disabled`); one
  `account_refusal_notified` event per email (`trigger:
  'account_not_permitted'`, `refusal_count`, `hours_since_first_refusal`,
  `tool`). Runbook `monitoring.md` 7.26d.

## Simulation (30 d of production refusals, threshold 3 in 24 h)

Two emails to two people; nobody capped. The job's owner: one email on
09-09; the self-correcting caller: one on 08-31 (would have been the
pre-graduation form then; the trigger counts only the 🚫 form going
forward). Six one-off callers: nothing.

## QA

Capability 14 A17 (sender configured as in A16): three `sheets_read_range`
calls with an `account` the profile cannot use → the third refusal carries
the 📧 line and one email; a fourth carries "already emailed" and no second
message; `$mcp_tool_call` rows carry `account_requested` and
`notify_status`; capability 16 A25 pins the event.

Local result (2026-09-16, hosted-MCP runbook scoped to 14 A16/A17 and 16
A22/A23): all four pass, run as USER_B. The first attempt as USER_A was
blocked outright — an earlier session's A16 run on the same Neon branch had
already sent USER_A its three reminders that day, and every due send came
back `skipped_rate_capped` (the cap working; capability 14 A16 now says to
check headroom and switch owner rather than clear stamps). A17 observed:
`not_due`, `not_due`, `sent`, `already_sent`; one email in USER_B's inbox
from the QA sender; `account_refusals` row `refusal_count` 4 /
`window_count` 4 / `notified_at` set once; the different value's row at 1
with `notified_at` NULL; one `account_refusal_notified` event and no
`approval_link_minted` row.

Preview: the sender variables are not set on Vercel's Preview environment
(adding them is a `vercel env add`, Ken's call), so the preview pass covers
the refusal path on the deployed build — 🚫 text, `notify_status:
'disabled'`, `account_requested` on the event, and the ledger row on the
preview DB (migration 0014 ran in the build log) — not a send.
