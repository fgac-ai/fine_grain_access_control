# Capability: Magic-Link Approvals (Actionable Denials)

> Phase C of `connector-growth_v1.md`. Send and Sheets denials carry a signed
> deep link that pre-fills the fix; the owning user approves in one click at
> the moment of need. Links are **signed and deterministic**: the same request
> always produces the same URL, so a retrying agent re-emits one link rather
> than minting a new one each time. Links **do not expire and are not
> single-use** (2026-08-25 change). Authorization is the owning user's Clerk
> session plus a live proxy-key ownership check — an agent can mint the
> request, only the human can approve; the HMAC exists to prevent forgery, not
> to authorize. Re-opening a link whose grant is still active is a success
> ("Already approved"). Re-approving after the grant was revoked is
> **permitted** — the URL is permanent by design, and re-granting requires the
> owner's session plus an explicit click on a page naming the grant, the same
> bar as re-adding the rule in the dashboard. Read-block denials deliberately
> carry NO link. Sheets approvals run picker-first when Google lacks a grant
> for the sheet — see capability 17; grant repair is capability 18 (google
> reconnect).

## Assertions

### A1: Send denial includes pre-filled approval links for both scopes
- With no matching whitelist entry, call `gmail_send` to `USER_B_EMAIL`
- **Expected**: Denial text includes TWO approval URLs on the FGAC origin —
  one granting just the denied recipient, one enabling sending to ANY
  recipient on the profile — with the message presenting them as
  alternatives; nothing is sent

### A2: Approving a send link grants exactly the requested recipient
- Open the A1 link in a browser signed in as the owning user; approve
- **Expected**: A confirmation UI naming the recipient and agent before any
  change; after approval, a whitelist rule for that recipient exists (visible
  in `get_my_permissions` and the dashboard), scoped to that profile; the
  agent's retried `gmail_send` succeeds. No other recipients became sendable

### A3: Sheets denial link pre-fills the spreadsheet and offers RO/RW
- Call `sheets_read_range` on an unexposed spreadsheet; open the denial link
  as the owning user
- **Expected**: Approval UI shows the spreadsheet (id and, where resolvable,
  name) with an explicit Read-only vs Read & Write choice. When Google
  already grants the sheet, approval is one click; when it does not, the
  Picker pick comes first (capability 17 A2/A4). After approving Read-only,
  the retried read succeeds and a write still fails

### A5: Another user's session cannot approve
- Open a USER_A denial link in a browser session signed in as USER_B
- **Expected**: Rejected — no rule is created on either account. The page
  renders the wrong-account card (not the generic "Invalid link" card): it
  names the **masked** issued-for account (e.g. `k•••••h@gmail.com` — never
  the full address) and the profile label, states which account the visitor
  is signed in as, and offers a sign-out control that returns to the same
  approve URL. Only forged/tampered links (A7) get the generic invalid card
- **Harness — this IS runnable with the two QA accounts; do not skip it.**
  Both local and PR-preview deployments work. Two ways to get the link:
  (a) mint a denial as the OTHER account (an MCP `gmail_send` to a
  non-whitelisted recipient from that account's connection), or (b) mint it
  deterministically — links are stateless HMAC URLs, so
  `mintApprovalLink(baseUrl, ownerUserId, ownerProxyKeyId, action)` with the
  deployment's own `CLERK_SECRET_KEY` produces a byte-identical URL (ids via
  read-only DB lookup; see `scripts/test-approval-links.ts` for the pattern).
  Always run the control first: opened as the OWNER the link must render the
  genuine approve page (proves the signature matches the deployment's key).
  If either account hits a sign-in wall (institutional SSO, expired Google
  session), report the assertion as **`blocked`** with "USER ACTION REQUIRED:
  re-auth <account>" — never `skip` (README → skip vs blocked).

### A6: Unauthenticated click requires the owner's sign-in
- Open a valid link in a signed-out browser
- **Expected**: Sign-in is required first; after signing in as the owning
  user the approval proceeds (signing in as anyone else hits A5 behavior)

### A7: Tampered links are rejected
- Modify one character of the link's signature or its recipient parameter
- **Expected**: Rejected as invalid; nothing is created

### A8: Read-block denials carry no magic link
- Trigger a label- or content-blocked `gmail_read` denial
- **Expected**: The restriction message contains no approval URL — weakening
  a read block remains a deliberate dashboard act

### A9: Approval URLs are well-formed single-line links
- Capture approval URLs from (a) a send denial, (b) a sheets denial, and
  (c) `request_access`'s structured `approvalUrl` field
- **Expected**: Each URL contains no whitespace or newline characters
  anywhere in the string, and parses to the FGAC origin with path
  `/dashboard/approve` carrying a non-empty `a` (action) and `s` (signature)
  parameter, plus `k` (proxy key) and — for every action except `send_all` —
  `r` (target). No user id appears anywhere in the URL
- **Regression**: 2026-08-15 tester finding — a trailing newline in the env
  base URL shipped links as `https://fgac.ai\n/dashboard/...`, breaking the
  entire approval loop

### A10: Denial-minted links match the access level the operation needs
- Read the `a` (action) query parameter of the approval link from each denied
  call in this matrix:
  | Denied operation | Sheet state | Required `a` value |
  |---|---|---|
  | `sheets_read_range` | unexposed | `sheets_expose` |
  | `sheets_update_range` | unexposed | `sheets_write` |
  | `sheets_append_rows` | unexposed | `sheets_write` |
  | `sheets_update_range` | exposed Read Only | `sheets_write` |
  | `google_api_modify` (Sheets PUT) | unexposed | `sheets_write` |
- **Expected**: The link's `a` parameter equals the required action in every
  row — a write denial must never mint a read-level (`sheets_expose`) link,
  which would send the user through an approval that cannot satisfy the
  retried operation
- **Regression**: 2026-08-15 tester finding — write denials minted
  `sheets_expose`, creating an approve→retry→fail loop with no signal

### A11: Approving the send-to-anyone link enables all recipients
- From an A1 denial, open the ANY-recipient link signed in as the owning
  user; approve
- **Expected**: The confirmation UI states sending to ANY recipient from
  every mailbox on the profile is being granted; after approval a
  "Send to Anyone" rule (pattern `*`) is assigned to the profile;
  `gmail_send` to arbitrary addresses succeeds; and the grant is removable
  from the dashboard rules

### A12: Repeating a denial re-emits the same URL
- Trigger the identical denial three times in a row (e.g. call
  `sheets_read_range` on the same unexposed spreadsheet, from the same
  profile, three times); capture the approval URL from each response
- **Expected**: All three URLs are **byte-identical**. A retrying agent
  re-emits one link instead of minting a fresh one per attempt, so the user
  sees one thing to click and `approval_link_minted` counts attempts against
  a single stable `request_id`
- **Regression**: 2026-08 launch cohort — every denial minted a new signed
  token, so one access request produced ~1.45 distinct URLs on average
  (worst observed: 17). Analytics counted those as separate unopened
  requests, reporting a 31% approval rate for a funnel actually converting
  near 58%

### A13: Links do not expire
- Approve a link minted well beyond the retired TTL window (>30 minutes old;
  an hours-old or day-old link is a stronger check)
- **Expected**: The link still resolves and approves normally. No "Link
  expired" card renders in any path, and no denial text, approve-page footer,
  or `request_access` response promises an expiry window

### A14: Re-opening an approved link is idempotent
- Open and approve a link, then open the very same URL again while the grant
  is still active; then click Approve a second time
- **Expected**: Both the re-open and the second approve render "Already
  approved" (success tone, no destructive action) and write nothing — no
  duplicate rule, no second grant. The state is resolved at page LOAD from
  live grant state, not after clicking Approve
- **Note**: This is the one property retained from the retired A4. Re-approval
  after the grant has been **revoked** is deliberately permitted (the URL is
  permanent by design) and is intentionally not asserted here

### A15: The file-grant approve button locks while the approval runs
- Open a sheets or docs approval link that reaches the confirm step (Google
  already shares the file, or pick it first per capability 17). Click
  "Approve this grant" and, within the same second, click it several more
  times (the QA harness schedules 6 clicks 150 ms apart and records
  `disabled`/label at each)
- **Expected**: Only the first click submits. From then until the redirect the
  button is `disabled` and reads "Approving…"; exactly ONE POST to
  `/dashboard/approve` is sent and exactly one rule for the file appears on
  the profile. The substitution wording ("Grant access to what I picked")
  gets the same guard
- **Server half**: even when two submits DO land (slow network — simulate with
  `form.requestSubmit()` twice in one tick, which bypasses the disabled
  button), the second writes no rule and the page still ends on the success
  card. Both approve forms render `ApproveSubmitButton`; a bare
  `<button type="submit">` on this page is a regression
- **Regression**: until 2026-09-05 `FileApprovalFlow` had no pending state and
  the picked-file path skipped the grant-level idempotency check. Rage-clicking
  users produced one production link with 14 approve events and another
  writing 11 duplicate rules for one sheet in 12 s (PostHog, 2026-08-30 →
  2026-09-04); reproduced locally as 6 clicks → 6 POSTs → 6 duplicate rules

### A16: A repeat request emails the link from FGAC's support mailbox; a first request does not
- Environment needs the sender configured: `SUPPORT_FGAC_PROXY_KEY` (an
  FGAC proxy key on a profile with a send rule covering the recipients) and
  `SUPPORT_SENDER_EMAIL` (that key's own mailbox). In production that is the
  support mailbox's FGAC account. For QA, stand USER_A in for it: as USER_A
  create a NEW profile (`FGAC reminders (QA)`; a profile is its own key) and
  on it "+ Apply a rule → + Create a new rule" as a Gmail send whitelist with
  pattern `*` (the quick-add button is Default-Profile-only), reveal the
  key, write both values to `.secrets/sender.env`,
  and start the dev server with `.claude/launch.json` `fgac-dev-sender`. The
  reminder then lands in USER_A's own inbox, sent by USER_A's key — read it
  through the MCP `gmail_list`/`gmail_read` tools. Without the two variables
  every mint carries `notify_status: 'disabled'` and this assertion is
  `blocked`, not `skip`. The 3-a-day cap is per OWNER of the connection and
  lives in the branch DB, so an earlier session's run on the same Neon
  branch can exhaust it (2026-09-16: three link reminders sent to USER_A at
  ~05:00 UTC blocked a later run outright). Check headroom first
  (read-only: `notified_at > now() - interval '24 hours'` on
  `approval_requests` and `account_refusals`, grouped by owner) and, when
  it is spent, run A16/A17 with the OTHER QA account as the connection
  owner and recipient — never clear the stamps
- Signed in as USER_A, trigger a send denial to a recipient never denied
  before on this profile (a fresh `+tag` on `USER_B_EMAIL`), then trigger the
  identical denial again within a minute, then a third time at least 5
  minutes after the first
- **Expected**: The FIRST and SECOND denials carry NO 📧 line (first ask;
  repeat inside the same-turn window) and nothing is emailed. The THIRD
  denial carries a 📧 line saying that because this is a repeat request FGAC
  has also emailed the link to the user just now; the sender's inbox holds
  exactly ONE message to USER_A's address, From `FGAC <support address>`,
  Reply-To the support address, subject `Your agent has asked 3 times to
  send email to … — approve it?`, plain text, body opening "FGAC has detected
  <agent> asking 3 times, without approval, to:", naming the first request
  time in UTC, carrying BOTH approval URLs from the denial each with
  `&src=email` appended and the signed `a`/`k`/`r`/`s` params byte-identical,
  and offering "do nothing" and "reply to this email" as the decline paths.
  A FOURTH denial says the link was emailed "at <date HH:MM UTC>" and no
  further email is sent; the mailbox still holds one message. Opening the
  emailed link resolves and approves exactly like the chat link (A2), and
  its `approval_link_opened` row carries `link_source: 'email'` (capability
  16 A24). A request whose approve page was opened BEFORE the repeat ask
  never emails (`notify_status: 'skipped_opened'`)
- **Cap**: with three distinct requests already emailed to USER_A in the
  last 24 h, a fourth due repeat carries no 📧 line and
  `notify_status: 'skipped_rate_capped'`; the ledger row keeps
  `notified_at` NULL
- **Never**: no email is ever sent through a user's Google grant — the
  sender is FGAC's own mailbox. Never assert on a production account's
  inbox


### A17: A repeatedly refused `account` value emails the owner once, naming the value and the fixes
- Sender configured exactly as in A16 (`SUPPORT_FGAC_PROXY_KEY` /
  `SUPPORT_SENDER_EMAIL`; USER_A stands in). Without them every refusal
  carries `notify_status: 'disabled'`, the `account_refusals` row is still
  written, and this assertion is `blocked`, not `skip`
- Signed in as USER_A, on a profile whose mailbox list does NOT include the
  value you will pass (the Default Profile is fine even when USER_B's
  delegated mailbox is on it), call `sheets_read_range` (any spreadsheet id)
  THREE times with `account` set to an address the profile does not include
  (a fresh `+tag` on `USER_B_EMAIL` — never a real third party's address),
  then a FOURTH time with the same value, then once with a DIFFERENT
  unlisted value
- **Expected**: every call is the 🚫 `account_not_permitted` refusal from
  `accountNotPermittedByCaller` (names the refused value and the usable
  account, "no approval link exists for it") — no approval link is ever
  minted and no `approval_link_minted` row appears. The FIRST and SECOND
  carry NO 📧 line. The THIRD carries a 📧 line saying FGAC has emailed the
  user naming the account this task passes and the accounts the connection
  can use; the sender's inbox holds exactly ONE message to USER_A's address,
  From `FGAC <support address>`, Reply-To the support address, subject
  `Your agent keeps asking for '<value>', an account it cannot use — a
  change is needed`, plain text, body opening "FGAC has refused <agent> 3
  times since <date HH:MM UTC> (its sheets_read_range calls) because it asks
  for the Google account:", the value on its own line, "The account(s) it
  can use: <every mailbox on the profile>.", "No approval link exists for
  this", the two
  numbered fixes (change the task / sign in as that account and delegate to
  USER_A's address, with the `/dashboard/accounts` URL), and "will not email
  you about this account again". The FOURTH says FGAC emailed the user about
  this account "at <date HH:MM UTC>" and no further email is sent; the
  mailbox still holds one message. The DIFFERENT value starts its own count
  (no 📧 line on its first refusal)
- **Ledger** (read-only query on the branch DB): one `account_refusals`
  row per (profile key, value), `requested_email` lower-cased,
  `refusal_count` 4 and `window_count` 4 for the first value, `last_tool`
  `sheets_read_range`, `notified_at` set once and unchanged by the fourth
  refusal; the second value's row has `notified_at` NULL
- **Cap**: with three reminder emails already sent to USER_A in the last
  24 h (A16 links and A17 notices count together), a due third refusal
  carries no 📧 line and `notify_status: 'skipped_rate_capped'`; the row
  keeps `notified_at` NULL
- **Never**: a refusal never mints a link, never emails on the first or
  second refusal, never emails twice for the same (key, value), and never
  sends through a user's Google grant. Never assert on a production
  account's inbox
