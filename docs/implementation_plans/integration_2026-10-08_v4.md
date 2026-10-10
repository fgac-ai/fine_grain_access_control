# Integration train 2026-10-08: OpenClaw + Hermes clients and setup guides, temporary-key reachability ping, neonctl retries (v4: + full regression, ping cap, ping parent check)

Branch: `integration/2026-10-08` (from `origin/main` at `4c9119a`, the #195 merge).
Architecture: `docs/adr/002_integration_trains.md` (seventh train).
Sidebar group: `Train 2026-10-08`.

## Candidate table (the selection Ken approved, 2026-10-08)

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #196 | Names OpenClaw and Hermes clients; the Python MCP SDK UA is no longer a scanner; serves the RFC 9728 PRM path `/.well-known/oauth-protected-resource/api/mcp` | OpenClaw probes that path on every login (it 404'd, and one fetch hit its 60 s timeout); Hermes read as a crawler | 0 prod users of either client today; this gates the listings | Local + own preview: both real clients end to end, `mcp-auth-probe` 4/4 | Yes, lands first |
| `claude/agent-ecosystem-listings` | `/openclaw` and `/hermes` setup guides, ClawHub skill, Hermes catalog staging | Listing assets; publication gated on #196 | New install path from two agent ecosystems (vendor publication stays an owner action) | Local only (plan v3) | Yes, after #196 |
| #197 | `GET|HEAD /api/proxy/ping` and a ping-first temporary-key recipe | 56 of 111 claude-code keys (7 d) never used, 54 of the 66 never-used on 18 accounts where no key ever worked (inferred: sandbox blocks fgac.ai) | Walled sandboxes stop minting dead keys and fall back to windowed reads; target never-used < 20% (§7.34) | Unit, `mcp:lint`, `tsc`; preview pending | Yes |
| `claude/neonctl-transient-retry` | Retry transient neonctl failures; stop blaming auth | Prune/db:branch die on blips with a misleading diagnosis | Tooling only | Unit (`test-neonctl-runner`) | Yes |
| #194 | ChatGPT plugin packet + explicit tool hints + challenge route | Directory prep | Hints change runtime behaviour for every client; submission still blocked (generic API tools, reviewer sign-in) | Unit, `tsc` | No: hold. Its RFC 9728 route duplicates #196's (take #196's, proven with real clients); rebase without the route when the ChatGPT tool set is decided |
| Muse packet | Docs only | — | None at runtime | n/a | Not taken |
| `great-dhawan-c05848` | Capability 21 draft + plans (09-24) | Likely superseded by the Drive tree work | None | n/a | No: stale |
| #188 | Drive card override count | Already shipped in #193 | — | — | No: close as shipped |
| #121, #72 and two August branches | Old growth / sheets / QA-guard work | Far behind `main` | — | — | No: stale |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #196 | `claude/mcp-client-openclaw-hermes` | none | — |
| listings | `claude/agent-ecosystem-listings` | none | — |
| #197 | `claude/temp-key-never-used` | none (auto-merged `src/app/api/mcp/route.ts`, `docs/analytics.md`, `docs/monitoring.md` with #196) | — |
| neon | `claude/neonctl-transient-retry` | `package.json` | union of the `mcp:lint` chains (adds `test-neonctl-runner` to `main`'s chain, which already had `test-google-reconnect-url`) |
| train fix | — | — | `scripts/lib/neonctl.ts`: two `no-explicit-any` lint errors from the neon branch removed (typed catch; JSON default generic) |
| QA tooling | `claude/qa-mcp-token-refresh` | none | landed after the first QA round was blocked (see below) |
| fix round 1 | — (train commit `104e82d`) | — | tool copy names the serving deployment instead of `fgac.ai` (capability 23 A12) |
| reachability reports | `claude/temp-key-reachability-report` | none | added 2026-10-09 at Ken's request: separates "network blocked" from "agent's rules blocked" (plan `claude_temp-key-reachability-report_v1.md`) |
| ping event cap | `claude/ping-event-cap` | none | the anonymous `proxy_ping_checked` event is capped to one per source address per 10 min, 60/min per instance; the response is never gated |
| ping parent check + QA guardrails | `claude/ping-parent-check` | none | found by the full regression; the ping now mirrors the proxy's parent-profile checks; the runbooks' denial address moved to the reserved `blocked@example.net`; runners never revoke the stored bearer's own connection |
| rules | — (train commit `4916504`) | — | QA token mints pre-approved permanently (Ken, 2026-10-09) |

## Registries after landing

- Capability 23 (temporary keys): **A14** added by #197 (next free after A13); **A15** added by the reachability reports. A11 now also
  requires the copy to name the serving host (spec wording, no new id). No collisions.
- No migrations.
- `mcp:lint`: adds `test-neonctl-runner`; `test-temporary-api-keys` gains 7 host-copy checks.

## Fix round 1: the ping copy pointed previews at production

**Observed** (QA round 2, preview `c6b2znj0x`, SHA `f844f43`): the real-agent check (A12)
completed 1 of 2 runs. The failing run pinged `https://fgac.ai/api/proxy/ping`, the host
hard-coded in the `create_temporary_api_key` description and the large-file hint. Production
does not have this build's ping route, so the agent got a 401 and correctly declined to mint.

**Fix** (`104e82d`): `deploymentHostCopy` / `deploymentOrigin` in `src/lib/temporaryApiKeys.ts`
rewrite the host in tool descriptions and the hint to the deployment serving them
(`VERCEL_URL` on previews, `localhost:PORT` locally). Production text is unchanged byte for
byte (unit-checked). `toolDefs.ts` stays env-free.

**Production relevance (inferred):** none for end users. In production `fgac.ai` is the
serving host. The bug only made previews and local builds test the wrong host, and it would
have recurred on every future train that changes the proxy.

## QA tooling: consent-once MCP bearer

QA round 1 was **blocked**: the runner's click on Clerk's consent "Allow" for a fresh DCR
client was denied by the auto-mode classifier ("Account & Standing-Rule Changes"). That was
the third train in a row (10-05, 10-07, 10-08). `scripts/qa-mcp-token.ts` stores a refresh
token once (main clone `.secrets/qa-mcp/`, 0600) and hands runners a fresh bearer that works
on localhost and every preview, because dev Clerk tokens carry no `aud`. It refuses
production hosts and non-dev issuers.
- **One-time mint:** run by `qa-setup-driver` with Ken's approval in chat, 2026-10-08. The
  consent was for USER_A, with a trusted click and no denial.
- **Refresh verified** by force-expiring the store: a new 24 h token, and `list_accounts`
  returned 200.
- The runner definitions now use the script and click consent screens with trusted clicks
  only. They call the PostHog connector whenever it is present, and they carry the headless
  `claude -p` recipe for real-agent checks (`claude -p` works again as of 2026-10-08).

## Validation

**Unit (train head `104e82d`):** `tsc --noEmit` clean; `npm run mcp:lint` exit 0; eslint clean
on every changed `.ts/.tsx` file (remaining repo-wide errors are pre-existing on `main`).

**Preview:** final build `https://fine-grain-access-control-j7ahvuhv1-kenyesh-gmailcoms-projects.vercel.app`
(SHA `104e82d`, Ready). Earlier rounds ran on `c6b2znj0x` (SHA `f844f43`). The fix commit
changed copy only.

| scope | build | result |
| --- | --- | --- |
| 23 A1 mint with defaults | `104e82d` | PASS: the recipe's FIRST command is the authenticated ping to the preview host; `base_url` = preview; 15-minute expiry; key masked |
| 23 A11 agents told the path exists | `104e82d` | PASS: tools/list (orchestrator, stored QA bearer) shows `gmail_get_attachment`, `gmail_send` and `google_api_modify` each pointing to `create_temporary_api_key`; the description's ping and "allow this host" text name the preview host; no `fgac.ai` in any of the four |
| 23 A12 agent uses it unprompted | `104e82d` | PASS, 3/3 headless `claude -p` runs, tool never named. Each run pinged the preview, minted, and downloaded a 6,291,456-byte attachment in 9 tool calls. No harness denial; the key never appeared in a reply. Size matched Gmail metadata; no hash comparison (the task asked for the size) |
| 23 A14 reachability ping | both | PASS for the legs run. No key → 200 `fgac-proxy-ok` no-store. Made-up key → 401 `key-invalid`. Fresh key → 200 `key-valid`. Expired key → 401 `key-expired`. **Not run:** standing profile key → `key-not-temporary` (needs the dashboard UI) and revoked key |
| `temp_api_key_pinged` (PostHog connector) | both | 9 preview rows between 02:26 and 02:50 UTC: `valid` ×8 and `expired` ×1, one row per ping, including the manual 02:50:14 ping (which arrived late) |
| #196 discovery | `f844f43` | `mcp-auth-probe` 4/4 incl. `oauth-resource-metadata-rfc9728-path` 200; production still 404s there (expected until deploy) |
| #196 regression | both | `list_accounts` 200 (`qa-mcp-token.ts check`); `gmail_list` 200 with `isError` null; the A12 agents used `gmail_list` / `gmail_read` through the hosted MCP |
| guide pages | `f844f43` | `/openclaw`, `/hermes`, `/setup` 200 with headings and 2 copy buttons each; no horizontal overflow at 375 px; stay light under dark emulation (site is light-only). Copy buttons were not clicked. One console error from a signed-out `/dashboard` prefetch hitting dev Clerk CORS (preview-only, pre-existing) |
| neon retries | — | unit only (`test-neonctl-runner`); tooling, not deployed |

`qa-coverage-check` (scoped, capability 23): 14/14 accounted, 4 pass / 0 fail / 10 skip.

**Auditor findings, disposition:**
- A14 pass with legs missing: **accepted as a known gap**. `key-not-temporary` and revoked are
  not run (listed above). Both are rejections on the auth path that the unit tests cover. The
  manual-ping PostHog row was re-queried and is present.
- A11 evidence was from the old build: **fixed**. Re-inspected on `104e82d` (row above); the
  spec now says "serving host".
- A12 had no hash comparison, a 6 MB fixture and no proxy-request count: **accepted**. What the
  assertion is for (an unprompted agent finds and uses the path) is shown 3/3.
- Plan-scope rows not in the results file: **recorded here** (guide pages, #196 smoke, probe).
- Skips A2–A10, A13: **accepted**. The train does not touch mint, expiry or revoke.

## Reachability reports (added 2026-10-09)

Ken asked to capture the pre-mint check so a sandbox blocking fgac.ai can be told apart
from the agent's own permission rules refusing the command. Neither request reaches FGAC,
so the agent reports the result on `create_temporary_api_key` (`reachability`: `ok` /
`unreachable` / `command_denied`). Failures mint nothing, return cause-specific advice and
emit `temp_api_key_check_failed`. Mints record `reachability` (`not_reported` when absent),
and the keyless ping emits anonymous `proxy_ping_checked`. Readout: `docs/monitoring.md`
§7.34 (8).

Preview `ddxp0z9z2` (SHA `7ef5013`), runner via the stored QA bearer:

| scope | result |
| --- | --- |
| 23 A15a `unreachable` | PASS: "No key was created. / Your code cannot reach <preview host>: the sandbox's network blocks it." Names the host, the network setting and the windowed fallback; no key |
| 23 A15b `command_denied` | PASS: "…permission rules refused to run the command; the network was never tried." Advice is to approve or allow the command; no network advice; no key |
| 23 A15c no insert | PASS: no `temp_api_key_created` between the reports and the next explicit mint; 4 created rows = 4 mints in the window |
| 23 A15d after a mint | PASS: "Stop using the key you already have and do not create another one this session"; event `after_mint = true` |
| 23 A15e legacy mint | PASS: key returned; `reachability = not_reported` |
| 23 A15f/g events | PASS: 3 `temp_api_key_check_failed` rows with the right `reachability` / `after_mint`; a fake key in `check_output` was stored as `Bearer [redacted] x`; `proxy_ping_checked` rows carry `$process_person_profile = false` and no person row exists |
| 23 A12 regression | PASS 2/2: both real agents pinged the preview, passed `reachability: "ok"` unprompted (PostHog), downloaded 6,291,456 B, key never in a reply. One denial in run 2 was another connector's tool, not on the key path |
| honest agent-side failure run | NOT RUN: no honest way to make a real sandbox fail the check without faking it |

`qa-coverage-check` (scoped, capability 23): all in-scope assertions accounted for.

**Auditor findings (round 3), disposition:**
- A15c rested on missing analytics rows over an 8 s window: **re-run by the orchestrator at
  the database level**. Sequence on the same connection: mint `ok` → `unreachable` →
  `command_denied` → `unreachable` → mint `ok`. Replies: only the two mints returned a key,
  and all three reports began "No key was created" (all `after_mint`, because a key was
  live). `temp_api_key_created.live_temp_keys` is a database count taken inside each mint, and
  across both rounds it reads 1 → 2 → 3 → 4 → 5 → 6, one per mint. The six failure reports in
  between added nothing, including the three just before the last mint (5 → 6). The
  `$mcp_tool_call` rows agree: `temp_key_id` (set only after an insert) is present on the
  mints alone. PostHog took several minutes to show some of these rows. That was lag, not
  loss; all 6 + 6 arrived.
- A12 has no hash comparison and no request count: **accepted, restated**. The download
  size matched Gmail's metadata; the hash was not compared.
- A11 row in `qa-results.json` was stale: the current-build evidence is the v2 re-inspection
  (all four tools name the serving host; no `fgac.ai`). The results file keeps the
  runner's older row.
- `check_output` redaction: the `Bearer [redacted]` form was observed live; the bare
  `sk_proxy_[redacted]` form and first-line truncation are verified by unit tests only.
- A15 command_denied after a mint: covered by the orchestrator sequence above
  (`after_mint = true` on the command_denied row).
- A14 remains partial (`key-not-temporary` and revoked legs not run), as in v2.

## Full regression (Ken asked before deploy, 2026-10-09)

Runbook `docs/QA_Acceptance_Test/agents/01_hosted_mcp.md`, every capability, on two builds:
the first pass on `ddxp0z9z2` (`7ef5013`), then a re-run of everything blocked on
`jczvys1fp` (`a983f12`, the final app code). `qa-coverage-check`: 278/278 accounted.

**Final: 224 pass, 4 fail, 5 skip, 45 blocked.** None of the 4 fails is caused by the train.

| fail | disposition |
| --- | --- |
| 16 A17, 17 A7, 19 A12 | **Spec drift, fixed in the specs.** These refusals graduated from ❌ `failed` to 🚫 `denied_by_policy` / `file_grant_missing_at_google` on `main` on 2026-09-03 (`78f6227`). Capabilities 10 and 21 already asserted 🚫; these three did not. The auditor confirmed against the code, and the train's `src` diff does not touch that path |
| 07 A2 | **Pre-existing, out of scope.** A revoked profile shows no "Revoked" marker. Spun off as a product task (orphaned connection after profile revocation, which also explains the dead end recorded in 06 A11) |

**Blocked (45), all setup or infra, none on the train's surface:**
- partner app not registered on previews (11, 10 rows)
- push infrastructure (12, 12 rows)
- needs a brand-new Google account (13 A1, 14 A20)
- no support sender on previews (14 A16/A17, 16 A24/A25/A30/A32, 18 A13–A15)
- Google-side grant fixtures that cannot be produced from consent screens (18 A2/A3/A5/A7–A12)
- classifier refusals on the Contact-sales Send and on a non-browser session credential (16 A28, A13 partial)
- 16 A20 file-grant half

Each is labelled BLOCKED, never skipped quietly.

**Found and fixed during the regression:** `/api/proxy/ping` returned `key-valid` for a
temporary key whose parent profile was revoked, while real calls 401'd. That was train code
(#197). The fix (`claude/ping-parent-check`) is verified on the final build: 401
`fgac-proxy-ok key-parent-revoked`.

**Runner incidents and their fixes:**
- A runner revoked the profile bound to its own stored bearer, orphaning the connection and
  blocking ~110 rows. Runner rules now forbid it, and `qa-mcp-token.ts start --new-client`
  recovers.
- 01 A4 sent one real message to `blocked@` on an outside domain that has no MX record (it
  almost certainly bounced). The denial address is now `blocked@example.net` (RFC 2606), and
  sends that can succeed go to USER_B only.

**Auditor round 4, disposition:** nothing blocks. The final-build gaps it listed were closed
by the orchestrator on `jczvys1fp`:
- `/openclaw`, `/hermes` and `/setup` return 200.
- RFC 9728 `resource` = `<preview>/api/mcp`.
- `python-httpx2` no-token → `connector_install_started.client_class = direct`, not scanner.
- The `Hermes-Agent/` discovery UA → `client_class_signal = product:hermes`.
- Two keyless pings from one source → both 200, **one** `proxy_ping_checked` row (an earlier
  build: 20 pings → 1 row).

The A15 spec now states the per-source cap. Accepted as is:
- 24 A9 skipped (no agent leg; out of the train's surface).
- 07 A3/A4 skipped (no key-roll control exists; the spec looks stale).

**Known issues shipped as-is (pre-existing, tasks open):** the orphaned connection after a
profile is revoked (06 A11 / 07 A2); approval links on previews pointing at production. Neither
is touched by this train.

## Open (Ken)

- `/deploy-prod` merges #199.
- After deploy: §7.34 (8) gives the network-vs-rules split from day one (its before figure is zero by construction). §7.34 (7): The never-used share of claude-code temporary keys should fall from
  50% to under 20% within a week, with no drop in mints on accounts where keys work. Also:
  `mcp-auth-probe` against production should report the RFC 9728 path as 200, and the first
  `client_name` `openclaw` / `hermes-agent` rows show up when those listings go live.
- Untestable before production: Hermes CIMD naming (prod Clerk only).
- Still not automatable: email legs on previews (no support sender; `vercel env add` is
  approval-gated). The `.mcp.json` `posthog` server still 401s on its personal key; nothing
  depends on it now.
