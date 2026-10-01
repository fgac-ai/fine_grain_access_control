# Wall sign-ups reach the wrong-account card, not "Invalid link"

> Branch: `claude/silly-varahamihira-6e9c5e` — v1 (2026-09-30)
>
> Problem (production, PostHog, the 2026-09-24 case): an owner's agent kept
> minting `sheets_expose` links; PR #142's reminder email went out once; the
> person clicked the emailed link in a browser with no FGAC session, hit the
> approval sign-in wall, and Google's account chooser produced a NEW FGAC
> account (a second identity for the same person). The very first thing that
> new account saw was **"Invalid link"** — not the wrong-account card with
> PR #158's one-click delegation, which was built for exactly this case. They
> bounced off via the logo, came back the next day from the agent's pasted
> link, saw "Invalid link" again, clicked "Back to dashboard", browsed
> Accounts and Pricing, and never delegated or approved. The agent re-minted
> nine more times. Zero approvals, ever, on that request.

## Established (not assumed)

### 1. Where the `users` row is born, and why the approve page never makes one

`resolveDbUser` (`src/db/userHelpers.ts`) is the only provisioning path. It is
called from `loadDashboardData` (every `/dashboard` and `/dashboard/agents/*`
render), `/dashboard/accounts`, `/oauth/authorize`, the partner-consent route,
the MCP route's token path, and `findDelegateUser` when someone delegates to
an address. There is no dashboard `layout.tsx` and the middleware runs on the
edge with no database — nothing provisions a row at sign-in time.

`/dashboard/approve` is the one dashboard page that does not call it:
`resolveApprovalLink` (`src/app/dashboard/actions.ts`) starts with
`tryGetDbUser()`, a SELECT by Clerk id that returns null for a Clerk session
with no row, and that null is returned as `{ status: "invalid" }` before the
owner is ever resolved. The comment there (2026-08-26) was written for a
bystander who received a leaked link; it predates the wall (2026-09-16) and
PR #158 (2026-09-23), which together made "signed in, no row yet" the
*normal* state of the person this card exists for. `delegateToApprovalOwner`
uses the throwing `getDbUser()`, so rendering the card without a row
(candidate b) would still break the one-click delegation behind it.

**Local repro (dev build, fresh branch database, 2026-09-30):** a fresh
`db:branch` is a copy of main, whose `users` rows carry PRODUCTION Clerk ids,
so a QA account on the dev Clerk instance has no row for its own Clerk id
until a dashboard page adopts one (`resolveDbUser` matches by Clerk id, then
by email). USER_B owns the link (`npm run qa:mint-link` reads the owner row
and key offline, so the owner never signs in — USER_B's Google sign-in lands
on the U-M Okta wall in the built-in browser, a hard stop). USER_A, with no
dashboard load on the branch, opens the link signed out → wall → Google
chooser → USER_A → approve page. Pre-fix and post-fix results are recorded in
the QA section. Two harness facts the runner established on the way: a
localhost sign-out alone does not end a dev-instance session (the hosted
accounts.dev client re-adopts it — sign out there too), and the owner
control (USER_A opening a USER_A link) rendered the genuine approve flow, so
the mint matches the deployment.

### 2. How many of the week's 'invalid' opens were this

`approval_link_opened{status='invalid'}`, 2026-09-21 → 09-28 (production):
15 opens by 7 accounts. One account is internal (QA/Ken; 1 open), so the
external figure is 14 opens by 6 people, split by joining each open to the
same distinct id's `sign_up_completed` and to `approval_sign_in_wall` rows for
the same action in the prior ten minutes:

| class | opens | people | evidence |
| --- | --- | --- | --- |
| wall → new Clerk account → open, no row | 7 | 4 | `sign_up_completed` 1–25 s before the open, a wall hit for the same action 12–247 s before, no dashboard pageview before the open, 0 delegations, 0 approvals ever |
| existing account, genuinely bad link | 7 | 2 | both had approved links before the invalid open (4 and 5 approvals); no wall hit preceded the opens; one pasted a `docs_write` link five times in four minutes |

So half the external 'invalid' opens, and four of the six people, were the
no-row case. Four-week view (2026-08-30 → 09-28, internal excluded):
invalid 21 opens / 11 people, against wrong_account 38 / 12 — the card
PR #158 improved was reaching roughly half the people it was built for.

The 09-24 16:50:07 `/dashboard/approve` pageview under the OWNER's identity is
the same browser, not a second device: it shares `$session_id` and
`$device_id` with the new account's `$set` 240 ms later and every subsequent
event. posthog-js still carried the owner's persisted distinct id from an
earlier session in that browser and switched on identify. It also says the
person had been signed in as the owner in that browser before — the session
had lapsed, and the chooser offered both identities.

### 3. Does the wall create the second account?

The wall is Clerk's hosted sign-in (`ClerkProvider` has no `signInUrl`;
`auth.protect()` redirects with `redirect_url` only). Nothing FGAC renders
sits between the link and Google's chooser, the edge has no database to
resolve the owner, and Clerk's hosted page accepts no login hint we could
populate from the link's params. The chooser lists every Google identity the
browser holds; picking one that has no FGAC account creates one — `sign_up_completed`
one second before the open is Clerk's `user.created` webhook for the chooser's
pick. Candidate (c) — owner-hinted sign-in copy — has nowhere to render
without an FGAC interstitial, which is an extra click on every wall hit for
everyone (rejected: no extra user steps). The wrong-account card IS the
recovery for a mis-chosen identity, so the fix is to make sure it renders.

## Ship list

1. **`resolveApprovalLink` provisions the visitor's row** (candidate a).
   When Clerk reports a signed-in user and `tryGetDbUser()` finds no row,
   call `resolveDbUser` — the same call the dashboard makes — and continue.
   A brand-new account then fails `verifyApprovalParams` against its own id,
   `resolveWrongAccountLink` names the owner, and the page renders the
   wrong-account card with `DelegateToPanel`. A reissued Clerk id for the
   *owner's* own email is adopted by the same call and the link verifies as
   the owner (correct, and previously "invalid" too). `approveMagicLink`
   uses the same helper so a stale form POST from a brand-new session gets
   the wrong-account diagnosis instead of "no FGAC profile".
2. **`invalid` carries a reason.** `{ status: 'invalid', reason }` with
   `signed_out` (no Clerk session — unreachable behind the wall, kept for
   the action path), `unprovisioned` (signed in, row could not be created),
   `signature` (verified against the resolved owner and failed — forged,
   truncated, or revoked key). The approve page stamps it as
   `invalid_reason` on `approval_link_opened`, so monitoring can tell a bad
   link from a person the card failed.
3. **QA** — capability 14 gains A20 (a wall sign-in as the non-owner with no
   row must render the wrong-account card and the delegate panel, never
   "Invalid link"); A5's harness note explains the fresh-branch fixture.
4. **Monitoring** — §7.25 gains the query: 'invalid' opens by a signed-in
   Clerk id that signed up in the prior ten minutes, which must trend to
   zero, plus the `invalid_reason` breakdown.

Not changed: the wall, the chooser, Clerk configuration, the delegation
write, the email. No schema change.

## Instrumentation

- `approval_link_opened` gains `invalid_reason` (only when `status='invalid'`).
- The wrong-account open for a brand-new account now carries `request_id`,
  `delegate_offer`, `prior_session_matches` like every other wrong-account
  open, so PR #158's funnel (`delegation_prompt_shown{surface:'approve_wall'}`
  → `delegation_created{via:'approve_wall'}`) covers the wall sign-up case.

## QA (two accounts, local then preview)

Fixture: a fresh `db:branch` (or preview branch) where USER_B has not loaded
`/dashboard`. Control first (owner opens the link → approve flow). Then
signed out → link → wall → chooser → USER_B → approve page.

- Pre-fix (local, 2026-09-30): see Established §1 — "Invalid link".
- Post-fix (local): filled in below.
- Preview: filled in below.
