# Approval-link reminder email from FGAC's support mailbox

Branch: `claude/approval-email-from-support` · revision 1 · 2026-09-15
Evidence and the rejected first design: PR #139
(`docs/implementation_plans/claude_compassionate-leavitt-304fca_v1.md` and `_v2.md`).

## What Ken asked for (2026-09-15)

An email **from an FGAC address** telling the user that FGAC detected their
agent requesting access to a resource multiple times with no approval, with
the approval link and an invitation to let us know if they intentionally do
not want the agent to have that access. Separate tracking for emailed vs
agent-furnished links. Email only when multiple agent requests for the same
link occur. No user receives more than 3 emails in a single day from this
flow, in case an agent asks for many docs at once. Simulate whether that
cap would be hit. Send with the support@fgac.ai credentials.

## Simulation (PostHog, production, external users, 30 d to 2026-09-15)

Trigger = a repeat mint of the same request, at least GAP after the first
mint, with the approve page never opened at that point. One email per
request, so a person-day's count is the number of distinct requests that
became due that day.

| gap | reminders in 30 d | people | max to one person in a day | days the 3-cap engages |
| --- | --- | --- | --- | --- |
| 0 s (any repeat) | 70 | 42 | 4 | 1 |
| 5 min | 42 | 29 | 2 | 0 |
| 10 min | 37 | 27 | 2 | 0 |

The 4-a-day case at gap 0 was one person's agent re-asking four `docs_write`
requests 67–74 s after the first ask — a same-turn retry batch, not four
separate decisions by the person. Largest batches in the window: 15
distinct requests minted by one person in ten minutes (2026-09-04) and 13
by another; a first-mint trigger would have sent those as 15 and 13 emails
in one go, which is exactly what the repeat rule and the cap exist to stop.
**Chosen: gap 5 minutes, cap 3 per rolling 24 h.** Under that rule the cap
would not have engaged once in 30 days, and no person would have received
more than 2 in a day.

Coverage caveat, so nobody is surprised later: of 161 never-opened requests
in the window, only 30 were ever re-asked at all (agents mostly stop after
one denial since PR #137) and 19–30 would have qualified depending on the
gap. The reminder reaches at most ~19% of the never-opened loss; the other
~81% are asked once and never again, and no repeat-triggered channel can
reach them.

## Design

- **Trigger**: on any mint (policy denial, send denial, `request_access`),
  if the request's `mint_count ≥ 2`, `now − first_minted_at ≥ 5 min`, and
  `opened_at IS NULL` and `notified_at IS NULL`. A non-due mint costs one
  SELECT and changes nothing.
- **Dedupe and cap**: one atomic `UPDATE approval_requests SET notified_at =
  now() WHERE request_id = ? AND notified_at IS NULL AND (count of this
  user's notified_at in the last 24 h) < 3 RETURNING …`. Released only when
  the SMTP server definitively refused the message; a timeout keeps the
  claim (a duplicate costs more trust than a missed reminder).
- **Sender**: FGAC's support mailbox over SMTP with an app password
  (`SUPPORT_SMTP_USER`, `SUPPORT_SMTP_APP_PASSWORD`; relay
  `SUPPORT_SMTP_HOST`/`PORT` default to Gmail's, overridable for QA capture).
  From `FGAC <support address>`, Reply-To the same, so "let us know" is a
  reply. Without the credentials the feature is off (`notify_status:
  'disabled'`) and nothing else changes. **No user credential is involved.**
- **Content**: "FGAC has detected <agent> asking N times, without approval,
  to: <grant>. The first request was at <UTC>. … approve it here: <link>
  [Or instead: <send-to-anyone link>] … If you intentionally do not want
  the agent to have this access, do nothing — it stays blocked. Or reply to
  this email to let us know." Plain text; agent-controlled strings are
  CR/LF-stripped and length-capped; the subject is
  `Your agent has asked N times to <grant> — approve it?`.
- **Denial text**: after the link line, `📧 Because this is a repeat
  request, FGAC has also emailed this link to the user just now…`; on later
  mints `📧 FGAC emailed this link to the user at <UTC>; no further email is
  sent for repeats…`. Nothing appended for any other outcome.
- **Tracking**: `approval_link_minted.notify_status` (`sent` /
  `already_sent` / `not_due` / `skipped_opened` / `skipped_rate_capped` /
  `failed` / `disabled`); `approval_link_notified` (once per emailed
  request: `mint_count`, `hours_since_first_mint`, `link_count`);
  `approval_link_opened.link_source` (`email` when the URL carried the
  email's `src=email` marker, kept through the page's sign-out / try-again
  round trips, else `agent`). `monitoring.md` 7.23 compares the two.
- **Schema**: `approval_requests.notified_at` + index `(user_id,
  notified_at)`; migration 0013.

## Not in this revision

- Reply handling is a human reading the support inbox. A "do not remind
  me" link that records a decline would be the next step if replies arrive.
- Preview and local run with the sender off unless the SMTP vars are set in
  that environment; QA uses an Ethereal capture mailbox.

## Validation

`npm run mcp:lint` (incl. `scripts/test-approval-notify-copy.ts`), `tsc`;
capability 14 A16 and 16 A22 locally against an Ethereal relay; preview
build via `/deploy-pr-preview` (sender off there unless env is added).

## What Ken must provision for production

`SUPPORT_SMTP_USER=support@fgac.ai` and `SUPPORT_SMTP_APP_PASSWORD=<Google
app password for that mailbox>` in the Vercel Production environment (no
quotes), then a production deploy. An app password needs 2-step
verification on the support account.
