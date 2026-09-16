# Approval-link reminder email — revision 2: cross-session enrichment

Branch: `claude/approval-email-from-support` · revision 2 · 2026-09-15
Supersedes nothing in v1; adds what the daily-review session handed over
(its local enrichment file carries customer identifiers and stays local).

## What changes under this design vs the withdrawn PR #139 build

- **The scope-less hourly job is now covered.** The worst repeater in the
  review window is a scheduled Sheets read denied at a 1–3 h cadence with
  zero opens and zero dashboard visits. Under #139 it fell into
  "no Gmail scope, no email". Under this branch the sender is FGAC's own
  mailbox, so its next repeat mint ≥ 5 min after the first (trivially true
  for an hourly job) emails once per request — and then never again for
  that request, which is exactly the behaviour the hourly case needs.
- **First real-world read of 7.23.** Three accounts re-minted the same
  requests 5–12× with no approval in 2026-09-07 → 09-14; their ledger rows
  predate the migration with `notified_at NULL`, so their next repeat after
  deploy sends the first production reminders. Watch 7.23a/b in the first
  week for those three specifically.

## Open items added

- **Org rollout, wrong-account opens.** A teammate signed up and seconds
  later opened the operator's link, hit the wrong-account card, and was told
  to sign in as the (masked) owner — an account they may not control. The
  reminder email goes to the request OWNER's sign-up address, which is the
  right person, but the card itself still offers no "forward this to the
  owner" path. Separate change; noted here so it is not lost.
- **`target_hash` is stamped on `approval_link_minted` only**, not on
  `$mcp_tool_call` (the review's join came back empty). 7.23's queries do
  not join on it; anything that does must read it from the mint event.
