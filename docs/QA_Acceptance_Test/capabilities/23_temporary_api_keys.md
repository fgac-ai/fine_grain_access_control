# Capability 23: Temporary API Keys

An MCP connection can mint a short-lived `sk_proxy_tmp_` key (`create_temporary_api_key`) so a
script the agent runs can call the REST proxy (`/api/proxy/...`) directly — for payloads too
large for tool calls. The key resolves to the **calling connection's profile at request time**:
same rules, same refusals, nothing copied. Default lifetime 15 min, agent may ask up to 60.

Temporary keys live in their own table (`temporary_api_keys`, SHA-256 only) and are never
profiles: they do not appear in the profile tabs, token routes, or anything else that lists
`proxy_keys`. Plan: `docs/implementation_plans/large-api-payload-options_v5.md`. Requests up to
Vercel's 4.5 MB body cap only; larger transfers are capability 24.

Fixtures:
- the QA baseline profile and connection from setup (exposed sheet, send whitelist containing
  USER_B, read-blacklist rule);
- a ~2 MB attachment in USER_A's mailbox (≈ 2.7 MB as base64 JSON — over the MCP window cap,
  under the proxy body cap); send USER_B → USER_A under the standing permission if absent;
- for A8 only: a **scratch profile + scratch connection** (manual DCR token, bound to the scratch
  profile in the dashboard). **Never revoke the baseline profile** — it backs every other
  capability in the run.

Throughout: `$TMP` is the minted key, `$BASE_URL/api/proxy/` the proxy root. Mask the key in
evidence (`sk_proxy_…<last4>`).

### A1: Mint with defaults returns a usable, honest key

`create_temporary_api_key {purpose: "download"}` returns `api_key` (`sk_proxy_tmp_` prefix),
an expiry 15 min (±1 min) after the call, `base_url`, and a download recipe (`curl -o`).
`base_url` is **the host that served the MCP call** (the preview URL on a preview, localhost
locally), never a hard-coded fgac.ai.
The text says the key carries this connection's permissions, needs code execution with network
access, and must not be shown to the user, put in a URL, logged, or committed. Its curl examples read
the key with `$(cat "$KEY_FILE")` from a private (umask 077 / chmod 600) temp file that is deleted
afterwards — never a bare `$KEY` inline in the command — and it states that `users/me` is the FGAC
sign-in address while other mailboxes take `users/<address>`. No Google token appears anywhere in
the response.

### A2: TTL bounds are enforced and reported

`ttl_minutes: 60` → granted 60. `ttl_minutes: 120` → granted 60, and the response states the
cap ("granted 60 of the 120 requested"). `ttl_minutes: 0` → guided refusal (no key minted).

### A3: Parity — the temporary key reaches what the profile reaches

With `$TMP`: a Gmail message list and read on the baseline mailbox → 200; the exposed sheet's
values read → 200; `messages/send` to USER_B (whitelisted) → 200 and delivered.

### A4: No escalation — every proxy refusal applies to the temporary key

With `$TMP`, each must be refused with the same text a standing key gets:
- an unexposed sheet/doc id → 403;
- a write to a read-only-exposed sheet → 403;
- `messages/send` with whitelisted `To` but a non-whitelisted `Cc` (an `@example.com`
  address) → 403, nothing sent; repeat with `Bcc`;
- `upload/gmail/v1/users/me/messages/send?uploadType=media` with a raw RFC 822 body to a
  non-whitelisted recipient → 403;
- `PATCH upload/drive/v3/files/<unexposed id>?uploadType=media` → 403;
- `batch/gmail/v1` → 403;
- a message matching the read-blacklist rule → 403 with the rule-named text;
- a mailbox the profile cannot reach (`users/<USER_B>/…` without delegation) → 403.

(The `upload/`, `Cc`/`Bcc` and batch rows are the prerequisite policy fix; they FAIL until it
lands, and the feature must not ship while they do.)

### A5: Rule changes apply live, without re-minting

Mint `$TMP`, read the exposed sheet (200). In the dashboard, change that sheet's rule to
Blocked → the same request with the same `$TMP` → 403. Restore the rule → 200 again.

### A6: Expiry is enforced with recovery guidance

Mint with `ttl_minutes: 1`; wait past `expires_at`; any proxy call → 401 whose text names
expiry (not a generic "Invalid API Key"), says to mint a new key, and says an in-progress
upload can resume. A fresh mint works immediately.

### A7: Dashboard lists and revokes live temporary keys

The baseline profile's page lists the live `$TMP` as a temporary key, naming the connection
and its expiry, with Revoke. Revoke it (override `window.confirm` in the embedded pane) →
next proxy call 401 "revoked". An expired key no longer appears in the list. Standing keys are
unaffected.

### A8: Revoking the parent profile kills its temporary keys

On the **scratch** profile/connection: mint a key, confirm 200 on an allowed read, revoke the
scratch profile in the dashboard → the temporary key 401s with text naming the profile
(`auth_failure_reason: 'parent_revoked'`). The baseline profile and its keys
still work.

### A9: Connections that are not approved cannot mint

A pending (or blocked) connection calling `create_temporary_api_key` gets the standard approval
refusal (pending: the approve link; blocked: the blocked text). No key is minted.

### A10: Live-key cap per connection

Mint until refused: the 11th live key on one connection is refused with text telling the agent
to reuse its current key (`live_temp_keys` = 10). Revoking one frees a slot.

### A11: Agents are told the path exists

`tools/list` includes `create_temporary_api_key` with the description's four elements: when to
use it (over ~1 MB / scripted loops), the reachability pre-check (`curl -sS
<serving host>/api/proxy/ping` prints `fgac-proxy-ok`; anything else → do not mint) with the
windowed-tool fallback named, the 15/60-minute lifetime with resume-after-expiry, and the key-handling rule ("keep the key out of
anything that leaves this session" — private temp file or env var allowed). The
`initialize` instructions contain the large-file sentence. `gmail_get_attachment`,
`gmail_send`, and `google_api_modify` descriptions each point to the tool.
Every host the copy names is the deployment serving it: `fgac.ai` in production, the
preview's own host on a preview, `localhost:<port>` locally — never production from a
non-production build (train QA 2026-10-08: a preview pointing at production made a
correct agent decline to mint).

### A12: An agent finds and uses it unprompted (code-execution runtimes)

Prompt, with no mention of keys or scripts: "Save the ~2 MB attachment on <subject> to
`./qa-out/` and tell me its SHA-256." Pass when the agent calls `create_temporary_api_key`,
downloads via the proxy in ≤ 2 requests (not windowed tool calls), the saved file's hash
matches the sent file, and **the key does not appear in the agent's final reply**. A key handed to the
script through a chmod-600 temp file is the intended path, not a failure; record whether the agent's
harness blocked any step (e.g. an auto-mode classifier refusing an inline key). Record the
number of tool calls taken. Runtimes without code execution: `skip` by design.

### A13: Mint-to-use is measurable

In the run window:
- `temp_api_key_created` rows carry `purpose`, `ttl_requested` (only when the agent passed one),
  `ttl_granted`, `ttl_capped`,
  `expected_bytes_bucket`, `client_name`, `client_id`, `connection_id`, `parent_proxy_key_id`,
  `temp_key_id`, `live_temp_keys` — A2's capped mint shows 120 → 60 with `ttl_capped: true`;
- `temp_api_key_refused` rows exist for A9 (`connection_not_approved`) and A10 (`rate_capped`);
- `proxy_request` rows from `$TMP` carry `key_kind: 'temporary'` and `temp_key_id`, with
  `proxy_key_id` = the **parent profile** key; they join to the mint on `temp_key_id`;
- A6/A7/A8 401s carry `auth_failure_reason` `expired` / `revoked` / `parent_revoked`;
- A7's dashboard revoke emits `temp_api_key_revoked` (`via: 'dashboard'`);
- runbook query `docs/monitoring.md` §7.34 (1) and (2) return the run's mints, with the
  never-used ones (e.g. A10's surplus keys) counted as never used.

### A14: The reachability ping separates a blocked sandbox from a broken key hand-off

`curl -sS $BASE_URL/api/proxy/ping` with no key → 200, body exactly `fgac-proxy-ok`,
`Cache-Control: no-store`. With `Authorization: Bearer $TMP` → 200 `fgac-proxy-ok key-valid`
and one `temp_api_key_pinged` event (`outcome: 'valid'`, `temp_key_id` = the mint's); with an
expired key → 401 `fgac-proxy-ok key-expired`; with a made-up `sk_proxy_tmp_` key → 401
`fgac-proxy-ok key-invalid`; with the standing profile key → 401 `key-not-temporary`. No ping
makes a Google request, and a pinged key with no other traffic still counts as never used in
§7.34 (2). The minted recipe text (A1) contains the authenticated ping as its FIRST command,
before any Google path, plus the "do not create another one this session" fallback.

### A15: A failed check is reported with its cause, and mints nothing

`create_temporary_api_key` with `reachability: "unreachable"` returns "No key was created",
names the serving host and the sandbox network setting, and lists the windowed fallback.
With `"command_denied"` it says the agent's permission rules refused the command and the
network was never tried, and points the user at approving or allowing the command (no
network-settings advice). Neither call inserts a key: a following `get_my_permissions` or
dashboard list shows no new temporary key. Each emits one `temp_api_key_check_failed`
(`reachability` as sent; `after_mint` false with no live key, true after a mint;
`check_output` first line, with any key redacted: `sk_proxy_[redacted]`, or
`Bearer [redacted]` when it follows `Bearer`). `reachability: "ok"` and an
omitted value both mint as before, with `temp_api_key_created.reachability` = `ok` /
`not_reported`. A keyless `GET /api/proxy/ping` emits one anonymous `proxy_ping_checked`
and creates no person. A real agent (A12 setup) that reaches the host passes `ok`
unprompted.
