# Agent: Claude Code CLI (Local Scripts)

> Runs ALL capabilities via Claude Code invoking local scripts (auth.js, gmail.js).
> Package #4 from distribution_architecture.md — shares scripts with OpenClaw skill.

## Testing Model: Two-Phase Hybrid

This agent uses a **two-phase hybrid testing approach** based on Anthropic's best practices
for skill testing. Phase 1 handles interactive auth, Phase 2 uses `claude -p` headless mode.

### Phase 1: Auth Setup (Interactive, One-Time)

1. **Run reset**: `bash test/qa-envs/cc-cli/reset.sh`
   - Copies plugin into `.claude/skills/fgac/` (mimics marketplace install)
   - Installs npm dependencies
2. **Authenticate**:
   ```bash
   FGAC_ROOT_URL=http://localhost:3000 node test/qa-envs/cc-cli/.claude/skills/fgac/scripts/auth.js --action login
   ```
   Complete OAuth in browser via `/browser-agent`, then approve connection in dashboard:
   Navigate to `http://localhost:3000/dashboard#connected-agents`, find the pending connection,
   select a proxy key and click **Approve**.
   ⚠️ NEVER approve connections via direct DB writes — always use the Web UI.
3. **Retrieve proxy key**:
   ```bash
   FGAC_ROOT_URL=http://localhost:3000 node test/qa-envs/cc-cli/.claude/skills/fgac/scripts/auth.js --action status
   ```
4. **Verify credentials exist**:
   ```bash
   test -f ~/.openclaw/fgac/fgac-credentials.json && echo "✅ Auth ready" || echo "❌ Auth needed"
   ```

### Phase 2: Headless Capability Eval (`claude -p`)

Once auth is pre-seeded, run the eval suite:
```bash
cd test/qa-envs/cc-cli && bash evals/run_evals.sh
```

This runs each test case via `claude -p` (non-interactive mode) with:
- `--output-format json` — structured results with tool calls, cost, turns
- `--allowedTools "Bash(node:*)"` — restricted to skill scripts
- `--max-turns 5` — prevents runaway execution
- `--dangerously-skip-permissions` — unattended execution

> **Key insight**: Slash commands (`/fgac`) are interactive-only. In `-p` mode,
> prompts reference the skill by its trigger description in natural language
> (e.g., "Using the fgac skill, ...").

## Proof of Authenticity

> Evidence that Claude Code discovers and invokes the skill (not a test harness):

- [ ] `claude -p` JSON output contains `num_turns > 1` (Claude made tool calls)
- [ ] Result JSON shows Bash tool invocations in the `usage.iterations` array
- [ ] Output references specific script behavior (FGAC proxy, Message IDs)

---

## Capability: Send Whitelist (→ capabilities/01_send_whitelist.md)

### A1: Send to whitelisted address
```bash
claude -p "Using the fgac skill, send an email to \$USER_B_EMAIL with subject 'QA CC CLI - Send Whitelist A1' and body 'Test'" \
  --allowedTools "Bash(node:*)" --output-format json --max-turns 5 --dangerously-skip-permissions
```
- [ ] Result contains "sent successfully" or "Message ID"

### A2: Send to blocked address
```bash
claude -p "Using the fgac skill, send an email to blocked@untrusted.com with subject 'Should Block' and body 'Test'" \
  --allowedTools "Bash(node:*)" --output-format json --max-turns 5 --dangerously-skip-permissions
```
- [ ] Result contains "blocked", "403", "Unauthorized", or "whitelist"

---

## Capability: Read Blacklist (→ capabilities/02_read_blacklist.md)

### A3: Read normal email
```bash
claude -p "Using the fgac skill, list my 5 most recent emails" \
  --allowedTools "Bash(node:*)" --output-format json --max-turns 5 --dangerously-skip-permissions
```
- [ ] Result contains email subjects/senders or appropriate rule-based block message

---

## Capability: Multi-Email Scoping (→ capabilities/03_multi_email_scoping.md)

### A4: List accounts
```bash
claude -p "Using the fgac skill, what email accounts can I access?" \
  --allowedTools "Bash(node:*)" --output-format json --max-turns 5 --dangerously-skip-permissions
```
- [ ] Result shows mapped email addresses

---

## Capability: Delegation (→ capabilities/04_delegation.md)

### A6: List accounts shows delegated
- [ ] accounts.js returns both own and delegated emails

### A8: List accounts reports per-account scope state
- [ ] accounts.js output includes `account_details` with three-state
  `gmail`/`drive_file` per account (`granted` on healthy QA accounts); any
  `reconnect_url` is bound with `&for=<email>`

---

## Capability: Connection Lifecycle (→ capabilities/06_connection_lifecycle.md)

### A3-A5: Tested during Phase 1 auth setup
- [ ] OAuth → pending → approved → tools work

### A12–A13: Profile-addressed MCP URLs
> Not applicable — this environment authenticates via cli-token/proxy-key
> scripts, not MCP OAuth URLs. Record as `skip` with reason "MCP-URL
> capability; covered in hosted-mcp and claude-code-mcp runbooks".

---

## Capability: Key Lifecycle (→ capabilities/07_key_lifecycle.md)

### A1: After key revocation
- [ ] Script returns auth error

---

## Capability: Label Access (→ capabilities/05_label_access.md)

- [ ] Label rules enforced when reading via scripts

---

## Capability: Light Mode (→ capabilities/08_strict_light_mode.md)

> Tested via browser agent — same for all agents.

---

## Automated vs Manual Test Coverage

| Test | Method | Automated? |
|------|--------|------------|
| A1: Send whitelist | `claude -p` eval suite | ✅ |
| A2: Send blocked | `claude -p` eval suite | ✅ |
| A3: Read emails | `claude -p` eval suite | ✅ |
| A4: List accounts | `claude -p` eval suite | ✅ |
| A5: Connection lifecycle | Phase 1 (interactive) | Manual |
| A6: Delegation | `claude -p` eval suite | ✅ |
| A7: Key revocation | `claude -p` eval suite | ✅ |
| A8: Light mode | Browser agent | Manual |

---

## Cleanup

No tmux sessions to clean up. Results are saved to `test/qa-envs/cc-cli/evals/results/`.

## Capability: Partner Handoff (→ capabilities/11_partner_handoff.md)

> Channel-inapplicable here: the handoff is a browser + REST surface, executed
> once per cycle via agents/01_hosted_mcp.md. Record as skip with reason
> "runs in hosted-mcp runbook".

## Capability: Push Notifications (→ capabilities/12_push_notifications.md)

> Channel-inapplicable here: server-side pipeline, executed once per cycle via
> agents/01_hosted_mcp.md. Record as skip with reason "runs in hosted-mcp runbook".

## Capability: Sheets Grant Recovery (→ capabilities/17_sheets_grant_recovery.md)

- A1/A7: headless `claude -p` evals calling `sheets_get_spreadsheet` on the
  never-picked fixture sheet — assert the denial link in the transcript
  (A1) and the stranded-sheet error text after approval (A7).
- A2–A6 are browser assertions; run them from the hosted-MCP runbook (or
  `skip` here with reason "browser assertions covered by 01_hosted_mcp").
- A4 retry: re-run the eval post-recovery → success payload in transcript.

## Capability: Docs Management (→ capabilities/19_docs_management.md)

- Headless `claude -p` evals invoking the docs tools through the local MCP
  config: read exposed fixture (A7), denied external doc with docs_expose
  link (A6), append/replace level checks (A8), block (A9), create/auto-grant
  (A10). Proxy assertions (A11) via the scripts' curl helpers.
- Browser halves (A1–A4, A12) are executed once per run via `/browser-agent`
  (shared with the other environments).

---

## Capability: Slides Management (→ capabilities/21_slides_management.md)

- Headless `claude -p` evals invoking the slides tools through the local MCP
  config: read exposed fixture (A7), denied external presentation with
  slides_expose link (A6), edit level checks (A8), block (A9), create/auto-grant
  (A10). Proxy assertions (A11) via the scripts' curl helpers.
- Browser halves (A1–A4, A12) are executed once per run via `/browser-agent`
  (shared with the other environments).
- A14: a 403 `SERVICE_DISABLED` on any Slides call is the GCP-console
  blocker — record it as `blocked`.

---

## Capability: Windowed Large Responses (→ capabilities/20_attachment_reading.md)

- Fixtures: an under-150 KB attachment, an over-160 KB attachment, and a
  long-bodied (> 20k chars) message in the QA mailbox (send between
  USER_A/USER_B under the standing permission if absent), plus the QA sheet
  and doc from setup.
- A1–A7: headless `claude -p` evals invoking the adopter tools
  (`gmail_get_attachment`, `gmail_read`, `docs_read_document`, sheets reads,
  `google_api_get`) with the capability doc's `offset`/`limit` matrix; grade
  on the envelope fields (`total_chars`, `next_offset`, `chars_returned` ≤
  limit) and the ⚠️/❌ guidance. A3 reassembly: script the windows via the
  eval harness, concatenate + decode once, compare length/hash.
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
