# Agent: Claude Code MCP

> Runs ALL capabilities via Claude Code MCP in a tmux session.
> Package #3 from distribution_architecture.md.

## Environment Setup

1. **Run reset**: `bash test/qa-envs/cc-mcp/reset.sh`
2. Configure MCP Server using the Claude CLI:
   ```bash
   cd test/qa-envs/cc-mcp && claude mcp add --transport http fgac http://localhost:3000/api/mcp
   ```
3. Launch Claude Code IN the workspace:
   ```bash
   tmux new-session -d -s fgac-qa -x 200 -y 50 "cd test/qa-envs/cc-mcp && claude --dangerously-skip-permissions"
   ```
4. Verify Discovery: Enter `/mcp` in Claude Code and confirm `fgac` is listed.

## Auth Setup

> **⚠️ Existing Connection Re-use**: Claude Code's MCP transport uses a stable
> client ID. If a previous QA cycle already created and approved a connection
> for this client, new OAuth flows will auto-match to the existing connection
> and its bound proxy key — which may be the wrong key (e.g., "Restricted Agent"
> with no email access instead of "QA-Agent-A"). **Before running tests:**
> 1. Navigate to `http://localhost:3000/dashboard#connected-agents`
> 2. Find any existing approved connection for this Claude Code client
> 3. Verify it is bound to `QA-Agent-A` (or the intended test key)
> 4. If bound to the wrong key: **Block** it, then re-approve with the correct key

1. Start MCP auth:
   ```bash
   tmux send-keys -t fgac-qa "/mcp" Enter
   # Select fgac → Authenticate
   ```
4. Extract auth URL from tmux output:
   ```bash
   AUTH_URL=$(tmux capture-pane -t fgac-qa -p -S -50 | grep -o 'http[s]*://[^ ]*auth[^ ]*')
   ```
5. Auto-consent in the **built-in browser** (default — it holds the signed-in QA
   sessions): `navigate` to `$AUTH_URL`, `read_page`, click **Allow** via its `ref`.
   Playwright CLI fallback only if the built-in session has expired (password prompt):
   ```bash
   npx @playwright/cli -s=fgac_ui goto "$AUTH_URL"
   # Wait for and click "Allow" button
   ```
6. Verify authentication:
   ```bash
   tmux capture-pane -t fgac-qa -p | grep "Authentication successful"
   ```
7. Approve connection via `/browser-agent`:
   - Navigate to `http://localhost:3000/dashboard#connected-agents`
   - Find the pending connection for this client
   - Select a proxy key from the dropdown and click **Approve**
   - ⚠️ **NEVER approve connections via direct DB writes — always use the Web UI**

## Proof of Authenticity

> The following evidence proves Claude Code (not a script) processes requests:

- [ ] `tmux capture-pane` output shows Claude Code's TUI rendering the tool call
- [ ] Screenshot of Claude Code session showing `fgac` tool invocation
- [ ] Output is from Claude's natural language processing, not a raw `node gmail.js` call

---

## Capability: Send Whitelist (→ capabilities/01_send_whitelist.md)

### A1: Send to whitelisted address
```bash
tmux send-keys -t fgac-qa "Send an email to $USER_B_EMAIL with subject 'QA CC MCP - Send Whitelist A1' and body 'Test from Claude Code MCP'" Enter
```
- [ ] Claude Code invokes `gmail_send`, email sent successfully

### A2: Send to blocked address
```bash
tmux send-keys -t fgac-qa "Send an email to blocked@untrusted.com with subject 'Blocked'" Enter
```
- [ ] Claude Code reports whitelist error from fgac

---

## Capability: Read Blacklist (→ capabilities/02_read_blacklist.md)

### A1: Read blacklisted email
```bash
tmux send-keys -t fgac-qa "Read the email from sales@competitor.com" Enter
```
- [ ] Claude Code reports "Access restricted" error

### A4: Read normal email
```bash
tmux send-keys -t fgac-qa "List my recent emails" Enter
```
- [ ] Claude Code returns email list via `gmail_list`

---

## Capability: Multi-Email Scoping (→ capabilities/03_multi_email_scoping.md)

### A1: List accounts
```bash
tmux send-keys -t fgac-qa "What email accounts can I access?" Enter
```
- [ ] Shows correct email accounts for this proxy key

---

## Capability: Delegation (→ capabilities/04_delegation.md)

### A6: List accounts shows delegated
```bash
tmux send-keys -t fgac-qa "List my email accounts" Enter
```
- [ ] Shows both own and delegated emails (if delegation configured)

### A8: List accounts reports per-account scope state
```bash
tmux send-keys -t fgac-qa "List my email accounts and tell me each account's Google scope state verbatim from account_details" Enter
```
- [ ] `account_details` reports three-state `gmail`/`drive_file` per account
  (`granted` on healthy QA accounts); any `reconnect_url` is bound with
  `&for=<email>`

---

## Capability: Connection Lifecycle (→ capabilities/06_connection_lifecycle.md)

### A3-A5: Tested during auth setup above
- [ ] Pending connection created during OAuth
- [ ] Approved in dashboard
- [ ] Tools work after approval

### A6: get_my_permissions
```bash
tmux send-keys -t fgac-qa "What are my permissions?" Enter
```
- [ ] Shows connection, key, emails, rules

### A12: Profile-addressed URL binds to that profile
```bash
# <slug> = a non-default profile's label slugified ("All Access" → all-access)
claude mcp add --transport http fgac-slug <BASE_URL>/api/mcp/<slug>
claude mcp login fgac-slug    # needs a TTY — run inside tmux, complete OAuth via /browser-agent
```
- [ ] After OAuth, `get_my_permissions` (or the dashboard) shows the new
      connection bound to the slug's profile — no dashboard attach step

### A13: URL change never rebinds an existing connection
```bash
claude mcp remove fgac-slug && claude mcp add --transport http fgac-slug <BASE_URL>/api/mcp/<other-slug>
```
- Reconnect (cached credentials reuse the same OAuth client for the same
  entry name in the same project)
- [ ] The connection stays bound to its ORIGINAL profile; only the dashboard
      can rebind (cap 06 A5)

---

## Capability: Label Access (→ capabilities/05_label_access.md)

```bash
tmux send-keys -t fgac-qa "Read the email labeled Highly-Confidential" Enter
```
- [ ] Blocked by label blacklist (if configured)

---

## Capability: Key Lifecycle (→ capabilities/07_key_lifecycle.md)

> Key revocation tested by revoking key in dashboard, then retrying:
```bash
tmux send-keys -t fgac-qa "List my emails" Enter
```
- [ ] Returns error after key revocation

---

## Capability: Light Mode (→ capabilities/08_strict_light_mode.md)

> Tested via browser agent — same for all agents. See capability doc.

---

## Cleanup

```bash
tmux kill-session -t fgac-qa
```

## Capability: Partner Handoff (→ capabilities/11_partner_handoff.md)

> Channel-inapplicable here: the handoff is a browser + REST surface, executed
> once per cycle via agents/01_hosted_mcp.md. Record as skip with reason
> "runs in hosted-mcp runbook".

## Capability: Push Notifications (→ capabilities/12_push_notifications.md)

> Channel-inapplicable here: server-side pipeline, executed once per cycle via
> agents/01_hosted_mcp.md. Record as skip with reason "runs in hosted-mcp runbook".

## Capability: Sheets Grant Recovery (→ capabilities/17_sheets_grant_recovery.md)

- A1/A7: issue `sheets_get_spreadsheet` through the Claude Code MCP
  connection (tmux session) on the never-picked fixture sheet; capture the
  denial link (A1) and, post-approval, the honest stranded-sheet error (A7).
- A2–A6: browser-side and identical to the hosted-MCP runbook — execute
  there or re-run here with this runtime's denial links; either satisfies
  coverage as long as qa-results.json attributes the environment that ran it.
- A4 retry + A8 events: retry via this MCP connection; events via the
  capability-16 script with `--environment development`.

## Capability: Docs Management (→ capabilities/19_docs_management.md)

- Drive the docs tools conversationally through Claude Code MCP: ask for a
  read of the exposed fixture doc (expect content), the external doc (expect
  the FGAC denial + docs_expose link relayed verbatim), an append and a
  replace under each permission level, and a raw `v1/documents` POST for the
  auto-grant assertion (A10).
- Dashboard/browser halves (A1–A4, A12) run via `/browser-agent` per
  capability 09's harness note, docs variant (`grant-docs-access` seam).

---

## Capability: Slides Management (→ capabilities/21_slides_management.md)

- Drive the slides tools conversationally through Claude Code MCP: ask for a
  read of the exposed fixture presentation (expect the raw presentation JSON),
  the external presentation (expect the FGAC denial + slides_expose link
  relayed verbatim), a createSlide / insertText edit under each permission
  level, and a raw `v1/presentations` POST for the auto-grant assertion (A10).
- Dashboard/browser halves (A1–A4, A12) run via `/browser-agent` per
  capability 09's harness note, slides variant (`grant-slides-access` seam).
- A14: a 403 `SERVICE_DISABLED` on any Slides call is the GCP-console
  blocker — record it as `blocked`, never as a rule or grant failure.

---

## Capability: Windowed Large Responses (→ capabilities/20_attachment_reading.md)

- Fixtures: an under-150 KB attachment, an over-160 KB attachment, and a
  long-bodied (> 20k chars) message in the QA mailbox (send between
  USER_A/USER_B under the standing permission if absent), plus the QA sheet
  and doc from setup.
- A1–A7: drive the adopter tools (`gmail_get_attachment`, `gmail_read`,
  `docs_read_document`, sheets reads, `google_api_get`) through the tmux
  Claude Code MCP session, varying `offset`/`limit` per the capability doc.
  For A3, have the agent save each window's `data` to files, concatenate,
  decode once, verify length/hash; if the runtime can't hash, assert
  `total_chars` equals the summed `chars_returned` and the final
  `next_offset` is null.
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
