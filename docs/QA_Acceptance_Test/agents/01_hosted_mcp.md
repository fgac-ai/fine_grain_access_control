# Agent: Hosted MCP Server

> Runs ALL capabilities via curl against the MCP endpoint.
> Package #1 from distribution_architecture.md.

## Environment Setup

1. **Run reset**: `bash test/qa-envs/hosted-mcp/reset.sh`
2. Ensure dev server is running at `$BASE_URL` (default: `http://localhost:3000`)
3. Ensure `/qa-setup` is completed (keys, rules, emails configured)
4. Proceed to Auth flow (DCR registration via curl, saving tokens to `test/qa-envs/hosted-mcp/state.json`)

## Auth Setup

1. Register a Dynamic Client:
   ```bash
   REG_ENDPOINT=$(curl -sf $BASE_URL/.well-known/oauth-authorization-server | jq -r '.registration_endpoint')
   DCR=$(curl -sf $REG_ENDPOINT -X POST -H "Content-Type: application/json" \
     -d '{"client_name":"QA Hosted MCP Test","redirect_uris":["http://localhost:9999/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}')
   CLIENT_ID=$(echo $DCR | jq -r '.client_id')
   ```
2. Complete OAuth flow (via `/browser-agent`) to get access token
3. Approve connection via `/browser-agent`:
   - Navigate to `$BASE_URL/dashboard#connected-agents`
   - Find the pending connection for this client
   - Select a proxy key from the dropdown and click **Approve**
   - ⚠️ **NEVER approve connections via direct DB writes — always use the Web UI**

## Proof of Authenticity

> The following evidence proves the real MCP runtime processes requests:

- [ ] Raw `curl` output captured showing full HTTP request/response
- [ ] Response headers include `x-mcp-session-id`
- [ ] Auth went through full OAuth DCR → token → MCP endpoint chain (not a static key)

---

## Capability: Send Whitelist (→ capabilities/01_send_whitelist.md)

### A1: Send to whitelisted address
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"gmail_send","arguments":{"to":"'$USER_B_EMAIL'","subject":"QA Hosted MCP - Send Whitelist A1","body":"Test from hosted MCP"}},"id":1}'
```
- [ ] Send succeeds

### A2: Send to blocked address
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"gmail_send","arguments":{"to":"blocked@untrusted.com","subject":"Blocked","body":"Test"}},"id":1}'
```
- [ ] Returns error: "Unauthorized email address"

### A3: get_my_permissions shows send whitelist
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_my_permissions","arguments":{}},"id":1}'
```
- [ ] Shows send whitelist rules

---

## Capability: Read Blacklist (→ capabilities/02_read_blacklist.md)

### A1: Read blacklisted sender domain
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"gmail_read","arguments":{"query":"from:sales@competitor.com"}},"id":1}'
```
- [ ] Returns "Access restricted"

### A4: Non-blacklisted email reads successfully
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"gmail_list","arguments":{}},"id":1}'
```
- [ ] Returns email list

---

## Capability: Multi-Email Scoping (→ capabilities/03_multi_email_scoping.md)

### A1: Key accesses mapped email
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_accounts","arguments":{}},"id":1}'
```
- [ ] Returns exactly the emails mapped to this proxy key

### A2: Key blocked from unmapped email
```bash
curl -s $BASE_URL/api/mcp -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"gmail_list","arguments":{"account":"unmapped@other.com"}},"id":1}'
```
- [ ] Returns error: email not accessible

---

## Capability: Delegation (→ capabilities/04_delegation.md)

### A6: list_accounts shows delegated emails
- [ ] Returns both own and delegated email

### A8: list_accounts reports per-account scope state
- [ ] Same call: `account_details` present with `email`/`delegated` and
  three-state `gmail`/`drive_file` (`granted` on healthy QA accounts);
  `reconnect_url` only on accounts with a definitive problem, bound with
  `&for=<email>`

---

## Capability: Connection Lifecycle (→ capabilities/06_connection_lifecycle.md)

### A1-A2: Discovery and 401
- [ ] Discovery endpoints valid (tested during auth setup)
- [ ] Unauthenticated request returns 401

### A3-A5: Pending → Approve → Tools work
- [ ] Pending connection created during auth
- [ ] Approved via dashboard
- [ ] Tools return data after approval

### A6: get_my_permissions
- [ ] Shows connection ID, nickname, key, emails, rules

### A7: Block → rejected
- [ ] Tool call returns "blocked" message

### A12: Profile-addressed URL binds a new connection to that profile
- Discovery per-URL first (curl, no auth): `POST /api/mcp/<slug>` → 401 whose
  `resource_metadata` points at `/.well-known/oauth-protected-resource/mcp/<slug>`;
  that document AND the RFC 9728 probe form
  `/.well-known/oauth-protected-resource/api/mcp/<slug>` both return
  `resource` = the full slug URL. `<slug>` = a non-default profile's label
  slugified (lowercase, non-alphanumerics → `-`)
- Register a FRESH DCR client and complete OAuth (same procedure as auth
  setup) against `/api/mcp/<slug>`
- [ ] Dashboard shows the new connection already bound to the slug's profile
      (no approval/attach step)
- [ ] A nonsense slug (`/api/mcp/no-such-profile`) still authenticates but
      binds to the Default Profile

### A13: Profile-addressed URLs never rebind an existing connection
- Reuse the A12 client's bearer token; POST a tool call to a DIFFERENT
  profile's slug URL
- [ ] Call succeeds under the ORIGINAL profile's rules; dashboard binding
      unchanged

---

## Capability: Key Lifecycle (→ capabilities/07_key_lifecycle.md)

### A1: Revoked key rejected
- [ ] 401 with revoked key

---

## Capability: Label Access (→ capabilities/05_label_access.md)

- [ ] Whitelisted label allows read
- [ ] Blacklisted label blocks read

---

## Capability: Light Mode (→ capabilities/08_strict_light_mode.md)

> Tested via browser agent — same for all agents. See capability doc.

- [ ] Light mode enforced regardless of OS preference

## Capability: Partner Handoff (→ capabilities/11_partner_handoff.md)

> Primary runbook for this capability. Prereq: `setup/04_partner_app_registration.md`.

- Build the authorize URL from `qa-test-agents.json` → `qa_partner` (client_id,
  PKCE challenge, redirect_uri `http://localhost:3000/oauth/callback`).
- A1: bogus client_id via browser agent → error page.
- A2–A4: browser agent as USER_A — interstitial render, Deny round-trip,
  Approve → callback lands with `code` (the QA `/oauth/callback` route
  auto-exchanges and saves `qa-token-<client_id>.json`).
- A5: token file has refresh_token; `curl /api/mcp` `list_accounts` with the
  access token → data, no pending. Refresh grant against the Clerk token URL.
- A6: `curl -X POST /api/auth/partner-token -H "Authorization: Bearer <at>"` →
  `sk_proxy_...`; then `curl /gmail/v1/users/me/messages?maxResults=1` with it.
- A7: use a plain DCR client (`scripts/qa-dcr-setup.ts`) driven straight at the
  Clerk authorize URL → MCP call returns pending.
- A8: `gmail_send` via MCP + `messages/send` via proxy with the partner key →
  both 403/denied.
- A9: browser agent — partner badge on the connection card; Detach; re-try MCP
  + proxy calls → refused.
- A10: re-run `register-partner-app.ts` with a changed manifest; verify
  connection's pinned `manifestVersion` and rules unchanged.

## Capability: Push Notifications (→ capabilities/12_push_notifications.md)

> Server-side capability — run ONCE per QA cycle from this runbook. Prereqs:
> setup/04 complete, receiver + bridge running, dev server restarted after
> `setup-gmail-push.ts` wrote env vars.

- A1: after the cap-11 Approve, query the dashboard/DB state via
  `get_my_permissions` + `qa-webhook-log.json` baseline; subscription active.
- A2/A3: `gmail_send` a self-email to USER_A (whitelist it first or send via
  Gmail API using the vaulted token per spike method); bridge drains; assert
  the receiver log entry (signature_valid=true, ids-only payload).
- A4: add label blacklist rule via dashboard; labeled email → no ping;
  unlabeled control email → ping.
- A5: re-run `setup-gmail-push.ts --apply` (re-arms nothing) or re-arm watch;
  assert `enqueued=0` behavior on the arm-time notification.
- A6: re-POST the last drained envelope with the bridge secret → `enqueued: 0`.
- A7/A8: touch `qa-webhook-fail`; email; drain; call
  `/api/cron/deliver-webhooks` to walk the ladder; verify dead + suspension;
  remove flag, re-enable, verify recovery.
- A9: age `watchExpiresAt`; GET `/api/cron/renew-watches`; verify advance.
- A10: Detach via browser agent; email again → silence.
- A11: unauthenticated POST to `/api/webhooks/gmail` → 401.
- A12: `setup-gmail-push.ts --project dev-fgac-ai` dry run → all ✔.

## Capability: Sheets Grant Recovery (→ capabilities/17_sheets_grant_recovery.md)

> Needs a spreadsheet that has NEVER been picked in this environment (create
> a fresh one as USER_A) plus the standing picked QA fixture sheet. Browser
> assertions run in the built-in browser signed in as USER_A.

- A1: `sheets_get_spreadsheet` on the fresh sheet via hosted MCP → capture
  the denial text and its `/dashboard/approve` link.
- A2: open the link → assert the pick-first state (`sheets-flow-pick-first`
  testid): no approve/submit control rendered, no rule created, link not
  consumed (reload still shows the flow).
- A3: assert the pick button AND the Descript embed
  (`iframe[src*='Fv9pwXugLUa']`) on the approve page's pick-first state.
- A4: full pick (of the requested sheet) via Playwright CDP path
  (capability 09 harness note) → confirm step shows the real title →
  approve Read Only → success page; retry the MCP call → success. Legacy
  path: `/dashboard/sheets-setup?sid=…` still picks→verifies for stranded
  rules.
- A5: mint a denial for the standing fixture sheet (delete its FGAC rule
  first if present), open link → straight confirm (no pick step) → approve
  → success; retried read succeeds.
- A9: from the pick-first state pick a DIFFERENT owned sheet → substitution
  confirm (`sheets-flow-substitution` testid) → approve → rule for picked id
  only; requested id has no rule; retry on requested id still errors
  honestly (A7) while the picked sheet's call succeeds.
- A6: `/dashboard` and `/dashboard/accounts` → "needs Google access" chip on
  the stranded rule only; recovery panel opens from the chip.
- A7: retry the sheets call while stranded → error text names FGAC approval
  vs Google setup and points at the dashboard; no "Check the ID" copy.
- A8: covered by a capability-16-style event query (PostHog MCP primary, per
  capability 16 "How to query"): events `sheets_grant_verification` and
  `sheets_grant_recovered` scoped to the run window.

## Capability: Raw Google API Pair (→ capabilities/10_raw_google_api.md)

> Allow-by-default posture (2026-08-30): Gmail mailbox writes succeed; sends
> (messages/send AND drafts/send) ride the whitelist; settings writes and
> batchDelete are refused with honest reasons.

- A1, A10: `tools/list` + `initialize` via curl — check annotations, absence
  of `raw_google_api_call`, and the description/instructions claims (must NOT
  say "the only supported Gmail write is messages/send").
- A2–A9: `tools/call` via curl on `google_api_get` / `google_api_modify`,
  using ids from a prior `gmail_list` and the setup doc's sheets fixtures.
- A4: three writes that must SUCCEED — `messages/<id>/modify`
  (removeLabelIds UNREAD), `labels` create, `messages/batchModify` applying
  the new label. Verify event props via capability 16's query path.
- A11: `drafts` create addressed to `blocked@untrusted.com` (must succeed),
  then `drafts/send` with that draft id (must be DENIED with approval
  links — recipients came from the stored draft). Whitelisted-draft variant
  sends for real (standing permission covers QA-account mail).
- A12: `PATCH settings/sendAs/<alias>` → `gmail_settings_unsupported` scope
  message (no approval link); `messages/batchDelete` →
  permanent-deletion refusal; `GET settings/sendAs` still succeeds.
- A13: `POST drive/v3/files/<S>/copy` (succeeds, copy auto-granted), Read Only
  and unexposed-source variants, `POST drive/v3/files` creates.
- A14: `PATCH drive/v3/files/<id>` rename/trash and `POST …/permissions` on
  Read & Write / Read Only / Blocked / no-rule sheets; `GET drive/v3/files`
  and `generateIds` stay passthrough; raw JSON-RPC `method: "DELETE"` must be
  rejected by the schema (`isError`, no Google call). Untrash and un-share in
  Drive afterwards (permission removal is DELETE-only, unavailable via FGAC).
- A15: one file per creation path (`v4/spreadsheets`, `v1/documents`,
  `drive/v3/files` Sheets mimeType, `files/<id>/copy`, `drive/v3/files`
  text/plain) → write, trash, GET `?fields=trashed`, untrash, rename must all
  succeed with no approval; pure `tools/call` via curl, no browser needed.

## Capability: Docs Management (→ capabilities/19_docs_management.md)

- A5–A10, A13: `tools/call` via curl on `docs_read_document` / `docs_edit` /
  `comments_read` / `comments_add` / `google_api_get` (`v1/documents/<id>`) /
  `google_api_modify` (`:batchUpdate`, and POST `v1/documents` for the
  auto-grant), using the setup doc's exposed + external docs fixtures.
- A11: proxy-route probes with the profile's `sk_proxy_` bearer against
  `$BASE_URL/api/proxy/v1/documents/...` and `.../drive/v3/files/<doc id>`.
- A1–A4, A12: browser assertions via `/browser-agent` (picker iframe caveats
  identical to capability 09; app-API seam is `POST /api/rules/grant-docs-access`;
  full-fidelity picks via the Playwright CDP path).

---

## Capability: Slides Management (→ capabilities/21_slides_management.md)

- A5–A10, A13: `tools/call` via curl on `slides_get_presentation` /
  `slides_edit` / `comments_read` / `comments_add` / `google_api_get`
  (`v1/presentations/<id>` and `slides/v1/presentations/<id>`) /
  `google_api_modify` (`:batchUpdate`, and POST `v1/presentations` for the
  auto-grant), using the setup doc's exposed + external presentation fixtures.
- A11: proxy-route probes with the profile's `sk_proxy_` bearer against
  `$BASE_URL/api/proxy/v1/presentations/...` and `.../drive/v3/files/<presentation id>`.
- A1–A4, A12: browser assertions via `/browser-agent` (picker iframe caveats
  identical to capability 09; app-API seam is `POST /api/rules/grant-slides-access`;
  full-fidelity picks via the Playwright CDP path).
- A14 (API enablement): read `error_reason` on any Slides failure — a 403
  `SERVICE_DISABLED` is the GCP-console blocker, not a rule or grant problem;
  report it as `blocked` with the project number from the error body.

---

## Capability: Windowed Large Responses (→ capabilities/20_attachment_reading.md)

- Fixtures: an under-150 KB attachment, an over-160 KB attachment, and a
  long-bodied (> 20k chars) message in the QA mailbox (send between
  USER_A/USER_B under the standing permission if absent), plus the QA sheet
  and doc from setup.
- A1–A7: `tools/call` via curl on `gmail_get_attachment`, `gmail_read`,
  `docs_read_document`, `sheets_read_range`/`sheets_get_spreadsheet`, and
  `google_api_get`, varying `offset`/`limit` per the capability doc. A3
  reassembly: concatenate the windows' `data` strings in offset order,
  base64url-decode once, compare `shasum` + length against the sent file;
  A4/A5: concatenated windows must equal the windowless read.
- A8: fold into the Analytics Events queries below (same run window).

---

## Capability: Analytics Events (→ capabilities/16_analytics_events.md)

> Run LAST — it inspects the PostHog events the capabilities above generated.
> Environment tier here is `development` (localhost dev server).

- A1–A5: query per capability 16 “How to query” — primary: the session's
  PostHog MCP connector (load via ToolSearch keyword `posthog exec`, then
  `execute-sql` HogQL) filtering `properties.environment = 'development'` and the
  run window; fallback: `npx tsx scripts/qa-posthog-events.ts --event
  '$mcp_tool_call' --since <minutes since run start> --environment development`
  (needs the currently-unprovisioned query keys). A2 expects 0 rows for the
  legacy `mcp_tool_call` name. `skip` only if the session has no PostHog
  query path at all. Ingestion lags ~30–60s — re-query before failing.
- A6: via the browser agent, click a sign-up CTA signed-out (never complete
  sign-up), then query `--event sign_up_started`. Headless-only run → `skip`.
- A7: start playback on a landing-page demo video (play control, or the
  console postMessage fallback in the capability doc), then query
  `--event video_played`. Headless-only run → `skip`.
