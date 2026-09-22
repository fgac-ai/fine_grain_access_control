# Capability: Email Delegation

> Extracted from `04_email_delegation.md` §1-10

## Assertions

### A1: Own email accessible without delegation
- Access own email with a key that has it mapped
- **Expected**: Success — no delegation setup needed

### A2: Delegated email accessible via proxy
- Owner delegates their email to another user. Delegate creates key with access to owner's email.
- Access delegated email through the proxy
- **Expected**: Success — proxy fetches owner's Google token via Clerk

### A3: Access rules work on delegated emails
- Delegate creates a read_blacklist rule scoped to the delegated email
- **Expected**: Rule blocks content on delegated email but not on delegate's own email

### A4: Revoked delegation immediately cuts access
- Owner revokes the delegation
- Delegate attempts to access the owner's email
- **Expected**: 403 Forbidden — delegation revoked

### A5: Delegation is data-plane only
- Delegate cannot see owner's keys, rules, or dashboard settings
- **Expected**: Complete control-plane isolation

### A6: list_accounts shows delegated emails
- Agent calls list_accounts
- **Expected**: Returns both own and delegated email addresses

### A7: Default Profile auto-includes delegated mailboxes
- Owner delegates to a user who has a Default Profile connection but takes NO
  dashboard action as the delegate (no key creation, no profile edit)
- On that default-profile connection, call `list_accounts`, then `gmail_list`
  with `account=<owner email>`
- **Expected**: The owner's mailbox is listed and readable immediately —
  delegation alone attaches it to the Default Profile. After the owner
  revokes, the same calls are denied and the mailbox disappears from
  `list_accounts` (custom profiles remain per-mailbox opt-in at creation)

### A8: list_accounts reports per-account Google scope state
- Agent calls list_accounts on a key with at least one own and one delegated
  mailbox
- **Expected**: The response carries `account_details` alongside the
  unchanged `accounts` string array — one entry per account with `email`,
  `delegated`, `google_token` (`ok` / `unavailable` / `unknown`, plus
  `google_token_failure` naming the class when `unavailable`), and three-state
  `gmail` / `drive_file` values
  (`granted`/`missing`/`unknown`; a scope Clerk cannot report is `unknown`,
  never coerced to `missing`). A healthy QA account reports `google_token:
  'ok'` and both scopes `granted` with no `reconnect_url`; an account with a
  missing scope (or a token failure that cannot clear on its own —
  `no_token` / `refresh_failed` / `grant_revoked`) carries a `reconnect_url` ending in
  `?reconnect=1&for=<that account's email>` (URL-encoded — the link is bound
  to the account it repairs) and a `reconnect_by` that, for a delegated
  mailbox, names the OWNER as the one who must open it signed in as that
  account; a transient token failure, a timed-out probe, a missing owner
  account (`google_token_failure: 'owner_not_found'` — what every delegated
  mailbox reports on a Vercel preview, whose database is a copy of production
  with production Clerk ids), or an inactive delegation carries NO link. `next_steps.sheets`/`next_steps.docs` point at
  the link when `drive_file` is `missing`

### A9: The "+ Add account" link attaches a second account in one click
- Signed in as USER_A, open `/dashboard/accounts`, click **+ Add account**
- **Expected**: the dialog (`[data-testid=add-account-dialog]`) shows a
  read-only link (`[data-testid=delegate-link]`) of the form
  `<origin>/dashboard/accounts?delegate_to=<uuid>` — a `users.id`, never an
  email — with **Copy** and **Switch account now**; there is no "Got it".
  Open that link signed in as USER_B (sign out, sign in as USER_B, paste it):
  the Accounts page renders `[data-testid=delegate-panel]` with
  `data-surface="accounts_link"` naming USER_A **masked** (e.g.
  `k•••••2@example.com`) and USER_B in full. Click the offer, then
  **Attach this mailbox** on the confirm step (the step names the recipient,
  the mailbox and how to revoke): `[data-testid=delegate-panel-done]`
  appears, and USER_B's "Delegations You've Granted" lists USER_A as Active
  without a reload. Signed back in as USER_A, USER_B appears under
  Accessible Gmail Accounts with "Delegated to you", and `list_accounts` on
  USER_A's connection returns it (A6/A7). Opening the same link again as
  USER_B renders `[data-testid=delegate-link-notice][data-state=already_active]`;
  opening it as USER_A renders `data-state=self` ("This is your own account
  link"); a link with a garbage or unknown uuid renders nothing / `missing`
- **Why**: measured 14 d to 2026-09-21, the old instructional dialog was
  closed 11 times by 6 people and converted none; one person created a
  second FGAC account and clicked the same button there. The link is the
  action the second account can take (`src/lib/secondAccount.ts`)
- **Never**: the link never carries an email; the confirm step is never
  skipped (two clicks, always); a self-open never writes anything; the
  landing never renders alongside the A10 dashboard prompt (one offer at a
  time — local QA 2026-09-21 saw both before the fix)

### A10: A fresh account whose browser just held another FGAC session is offered the merge
- Signed in as USER_A, load `/dashboard` (any dashboard page stamps the
  `fgac_last_account` marker). Sign out via the avatar menu and sign in as
  USER_B within a few minutes (no active USER_B → USER_A delegation:
  revoke it first if the baseline has one)
- **Expected**: USER_B's dashboard (and Accounts page) shows
  `[data-testid=second-account-banner]` — "You were signed in as
  `k•••••2@example.com` a moment ago — is that also you?" with the offer
  button and **No, that's someone else**. Clicking the offer then **Attach
  this mailbox** creates the USER_B → USER_A delegation (visible as in A9)
  and the banner does not return on the next load. Alternatively **No,
  that's someone else** hides it at once and it stays hidden on reload
  (the `fgac_prev_account` cookie is cleared). Signing in as USER_B again
  more than two hours after USER_A's last dashboard request shows no banner
  (adjacency window); signing back in as USER_A after USER_B shows USER_A a
  banner about USER_B (last account wins), never about itself — and because
  USER_A is the OLDER account it is the switch variant
  (`[data-testid=second-account-banner][data-direction=switch]`,
  `[data-testid=switch-and-attach-panel]`): "Switch to `k•••••h@example.com`
  and attach it here" signs out and lands on USER_A's delegate link, where
  USER_B confirms exactly as in A9. The newer account always gets the
  delegate offer (`data-direction=delegate`), the older one the switch offer
- **Why**: the 2026-09-19 case — sign out of A, create B four seconds
  later, repeat the same clicks on B. Nothing on B's dashboard knew A had
  just been here. Unit rules: `scripts/test-second-account.ts`
- **Never**: the markers hold Clerk user ids and timestamps only (no
  email); the banner never names an account in full except the visitor's
  own; a marker naming a deleted or unknown account renders nothing; a
  failed lookup never fails the dashboard

