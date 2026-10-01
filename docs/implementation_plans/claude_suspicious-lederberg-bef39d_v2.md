# Directory connections stopped 2026-09-27 — recurrence and decision (v2)

Supersedes v1 (same directory) after the 2026-10-01 daily review reported the
gap has **not** recovered. Written 2026-10-01 11:30Z. Runbook:
`docs/monitoring.md` §7.33. Still no code shipped; this revision gives Ken the
one check that decides the cause and a costed structural option.

## 1. Where it stands (re-run of §7.33 steps 1, 2, 3, 5 on 2026-10-01)

| day (UTC) | 7.5 ClaudeAI unauth initializes | sign-ups (all) | connector sign-ups | connections |
|---|---|---|---|---|
| 09-24 | 20 | 7 | 3 | 4 |
| 09-25 | 18 | 8 | 6 | 6 |
| 09-26 | 16 | 3 | 1 | 1 |
| 09-27 | 21 | 1 | 0 | 0 |
| 09-28 | 20 | 5 | 0 | 0 |
| 09-29 | 21 | 4 | 0 | 0 |
| 09-30 | 24 | 1 | 1 | 1 |
| 10-01 to 11:00Z | 9 | 0 | 0 | 0 |

- Since 2026-09-26 23:51Z: 4.47 days, one connection (09-30 23:01Z).
  Expected at the 09-17..26 pace of 4.7/day: 21. **About 20 directory
  connections lost so far, and roughly 4.7 more per day while it lasts.**
- Step 2 (outside-in): 401 challenge, both discovery documents, Claude's
  client-metadata document, the authorize → continue → sign-in chain and
  `scripts/mcp-auth-probe.ts` all pass (2026-10-01 11:01Z).
- Step 3 (qa-setup-driver, built-in browser, USER_A, fresh PKCE, 11:02Z):
  authorize → consent → Allow → Claude callback, no Cloudflare interstitial
  at any hop, nothing different from the 09-30 run. First failing step: none.
- Step 5: current production deployment (train #174) error log for the last
  24 h holds only the four synthetic-probe 401s.
- Both runs are from the same network and account, so they prove the chain
  *can* complete (as the 09-30 user did), not that every user's does.

Conclusion unchanged: attempts keep arriving at our 401, nothing reaches
Clerk account creation, and nothing FGAC can observe is failing. The failure
sits in the segment that runs on Clerk's hosts and inside Claude's popup.

## 2. Step 4 — the Clerk Application Logs query (Ken)

Open **https://dashboard.clerk.com/~/application-logs** on the **production**
instance (`clerk.fgac.ai`), date range **2026-09-26 00:00 UTC → now**, and
read these event-type filters one at a time (the filter accepts trailing
wildcards):

| filter | what to read | meaning |
|---|---|---|
| `oauth_authorization.*` | count of `granted` vs `failed` per day; open a `failed` payload | how many people reached and passed the consent page for the Claude client (client id `https://claude.ai/oauth/mcp-oauth-client-metadata`); a `failed` payload names the reason |
| `oauth_token.created` | count per day | tokens Claude actually exchanged; each one should be followed within seconds by an `mcp_connection_created` on our side |
| `oauth_callback.failed`, `oauth_consent.denied` | any rows | Claude's redirect rejected, or users clicking Deny |
| `sign_up.created` and `sign_up.completed` | per-day counts, with `source`/path in the payload (Account Portal vs fgac.ai) | sign-ups started on the hosted portal that never completed = stalled on the portal |
| `sign_in.created`, `sign_in.failed`, `sign_in.attempt_first_factor.failed` | same | existing users trying to connect who could not sign in on the portal |

Decision table (compare 09-27..30 against 09-22..25):

| Clerk shows | the break is | follow-up |
|---|---|---|
| no `oauth_authorization.*`, no portal `sign_in/sign_up.created` | before Clerk: users never got, or never completed, Claude's popup | Anthropic support with the window, the listing's failed-connect count, and the three `ofid_` references from our probes as "what a rejected callback looks like" |
| portal `sign_in/sign_up.created` without `completed` | on the hosted portal (Cloudflare challenge, Google sign-in inside the popup, or email-code delivery) | the §3 option, or a Clerk ticket quoting the failed payloads |
| `oauth_authorization.granted` but no `oauth_token.created` (or `oauth_callback.failed`) | Claude's callback / token exchange | Anthropic support; Clerk ticket if the token endpoint logged errors |
| `oauth_token.created` at the old pace | tokens issued, Claude never made its first request | Anthropic support (inspector / client side); nothing on our side to fix |

Also delete the DCR test application named `fgac-outage-probe-2026-09-30`
(Configure → OAuth applications).

## 3. Structural option — host sign-in and consent on fgac.ai

Today Clerk's environment (`clerk.fgac.ai/v1/environment`, `display_config`)
sends the authorize flow to `sign_in_url = https://accounts.fgac.ai/sign-in`
and `oauth_consent_url = https://accounts.fgac.ai/oauth-consent`. Both are
Dashboard settings (Configure → Paths; production needs full URLs) and both
can point at pages on fgac.ai:

1. **Consent** — `<OAuthConsent />` from `@clerk/nextjs` at `/oauth-consent`
   (Clerk changelog 2026-06-22), left unmodified: Clerk's own caveat is that
   consent is a security boundary and a custom page must not hide the client,
   misstate scopes or bury Deny.
2. **Sign-in / sign-up** — `/sign-in` and `/sign-up` pages with `<SignIn />`
   and `<SignUp />` plus `NEXT_PUBLIC_CLERK_SIGN_IN_URL` /
   `NEXT_PUBLIC_CLERK_SIGN_UP_URL`; public in `src/middleware.ts`. The
   website's modal sign-up is unaffected.
3. **Telemetry** — one server event when the consent page renders and one on
   Allow/Deny (client id, scopes, account age), so the funnel reads
   `connector_install_started` → consent shown → consent granted →
   `mcp_connection_created`; `clerk_auth_redirect` (§7.31) already covers
   the sign-in redirect on our domain.
4. **Dev instance too** — the same Paths on the development instance
   (relative to the fallback dev host) so preview and local QA exercise the
   same pages; runbook §7.33 step 3 then runs against our pages.

What it buys: the whole connector funnel lands in Vercel logs and PostHog,
and the Account Portal, with its zone-wide Cloudflare managed challenge,
leaves the connector path. What it does not do: fix a cause we have not
seen. If Clerk's logs say nobody arrived (first row of the decision table),
this change helps the next incident, not this one.

Cost: about one day of work (three pages, two env vars, middleware, two
events, QA on preview with both Clerk instances' Paths set) against ~20
connections already lost and ~4.7/day ongoing; at the launch cohort's
measured activation it is the difference between the directory producing
new users and producing none.

## 4. Side effects of the 2026-10-01 re-run

USER_A kept yesterday's Clerk session, so the sign-in form and Google
chooser were skipped; a third consent grant for Claude's client id exists on
USER_A; Claude logged the (already signed-out) pane out again. Nothing else
changed anywhere.
