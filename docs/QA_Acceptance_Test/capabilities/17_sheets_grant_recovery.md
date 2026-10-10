# Capability: Sheets Grant Recovery (Approval → Google Grant → Verified Success)

## Overview
Models the real connector-directory user journey observed in production
(2026-08-16 launch cohort): an agent calls a sheets tool on a sheet the user
never exposed, the denial mints a `sheets_expose` magic link, the user
approves — and, before this capability existed, every retry then failed with
a generic Google 404/403 because approving created only the FGAC rule, never
the Google-side `drive.file` per-file grant (which registers only via a
Google Picker pick). Production data: 3 of 3 users who approved churned on
post-approval errors; zero external users ever reached a successful sheets
call.

This capability asserts the whole loop is now honest and recoverable: the
approval page verifies the Google half, walks the user through the Picker
with the embedded Sheets demo video when the grant is missing, the dashboard
flags stranded rules, and the MCP error for a rule-covered-but-ungranted
sheet tells the truth.

> **Shared machinery note (Google Docs support)**: the components behind this
> capability are kind-parameterized (`FileApprovalFlow`, `FileGrantRecovery`,
> `fileAccessHandlers`) and also serve Google Docs. Sheets behavior, copy,
> endpoints, testids (`sheets-flow-*`), and analytics event names are
> unchanged — these assertions double as the regression suite for that
> generalization. The docs twin of this funnel is capability 19 A12.

## Pre-requisites
* `/qa-setup` complete; dev server running; USER_A signed in (built-in browser).
* An MCP connection with an approved proxy key for USER_A (hosted MCP or
  Claude Code MCP per the agent runbook).
* A fixture spreadsheet owned by USER_A that has **never** been picked via
  the FGAC Google Picker in this environment (a fresh Neon branch resets
  FGAC rules but NOT Google-side drive.file grants — prefer a
  freshly-created spreadsheet to guarantee the ungranted state).
* Picker automation limits per capability 09's harness note: the picker
  iframe is cross-origin; use the app-API seam
  (`POST /api/rules/grant-sheets-access` cannot register a Google grant, so
  the *granted* end-state is simulated with a sheet that HAS been picked
  before — e.g. the standing QA fixture sheet — while the *ungranted* path
  uses the fresh sheet) or the Playwright CDP path for full fidelity.

## Assertions

### A1: The production failure sequence is reproducible up to the fix
- With the fresh (never-picked) spreadsheet: call `sheets_get_spreadsheet`
  via MCP → expect a denial whose text contains a `/dashboard/approve` link
  (token action `sheets_expose`, per capability 14 A10).
- **Expected**: The denial fires `$mcp_tool_call` with
  `outcome=denied_by_policy` and an `approval_link_minted` event with
  `action=sheets_expose` — the same event signature as the production
  incident. (This assertion pins the replication baseline; A2–A8 assert the
  new behavior on top of it.)

### A2: A missing Google grant makes the pick come FIRST — no blind approve
- Open the A1 link signed in as USER_A.
- **Expected**: The page verifies the Google-side grant on load (fires
  `sheets_grant_verification {via: link_open, result: missing}`) and shows
  the picker-first state: an explanation that Google hasn't shared the
  sheet, a "Step 1 — Pick the sheet in Google Picker" button, and **no
  approve/submit control** until a pick happens. No FGAC rule exists yet
  (`GET /api/rules/grant-sheets-access` unchanged) and the link is NOT
  consumed by merely opening the page.

### A3: The pick-first state embeds the setup video
- On the A2 page.
- **Expected**: The pick button launches the Google Picker flow (the
  `.picker-dialog` iframe opens, or the first-time `drive.file` consent
  redirect per capability 09 A2 — which must return to the approve page
  WITH the token still in the URL), AND the Sheets demo video (Descript
  embed `Fv9pwXugLUa`, rendered via `TrackedVideoEmbed`) is present.
  Playing it fires `video_played` with the approve page's `page` property.

### A4: Picking the requested sheet leads to confirm → approve → success
- Complete a pick that includes the requested sheet (Playwright CDP path
  for the real pick; app-API seam otherwise — see Pre-requisites), then
  approve (Read Only) on the confirm step that appears.
- **Expected**: The confirm step shows the sheet's real title; approval
  creates the rule and lands on the success page. The retried MCP call
  succeeds (`$mcp_tool_call` outcome=success) with no new approval link
  minted. The legacy recovery page at `/dashboard/sheets-setup` still
  performs pick → `sheets_grant_recovered` → verified for rules stranded
  before this flow existed (dashboard-chip entry path).

### A5: Approving a sheet that already has a Google grant skips the pick
- Mint a fresh denial link for a spreadsheet that HAS been picked before
  (standing QA fixture sheet) by calling `sheets_read_range` on it before
  any FGAC rule exists; open and approve the link as USER_A.
- **Expected**: The page goes straight to the one-click confirm (no pick
  step), showing the sheet's title resolved from Google; approving lands
  on the success state and `sheets_grant_verification` fires with
  `result=ok` (once via `link_open`, once via `magic_link`); the retried
  read succeeds.

### A9: Picking a DIFFERENT sheet becomes an explicit substitution
- From the A2 pick-first state, pick a sheet that is NOT the requested id
  (any real sheet USER_A owns).
- **Expected**: An explicit substitution confirmation appears — naming
  both the picked sheet and the agent's wrong id — and approving creates
  rule(s) for the PICKED sheet only; the requested id gets NO rule
  (`GET /api/rules/grant-sheets-access` shows no row for it, and no
  "needs Google access" chip appears later). `approval_link_approved`
  carries `substituted: true`. The agent's retry on the wrong id gets a
  fresh not-exposed denial (no phantom rule means no misleading A7 state),
  while `get_my_permissions` lists the picked sheet, and a call on the
  picked sheet succeeds. Server-side guard: a
  forged `picked` payload naming a sheet Google does NOT grant creates
  nothing and leaves the link unconsumed (retryable).

### A6: Dashboard flags rules whose sheets lack a Google grant
- With the A2 rule present but its sheet still un-picked, load `/dashboard`
  (profile Sheets card) and `/dashboard/accounts`.
- **Expected**: That rule's row carries a visible "needs Google access"
  indicator with a working recovery affordance (opens the same picker +
  video panel). Rules whose sheets verify OK show no indicator. The
  indicator never blocks the rest of the dashboard from rendering (a
  Google outage degrades to no-indicator, not a broken page).

### A7: Post-policy Google 403/404 on a sheets call returns honest 🚫 guidance
- With the A2 rule present and the sheet still un-picked, retry
  `sheets_get_spreadsheet` via MCP.
- **Expected**: The response is NOT the generic "Google resource not found
  (404). Check the ID and try again." It is 🚫 guidance stating that the
  sheet is approved in FGAC but Google access is not set up yet ("Not
  available yet … pick this sheet"), and points the user at
  `/dashboard/sheets-setup`. It classifies as `$mcp_tool_call`
  `outcome=denied_by_policy`, `denial_code=file_grant_missing_at_google`,
  `$mcp_is_error=false` — a user-fixable condition, kept out of the Connector
  Directory error rate (❌ `failed` until the 2026-09-03 graduation, `78f6227`)
  — while still carrying `error_status` (403/404) internally. `outcome=error`
  here is the regression (capability 16 A17 asserts the event side).

### A8: Recovery analytics distinguish the funnel stages
- Replay A1→A4 and inspect captured events (PostHog debug/local capture per
  capability 16 conventions).
- **Expected**: The sequence contains `approval_link_minted(sheets_expose)`
  → `sheets_grant_verification {via: 'link_open', result: 'missing'}` →
  `approval_link_approved(sheets_expose)` → `sheets_grant_verification
  {via: 'magic_link', result: 'ok'}` → `sheets_grant_verification {via:
  'post_approval', result: 'ok'}` → `$mcp_tool_call` success — each stage
  attributable to the same person and `request_id`, so the production
  dashboard measures the approve-page funnel directly as
  `link_open{missing}` → `magic_link{ok}` conversion (`docs/analytics.md`).
  `sheets_grant_recovered` is NOT part of this chain: it belongs to the
  dashboard recovery panel's `context=recovery` re-check for pre-existing
  stranded rules (A4's Picker pick from the approve page is a first-time
  grant, not a recovery) — that path is asserted by A11. Corrected
  2026-09-03; the earlier wording listed `sheets_grant_recovered` here and
  could never pass through the approve-page flow.

### A10: Hand-typed rule creation verifies the grant at birth
- Create a sheets rule for the never-picked fixture spreadsheet's id via
  the app's own grant seam — as the signed-in user,
  `POST /api/rules/grant-sheets-access` with a hand-typed
  `targetResourceId` (the manual rule modal is Gmail-only, so this REST
  endpoint — the same one the Picker manager calls — is the reachable
  hand-typed path). The rule must save successfully regardless of the
  grant state.
- **Expected**: `sheets_grant_verification` fires with
  `{via: 'grant_api', result: 'missing', spreadsheet_id: <typed id>}`
  (query per capability 16 conventions) — the stranded-at-birth rule is
  visible in the funnel from the moment it exists, instead of only when a
  call later fails. Repeating with a sheet that HAS been picked (standing
  QA fixture) yields a fresh-create `result: 'ok'` (updates to an existing
  rule do not re-verify). Telemetry only: rule creation must succeed even
  if the Google check errors (`result: 'unknown'` is acceptable then), and
  the same creation fires `rule_saved {via: 'grant_api', file_id}`
  (capability 16 A15 — one creation serves both assertions).

### A11: Recovery re-checks are captured even when the grant stays missing
- With a stranded rule (A2/A10 state), open the recovery panel
  (`/dashboard/sheets-setup?sid=<id>` or the dashboard chip) and trigger a
  re-check WITHOUT completing a Picker pick — e.g. close/skip the Picker so
  the recovery UI re-verifies, or call the seam it uses directly:
  `GET /api/rules/verify-sheets-access?sid=<id>&context=recovery` as the
  signed-in user.
- **Expected**: `sheets_grant_verification` fires with
  `{via: 'recovery', result: 'missing', spreadsheet_id: <id>}` and NO
  `sheets_grant_recovered` event. Previously only successful re-checks were
  visible (via `sheets_grant_recovered`), so stuck users were
  indistinguishable from users who never tried. After a real pick, the
  re-check fires `{via: 'recovery', result: 'ok'}` AND
  `sheets_grant_recovered` (A4/A8 unchanged).

### A12: Cancelling the Picker on the approve page explains and offers a retry
- Open a denial-minted sheets link (A1) as USER_A in the pick-first state
  (A2). Click "Step 1 — Pick the sheet in Google Picker" and close the Picker
  without choosing (its Cancel / ✕, or Escape).
- **Expected**: The pick-first panel is replaced by a recovery panel
  (`data-testid="sheets-flow-pick-cancelled"`) that says nothing has changed,
  names what the agent asked for — the title when the link was minted with
  one (capability 15 A8), otherwise "the sheet with Google id <id>" — tells the
  user Google's picker lists files by NAME (id-only case: "by name, not by
  id"), and says any sheet can be picked and a mismatch is flagged before
  approval. The pick button now reads "Try again — open the picker" and
  re-opens the Picker WITHOUT a page reload; picking the requested sheet then
  proceeds exactly as A4. Before any cancel, the hint under the pick button
  (`sheets-flow-pick-hint`) already says to look for the sheet by name.
  Cancelling from "Pick again" on the confirm step keeps the existing pick
  and shows no recovery panel. Docs links mirror this with the `docs-`
  test-id prefix and "document".
- **Analytics**: `picker_cancelled {kind, attempt: 1, elapsed_ms > 0,
  from_oauth_return: false}` on the cancel; the retry fires `picker_opened
  {attempt: 2}` (capability 16 A21)
- **Regression**: until 2026-09-08 a cancel changed nothing on screen — the
  page showed a raw Google id, the user opened the Picker, could not tell
  which file it meant, and closed it. Production 2026-09-03 → 09-07: 13 of 33
  Picker opens ended in a cancel; both users who cancelled on the approve
  page never approved

### A13: The pick-first panel names the Google account the Picker searches
- Open a denial-minted sheets link (A1) as USER_A in the pick-first state
  (A2). Read the line under the pick button
  (`data-testid="sheets-flow-account-hint"`). Then cancel the Picker (A12)
  and read the recovery panel.
- **Expected**: Both say "The picker shows the Google Drive of
  <USER_A's connected Google address>", that a sheet belonging to a
  different Google account must be shared with that address first, and that
  it then appears under "Shared with me". The address shown is the Google
  account Clerk holds for USER_A (Accounts page "Connected Google account"),
  not a placeholder. Docs links mirror this with the `docs-` prefix and
  "document". A signed-in user with no Google external account (not
  reproducible with the QA accounts) gets the generic "the Google account
  connected to FGAC" wording — pinned by
  `scripts/test-picker-recovery-copy.ts`.
- **Regression**: 2026-09-03 and 09-05 (production) two people whose sheet
  lived in a second Google account cancelled the Picker within seconds
  (18 s / 7 s / 4 s; 40 s), then went hunting — sign out, sign back in with
  Google, add a delegated account, remove accounts — and never approved.
  Nothing on the page said whose Drive the Picker was listing.

### A14: A pick-button click is visible server-side even when posthog-js is blocked
- Run A2 with a content blocker (or with `us.i.posthog.com` blocked in the
  browser's devtools network conditions) so no client-side event leaves the
  page. Click "Step 1 — Pick the sheet in Google Picker". Then query:
  `SELECT event, properties.result, properties.has_drive_file_scope,
  properties.scope_source, properties.app_id_resolved, properties.page FROM
  events WHERE event = 'picker_token_requested' AND timestamp >= now() -
  INTERVAL 1 HOUR ORDER BY timestamp`
- **Expected**: one `picker_token_requested {result: 'ok',
  has_drive_file_scope: true, scope_source: 'google-tokeninfo',
  app_id_resolved: true, page: '/dashboard/approve'}` per click, with NO
  `picker_opened` for the blocked run (and one `picker_opened` per click for
  an unblocked run). A user whose Google grant lacks drive.file produces
  `has_drive_file_scope: false` on the same row (the reconnect leg).
- **Regression**: 8 of the 65 people who opened an approval link in the 30
  days to 2026-09-09 emitted no client-side event at all; two of that
  week's three "opened, never picked" accounts were among them, and the
  review could not say whether they had clicked.
