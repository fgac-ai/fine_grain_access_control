# Integration train 2026-10-08: OpenClaw + Hermes clients and setup guides, temporary-key reachability ping, neonctl retries (v2: preview QA, A12 fix-and-retest, consent-once QA bearer)

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

## Registries after landing

- Capability 23 (temporary keys): **A14** added by #197 (next free after A13). A11 now also
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

## Open (Ken)

- `/deploy-prod` merges #199.
- After deploy: §7.34 (7). The never-used share of claude-code temporary keys should fall from
  50% to under 20% within a week, with no drop in mints on accounts where keys work. Also:
  `mcp-auth-probe` against production should report the RFC 9728 path as 200, and the first
  `client_name` `openclaw` / `hermes-agent` rows show up when those listings go live.
- Untestable before production: Hermes CIMD naming (prod Clerk only).
- Still not automatable: email legs on previews (no support sender; `vercel env add` is
  approval-gated). The `.mcp.json` `posthog` server still 401s on its personal key; nothing
  depends on it now.
