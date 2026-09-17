# Agent: OpenClaw (Docker)

> Runs ALL capabilities via a genuine OpenClaw instance in Docker.
> Package #2 from distribution_architecture.md.

## Environment Setup

1. **Run reset**: `bash test/qa-envs/openclaw/reset.sh`
2. Ensure base image exists: `docker image inspect openclaw:local`
3. Build & Start:
   ```bash
   cd test/qa-envs/openclaw && docker compose build
   FGAC_ROOT_URL=http://localhost:3000 docker compose up -d
   ```
4. Wait for OpenClaw gateway:
   ```bash
   until curl -sf http://localhost:18790/health; do sleep 2; done
   ```
5. Authenticate via docker exec:
   ```bash
   docker exec qa-envs-testclaw-1 \
     FGAC_ROOT_URL=http://localhost:3000 \
     node /home/node/.openclaw/skills/fgac/scripts/auth.js --action login
   ```
   *(Complete OAuth flow via `/browser-agent`, then approve connection in dashboard:*
   *Navigate to `http://localhost:3000/dashboard#connected-agents`, find the pending connection, select a proxy key and click **Approve**.*
   *⚠️ NEVER approve connections via direct DB writes — always use the Web UI)*

## Proof of Authenticity

> The following evidence proves the **real OpenClaw agent** processes requests:

- [ ] Docker container logs show gateway receiving the chat prompt:
      `docker logs testclaw-testclaw-1 2>&1 | grep -i "fgac"`
- [ ] Logs show skill discovery and invocation (not direct script execution)
- [ ] Prompts sent to `http://localhost:18790/api/chat` (gateway API), NOT to `node gmail.js`

---

## Capability: Send Whitelist (→ capabilities/01_send_whitelist.md)

### A1: Send to whitelisted address
```bash
curl -X POST http://localhost:18790/api/chat \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Send an email to '$USER_B_EMAIL' with subject QA OpenClaw - Send Whitelist A1 and body Test from OpenClaw using the fgac skill"}'
```
- [ ] OpenClaw discovers fgac skill, invokes `gmail.js --action send`
- [ ] Email sent successfully

### A2: Send to blocked address
```bash
curl -X POST http://localhost:18790/api/chat \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Send an email to blocked@untrusted.com with subject Blocked using fgac"}'
```
- [ ] OpenClaw reports whitelist error from skill output
- [ ] Agent does not crash — handles error gracefully

---

## Capability: Read Blacklist (→ capabilities/02_read_blacklist.md)

### A4: Read normal email
```bash
curl -X POST http://localhost:18790/api/chat \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "List my recent emails using fgac"}'
```
- [ ] OpenClaw invokes `gmail.js --action list`, returns emails

---

## Capability: Multi-Email Scoping (→ capabilities/03_multi_email_scoping.md)

### A1: List accounts
```bash
curl -X POST http://localhost:18790/api/chat \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "What email accounts can I access via fgac?"}'
```
- [ ] OpenClaw invokes `accounts.js --action list`
- [ ] Returns mapped email accounts

---

## Capability: Delegation (→ capabilities/04_delegation.md)

### A6: List accounts shows delegated
- [ ] accounts.js returns both own and delegated emails through gateway

### A8: List accounts reports per-account scope state
- [ ] Gateway response includes `account_details` with three-state
  `gmail`/`drive_file` per account (`granted` on healthy QA accounts); any
  `reconnect_url` is bound with `&for=<email>`

---

## Capability: Connection Lifecycle (→ capabilities/06_connection_lifecycle.md)

### A3-A5: Tested during auth setup
- [ ] OAuth → pending → approved → tools work through gateway

### A12–A13: Profile-addressed MCP URLs
> Not applicable — OpenClaw connects through the gateway with a proxy key,
> not MCP OAuth URLs. Record as `skip` with reason "MCP-URL capability;
> covered in hosted-mcp and claude-code-mcp runbooks".

---

## Capability: Key Lifecycle (→ capabilities/07_key_lifecycle.md)

### A1: After key revocation
- [ ] Gateway returns auth error when skill tries to use revoked key

---

## Capability: Label Access (→ capabilities/05_label_access.md)

- [ ] Label rules enforced when reading via gateway

---

## Capability: Light Mode (→ capabilities/08_strict_light_mode.md)

> Tested via browser agent — same for all agents.

## Capability: Partner Handoff (→ capabilities/11_partner_handoff.md)

> Channel-inapplicable here: the handoff is a browser + REST surface, executed
> once per cycle via agents/01_hosted_mcp.md. Record as skip with reason
> "runs in hosted-mcp runbook".

## Capability: Push Notifications (→ capabilities/12_push_notifications.md)

> Channel-inapplicable here: server-side pipeline, executed once per cycle via
> agents/01_hosted_mcp.md. Record as skip with reason "runs in hosted-mcp runbook".


---

## Cleanup

```bash
docker compose -f test/qa-envs/openclaw/docker-compose.yml down
```

## Capability: Sheets Grant Recovery (→ capabilities/17_sheets_grant_recovery.md)

- A1/A7: drive the OpenClaw instance to call `sheets_get_spreadsheet` on the
  never-picked fixture sheet; assert the denial link surfaces to the end
  user intact (A9 of capability 14 applies) and the stranded-sheet error is
  relayed verbatim (A7).
- A2–A6: browser assertions — cover via 01_hosted_mcp or `skip` with reason.
- A4 retry: repeat the OpenClaw task after recovery → success.

## Capability: Docs Management (→ capabilities/19_docs_management.md)

- From the OpenClaw container, exercise docs_read_document / docs_edit /
  comments_read / comments_add and the raw documents calls against the connected FGAC MCP
  server; assert denials carry the docs_expose/docs_write links (A6, A8) and
  reads/writes succeed per rule level (A7, A8).
- Browser/dashboard halves (A1–A4, A12) via `/browser-agent` outside the
  container, as with sheets.

---

## Capability: Slides Management (→ capabilities/21_slides_management.md)

- From the OpenClaw container, exercise slides_get_presentation / slides_edit /
  comments_read / comments_add and the raw presentations calls against the
  connected FGAC MCP server; assert denials carry the slides_expose/slides_write
  links (A6, A8) and reads/writes succeed per rule level (A7, A8).
- Browser/dashboard halves (A1–A4, A12) via `/browser-agent` outside the
  container, as with sheets and docs.
- A14: a 403 `SERVICE_DISABLED` on any Slides call is the GCP-console
  blocker — record it as `blocked`.

---

## Capability: Windowed Large Responses (→ capabilities/20_attachment_reading.md)

- Fixtures: an under-150 KB attachment, an over-160 KB attachment, and a
  long-bodied (> 20k chars) message in the QA mailbox (send between
  USER_A/USER_B under the standing permission if absent), plus the QA sheet
  and doc from setup.
- A1–A7: drive the adopter tools (`gmail_get_attachment`, `gmail_read`,
  `docs_read_document`, sheets reads, `google_api_get`) through the OpenClaw
  gateway, varying `offset`/`limit` per the capability doc; assert on the
  envelope fields, and for A3 assert `total_chars` equals the summed
  `chars_returned` with a null final `next_offset` (hash locally when the
  gateway lets you extract the windows).
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
