# Second FGAC account → one-click delegation

> Branch: `claude/zealous-bassi-20e989` — v2 (2026-09-21, after local QA round 1)
>
> **v2 changes:** local QA (qa-env-runner, built-in browser, both QA accounts,
> dev server on an autoPort) passed 04 A9, 04 A10, 14 A19 and the 14 A5
> regression, and surfaced two rough edges, both fixed: (1) the delegate-link
> landing rendered the dashboard prompt at the same time — two offers at once;
> the Accounts page now renders one or the other. (2) The wall's done state
> ("✓ attached" + "Switch to <owner>") was replaced after ~250 ms by the
> "already attached" card because `delegateToApprovalOwner` revalidated the
> whole dashboard layout, which re-rendered `/dashboard/approve` inside the
> action response; it now revalidates only `/dashboard/accounts`. Also added
> in v2: the dashboard prompt's **direction** — the NEWER account (the
> accidental one) gets "attach this mailbox to the account you were just in";
> the OLDER account (the primary, where agents are connected) gets "Switch to
> <newer> and attach it here", which signs out to its own delegate link, so a
> person returning to their primary is never offered to delegate it away.
> Event prop `direction` on `delegation_prompt_shown{surface:'dashboard_banner'}`.
> Environment note from the runner: the dev Clerk instance intermittently
> loops back to its hosted sign-in page after Google consent; the session had
> completed and a direct navigation to the app recovered every time (known,
> memory "preview-uses-dev-clerk-and-hosted-loop").
>
> Problem (PostHog production, week to 2026-09-21): FGAC's multi-account model
> is "sign in as the second Google account and delegate its mailbox to your
> first FGAC account". Real users do something else — they create a SECOND
> FGAC account and get stuck between the two. Three instances reconstructed
> from event sequences in one week (2026-09-14, 09-17, 09-19; identifiers stay
> in the analytics session, never in this repo): account A signs up, account B
> is created minutes later from the same sign-out, and B then either opens A's
> approval link repeatedly (every open lands on the wrong-account wall, whose
> only control is "Sign out to switch accounts") or clicks "+ Add account" →
> "Got it" on B exactly as it did on A — the explainer tells B to "sign in as
> the other account", which is what B already is.

## What the code knows today (verified on main at 4f917dc)

- `src/app/dashboard/approve/page.tsx` → `resolveApprovalLink` (actions.ts)
  decides `wrong_account` by resolving the link's true owner from `k` (the
  proxy key id, cleartext in the URL), re-verifying the HMAC against that
  owner, and contrasting with the signed-in `users` row. It knows the owner's
  email (masked for display), the profile label, the real request id — and
  nothing about whether the visitor is the same person. The only control is
  `SignOutAndReturn`.
- Delegation is a pure database write (`createDelegation`, actions.ts): the
  signed-in user is the OWNER of the mailbox being delegated; the delegate is
  looked up by email; `syncDefaultProfileDelegatedAccess` attaches the mailbox
  to the delegate's Default Profile. No Google consent is involved — the
  owner's existing Clerk grant is what the proxy uses. So **the signed-in
  non-owner on the wrong-account wall IS the would-be delegator**, and a
  delegation to the link's owner can be granted from that page in one click,
  with no new consent flow. Sheets/Docs/Slides tools also honour `account:`
  (they run on the delegated account's token), so the delegation covers files
  as well as mail.
- `AddDelegatedAccountButton` is instructional only ("Got it" closes it) and
  `list_accounts.add_more_accounts.own_account` describes the same routine to
  agents. Neither produces anything the second account can act on.
- Same-browser detection: nothing. PostHog cannot pair the two accounts
  either — `PostHogIdentify.tsx` calls `posthog.reset()` on sign-out, so the
  device id rotates between A and B (a 30-day pairing by `$device_id`, and
  by IP + UA, found zero multi-person devices).

## Sizing (production, 30 d to 2026-09-21, internal/QA excluded)

| signal | value |
| --- | --- |
| wrong-account opens (rows / requests / people) | 33 / 11 / 10 |
| …of which the opener's account was under 30 min old | 3 of 12 person-requests (0, 1 and 27 min) |
| …openers who had also delegated at some point | 6 of 12 — multi-account people who still hit the wall |
| "+ Add account" clicks / people; "Got it" people | 30 / 17; 16 |
| `delegation_created` per week | 8, 12, 13(32 rows), 1, 5 — falling |
| sign-ups | 172 |

The wall change catches every wrong-account open by construction (12 of 12
person-requests in 30 d). The dashboard prompt and the delegate link cannot
be sized retroactively — the same-browser join does not exist in PostHog,
which is why this PR adds the cookie marker: from now on the pairing is
measurable (`delegation_prompt_shown{surface:'dashboard_banner'}` counts
second accounts created from a browser that just held another FGAC session).
"~30 known second accounts" (monitoring 7.18 notes) is therefore an estimate
from dashboard-view patterns, not a join; the assertion "N would have been
caught" is not honestly computable and is not claimed.

## Decisions on the candidate directions

| direction | verdict | why |
| --- | --- | --- |
| Wrong-account wall: "Add this mailbox to \<owner\>" | **accept** — primary when the browser held the owner's session moments ago, secondary otherwise | Catches all 12/12 wall cases. Ordering by evidence limits the phishing surface: a link-holder with an FGAC account can send anyone a link, and delegation is read access to a whole mailbox, so a visitor with no prior owner session gets the sign-out button first and a guarded two-step behind it |
| "+ Add account": copyable/openable delegation link | **accept** | Fixes the 09-19 loop: the link IS the action for the second account. `/dashboard/accounts?delegate_to=<users.id>` renders a one-click confirm for whoever opens it signed in; "Switch account now" signs out and returns to it (same mechanism as the wall's sign-out) |
| Sign-up: offer "second mailbox" to a fresh account from a browser that just held another FGAC session | **accept, as a dashboard prompt** rather than a Clerk sign-up interception (Clerk owns that surface; the dashboard is where the new account lands) | Middleware stamps `fgac_last_account` / `fgac_prev_account` (Clerk user ids + timestamps, no PII) on every signed-in `/dashboard*` request; the dashboard shows the prompt when the previous account was active in this browser within 2 h and no delegation exists yet |
| Agent surface: denial text names the account the link needs | **accept** (one clause) | Cheap, tells the agent to tell the user which account to use; `list_accounts.own_account` now hands the agent the delegate link so the user gets a click instead of a routine |

Not signing the `delegate_to` link: an attacker can only ever mint a link
naming their own account (the same thing they can type into no form, but ask
for by email today); the defence is the confirm step naming the recipient and
the consequence, plus revocation from Accounts.

## Ship list

1. `src/lib/secondAccount.ts` (pure, edge-safe) — cookie encode/decode, the
   transition (last → prev on a switch), the prior-account candidate rule,
   `delegateLinkPath`. Unit tests `scripts/test-second-account.ts` (mcp:lint).
2. `src/middleware.ts` — stamp the markers for signed-in protected requests.
3. `src/app/dashboard/actions.ts` — `grantDelegation` core extracted from
   `createDelegation`; `delegateToUser(targetUserId, via)` and
   `delegateToApprovalOwner(link)`; `delegation_created` gains `via`.
   `WrongAccountDetails` gains `ownerClerkUserId` (server-only use) and
   `delegationActive`.
4. `src/lib/delegationTargets.ts` — server read helpers (target by users.id /
   Clerk id, masked email, active-delegation check).
5. `src/app/dashboard/DelegateToPanel.tsx` — the two-step confirm, shared by
   the wall, the accounts-link landing and the dashboard prompt.
6. `src/app/dashboard/SecondAccountBanner.tsx` — server component reading the
   markers; mounted on dashboard index, profile pages and Accounts.
7. `approve/page.tsx` — wall renders the panel (prominent when the markers
   name the owner), "already attached" variant, sign-out kept.
8. `accounts/page.tsx` + `AddDelegatedAccountButton.tsx` — `delegate_to`
   landing; dialog becomes link + "Switch account now" + Copy.
9. `src/app/api/mcp/route.ts` — denial clause + `own_account` link.
10. Docs: user guide, analytics event catalog, monitoring §7.29, QA
    capabilities 04 (A9–A10) and 14 (A19), setup 02 note.

## Instrumentation

- `delegation_prompt_shown` {surface: approve_wall | dashboard_banner |
  accounts_link, prior_session_matches, prior_gap_s, account_age_s, action}
- `delegation_prompt_dismissed` {surface}
- `delegation_link_copied` / `delegation_link_switch_clicked` {surface:
  add_account_dialog}
- `delegation_created` + `via` (form | approve_wall | dashboard_banner |
  accounts_link), `prior_session_matches` where known
- `approval_link_opened` (wrong_account rows) + `delegate_offer`,
  `prior_session_matches`, `delegation_active`

Conversion = `delegation_created{via != 'form'}` / `delegation_prompt_shown`
per surface, per person (monitoring §7.29).

## QA (two accounts, local then preview)

- 14-A19: USER_A link opened as USER_B → wall shows the delegate panel;
  confirm → USER_B's mailbox appears under USER_A's Accessible accounts and
  `list_accounts` on USER_A's connection; the link itself still needs
  USER_A; re-open as USER_B → "already attached" variant. Revoke afterwards.
- 04-A9: USER_A "+ Add account" → copy link → open as USER_B → confirm →
  delegation active; opening the link as USER_A → own-link notice.
- 04-A10: sign out of USER_A on the dashboard, sign in as USER_B → prompt
  names USER_A masked; Dismiss hides it and it stays hidden; confirm path
  creates the delegation.
