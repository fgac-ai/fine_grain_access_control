# Dead Google Grant → Tell the Mailbox Owner — v4 (refusal notice joins the episode model)

> Branch: `claude/lucid-pare-619cae`, PR #156 — v4 adds to v3. Design and
> evidence for the dead-grant notice are in v1–v3.
>
> **v4 changes (2026-09-22):** the daily analytics review's first week of the
> owner-email watch found the sibling notice from PR #142 — the account-refusal
> email — producing exactly the volume Ken asked this branch to prevent. Fixed here
> because it is the same module, the same ledger and the same rule.

## 1. What the watch found (production, 2026-09-16 → 09-22)

Thirteen approval-link reminders, four account-refusal notices, no dead-grant
notices yet (not deployed). Three recipients received more than one email in a
calendar day. One of them received **three account-refusal emails in 16.7 hours**
— the daily cap, exactly — because their agent (a high-volume crawler, thousands
of successful calls a day) guessed three different mailbox addresses between
bursts, and the refusal notice was keyed once-ever per (key, requested value):
three values, three ledger rows, three emails. Only `NOTIFY_MAX_PER_DAY` stopped
a fourth. The owner did read the first email (two Accounts-page visits within
ten minutes), so the second and third added nothing but noise.

## 2. Decision: one refusal email per owner per episode

`claimAccountRefusalNotification` now also requires that the owner has **no
account-refusal row stamped `notified_at` within the last 14 days**, whatever
the refused value. A later value inside the episode records its ledger row as
before (the diagnosis analytics never had), stamps `notify_status:
'skipped_episode'` on the refusal, and sends nothing; the 🚫 text still names
that value and both fixes on every call, so the agent loses nothing. Fourteen
days is the same episode gap as the dead-grant notice; refusals that resume
after a fortnight of silence are a new episode and earn one new email.

The once-per-(key, value) rule stays underneath — it is what makes the ledger
row the diagnosis — and the shared daily cap is unchanged. No global breaker was
added for this trigger: it needs three refusals of one value inside 24 hours
before it can fire at all, so an incident cannot fan it out the way a
deterministic Clerk error code can fan out the dead-grant notice.

Under the new rule the 09-20/21 case sends one email (09-20 21:06 UTC) and the
next two are `skipped_episode`.

## 3. Left as follow-ups (recorded, not built)

- **Approval-link reminders for same-turn bursts.** The same week shows one
  owner receiving two link reminders 108 ms apart (two spreadsheets minted in
  one agent turn, each re-minted to count 2 at the same moment) and four link
  emails over three days; another owner got two different-request reminders
  five minutes apart. Design A in the PR #152 plan v4 — collapse a same-turn
  burst into one link, one reminder carrying the batch — is the fix and is docs
  only so far. It changes the minting model, not the notice, so it stays with
  that branch.
- **The Accounts-page stall after the refusal email.** The emailed owner reached
  Accounts and backed out twice. What the page asks a single-Gmail user to do
  when the agent named an address they do not own is a UI question; PR #158
  (one-click delegation for the second-account case) may already own it.

## 4. Changes

| file | change |
| --- | --- |
| `src/lib/approvalNotifyCopy.ts` | `ACCOUNT_REFUSAL_EPISODE_GAP_MS` (14 d); `NotifyStatus` gains `skipped_episode` |
| `src/lib/accountRefusals.ts` | claim adds the owner-episode `NOT EXISTS` in the same atomic UPDATE; fallback reason `episode` |
| `src/lib/approvalNotify.ts` | `episode` → `skipped_episode` (no 📧 line) |
| `scripts/test-approval-notify-copy.ts` | pins the constant and that `skipped_episode` adds no line |
| `docs/analytics.md`, `docs/monitoring.md` 7.26d, QA cap 14 A17 | one email per owner per episode; `skipped_episode` documented; A17 now asserts the different value's third refusal sends nothing |

## 5. Validation

- `mcp:lint` pins, `tsc`, eslint green. The claim SQL change is exercised by
  capability 14 A17 (the "DIFFERENT value" step now asserts `skipped_episode`);
  that QA step was NOT re-run on this branch after the change — v1's A13 run
  did not cover the refusal notice — so the SQL path is verified by type-check
  and review only until the next capability 14 run.
