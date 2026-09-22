# Dead Google Grant → Tell the Mailbox Owner — v3 (review enrichment addendum)

> Branch: `claude/lucid-pare-619cae`, PR #156 — v3 adds to v2 (one notice per
> episode, global breaker, spam watch); design and evidence are in v1 and v2.
>
> **v3 changes (2026-09-21):** the daily analytics review ran against the 7 days
> to 2026-09-21 and handed this branch three points. Decisions recorded here;
> one copy line changed.

## 1. Fast self-recovery (one owner, 99 s)

One own-mailbox owner hit the `google_token_unavailable` refusal and had a
successful call 99 seconds later — they were driving the agent interactively and
clicked the agent's link. Under first-refusal semantics they receive a notice
for a grant that is alive again by the time they read it.

Decision: **keep first-refusal semantics; add one line to the email.** The body
now says "If you have already reconnected, no action is needed — this email was
sent the moment the agent was first refused." The evidence for first-refusal is
the two owners who got exactly one refusal and went dark for days (v1 §1); a
second-refusal trigger reaches neither, and a synchronous debounce is impossible
on a serverless request. The cost of the current rule is one slightly stale
email to a fast recoverer, which the line addresses. Measured ratio so far: two
dark owners to one fast recoverer.

Follow-up option if 7.29b shows fast recoverers becoming common: a Vercel cron
sweep that sends from the ledger N minutes after `first_failed_at`, re-checking
the grant with Clerk before sending. Not built here — it is a second delivery
path with its own failure modes, and the data does not yet call for it.

## 2. Scope-missing refusals — the population this PR leaves out

Three accounts in the same week were refused daily for a missing SCOPE rather
than a dead grant: one `gmail_scope_missing` every day for 11 days (a scheduled
agent: `list_accounts` ok, then `gmail_list` 🚫), two `drive_file_scope_missing`
on Sheets calls over 2–4 days. The refusal text already carries the reconnect
link (`gmailScopeDenial` / `driveFileScopeDenial` in the MCP route) and the
agent never surfaces it — the same delivery gap this PR closes for dead grants.

Decision: **out of scope for this PR, recorded as the next population.** Reasons:
`DeadGrantReason` is deliberately the reconnect-repairable token-fetch classes;
a narrowed grant is a different mechanism (a plain Google sign-in rewrites the
grant without drive.file, and the dashboard already auto-repairs drive.file
right after sign-in — `ConnectGoogleWarning`), so its copy and its false-alarm
profile differ; and Ken's review of v1 was about email volume — a fourth trigger
should be its own decision with its own count. The 11-day daily
`gmail_scope_missing` case is the strongest argument for the follow-up; it would
reuse the ledger, sender, cap and breaker with `reason` extended to the two scope
classes and a scope-specific cause paragraph.

## 3. Delegated mailbox whose owner never signs in

Confirmed against the code: the notice's `To` is the mailbox address (the
owner's FGAC sign-in), the key owner is CC'd (`approvalEmailRaw` `cc`), and the
cadence since v2 is ONE email per episode — not the weekly repeat the review
asked about, which v2 removed at Ken's request.

## 4. Validation

- `scripts/test-google-grant-notify-copy.ts` pins the new line. `tsc`, eslint,
  `mcp:lint` green. Copy-only change to the email body; no behaviour change.
