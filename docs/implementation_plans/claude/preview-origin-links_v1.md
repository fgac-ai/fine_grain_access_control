# Preview links name the preview — v1

Branch: `claude/preview-origin-links` (based on `integration/2026-10-08`, PR #199,
because it builds on that train's `deploymentOrigin()` helper — ADR-002 "branch from
the train only when the feature depends on something already landed there").

## Problem

Found by the full hosted-MCP QA regression on 2026-10-09 (train integration/2026-10-08).
The train already pointed MCP tool *descriptions* at the serving deployment
(`deploymentHostCopy` / `deploymentOrigin`), but every other outbound link still
named fgac.ai on a preview:

- approval links in MCP denials and `request_access` (minted on `DASHBOARD_URL`);
- `list_accounts` → `add_more_accounts` delegation links and walkthrough;
- reconnect links, Drive setup / re-enable pointers, pending-connection deep links;
- REST proxy Drive denials and reconnect hint;
- Gmail read-rule denials (hard-coded `https://fgac.ai/dashboard`);
- the dashboard's MCP endpoint string (`NEXT_PUBLIC_APP_URL ?? fgac.ai`);
- `/api/auth/cli-token` and `/api/auth/partner-token` pending `dashboard_url`.

`DASHBOARD_URL` resolves `NEXT_PUBLIC_APP_URL → VERCEL_PROJECT_PRODUCTION_URL →
localhost`, so on a preview it is production — where the approval request, the
Clerk instance and the user rows do not match the preview. Runbooks worked around
it by rewriting origins by hand (cap 14 A18, cap 18 A4 notes).

## Design

New `src/lib/linkOrigin.ts`:

- `linkBase(configured, env?, origin?)` — **production (`VERCEL_ENV=production`)
  returns `configured` unchanged**, byte for byte (no trimming, no request host —
  a request that arrived on www./gmail./a vercel.app alias still gets fgac.ai).
  Elsewhere: the request's origin, else `deploymentOrigin(env)` (VERCEL_URL /
  localhost:PORT).
- `runWithLinkOrigin(origin, fn)` — AsyncLocalStorage scope, set once per request.
  Same pattern as `toolCallContext.ts`; a separate store because the request-props
  store is spread into PostHog captures. Chosen over threading a parameter through
  ~20 call sites in helpers that never see `authInfo` (policy denials,
  account resolution, owner notices).

Wiring:

- MCP route: `DASHBOARD_URL` → `CONFIGURED_DASHBOARD_URL` + `dashboardUrl()`; the
  outermost handler is wrapped in `withLinkOrigin` (`requestOrigin(req)`, the same
  value as `authInfo.extra.requestOrigin`), so the auth path (pending-connection
  deep link) is covered too.
- REST proxy: same, each verb wrapped.
- `gmailRules.ts`: `linkBase('https://fgac.ai')`.
- `loadDashboard.ts`: `linkBase(appUrl, env, origin-from-next/headers)`.
- cli-token / partner-token: `dashboard_url` only. `proxy_endpoint` is left alone
  (its `gmail.` subdomain rewrite has no preview equivalent).

Emails: owner notices receive the same base. Production is unchanged
(configured URL; `notifyBaseUrl`'s production loopback rule still applies). On a
preview the emailed links now name the preview, which is where the request lives.
The forwarded host on Vercel is platform-set and can only be a host routed to this
deployment, so a caller cannot steer emailed links elsewhere.

Out of scope (by request): `/setup`, `/openclaw`, `/hermes` guide pages stay on
fgac.ai (public install docs). Tool descriptions were already handled by the train.

## Validation

- `npx tsc --noEmit` clean.
- `scripts/test-link-origin.ts` (added to `mcp:lint`): production output identical to
  the configured URL for every request host (incl. an untrimmed value), production
  approval link byte-identical to the pre-change link, production read-rule denial
  still `https://fgac.ai/dashboard`; preview names the request host / VERCEL_URL;
  local names the dev-server port; origin survives awaits and does not leak across
  concurrent requests.
- `npm run mcp:lint` passes.
- QA docs: cap 14 A9 now expects the deployment's own origin (never fgac.ai from a
  preview); A18 and cap 18 workaround notes replaced.

Preview validation: see v2.
