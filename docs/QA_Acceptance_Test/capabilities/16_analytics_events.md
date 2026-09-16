# Capability: Analytics Events (PostHog)

> Asserts that product analytics actually arrive in PostHog with the canonical
> schema (`docs/analytics.md`). Exists to catch regressions like the 2026-08
> incident where MCP tool calls were captured under the legacy `mcp_tool_call`
> name, so PostHog's MCP views showed "MCP tool call (legacy)" with no tool name.

## How to query

Preferred: the session's **PostHog MCP connector** (decision 2026-08-23 —
option 2 of the key-provisioning discussion on PR #78). Runners inherit the
session's MCP connections: load the tool via ToolSearch (keyword `posthog
exec`; the server prefix is a connector UUID, so never hardcode the full tool
name) and run read-only HogQL via `call execute-sql {"query": …}`. The
`qa-env-runner` agent definition allowlists this tool. Cite "via PostHog MCP"
in evidence.

Fallback: `npx tsx scripts/qa-posthog-events.ts` (read-only HogQL probe; see
its header for flags). It requires `POSTHOG_PERSONAL_API_KEY` (Query:Read
scope) and `POSTHOG_PROJECT_ID` in the environment or `.env.local` — **these
are deliberately unprovisioned as of 2026-08-23**; the script becomes the
primary path for cloud/CI sessions only if Ken provisions the keys later.

Prerequisites and caveats:

- If NEITHER path is available (ToolSearch finds no PostHog tool — possible in
  cloud/CI sessions where the interactively-authenticated connector is absent,
  and the keys are unprovisioned), every assertion below is a `skip` with
  reason "no PostHog query path in this session" — never a pass.
- All three Vercel environments share one PostHog project. **Always filter on
  the `environment` property** matching the deployment under test:
  `development` (localhost), `preview` (`*.vercel.app`), `production`.
- Ingestion lags ~30–60s. Re-query at least twice over ~2 minutes before
  calling an expected event missing.
- Evidence masking: the script truncates distinct ids; never paste a full Clerk
  user id, email, or key into qa-results.json or anything public.

## Assertions

Run these AFTER the environment's other capabilities (they generate the tool
calls under inspection). Use `--since` spanning the run so counts are
attributable to it.

### A8: Response-size monitoring props on every tool call
- Inspect `$mcp_tool_call` events across services (gmail, sheets, docs tools)
  from this run.
- **Expected**: Every event carries `response_chars` and `response_kb`
  (monitoring-only — plan google-docs-support v5, D7: no size caps are
  enforced; the props exist so PostHog can measure how often responses exceed
  MCP clients' tool-result budgets). `gmail_get_attachment` additionally
  carries `attachment_chars`/`attachment_kb` on every outcome that reaches
  the attachment fetch, including the over-cap ⚠️ refusal — which since
  2026-08-24 classifies as `outcome=size_capped`, not `failed` (first shipped
  with the raw-api-classification change — earlier docs described these props
  ahead of the code). Events whose attachment fetch itself failed carry
  `attachment_declared_kb` (size from the parent's MIME metadata) instead —
  but only when the intended attachment is identifiable from the fresh
  parent read: filename-selected fetches, current-id fetches, and the
  single-attachment self-heal (`attachment_selfheal` `recovered`/
  `retry_failed`, which resolves the caller's stale id to the message's
  only attachment and stamps its declared size). The `ambiguous` and
  `no_attachments` branches cannot name a target attachment, so a null
  declared size there is correct, not a regression (2026-09-02 finding:
  before this the heal branch stamped nothing either, making the fallback
  black-box unreachable).
  Windowed reads (`gmail_get_attachment`, `docs_read_document`) add
  `window_offset` / `window_chars` / `window_total_chars` — asserted in
  capability 20 (A6), not re-checked here.

### A9: Raw Google API calls carry product/action classification
- Inspect `$mcp_tool_call` events where `$mcp_tool_name` is `google_api_get`
  or `google_api_modify` from this run (capability 10 generates them: a raw
  Gmail read, a raw Sheets call, and an unknown-family passthrough).
- **Expected**: every such event carries `raw_api_kind` (one of `sheets`,
  `sheets_create`, `docs`, `docs_create`, `gmail_read`, `gmail_send`,
  `gmail_draft_send`, `gmail_write`, `passthrough`, `denied`),
  `raw_api_mutating`, and `raw_api_endpoint` whose
  value is the HTTP method plus an **id-stripped** path template — it must
  contain `{id}`/`{range}` placeholders where the call used real identifiers
  and must NOT contain any actual spreadsheet/message/document id.
  `raw_api_family` is present on every non-denied event (`gmail`,
  `spreadsheets`, `documents`, or the passthrough family); denied events
  carry `denial_code` instead.

### A10: Google failure reason and account-resolution reason are recorded
- Inspect `$mcp_tool_call` events from this run whose `outcome` is `error` or
  `failed`.
- **Expected**:
  - Every `outcome=error` event carries `error_status`. Events whose Google
    response body included an error reason additionally carry `error_reason`
    (Google's `error.errors[0].reason`, e.g. `rateLimitExceeded`,
    `insufficientPermissions`, `domainPolicy`) and, when present,
    `error_domain` (e.g. `usageLimits`). Absent reasons are legitimate — some
    Google errors carry no `errors[]` — so assert "present when the body had
    one", not "always present".
  - No `error_reason` / `error_domain` value contains an email, message id,
    spreadsheet id, or any other identifier: these must only ever be Google's
    enum strings.
  - Every `outcome=failed` event produced by account/token resolution carries
    `failure_reason`, one of `no_proxy_key`, `no_accessible_accounts`,
    `account_not_permitted`, `google_token_unavailable`. Capability 03
    (multi-email scoping) and 07 (key lifecycle) generate the
    `account_not_permitted` and `no_proxy_key` cases respectively. Since
    2026-09-08 `account_not_permitted` with an EXPLICIT `account` argument
    (capability 03's MCP case) is a 🚫 refusal instead: `outcome =
    denied_by_policy`, `denial_code = failure_reason = 'account_not_permitted'`,
    text listing the usable accounts and saying to omit the parameter; the
    implicit case (no `account`, owner's own address not on the key) stays
    `failed`.
  - Since the directory-error demotion (PR #72 salvage, 2026-09-02), a second
    class of `outcome=failed` events exists: user/caller-fixable Google
    results demoted from `error` — the stale Gmail message-id/attachment-id
    404 guidance (`gmailNotFoundResult`) and the stale-comment 404 guidance
    (`commentsErrorResult`). These carry `error_status` (NOT
    `failure_reason`); a run where they classify as `outcome=error` is a
    regression. Genuine unhealth (5xx, `timeout`, `network`, throttling 403,
    exceptions) must still classify `error`.
  - Since the refusal graduation (2026-09-03), deterministic grant refusals
    classify `outcome=denied_by_policy` (🚫), NOT `failed` or `error`: the
    scope pre-flights (`denial_code` = `failure_reason` =
    `gmail_scope_missing` / `drive_file_scope_missing`, plus
    `google_scope_missing: true`) and the not-picked sheet/doc 403/404
    setup-link guidance (`fileGrantErrorResult` and id-addressed passthrough
    404s, `denial_code: file_grant_missing_at_google`, still carrying
    `error_status` when Google was reached). A run where any of these
    classify `failed` or `error` is a regression.
  - `outcome=failed` and `outcome=denied_by_policy` events must still have
    `$mcp_is_error = false`. These are deliberately `textResult`, not
    `errorResult`. A run where `$mcp_is_error` is true for either outcome is
    a regression, not a pass.
  - A `gmail_get_attachment` or `gmail_read` event with `error_status = 404`
    carries `gmail_404_site` (`message` or `attachment`). `attachment` means
    the parent message read succeeded and only the attachment id was stale.
    (Since the demotion these rows classify `outcome=failed`, not `error`.)

> **Runnable via the PostHog MCP connector** (load with `ToolSearch "posthog
> exec"`), which is how the 2026-08-26 baseline below was measured. The
> `scripts/qa-posthog-events.ts` path still needs `POSTHOG_PERSONAL_API_KEY`
> (`phx_…`, Query:Read) in `.env.local`, and the `.mcp.json` server still
> needs it in the shell env — `npm run env:check` reports both gaps. Use the
> connector when the script path is unprovisioned; record `blocked` only if
> neither is available.
>
> A10 does NOT require a production deploy. `captureServerEvent` tags
> `environment: process.env.VERCEL_ENV ?? 'development'`, so a local
> `npm run dev:qa` run emits these events under `environment='development'`
> and a preview deploy under `'preview'`. Run it per tier.
>
> **Executed locally 2026-08-27** against a real Clerk OAuth MCP session
> (`scripts/qa-dcr-setup.ts` → consent as USER_A → bearer token → `tools/call`).
> Confirmed present on `environment='development'` events:
>
> | property | observed value | on |
> | --- | --- | --- |
> | `error_reason` / `error_domain` | `notFound` / `global` | 404s |
> | `error_reason` / `error_domain` | `invalidArgument` / `global` | 400s |
> | `gmail_404_site` | `message` | `gmail_read` and `gmail_get_attachment` |
> | `failure_reason` | `account_not_permitted` | `gmail_list` |
> | `failure_reason` | `google_token_unavailable` | `gmail_list` |
>
> Both `failed` rows carried `$mcp_is_error = false`, confirming the
> textResult/errorResult decision holds at runtime. No property value
> contained an identifier.
>
> **NOT covered by that run, and still open:**
> - `gmail_404_site = 'attachment'` could not be produced synthetically (see
>   the Gmail 400-vs-404 note below).
> - `error_reason` on a 403 — no 403 could be induced on demand.
> - `failure_reason` of `no_proxy_key` / `no_accessible_accounts` — these need
>   capability 07 / 03 setup states.
>
> **Gmail returns 400, not 404, for a malformed id** (verified 2026-08-27):
> a non-hex `messageId` gives `400 Invalid id value`, and a tampered
> `attachmentId` gives `400 Invalid attachment token` — attachment ids are
> signed tokens, so corruption fails validation rather than lookup. A valid
> attachment token also still resolved when passed with a *different*
> `messageId`. Consequence for triage: the production
> `gmail_get_attachment` 404s cannot be fabricated or corrupted ids — they
> must be well-formed, previously-valid ids that no longer resolve, which is
> exactly the stale-id case the `attachment` remediation targets.
>
> Pre-deploy production baseline to compare against (2026-08-26): Gmail
> failures are 68 404s (38 `gmail_get_attachment`, 30 `gmail_read`), 19 403s,
> and 39 statusless `failed` calls. After deploy those 404s must carry
> `gmail_404_site` and those statusless calls must carry `failure_reason`; if
> they do not, the instrumentation regressed.

### A1: Canonical tool-call events arrive with tool names
- Run: `npx tsx scripts/qa-posthog-events.ts --event '$mcp_tool_call' --since <run window> --environment <tier>`
- **Expected**: `row_count` ≥ the number of MCP tool calls this run made;
  `missing_tool_name` is 0; `by_tool` lists the tools actually called
  (e.g. `gmail_send`, `get_my_permissions`) with plausible counts

### A2: No legacy-named events are emitted
- Run the same query with `--event mcp_tool_call` (legacy name, no `$`)
- **Expected**: `row_count` is 0 for the run window in this environment —
  nothing in the deployed code still captures the legacy event

### A3: Outcome taxonomy is recorded
- Inspect `by_outcome` from A1 (ensure the run included at least one allowed
  call and one policy-denied call, e.g. capability 01 A1 + A2)
- **Expected**: at least one `success` and at least one `denied_by_policy`;
  every outcome value is within {success, denied_by_policy, pending_approval,
  size_capped, failed, error, exception}

### A4: Events attribute to the Clerk user, not anonymous
- Inspect `rows[].distinct_id` from A1
- **Expected**: rows from this run's authenticated calls have a Clerk-style
  distinct id (masked, `user_…` prefix) — the same person the dashboard
  identifies — and none attribute to `anonymous-mcp`

### A5: Environment tagging matches the deployment tier
- Compare A1 run with and without the `--environment` filter over the run window
- **Expected**: every row from this run carries the correct `environment` value
  for the base URL under test (localhost → `development`, `*.vercel.app` →
  `preview`, `fgac.ai` → `production`); the filtered and unfiltered counts of
  this run's events match

### A6: Sign-up CTA event fires (browser environments)
- Signed out, load the landing page and click a sign-up CTA (do NOT complete
  sign-up — never create accounts); then
  `npx tsx scripts/qa-posthog-events.ts --event sign_up_started --since 10 --environment <tier>`
- **Expected**: ≥ 1 row with `cta_location` ∈ {nav, hero, bottom_cta}.
  Headless environments (no browser) `skip` with that reason.
  (`sign_up_completed` is deliberately untested — it requires creating a real
  account, which QA never does; it is validated implicitly by the Clerk
  webhook's own tests.)

### A7: Demo video play event fires (browser environments)
- Load the landing page and start playback on one of the Descript demo
  embeds — click its play control; if the embed ignores automated clicks,
  trigger playback from the page console instead
  (`document.querySelector('iframe[src*="share.descript.com"]').contentWindow.postMessage(JSON.stringify({context:'player.js',version:'0.0.11',method:'play'}),'*')`
  — this still exercises FGAC's listener + capture path end-to-end); then
  `npx tsx scripts/qa-posthog-events.ts --event video_played --since 10 --environment <tier>`
- **Expected**: ≥ 1 row whose `video_id` matches the embed and whose `page`
  is `/` (or the use-case page); exactly one event per video per page load
  regardless of subsequent pause/resume. Headless environments `skip`.

### A14: The approval funnel joins on a deterministic request_id
- Trigger the same denial three times (capability 14 A12), then approve the
  link once. Query the three approval events for the affected user:
  `SELECT event, properties.request_id, properties.action, count() FROM events
   WHERE event LIKE 'approval_link_%' AND timestamp >= now() - INTERVAL 1 HOUR
   GROUP BY 1,2,3`
- **Expected**: All three mint attempts carry the **same** `request_id`, and
  the `approval_link_opened` / `approval_link_approved` rows carry that same
  id — a single request joins across all three stages. `uniq(request_id)` = 1
  while `count()` on minted = 3
- **Regression**: before 2026-08-25 `link_id` was a per-mint JWT `jti`, so
  retries were indistinguishable from fresh demand. That is what made a funnel
  converting near 58% report as 31%

### A11: Mint events count attempts, not requests
- From the same three denials, inspect `mint_count` on the minted events and
  the `approval_requests` row
- **Expected**: `approval_link_minted` fires **once per attempt** (3 events),
  and the `approval_requests` row for that `request_id` has `mint_count` = 3
  with one `first_minted_at`. Demand (rows) stays separable from retry
  pressure (`mint_count`) — a funnel that collapses retries into one event
  would lose the retry signal entirely

### A12: Approval events carry no raw customer identifiers
- Inspect the properties of every `approval_link_*` event from the run
- **Expected**: `target_hash` is present for targeted actions and is a hash —
  it must NOT equal, contain, or reveal the spreadsheet id, document id, or
  recipient address. No raw file id, recipient address, or FGAC user id
  appears in any approval-event property, and none appears in the approval URL

### A13: Approve-page opens distinguish agents from people
- Open an approval link in the browser, then fetch the same URL with a
  non-browser user agent (an authenticated agent-style client)
- **Expected**: Both produce `approval_link_opened`; the browser open has
  `agent_driven: false` and the agent-style fetch has `agent_driven: true`
- **Why**: the event is captured server-side and carries no browser UA of its
  own, so every open previously looked identical. ~23% of production
  approve-page loads were an AI agent rather than a person, which meant
  "opened" systematically overstated human reach. Report approvals, not opens

### A15: rule_saved carries via and file_id for rule creation
- Create a Gmail rule via the dashboard's manual rule form (the modal is
  Gmail-only today), AND create a sheets (or docs) rule for a hand-typed
  never-picked fixture id through the app's own grant seam — as the
  signed-in user, `POST /api/rules/grant-sheets-access` with
  `{targetResourceId, resourceName, actionType}` (the same call the Picker
  manager makes; the same action capability 17 A10 exercises — one creation
  serves both). Then query `rule_saved` events for the run window
  (`npx tsx scripts/qa-posthog-events.ts --event rule_saved --since <run
  window> --environment <tier>`, or the PostHog MCP connector).
- **Expected**: the Gmail creation yields a row with
  `via = 'dashboard_manual'`, `mode = 'create'`, correct
  `service`/`action_type`; the grant-seam creation yields a row with
  `via = 'grant_api'`, `mode = 'create'`, and `file_id` equal to the typed
  id (re-POSTing the same id yields `mode = 'update'`). No row carries a
  `regexPattern`/pattern text property — only `pattern_kind`/
  `pattern_length` shape props ever leave the server. (The
  `dashboard_picker` and `magic_link` `via` values are generated by
  capabilities 09/19 and 14/17 respectively; when this run executed those,
  spot-check one row each — `dashboard_picker` rows carry `profile_scoped`,
  `magic_link` rows carry `request_id`.)

### A16: Per-file tool calls carry file_id and file_service
- Inspect the `$mcp_tool_call` events from this run's sheets/docs tool calls
  (capabilities 09/17/19 generate them — e.g. `sheets_read_range`,
  `docs_read_document`, `comments_read`, and a raw per-file `google_api_get`).
- **Expected**: every such event — denied and failed outcomes included —
  carries `file_id` (the spreadsheet/document id the call targeted) and
  `file_service` (`sheets`/`docs`), stamped in `checkFilePermission`. The
  `file_id` on a successful call matches the `file_id` on the `rule_saved`
  row that exposed the file (A15) — the join the per-file
  time-to-first-success funnel depends on. Gmail tool events carry neither
  prop.

### A17: Not-picked-file calls classify failed, not error, and keep error_status
- With a rule-covered-but-never-picked file (the capability 17 A7 state),
  call `sheets_get_spreadsheet` (or a docs read) via MCP; inspect that
  `$mcp_tool_call` event.
- **Expected**: `outcome = 'failed'` with `$mcp_is_error = false` — the ❌
  setup-link guidance text is a textResult, demoted out of the field
  Anthropic's Connector Directory reads — while the event still carries
  `error_status` (403 or 404 from Google) for internal observability, and no
  `failure_reason` (that prop is account-resolution's). A row classifying
  `outcome = 'error'` for this call is the pre-demotion regression. Genuine
  unhealth must be unaffected: any 5xx/`timeout`/`network` row from this run
  still classifies `error` with `$mcp_is_error = true`.

### A18: Reconnect funnel closes with a terminal event
- As a signed-in user whose Google grant is healthy, load
  `/dashboard/accounts?reconnected=1` directly (no real consent round-trip
  needed — the return leg runs on the param alone).
- **Expected**: `google_reconnect_returned` fires when the page processes the
  param, then `google_reconnect_verified` once the tokeninfo poll confirms
  both scopes (with a broken grant it fires `google_reconnect_incomplete
  {missing_scopes}` instead — either terminal event closes the funnel). A
  `google_reconnect_started` with NO subsequent `returned` is the alertable
  signature for abandoned consent or a session dropped during the OAuth
  round-trip (monitoring.md §7.8); a run where the return leg fires neither
  terminal event is a regression.

### A19: Google token failures classify by cause and name who must reconnect
- Inspect `$mcp_tool_call` events from this run with
  `failure_reason = 'google_token_unavailable'` or `'delegation_inactive'`,
  and any `google_token_retry` rows. (Inducing a Clerk-side token failure on
  demand is not possible with the QA accounts — see the A10 evidence note —
  so this assertion is satisfied by the absence of regressions on the rows
  that do occur, plus `npx tsx scripts/test-google-token-failure.ts`, which
  pins the per-class wording.)
- **Expected** (since 2026-09-04):
  - `google_token_unavailable` rows carry `google_token_error` (`no_token` /
    `refresh_failed` / `grant_revoked` / `owner_not_found` / `clerk_error` /
    `timeout`) and the
    outcome follows the cause: `no_token` / `refresh_failed` / `grant_revoked` /
    `owner_not_found` classify `denied_by_policy` with
    `denial_code: 'google_token_unavailable'` (🚫 text that says STOP and
    names who must act — for a delegated mailbox, the OWNER signed in as that
    account; `owner_not_found` carries NO reconnect link and says the owner
    must sign in to FGAC again). On a Vercel preview every delegated mailbox
    is expected to land in `owner_not_found`: the preview database is a copy
    of production, so the delegator's row carries a production Clerk id the
    dev Clerk instance 404s on — an environment artifact, not a regression; `clerk_error` / `timeout` classify `failed` (❌ text that
    says retry ONCE before offering the reconnect link). A `no_token` or
    `refresh_failed` row classifying `failed`, or a `clerk_error` row
    classifying `denied_by_policy`, is a regression.
  - `delegation_inactive` rows (access row present, delegation no longer
    active) classify `failed` with re-delegate guidance and NO reconnect link.
  - A call whose first Clerk fetch failed and whose single server-side retry
    succeeded carries `google_token_retry: 'recovered'` on a `success` row and
    fires NO `google_token_fetch_failed`; `retry_failed` accompanies a final
    failure, whose standalone event carries `retried: true` and, when Clerk
    threw an API error, `clerk_status` / `clerk_code`. `google_token_fetch_failed`
    also fires for `reason = 'no_token'` (it did not before this date).
  - (since 2026-09-09) A Clerk 400 `oauth_token_retrieval_error` classifies
    `grant_revoked` on every path (`via` = `mcp` / `proxy` / `grant_check`):
    `retried: false` (never retried), outcome `denied_by_policy`, and the
    tool-call row carries `google_token_clerk_code:
    'oauth_token_retrieval_error'`. A `grant_revoked` row classifying `failed`,
    an `oauth_token_retrieval_error` row with `reason = 'clerk_error'`, or a
    `retried: true` on that code, is a regression.
  - `error_reason` stays absent on every token-layer row — it is the
    Google-response property and the token layer never reached Google.

### A20: approval_link_approved counts written grants; replays are a separate event
- Run capability 14 A15's server half (two submits of one file-grant approval
  landing together) and its generic twin (two `requestSubmit()` on a
  send-whitelist approval), then query the affected user's events for the last
  hour: `SELECT event, properties.action, properties.path, count() FROM events
  WHERE event IN ('approval_link_approved','approval_link_replayed','rule_saved')
  AND timestamp >= now() - INTERVAL 1 HOUR GROUP BY 1,2,3`
- **Expected**: per link exactly ONE `approval_link_approved` and ONE
  `rule_saved{via=magic_link}`; every extra submit is an
  `approval_link_replayed` carrying the same `request_id` and `action`, with
  `path='picked'` for the file grant and `path='grant_active'` for the send
  grant. `count(approval_link_approved) = uniq(request_id)` over the run.
  A replayed file approval makes NO `sheets_grant_verification` /
  `docs_grant_verification` event (no Google call)
- **Regression**: between 2026-08-25 and 2026-09-05 the picked-file path
  re-fired `approval_link_approved` per replay, so raw counts overstated
  conversion (71% raw vs 37% per link in the last pre-fix week). Funnel
  queries must divide `uniq(request_id)` by `uniq(request_id)` —
  `docs/monitoring.md` 7.14

### A21: Picker cancels and post-pick verification failures are measurable
- Run capability 17 A12 (cancel the Picker on the approve page, then Try
  again and pick), then query the user's events for the last hour:
  `SELECT event, properties.kind, properties.attempt, properties.elapsed_ms,
  properties.from_oauth_return, properties.via, properties.result,
  properties.picked_count FROM events WHERE event IN
  ('picker_opened','picker_cancelled','picker_picked','sheets_grant_verification')
  AND timestamp >= now() - INTERVAL 1 HOUR ORDER BY timestamp`
- **Expected**: `picker_opened {attempt: 1}` → `picker_cancelled {attempt: 1,
  elapsed_ms > 0, from_oauth_return: false}` → `picker_opened {attempt: 2}` →
  `picker_picked`. If the post-pick approval is submitted while Google has not
  yet propagated the grant (the "Google hasn't finished sharing… pick again"
  notice), `sheets_grant_verification {via: 'magic_link', result: 'missing',
  picked_count: 1, request_id}` fires for that submit; the eventual success
  fires the existing `{via: 'magic_link', result: 'ok'}`. `docs_*` twins carry
  the same props. The `request_access` mint from capability 15 A8 carries
  `has_resource_name: true`; a denial mint carries none. Since 2026-09-09 each
  pick-button click also lands a SERVER row `picker_token_requested {result:
  'ok', has_drive_file_scope: true, scope_source, app_id_resolved: true,
  page: '/dashboard/approve'}` (capability 17 A14) — so for the run above,
  `count(picker_token_requested) = count(picker_opened) = 2`. The
  `approval_link_opened` row for the run carries `client: 'browser'`
  (`claude_desktop` when the link is opened inside the Claude desktop app;
  `agent` only for non-browser fetchers), with `agent_driven: false` for
  both human classes. **The built-in browser pane IS Claude desktop** — its
  UA carries `Claude/<build> Chrome/…`, so opens driven from the pane land
  as `client: 'claude_desktop'` by design; assert `browser` only from a real
  Chrome (Path B). Also expect more `approval_link_opened` rows than clicks:
  the event fires per server render of the page (RSC refreshes and
  navigations re-render it), which is why the funnel is read per
  `request_id`, never per row
- **Regression**: until 2026-09-08 `picker_cancelled` carried only `kind`, so
  cancel-then-retry was indistinguishable from cancel-and-leave, and the
  failed post-pick verification emitted nothing — the 8-second retry loop one
  launch-cohort user ran 12 times (PostHog, 2026-08-31) was only visible as
  server-side `approval_link_opened` events with no pageview
