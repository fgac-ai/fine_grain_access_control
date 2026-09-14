# Approval-link delivery: email the link to the owner on first mint

Branch: `claude/compassionate-leavitt-304fca` · revision 1 · 2026-09-14

## Problem

A policy denial mints a one-click approval link into the tool result and
relies on the agent to relay it. PR #137 stopped retry loops; it did not
touch whether the *person* ever sees the URL. This plan is about delivery.

## What the data says (PostHog project 343912, production, external users)

All queries exclude the five internal/QA addresses and use
`environment = 'production'`. Read per `request_id` (one request = one link);
event counts are retry pressure.

**1. The funnel did not collapse; mint pressure doubled.** Per request, the
week to 2026-09-13 converted *better* than the week before:

| 7d window | minted requests | opened | approved | opened/minted | approved/minted |
| --- | --- | --- | --- | --- | --- |
| 2026-08-30 → 09-05 | 90 | 41 | 33 | 46% | 37% |
| 2026-09-06 → 09-12 | 128 | 71 | 58 | 55% | 45% |

The brief's 62% → 25% was `count()` over events: mint events rose 116 → 208
on 90 → 128 requests. The loss that matters is stable: **~45–55% of
requests are never opened**, and that step is where every unconverted
request is lost (opened → approved is 82%).

**2. `approval_link_opened` fires per render and is not deduplicated.**
14 d: 249 rows over 119 requests (2.09 renders per request). Every count in
this plan is `uniq(request_id)`. (`properties.status` reads NULL by dot
access — `JSONExtractString(properties,'status')`, see analytics.md.)

**3. The never-opened cluster is real, and it splits by client.** 14 d,
top of the list by mint events: one person with 13 requests / 1 opened
(send_whitelist, send_all), one with 8 / 0 (sheets_expose, docs_expose,
docs_write — 570 successful Gmail calls in the window), one with 4 / 0
(sheets_expose), one with 4 / 0 (docs_expose). Two of the three 0-open
people, and the one with 4 / 2, connect through **Claude Code**, whose UI
collapses tool results by default — the person reads the assistant's
paraphrase, and the URL lives in the collapsed block. The rest are on
claude.ai (`Anthropic/Toolbox` + `Anthropic/ClaudeAI` = 90% of linked
denials, 58 people), which shows the assistant text and a tool-result
disclosure; nothing in the event stream records whether the text was
paraphrased (the tool result body is not captured — `response_chars` only).

**4. When a link is opened, it is opened from the chat.** Of 118 requests
opened in 14 d, 79 (67%) were opened within 10 minutes of the first mint
and 56 within 2 minutes. 31 (26%) were opened after more than an hour — a
person coming back later. The in-chat path works when the URL survives.

**5. Out-of-band surfaces today: none.** `src/app/dashboard` has a pending
banner for *connections* (`PendingBanner` in `AgentProfilesView.tsx`), not
for approval requests; nothing in `src` sends mail on mint. Dashboard
reach for the cluster (14 d `$pageview /dashboard*`): three of the six
never/rarely-open people have **zero** dashboard views; the other three
have 7–9 views each and still did not open their links. A dashboard list
would reach half the cluster, at best, and only when they happen to visit.

**6. Gmail reach.** Of 104 people who minted a link in 30 d, 55 had at least
one successful Gmail call (so their grant carries the Gmail scope FGAC would
send with); 49 did not (Sheets/Docs-only, or the Gmail box unchecked at
consent). Of the cluster: every named person except the hourly-job account
has successful Gmail calls in the window.

The denial text already says "show the link VERBATIM" (`AGENT_APPROVAL_PROTOCOL`,
since 2026-08-19) and the request_access `note` repeats it. Adding more
copy is not a lever: the agent surfaces we cannot instruct (a collapsed
tool result) are the ones losing the URL.

## Decision

Accepted: **email the approval link to the account owner's own mailbox on
the first mint of each request**, sent through the owner's own Gmail grant
(FGAC already holds `gmail.send` for the owner, and every send from FGAC is
already this token). Subsequent mints of the same request do not email
again; the denial text says when the email went out.

Accepted (small): a `link_source` on `approval_link_opened` so opens from
the email are separable from opens from the chat, and a `notify_status`
on `approval_link_minted` so the funnel can be read per delivery outcome.

Rejected: rewriting the denial copy again (reason above — measure the
email instead; the copy gains one line naming the email). Rejected for this
PR: a dashboard pending-approvals list (half the cluster never opens the
dashboard; the email reaches them where they already are). Worth a
follow-up if the post-change data shows the *dashboard-visiting* half of
the cluster still not opening.

## Design

### Trigger and dedupe

- Runs in the three mint paths: `policyDenialWithLink`, `sendDenialWithLinks`
  (one email carrying both links), and the `request_access` tool.
- **One email per `request_id`, ever.** `approval_requests.notified_at` is
  claimed atomically (`UPDATE … SET notified_at = now() WHERE request_id = ?
  AND notified_at IS NULL RETURNING …`) *before* any send, so two concurrent
  mints cannot both email; a failed send releases the claim. The
  deterministic `request_id` is what makes the hourly-job case safe: the
  scheduled job that re-minted one `sheets_expose` request for days would
  have produced exactly one email.
- Send denials mint two requests; the email is claimed on the
  `send_whitelist` request (per recipient) and carries the `send_all` link
  too. A batch of N recipients in one turn is N requests, so the **per-owner
  cap of 5 emails per rolling hour** bounds it (a `send_all`-only denial —
  recipients undetermined — claims on `send_all`).
- Skipped without a claim when the owner's grant has no Gmail scope, when
  the token cannot be fetched, or when the cap is hit; the denial text is
  then unchanged (link only). The denial itself never fails because the
  email did: every step is best-effort with a 6 s ceiling, and the mint
  path already awaited two DB round-trips.

### The email

Plain text, `To:` the owner's own address, sent as the owner (the Gmail API
sets `From` from the token). Subject: `FGAC: approve your agent's request —
<one-line grant description>`. Body: what the agent (connection label)
tried, the approval URL(s) with `&src=email` appended, and a line saying
that doing nothing keeps the agent blocked. Agent-controlled strings
(recipient address, `resourceName` title) are CR/LF-stripped and
length-capped before they reach a header or the body; no HTML. The owner's
address is never put in a URL.

### Denial text

Appended after the link line, before `AGENT_APPROVAL_PROTOCOL`:

- sent: `📧 FGAC also emailed this link to the user's own inbox just now
  (subject "…") — if they cannot click the link here, tell them to check
  their email.`
- already sent: `📧 FGAC emailed this link to the user's own inbox at
  <UTC time> (subject "…"); no new email is sent for repeats — tell them to
  check their inbox.`
- skipped/failed: nothing appended.

Prefix invariants hold: the 🚫 refusal sentence stays first.

### Analytics

- `approval_link_minted` gains `notify_status`:
  `sent | already_sent | skipped_no_gmail_scope | skipped_token_unavailable |
  skipped_rate_capped | failed | disabled`.
- New `approval_link_notified` (server) fires only on `sent`: `action`,
  `request_id`, `link_count`, `channel: 'email'`.
- `approval_link_opened` gains `link_source`: `email` when the URL carries
  `src=email`, else `agent`.
- `docs/monitoring.md` 7.22 documents the before/after read.

### Schema

`approval_requests.notified_at timestamp` (nullable). Migration 0013.

## Files

- `src/db/schema.ts`, `src/db/migrations/0013_*.sql` + journal
- `src/lib/approvalRequests.ts` — claim / release / recent-count helpers
- `src/lib/approvalNotifyCopy.ts` — pure: email builder, sanitizers, denial line
- `src/lib/approvalNotify.ts` — orchestration: claim → token → Gmail send
- `src/app/api/mcp/route.ts` — wire the three mint paths
- `src/app/dashboard/approve/page.tsx` — `link_source`
- `scripts/test-approval-notify-copy.ts` (+ `mcp:lint` chain)
- `docs/analytics.md`, `docs/monitoring.md`,
  `docs/QA_Acceptance_Test/capabilities/14_magic_link_approvals.md` (A16),
  `docs/QA_Acceptance_Test/capabilities/16_analytics_events.md`

## Validation

1. `npm run mcp:lint` (unit tests incl. the new copy test), `npx tsc --noEmit`.
2. `npm run db:migrate` against the isolated Neon branch.
3. Local: a runner mints a send denial and a sheets denial as USER_A through
   MCP, confirms one email landed in USER_A's inbox (Gmail via the MCP
   tools), repeats the denial and confirms the "already emailed at" line and
   no second email, opens the emailed link and checks `link_source: email`.
4. `/deploy-pr-preview`, then the same capability-14 A16 pass on the preview.

## Open items

- One email per request, forever: a request re-minted months later (after a
  revoke) gets no new email. Revisit if `already_sent` rows pile up on
  unopened requests older than a week.
- Owners without the Gmail scope (49 of 104 minters in 30 d) get no email
  and no other out-of-band channel; a transactional sender would be a
  separate decision (cost, deliverability, a new secret).
