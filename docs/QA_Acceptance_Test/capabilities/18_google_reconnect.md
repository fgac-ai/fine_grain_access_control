# Capability: Google Reconnect (Grant Repair)

> A user's Google grant can break — expired verification (e.g. an abandoned
> consent attempt), revoked scopes, or a grant that never included
> `drive.file`. Every error that says "reconnect Google from the Accounts
> page" must point at a control that actually exists and works, and the repair
> must not depend on the thing it repairs (2026-08-19 incident: the picker
> died at token fetch BEFORE reaching the reconnect leg — the user's only
> symptom was a button that did nothing). Shared leg: `googleReconnect.ts`
> (reauthorize when verified; destroy-and-recreate otherwise — Clerk's
> designed recovery, safe only when completed in one pass).

## Assertions

### A1: The Accounts page has a working "Reconnect Google" button
- As a signed-in user, open `/dashboard/accounts` and click "Reconnect Google"
  on the Connected Google Account card
- **Expected**: The browser navigates to Google's OAuth consent (account
  chooser or consent screen) — never a silent no-op. After completing consent,
  the user returns to `/dashboard/accounts?reconnected=1`, sees a brief
  "Confirming Google permissions…" state, then "✓ Google reconnected —
  gmail.modify and drive.file confirmed." (success is verified against the
  token bridge, never assumed), and the scope badges show `gmail.modify` +
  `drive.file`. A `google_reconnect_started` event fires with
  `source: accounts_page`

### A2: A broken grant routes the picker into reconnect instead of dying
- With a broken/expired Google grant (token bridge `/api/auth/
  google-picker-token` returns an error), open a sheets approval link and
  click "Step 1 — Pick the sheet in Google Picker"
- **Expected**: The click navigates to Google's consent flow (the reconnect
  leg) — NOT a dead button, NOT an unexplained failure. The signed approval
  token survives the round-trip in the return URL (`autoOpenPicker=true`
  plus the original `token` param)

### A3: Every picker/reconnect failure is visible and actionable
- Force any failure in the flow (e.g. Clerk returns no verification URL, or
  the Google Picker script is blocked)
- **Expected**: An inline error renders next to the triggering button —
  "Google flow failed: …" with concrete advice and a link to the Accounts
  page — and a `picker_flow_error` analytics event fires carrying `stage`
  (one of: token_after_oauth, oauth_return_scope_missing, google_reauthorize,
  gapi_not_loaded, open_picker, trigger, accounts_reconnect) and `message`.
  No failure path may end at console.error or a bare alert() alone

### A4: Reconnect repairs agent access end-to-end
- After completing A1 or A2's consent as the QA user, retry (a) the token
  bridge, (b) a Gmail MCP tool call, (c) the sheets picker
- **Expected**: The token bridge returns `hasDriveFileScope: true`; the
  Clerk external account's verification status is `verified`; `gmail_list`
  succeeds again (no "🚫 Not available yet: FGAC's auth provider …" refusal
  and no "❌ FGAC's auth provider … instead of a Google token" failure — the
  token-failure texts from `src/lib/googleTokenFailure.ts`); the picker opens
  directly with no further OAuth detour

### A5: The OAuth return leg never loops
- Return from consent with the scope still missing (deny the drive.file
  checkbox on Google's consent screen, or close the consent tab early and
  reload the return URL)
- **Expected**: The page shows the "Google did not grant Sheets access on
  that pass" (or token failure) advice with a retry path — it must NOT
  redirect back to Google automatically (no consent loop), and nothing is
  granted

### A6: A reconnect link for a different account warns instead of auto-firing
- As USER_A (signed in to FGAC), open
  `/dashboard/accounts?reconnect=1&for=<USER_B_EMAIL>` — a reconnect link
  minted for USER_B's account
- **Expected**: The reconnect flow does NOT auto-fire (no navigation to
  Google's consent), and a warning card renders naming both accounts: the
  link is for USER_B, the session is USER_A, reconnecting here would repair
  the wrong account — sign out and sign back in as USER_B. The manual
  "Reconnect Google" button remains available. A
  `google_reconnect_wrong_account` event fires (once) carrying
  `intended_for: <USER_B_EMAIL>`, and no `google_reconnect_started` fires.
  With `for=<USER_A_EMAIL>` (or any address on USER_A's Clerk account) the
  auto-fire behaves exactly as before — no warning, no wrong-account event

### A7: Post-reconnect success is verified, not assumed
- Land on `/dashboard/accounts?reconnected=1` while the Google grant is still
  missing a scope (e.g. deny the drive.file checkbox on the consent screen
  before returning, or craft the URL directly with a scope-less grant)
- **Expected**: NO unconditional "✓ Google reconnected." — the button polls
  the token bridge (tolerating Clerk scope-propagation lag, ~4×1.5 s) and
  then renders a failure state naming the still-missing scope(s) with advice
  to reconnect and approve every checkbox. A `google_reconnect_incomplete`
  event fires with `missing_scopes`

### A8: Scope badges are independent per scope
- With an account holding gmail.modify but NOT drive.file (or vice versa),
  open `/dashboard/accounts`
- **Expected**: The granted scope shows its normal badge and the missing one
  shows its own "missing" error badge — never one combined state rendering
  both green from a single boolean. The Connected Google Account card's
  reconnect guidance still appears when either scope is missing

### A9: A Google sign-in that strips drive.file is repaired right after sign-in
- **Fixture note (2026-09-04, later the same day):** `drive.file` was added to
  the Google connection's scope list on the dev Clerk dashboard, so a plain
  sign-in no longer narrows the grant there (measured: chooser only, record
  stays wide, auto-repair does not fire — that non-firing is itself the
  expected result on a correctly configured instance). To exercise this
  assertion, arrange a Clerk record that lacks `drive.file` while Google still
  holds the grant by another route (e.g. temporarily remove the scope from the
  dev dashboard list, sign in, restore it), and record which route was used.
- As a QA user who holds `drive.file` AND has at least one Sheets or Docs rule,
  sign out of FGAC and sign back in with Google (on an instance whose sign-in
  scope set lacks `drive.file`, the sign-in rewrites Clerk's grant without it —
  confirm with the Clerk external account's `approved_scopes` or the Accounts
  page badges)
- **Expected**: Landing on the dashboard after the sign-in, the access card
  starts the reconnect on its own (no click): the browser goes to Google,
  which shows only a one-account chooser (NO consent screen — Google still
  holds the drive.file grant; the sign-in only narrowed Clerk's copy), bounces
  back to `/dashboard/accounts?reconnected=1`, and the page verifies "✓ Google
  reconnected — gmail.modify and drive.file confirmed." About an hour later
  the token still refreshes with drive.file (the no-consent pass must not
  leave a refresh-less grant — probe Clerk's token after expiry). A `google_reconnect_started` event fires with
  `source: sign_in_auto`, and a `sign_in_completed` event fired first with
  `drive_file_narrowed: true`. Gates: it fires at most ONCE per sign-in (reload
  the dashboard after abandoning the consent screen — no second redirect;
  the card with its manual button renders instead), never when Gmail is also
  missing, never when the user has no Sheets/Docs rules, and never on an
  OAuth return leg (`?reconnected=1`, `?autoOpenPicker=…`)

### A10: The access card names the scope that is missing
- With an account holding gmail.modify but NOT drive.file, open the dashboard;
  then the reverse (drive.file but not gmail.modify) if a grant can be arranged
- **Expected**: The card title/body name the missing scope — "Grant Google
  Drive file access" / "Sheets and Docs" for a drive.file gap (for a user with
  Sheets/Docs rules it also says a sign-in resets the permission), "Grant Gmail
  access" / "checkbox" for a Gmail gap — and never tells a user whose Gmail
  works that they "have not granted access to your Gmail". Only a grant
  missing both scopes gets the generic "Connect Google Account" copy

### A11: The MCP pre-flight trusts the token, not Clerk's stale scope record
- With a Clerk external account whose `approved_scopes` lack `drive.file`
  while the access token Clerk serves still carries it (tokeninfo shows
  `drive.file` — arises when Clerk refreshes with an older, wider refresh
  token), call `sheets_read_range` on an exposed sheet
- **Expected**: The call succeeds (no "connected WITHOUT the Google Drive file
  permission" denial), and the `$mcp_tool_call` event carries
  `clerk_scope_cache_stale: true`. When tokeninfo agrees the scope is missing,
  the denial fires as before, and its message names a repeat Google sign-in as
  a likely cause alongside the unchecked-checkbox case. If the token state
  cannot be arranged, record this assertion as blocked with the reason — never
  as a pass

### A12: A revoked Google grant is a 🚫 refusal with a reconnect link, and list_accounts says so first
- **Fixture (real user flow, 2026-09-09):** as a QA user, revoke FGAC's access
  from the Google side — Google Account → Security → "Third-party apps with
  account access" → FGAC → Remove access (a Google surface: `computer` clicks,
  never JS clicks; Path B if the pane cannot drive it). Do NOT touch Clerk or
  the database. Wait for the current access token to expire (≤ 1 h; Clerk
  refreshes on the next fetch and Google answers `invalid_grant` — confirm with
  the token bridge returning an error), then as the agent call `list_accounts`,
  `gmail_list`, and `sheets_get_spreadsheet` on that account
- **Expected**: `list_accounts` reports the account as `google_token:
  'unavailable'`, `google_token_failure: 'grant_revoked'`, WITH a
  `reconnect_url` bound to that account (`?reconnect=1&for=<email>`) and a
  `reconnect_by`, and `next_steps.reconnect` names the account, says every call
  on it fails until reconnected, says "do not retry", and carries the same link.
  Each tool call answers "🚫 Not available yet: Google has expired or revoked
  FGAC's access to '<email>' …" quoting Google's "Token has been expired or
  revoked", says STOP / retrying will NOT help, and ends with the one-click
  link — never the ❌ "usually temporary … Retry ONCE" text, and never a second
  server-side attempt (`google_token_fetch_failed` carries `retried: false`,
  `clerk_status: 400`, `clerk_code: 'oauth_token_retrieval_error'`, `reason:
  'grant_revoked'`; the `$mcp_tool_call` row is `denied_by_policy` with
  `denial_code: 'google_token_unavailable'`). Opening the link signed in as that
  account lands on Google's CONSENT screen (Google no longer holds the grant, so
  a chooser-only pass is a regression), and after consent A4 passes again. If
  the revocation cannot be arranged in the environment, `npx tsx
  scripts/test-google-token-failure.ts` pins the classification and wording —
  record the assertion as covered by unit test, with the reason, not as a pass.
  Preview note (measured 2026-09-09, PR #127): the minted `reconnect_url` always
  carries the canonical production host (`DASHBOARD_URL` falls back to
  `VERCEL_PROJECT_PRODUCTION_URL`), which runs a different Clerk instance from
  the preview — open the same path and query on the preview origin instead.
  The revocation took ~40 min to surface (Clerk serves its cached access token
  until expiry); the Google permissions page and the consent leg needed Path B
  in an unattended session

### A13: A dead grant emails the mailbox owner exactly once per episode, with the owner-bound link
- Sender configured exactly as capability 14 A16 (`SUPPORT_FGAC_PROXY_KEY` /
  `SUPPORT_SENDER_EMAIL`; USER_A stands in for the support mailbox via
  `.secrets/sender.env` and `fgac-dev-sender`). Without them every refusal
  carries `notify_status: 'disabled'`, the `google_grant_failures` row is
  still written, and this assertion is `blocked`, not `skip`. Headroom: the
  3-a-day cap is per mailbox OWNER across `approval_requests`,
  `account_refusals` AND `google_grant_failures` — check
  `notified_at > now() - interval '24 hours'` on all three (read-only) before
  running, and use the other QA account as the owner if it is spent
- **Fixture**: the A12 fixture (revoke FGAC from the Google side on a QA
  account, wait for the access token to expire) — OR the naturally dead dev
  grant: USER_A's dev Google grant dies on its own roughly hourly (Clerk's
  reauthorize uses `select_account`, so Google issues no refresh token); when
  `list_accounts` reports USER_A `google_token: 'unavailable'` the fixture is
  in place with no Google-side action. Run the own-mailbox leg with a key
  whose owner is the dead account, and the delegated leg with a key owned by
  the OTHER QA account that has the dead mailbox delegated onto it
  (capability 04 setup)
- Own-mailbox leg: as the agent, call `gmail_list` on the dead account three
  times a few seconds apart
- **Expected**: every call is the A12 🚫 `google_token_unavailable` refusal,
  unchanged, and the FIRST additionally ends with a 📧 line: "FGAC has also
  emailed the user just now with this reconnect link — do not re-ask"; the
  second and third say FGAC emailed the user "at <date HH:MM UTC>" and that
  no further email is sent while it keeps failing. The sender's inbox holds
  exactly ONE message to the dead account's address, From `FGAC <support
  address>`, Reply-To the support address, NO Cc, subject `Google access to
  <address> is disconnected — your agent is being refused`, plain text, body
  opening "<agent> has been refused today (first at <date HH:MM UTC>) because
  FGAC can no longer reach Google on behalf of:" — `<agent>` capitalised at
  the sentence start and reading like "Your Claude agent on the Default
  Profile" (nickname or client plus profile, never an id), the address on its own
  line, the cause paragraph matching the refusal's class (`grant_revoked` →
  "expired or revoked"; `refresh_failed` → "no usable refresh token"), the
  SAME `?reconnect=1&for=<address>` link as the refusal, "Open the link while
  signed in to FGAC as <address>", "do nothing — the agent stays refused", and
  "This is the only email FGAC will send about this account unless it is
  repaired and disconnects again" — never a promise of a reminder — and the
  signature `— FGAC support (support@fgac.ai)`, never the QA sender's
  address. Opening the emailed link signed in as that account runs A4
- Delegated leg: as the OTHER account's agent, call `gmail_list` with
  `account` = the dead mailbox, twice
- **Expected**: the refusal is the A12 delegated text (only the owner can
  repair it; the key owner cannot) and the FIRST ends with "FGAC has also
  emailed the owner of the mailbox (and copied this user) just now"; the
  second says it was emailed "at <date HH:MM UTC>". The sender's inbox holds
  ONE new message To the dead mailbox's address AND Cc the key owner's
  address, subject `Google access to <address> is disconnected — an agent you
  delegated to is being refused`, body opening "<agent>, run by <key owner>
  under the mailbox access you delegated, has been refused …", and a paragraph
  addressed to the key owner: "(copied on this email): this is the mailbox
  owner's grant, not yours — nothing on your own Accounts page fixes it … your
  other mailboxes are unaffected". If the own-mailbox leg already emailed this
  owner today for the same mailbox, the delegated leg's first refusal says
  "emailed … at <time>" instead and sends nothing — the ledger is per
  (owner, mailbox), not per key
- **Ledger** (read-only query on the branch DB): one `google_grant_failures`
  row per (owner, mailbox), `account_email` lower-cased, `last_reason` the
  class, `failure_count` = total refusals across both legs, `notified_count`
  1, `notified_at` set once and unchanged by later refusals,
  `first_failed_at` = the first refusal
- **Dashboard**: signed in as the dead account, `/dashboard` shows the amber
  card titled "Action Required: Reconnect Google" (not "Connect Google
  Account") whose body names revoked / password / aged-out causes and says
  agent calls are refused until reconnect; the button reads "Reconnect Google"
- **Cap**: with three notices of any kind already sent to this owner in 24 h,
  a due first refusal carries no 📧 line and `notify_status:
  'skipped_rate_capped'`; the row keeps `notified_at` NULL and
  `notified_count` 0. The global breaker (10 dead-grant notices per rolling
  hour across ALL owners → `notify_status: 'skipped_global_capped'`) cannot be
  reached with two QA accounts — `npx tsx scripts/test-google-grant-notify-copy.ts`
  pins the constant and the status; record it as covered by unit test
- **Never**: never emails on a transient `clerk_error` / `timeout` refusal
  (the ❌ "retry once" text) or on `owner_not_found` / `delegation_inactive`;
  never emails from the quiet `list_accounts` probes (call `list_accounts`
  five times on the dead account — no new message, no ledger row change);
  never emails the delegate ALONE (the owner is always the To); never sends
  through a user's Google grant; never assert on a production account's inbox.
  If the dead grant cannot be arranged, `npx tsx
  scripts/test-google-grant-notify-copy.ts` pins the copy, the Cc header and
  the one-per-episode rule — record the assertion as covered by unit test,
  with the reason, not as a pass
