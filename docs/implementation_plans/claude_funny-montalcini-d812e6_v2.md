# Scope-missing refusals email the mailbox owner — v2 (validation record)

> Branch: `claude/funny-montalcini-d812e6`, PR #166. v1 holds the findings,
> the decision and the mechanism; v2 records what was validated, what was
> not, and why. Main (PR #164: per-owner advisory-lock claims, human agent
> label, fixed signature) was merged in at `3d8e0f7`; the only conflict was
> the `google_grant_dead_notified` row of `docs/analytics.md`, resolved by
> keeping both sides' additions.

## 1. Static checks (merged tree)

`tsc --noEmit` clean; eslint clean on every touched file; `npm run mcp:lint`
(the bundle the Vercel build gates on) exit 0, including the extended
`scripts/test-google-grant-notify-copy.ts` (class rule, `missing_scope`
join, both cause paragraphs, both subjects, drive own-mailbox body, Gmail
delegated body, dead-grant body unchanged) and the updated
`scripts/test-google-scope-copy.ts`.

## 2. Branch-DB test of the trigger path (new, `scripts/test-grant-failure-episodes.ts`)

Runs against the isolated Neon branch with a throwaway example.com owner
(deleted at the end, cascade) and the send seam captured — the real
`recordGrantFailure` / advisory-lock claim / cap / breaker path, without
Google. All 21 checks pass:

- dead grant: first failure inserts, claim stamps, a second dead-grant class
  extends the episode (count 2, still notified);
- class change dead → scope resets (count 1, notices 0, stamp cleared,
  `first_failed_at` moves); the other scope reason extends, never resets;
- `notifyOwnerOfDeadGrant` with `drive_file_scope_missing`: `sent` once, the
  decoded Subject is "Google access to <mailbox> is missing the Google Drive
  file permission — your agent is being refused", To the mailbox, no Cc, the
  body carries the permission framing, the surfaces, "tick the box next to
  Google Drive", the reconnect link and the only-email line; the second and
  the Gmail-reason refusals inside the episode are `already_sent` with no
  second message;
- class change scope → dead sends again with the dead-grant subject; the
  14-day gap still resets within a class; a delegated scope notice Cc's the
  delegate with the delegated subject and paragraph.

## 3. Capability 18 A14 — BLOCKED locally (fixture), not failed

`qa-setup-driver` ran the runbook in the built-in browser (no password,
passkey, Okta or 2FA wall on either QA account). Set up and verified: the
sender fixture (USER_A profile "FGAC reminders (QA)" with a send-whitelist
`*` rule, `.secrets/sender.env`, server as `fgac-dev-sender`), cap headroom,
USER_A's grant repaired with a full-consent reconnect, USER_B's mailbox
already delegated to USER_A. The scope-less fixture could not be arranged:
Google shows an account that already holds every requested scope the
read-only `consentsummary` page ("accounts.dev already has some access",
zero checkboxes), so "Reconnect Google → untick Drive" is impossible until
FGAC's access is first removed on the Google side (A12). The runner reached
that control (Google Account → Linked apps → "Dev FGAC AI" → Remove all
links) and the permission system refused the click as an irreversible
deletion; it correctly did not pursue the outcome another way. No A14
bullet was exercised; nothing failed; both grants were left healthy.

Consequences recorded in this PR: the A14 fixture text now states the
two-step dependency and that step 1 is a human's click; until it is arranged
the ledger rule and the email are covered by §2, and A14 is recorded as
`blocked`, never `skip`. Two observations from the run, not fixed here: a
dev-Clerk cross-origin round trip through accounts.dev flipped the localhost
session from USER_B to USER_A once (re-sign-in fixed it); and the worktree's
`.env.local` had only the `db:branch` lines until re-pulled.

## 4. Preview

Vercel Preview for the merge head `3d8e0f7` built READY in 59 s (SHA
confirmed): https://fine-grain-access-control-6lorz64zc-kenyesh-gmailcoms-projects.vercel.app.
Smoke: `/` 200, unauthenticated `POST /api/mcp` 401, `/dashboard/accounts`
unauthenticated 404 (same as production). The scope refusal cannot be
produced on the preview for the same reason as §3 (the preview runs the same
dev Clerk instance, whose QA grants hold every scope), and the preview's
sender env is not provisioned, so an email from the preview was never
expected. The later commit adds a test script and docs only.

## 5. What to watch after deploy

- `docs/monitoring.md` 7.30e daily for the first week: `sent` once per new
  (owner, mailbox), `already_sent` afterwards, `disabled` absent (the
  production sender vars are set since PR #142), no `skipped_global_capped`.
- 7.30f after 7–14 days against the before-figures: 2 of 9 started a
  reconnect / 1 verified (week to 2026-09-25), 22 of 45 / 9 (30 d). A
  `google_reconnect_incomplete` after the email whose `missing_scopes` still
  lists the scope is an owner who clicked Continue without ticking the box.
- Daily review step 0.8 now reports the scope trigger's count and
  conversion separately.

## 6. Left for a human

To run A14 for real: remove "Dev FGAC AI" from USER_B's Google linked apps
(Google Account → Security → Third-party apps), then the runner's plan works
as written (reconnect with Drive unticked → mint USER_B bearer → three
`sheets_get_spreadsheet` calls → email in USER_A's sent mail / USER_B's
inbox → ledger row → delegated leg → restore both boxes).
