# Clerk auth-redirect monitoring — `clerk_auth_redirect` (v1)

Branch `claude/zealous-dhawan-5e92b4`, 2026-09-24.

## Problem

On 2026-09-21, testing the pricing page on localhost, Ken was stuck in a Clerk
sign-in loop: the server logged Clerk's "Refreshing the session token resulted
in an infinite redirect loop" warning dozens of times while the browser bounced
between `/dashboard` and the hosted accounts.dev sign-in page. Locally the
causes were a pruned Neon branch (the dashboard threw a DB auth error on every
load) plus stale Clerk cookies. Production has no dev-instance handshake, but
the same shape — the app and Clerk's sign-in/handshake endpoints handing a
browser back and forth — would produce **no signal today**: `sign_in_completed`
(`src/app/dashboard/SignInTelemetry.tsx`) fires only on success, and Clerk's
warning goes to Vercel's ~1 h runtime log.

## Where the redirects surface

Read from `@clerk/nextjs` 6.x / `@clerk/backend` 3.4.x:

- **Handshake**: `clerkMiddleware` returns `NextResponse.redirect(requestState.headers.Location)`
  *before* calling our handler when `authenticateRequest` decides the state is
  ambiguous. Location is `https://<frontendApi>/v1/client/handshake?redirect_url=…&__clerk_hs_reason=…`.
  On a dev instance the return hop (`?__clerk_handshake=…`) is answered with a
  second, same-origin redirect to the clean URL.
- **Sign-in**: `auth.protect()` throws a control-flow error; `clerkMiddleware`
  catches it (`handleControlFlowErrors`) and returns
  `redirectToSignIn` → `<signInUrl>?redirect_url=<returnBackUrl>` (dev instances
  get `__clerk_db_jwt` appended by `serverRedirectWithAuth`, which rebuilds the
  `NextResponse` but keeps its headers).
- Both carry Clerk's `x-clerk-auth-status` / `x-clerk-auth-reason` response
  headers (`withDebugHeaders`), so the reason is free.
- Clerk's own loop detector is the `__clerk_redirect_count` cookie: at 3 hops
  inside one handshake it gives up, returns `signedOut`, and prints the warning.

So the single observation point is the **outer wrapper** in `src/middleware.ts`
— the same place the approval wall attaches its marker cookie to "whatever
redirect Clerk produced".

## Design

`src/lib/clerkAuthRedirect.ts` (pure, edge-safe, sibling of `approvalWall.ts`):

- `classifyClerkRedirect(location, origin)` → `'handshake' | 'sign_in' | null`.
  The dev handshake's same-origin return hop is `null` on purpose (second half
  of a hop already counted; production has none).
- `stripPathIds(pathname)` → uuid / numeric / hex / long-opaque segments become
  `:id`.
- Bounce marker cookie `fgac_clerk_bounce` = `<16-hex id>.<first unix s>.<count>`,
  5-minute window (`advanceBounceMarker`): same series → count+1, else fresh.
  The count on the hop **is** the sliding-window loop length, so the detection
  query is a `max()` per series, not a self-join over timestamps.
- `describeClerkAuthRedirect(...)` → event properties: `kind`, `path`,
  `reason`, `auth_status`, `client_hash` (keyed HMAC of `__session`, else a
  non-zero `__client_uat`, else `__clerk_db_jwt`; `analyticsHash` exported from
  `approvalLinks.ts` — same secret and shape as `target_hash`, its own label),
  `browser_key` (`client_hash ?? bounce_id`), `has_session_cookie`,
  `has_client_cookie` (`__client_uat` present and ≠ `0`), `clerk_redirect_count`,
  `client` / `agent_driven` / `user_agent`, `navigation`, `bounce_id`,
  `bounce_count`, `bounce_age_s`.

`src/middleware.ts`: `observeClerkAuthRedirect(req, res, event)` runs after
`attachWallMarker` in the outer wrapper — 3xx + Location classified → set the
marker cookie on the `NextResponse` → `event.waitUntil(describe → captureEdgeEvent)`.
Whole body in try/catch; failures `console.warn` only; the response's status
and Location are never touched. Distinct id: constant `anonymous-clerk-redirect`.
Not deduped (unlike the wall): the hop count is the signal.

Volume: one row per Clerk redirect. Production baseline is one `sign_in` hop
per sign-in plus one `handshake` per returning browser with an expired token
(`session-token-expired`). Dev instances add one `dev-browser-missing`
handshake per fresh browser — every query filters `environment = 'production'`.

## Deliverables

| item | where |
| --- | --- |
| pure module + unit test | `src/lib/clerkAuthRedirect.ts`, `scripts/test-clerk-auth-redirect.ts` (in `mcp:lint`) |
| middleware capture | `src/middleware.ts` outer wrapper |
| hash helper | `analyticsHash` in `src/lib/approvalLinks.ts` |
| event catalog | `docs/analytics.md` `clerk_auth_redirect` row (cross-refs §7.25 / `approval_sign_in_wall`) |
| runbook + alert | `docs/monitoring.md` §7.31 (7.31a loops, 7.31a' cookie-less fallback, 7.31b per path, 7.31c baseline; alert spec) |
| QA | capability 16 A30 |

## Validation plan

1. `npx tsx scripts/test-clerk-auth-redirect.ts`, `tsc`, `eslint`,
   `npx tsx scripts/qa-coverage-check.ts` (doc parses; A30 counted).
2. Local: signed-out document navigation to `/dashboard` → 307 to accounts.dev
   with `Set-Cookie: fgac_clerk_bounce=…`; PostHog `environment = 'development'`
   shows the `sign_in` row (plus the dev `handshake` row for a fresh browser);
   a signed-in navigation adds nothing.
3. `/deploy-pr-preview`, repeat on the preview URL (`environment = 'preview'`).
4. Alert: created through the PostHog MCP connector (OAuth as Ken) —
   insight `XKnzwDVm`, alert `01a0d396-2dd7-0000-252a-fbe4f35492af`, hourly,
   fires when the hour's count of `bounce_count ≥ 5` production hops is above 0.
   The `phx_` automation key could not have done this (`insight:write`
   denied); §7.31 and the 2–3 alerts table record it.
5. No `/qa-production`.

## Findings during validation (2026-09-24)

- **A real loop showed up on the first local run.** The built-in browser pane
  (Claude desktop UA) opened the dev server and immediately looped: stale
  `__session` for localhost (cookies ignore ports, so it came from an earlier
  `:3000` session), no `__client_uat`, Clerk reason
  `session-token-but-no-client-uat`, 27 `handshake` hops in 214 s on one
  `bounce_id`, `bounce_count` 1 → 27. Every `navigate` call reported
  "denied or failed" — that is what a redirect loop looks like from the
  outside. 7.31a would have flagged it at hop 5.
- **Clerk's own loop detector never fired.** `__clerk_redirect_count` is set
  with `Max-Age=2`; `clerk_redirect_count` read 0 on all 27 hops. So the
  pre-existing signal (the console warning) is absent for any loop slower
  than two seconds per hop, which is most of them. Documented in §7.31.
- The signed-out `curl` probe (document `Accept`, Chrome UA) got the expected
  307 to `…/v1/client/handshake?…__clerk_hs_reason=dev-browser-missing` with
  `Set-Cookie: fgac_clerk_bounce=<id>.<ts>.1; Max-Age=300`; a second probe
  carrying that cookie was answered with `.2`. Both rows arrived in PostHog
  under `environment = 'development'` with `client_hash` absent,
  `browser_key = bounce_id`, `client = browser`, `navigation = true`.
