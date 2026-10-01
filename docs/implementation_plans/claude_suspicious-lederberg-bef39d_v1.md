# Directory connections stopped 2026-09-27..30 — investigation record (v1)

Branch: `claude/suspicious-lederberg-bef39d`. Written 2026-10-01 00:40Z.
Outcome: **no FGAC defect found; no code shipped.** This revision records what
was verified, what was ruled out, what remains unobservable from FGAC, and the
one decisive check that is Ken's to run. Runbook: `docs/monitoring.md` §7.33.

## 1. The finding, re-verified

| day (UTC) | 7.5 ClaudeAI unauth initializes | sign-ups (all flows) | connections | Toolbox inspector handshakes |
|---|---|---|---|---|
| 09-22 | 12 | 5 | 4 | 4 |
| 09-23 | 13 | 4 | 4 | 4 |
| 09-24 | 20 | 7 | 4 | 3 |
| 09-25 | 18 | 8 | 6 | 9 |
| 09-26 | 16 | 3 | 1 | 1 |
| 09-27 | 21 | 1 | 0 | 0 |
| 09-28 | 20 | 5 | 0 | 0 |
| 09-29 | 21 | 4 | 0 | 0 |
| 09-30 | 24 | 1 | 1 | 1 |

- 7.5 counts come from the exact `docs/monitoring.md` 7.5 query (14-day run,
  2026-10-01). Initializes were spread over 13–16 distinct hours each day, so
  they are human-paced, but they are an upper bound and cannot distinguish a
  Connect click from a directory probe.
- Last connection before the gap 2026-09-26 23:51:04Z; first after it
  2026-09-30 22:59:22Z → 23:01:09Z (a brand-new account; `sign_up_completed`
  from the Clerk webhook, then the Toolbox inspector's `discover_probe`
  rejection, its `initialize`, then the user's `Anthropic/ClaudeAI`
  `initialize` one second later). **That connection ran on the old
  deployment (`c5237a9`), before the 2026-10-01 00:04Z production deploy of
  PR #168.** The path was never hard-broken on our side.
- Every sign-up during the gap carries dashboard/delegation events and no
  connector events; the connector flow produced **zero Clerk accounts** in
  the window. `sign_up_completed` is captured by the `user.created` webhook
  (`src/app/api/webhooks/clerk/route.ts`), so this localises the failure (if
  people tried) to **before Clerk account creation**: authorize → hosted
  sign-in.
- Ratio before the gap (09-17..26): 129 ClaudeAI initializes for 47
  connections. During (09-27..29): 62 for 0.

## 2. Checks performed (all 2026-10-01 00:00–00:40Z unless noted)

| # | hop | method | result |
|---|---|---|---|
| 1 | 401 challenge on `POST /api/mcp` (no token, garbage token, GET) | curl | 401, `www-authenticate` carries `resource_metadata=https://fgac.ai/.well-known/oauth-protected-resource/mcp` |
| 2 | Protected-resource metadata, AS metadata on fgac.ai and clerk.fgac.ai, OIDC config | curl + WebFetch (Anthropic egress) | 200, issuer/token/registration endpoints correct, `client_id_metadata_document_supported: true` |
| 3 | Dynamic client registration | one POST, client name `fgac-outage-probe-2026-09-30` | 201. **The client id is deliberately not recorded here** (public repo rule); it is visible in Clerk Dashboard → OAuth applications under that name and can be deleted |
| 4 | Claude's client-metadata document `https://claude.ai/oauth/mcp-oauth-client-metadata` | curl, five user agents | 200 JSON, `redirect_uris = [https://claude.ai/api/mcp/auth_callback]`, `token_endpoint_auth_method: none` |
| 5 | Authorize chain with Claude's client id (+ `resource`) | curl | 302 → `/oauth/authorize/continue` → 302 → `accounts.fgac.ai/sign-in?redirect_url=…oauth-consent…`; bogus client id → 401 `invalid_client` |
| 6 | Hosted sign-in / sign-up / consent pages | curl, 3 networks, 4 UAs | **403 Cloudflare managed challenge** ("Just a moment", `cType: managed`). Same on accounts.clerk.com, inngest, trigger.dev, turso, tldraw → Clerk zone-wide, not ours |
| 7 | Same pages in a real browser, QA account (qa-setup-driver run) | built-in browser | sign-in card in <3 s, no interstitial; Google chooser; consent card "Claude wants to access…"; Allow → redirect to Claude's callback. Repeated twice. Claude answered the un-started flow with `end_error` and **logged the pane's claude.ai session out** (`/logout?involuntary=1`) |
| 8 | Token endpoint from Anthropic's egress | WebFetch GET | 405 (reachable, no challenge); from our IP a bogus code gets 400 `invalid_grant` |
| 9 | Auth-health (`mcp_auth_attempt`, 10 days) | PostHog | `ok` 364–693/day sampled; `invalid_token` only `client_class = internal` (the synthetic probe); `aud_present` false everywhere; no `audience_mismatch` |
| 10 | Vercel production logs 09-30 (project-wide `--since 96h` 504s; per-deployment 24h works) | `vercel logs` | only probe 401s, two Google `grant_revoked` token failures on existing users, two Clerk `auth()` warnings on favicon 404s. Nothing on the connect path |
| 11 | Clerk OAuth applications (556) | Backend API with `.secrets/prod.env`, deleted afterwards | Claude's DCR registrations stop 2026-09-10 (CIMD since; 70 connections on that id). No Claude DCR rows during the gap. Cursor, Grok, Oasis, AgencyAnalytics, a "Test MCP Client" registered 09-24..28 |
| 12 | Clerk and Anthropic status | status APIs | Clerk: dev-instances-only Apple email incident (09-28). Anthropic: one resolved claude.ai error incident 09-29 14:21Z. Neither covers 09-27..29 |
| 13 | DNS / TLS for clerk.fgac.ai, accounts.fgac.ai | dig, openssl | CNAMEs to Clerk (`frontend-api.clerk.services`, `accounts.clerk.services`), certs valid to Dec 2026 |
| 14 | Discovery fetches (`connector_install_started{oauth_discovery}`) | PostHog | all crawler/probe user agents plus `node` and empty; no Claude signature exists on our discovery routes (Claude reads AS metadata from clerk.fgac.ai directly) — inconclusive |

## 3. Hypotheses

| candidate | verdict | evidence |
|---|---|---|
| Clerk OAuth-application setting (DCR disabled, redirect allow-list, CIMD regression) | **rejected** | DCR 201; CIMD client resolves to a consent card; redirect to Claude's callback delivered twice |
| Clerk sign-in redirect loop on the consent page (PR #163 mechanism) | **rejected for the connector path** | the hosted pages are Clerk's, our middleware is not in that chain; §7.31 telemetry (live since 00:06Z) covers fgac.ai pages only |
| Auto-attach failure on the first authenticated request | **rejected** | zero connector sign-ups means no first request ever arrived; the 09-30 connection auto-attached on the same build |
| Deploy regression (c5237a9, 09-25) | **rejected** | two connections completed on it, before and after the gap |
| Clerk's Cloudflare managed challenge on the Account Portal | **not excluded, not supported** | real browsers pass it (check 7); it would only bite a client that cannot run the challenge, and the website flow never touches the portal so it cannot alibi it. Whether it was introduced on 09-26 is unknown (no archive captures) |
| Anthropic side (directory listing / popup / callback) | **leading, unprovable from here** | the only step with no FGAC or Clerk footprint; initializes continued, nothing else did, and it recovered without a change on our side |

## 4. Decision

Nothing to ship. The next discriminating data is **not on FGAC's hosts**:

1. **Ken — Clerk Dashboard → Logs, 2026-09-27 00:00Z to 09-30 22:00Z:** request
   counts and error rows for `/oauth/authorize`, `/oauth-consent` (Account
   Portal), `/oauth/token`, and sign-in/sign-up attempts that never completed.
   Authorize hits with no sign-ins = users reached the portal and stalled
   (Clerk/Cloudflare); no authorize hits = users never got a popup (Anthropic
   — then the health-badge "failed connects" and a support ticket with the
   window are the follow-up). Also delete the probe OAuth application named
   above.
2. **Ken — whether the Clerk Dashboard shows a changed setting** on the
   OAuth/Account Portal pages around 09-26 (bot protection, Account Portal
   domain, consent location).
3. If the Clerk logs show arrivals that stalled, the structural fix is to host
   the sign-in page and the OAuth consent page on fgac.ai (Clerk changelog
   2026-06-22 `<OAuthConsent />`, Configure → Paths; `CLERK_SIGN_IN_URL` →
   a `/sign-in` page with `<SignIn />`). That removes the Account Portal — and
   its Cloudflare challenge — from the connector path and brings every hop
   under Vercel logs and `clerk_auth_redirect`. Scope it as its own plan.

## 5. How recovery is measured

`mcp_connection_created` with `account_age_seconds < 600` per day (runbook
§7.33 query) against the pre-gap baseline of 4.7/day (09-17..26). The 7.5
initialize count is the denominator ceiling only. First post-gap data point:
one at 2026-09-30 22:59Z.

## 6. Side effects of this investigation

- One DCR test client on production Clerk (name above) — delete in Dashboard.
- USER_A now holds a live Clerk session on accounts.fgac.ai and two consent
  grants for Claude's client id (harmless; no connection row, no token minted).
- The built-in browser's claude.ai session was logged out by claude.ai during
  check 7. Nothing else was changed anywhere.
- `.secrets/prod.env` was pulled for check 11 and deleted; `vercel link`
  wrote a development `.env.local` in this worktree (no `db:branch` was run;
  the app was not started).
