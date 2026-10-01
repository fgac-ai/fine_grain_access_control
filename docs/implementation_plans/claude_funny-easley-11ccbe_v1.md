# Approval links opened by a just-created second account resolve as `invalid`

> Branch `claude/funny-easley-11ccbe`, off main @ 8ac8e16 (PR #168). Revision 1,
> 2026-09-30. Follow-up to the second-account repair
> (`second-account-delegation-20e989_v4.md`, PR #158).

## The problem

PR #158 put a one-click "attach this mailbox to the owner's account" panel on
the wrong-account approval card, for the person who signs out of their FGAC
account and comes back as a second Google identity. The most common way that
person *arrives* is by clicking their own approval link with the other Google
account — and for a brand-new account that path never reached the card.

Measured in production PostHog, week to 2026-09-29 (`approval_link_opened`,
`status` read with `JSONExtractString` — `properties.status` resolves NULL on
this event):

| status | opens | people |
| --- | --- | --- |
| fresh | 118 | — |
| already_granted | 20 | — |
| wrong_account | 3 | 2 |
| **invalid** | **15** | **6** |

The 15 `invalid` opens split three ways (re-verified 2026-09-30, per
distinct id):

- **7 opens, 4 accounts created in the same second as the open.** Each has
  `sign_up_completed` 1 s before its first `invalid` open; 3 of the 4 are
  recognisably the second Google identity of an active owner whose agent had
  just minted that link (a work address and its gmail twin; a gmail account
  and a company one; two near-identical gmail handles). None of the four did
  anything afterwards — 0 connections, 0 tool calls; one kept revisiting the
  dashboard's default-profile page for four days. One re-opened the link a
  day later and got `invalid` again, then clicked "Back to dashboard", which
  is what finally created their row.
- **6 opens, one owner, one `docs_write` link** opened 2026-09-26 → 09-28. A
  different mechanism: the signature in the URL is 31 characters where every
  valid link's is 32 — an agent-pasted link that lost its last character.
  The same owner opened and approved three other links normally that week.
  Not conflated with this fix; noted as a follow-up below.
- **2 opens, one person on 09-23** who then approved five links normally.

Over 6 weeks the before-figure query (monitoring §7.29d) finds an `invalid`
open within 2 minutes of the same account's sign-up for 1, 1, 1 and 4
accounts per week — a steady trickle that spiked when approval volume did.

The two `wrong_account` opens that *did* get the card this week were accounts
that already existed. So the repair worked for the people who had visited the
dashboard before and silently skipped the people it was built for.

## Why (verified against the code)

1. **`users` rows are created lazily.** `resolveDbUser` (userHelpers.ts) runs
   on the dashboard's first render (`loadDashboard.ts`), the Accounts page,
   the OAuth-consent page, the partner-consent route and the MCP route. The
   Clerk `user.created` webhook only captures `sign_up_completed` in PostHog;
   it writes no row. So a Clerk account that has not yet reached one of those
   pages has a session and no row.
2. **The approve page was the one Clerk-protected entry point that read the
   row without creating it.** `resolveApprovalLink` began with
   `tryGetDbUser()` and returned `invalid` on null, on the stated assumption
   that a row-less visitor "cannot be a wrong-account case". The signed-up-
   through-the-link visitor is exactly that case.
3. **That null is the only path to `invalid` for a well-formed link.** The
   HMAC-mismatch branch falls through to `resolveWrongAccountLink`, whose
   owner lookup (`resolveApprovalOwner`) resolves the owner from the cleartext
   key id and re-verifies the signature against *them* — it never needs the
   visitor's row. So once the row exists the existing card renders unchanged.

## What ships

- `src/app/dashboard/actions.ts` — `resolveApprovalVisitor()`: the signed-in
  visitor's row, provisioned via `resolveDbUser` (adopt-by-email, else
  create) when the Clerk id has none — the dashboard's own first-render path,
  with the dashboard's own side effects (Default Profile, own-mailbox
  access). `resolveApprovalLink` uses it and returns a `visitor` field
  (`rowProvisioned`, `accountAgeS`) on every variant. `invalid` is now only
  "no usable Clerk session" or "verifies against nobody".
- `src/app/dashboard/approve/page.tsx` — stamps `visitor_row_provisioned` and
  `visitor_account_age_s` on `approval_link_opened`, and
  `visitor_row_provisioned` + `account_age_s` on the wall's
  `delegation_prompt_shown`. No copy change: the fresh account gets the PR
  #158 card exactly as an existing account does, panel first when the
  middleware markers say this browser held the owner's session within 2 h.
- Docs: QA capability 14 **A20** (fixture, steps, control, nevers);
  monitoring **§7.29d** (the after-count and a before-figure query that works
  on pre-deploy rows); `docs/analytics.md` rows for both events.

### Directions considered

| direction | verdict | why |
| --- | --- | --- |
| Provision the row in `resolveApprovalLink` (the dashboard's own path) | **accept** | One place, no new state; the delegate action (`delegateToApprovalOwner` → `getDbUser`) needs the row anyway, so the alternative would have needed a second provisioning on the click. Side effects are the ones "Back to dashboard" would have produced one click later |
| Render the card from the Clerk-side email without a row | reject | Duplicates the identity resolution (`findActiveDelegation`, the delegation write) against a second source of truth, and the row would still be created on the first click |
| A distinct `status: 'invalid_no_account'` | reject | The state should not exist after this change; a boolean on the real status (`wrong_account`) is what §7.29 counts, and the before-figure is derivable from `sign_up_completed` adjacency without a new status |

## Instrumentation

- `approval_link_opened` + `visitor_row_provisioned`, `visitor_account_age_s`
  (all statuses; null when no Clerk session).
- `delegation_prompt_shown {surface: approve_wall}` + `visitor_row_provisioned`,
  `account_age_s` (aligns with the banner/link surfaces' `account_age_s`).
- Server log line `[resolveApprovalLink] provisioned the visitor's users row
  on the approve page (account age Ns)`; `could not provision …` on failure
  (then the generic card, never a 500 — the dashboard retries on the next
  click).

After-measurement (monitoring §7.29d): the before-figure query goes to zero;
`saw_the_card = provisioned_on_approve`; recovery is `delegation_created
{via: 'approve_wall'}` for those people, read through §7.29b.

## QA

- Capability 14 **A20** — on a fresh branch, before USER_B's first sign-in
  there (the branch copies main, whose USER_B row carries the production
  Clerk id; the dev instance's id differs, so the first approve-page visit
  as USER_B is the "session, no row" state): USER_A link → sign out → open
  signed out → pick USER_B → wrong-account card with the panel, server log
  line, `visitor_row_provisioned: true`; control re-open → `false`; A7
  tampered link as the fresh account → still "Invalid link".
- Regression: 14 A5, A7, A19.
- Unit: `npm run mcp:lint` (approval-link and second-account suites unchanged).

Validation evidence is recorded below as rounds complete.

## Follow-up (not in this PR)

- **Truncated signatures.** The 09-26 case (31-char `s`) is an agent rendering
  problem: the link lost its last character between the tool result and the
  click. The invalid card could say "this link looks cut short — ask the
  agent for it again / check the full URL was copied" when `s` is shorter
  than the minted length, and the open event could carry
  `signature_length`. Cheap, separate.
- The reminder email (`src=email`) delivered one of the four cases straight
  into this dead end 16 h after the mint; with the card rendering, the email
  path now lands on the repair too — nothing to change there.
