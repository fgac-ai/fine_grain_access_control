# Approval context after the sign-in wall: why the router never fired, and the pending-approvals banner — v2

Branch: `claude/stoic-goldberg-0a916f`. Supersedes v1 (same branch) with the
local reproduction's results and the skip-path telemetry it motivated. The
evidence section and the banner design are unchanged from v1; only what is
listed under "What changed since v1" is new.

## What changed since v1

1. **Local reproduction done** (qa-setup-driver, dev build, USER_A, 2026-09-21
   02:27–02:48Z; one real `request_access` link minted through a local MCP
   bearer). The router **works**: six signed-in `/dashboard` loads with a
   routable ledger row, five redirected to the approve page
   (`approval_wall_routed` at 122 / 429 / 24 / 9 / 89 s after the hit), the
   once-per-hit rule held on the second load, and the "Agent Profiles" nav
   click from the approve page after a cookie-less hit routed as well (the
   Scenario C the 2026-09-17 production owner hit). One load did not route
   with a provably routable row (opened before the hit, `routed_at` NULL,
   `wall_query` stored, unapproved), no error in the server log, one `users`
   row for the owner's Clerk id, and the identical load five minutes later
   routing fine. That single miss produced exactly the production
   signature: `sign_in_completed {after_approval_wall: true, landing_path:
   /dashboard/agents/…}` and no `approval_wall_routed`.
2. **Skip-path telemetry** so the next such miss names its rule.
   `resolveWallRoute` now returns a decision (`route` / `skip` with per-rule
   counts / `lookup_failed` / `none`), `listWallHitsForRouting` returns
   `null` on a read error instead of an empty list, and `/dashboard` emits
   `approval_wall_route_skipped {reason, candidates, stale, routed_already,
   opened_since, no_query, future}` whenever an owner had wall-hit rows on
   file and none routed. `explainWallRouteSkip` is pure and unit-tested in
   `scripts/test-approval-routing.ts`. Verified locally: two dashboard
   renders after the routed hit emitted `skip` with `routed_already: 1`.
   Query in `monitoring.md` 7.25.
3. **Banner verified in the browser** (built-in pane, USER_A, the runner's
   unopened request): the profile page shows "An agent is waiting for your
   approval" with the approve page's own description, the profile label and
   "20 minutes ago"; "Review" lands on `/dashboard/approve?a&k&r&s&src=banner`
   and the page renders the request; "Dismiss" hides it at once and it is
   gone on reload. PostHog (development): `approval_banner_shown
   {pending_count: 1}` per render, `approval_banner_clicked`,
   `approval_link_opened {link_source: 'banner'}`,
   `approval_banner_dismissed`, in that order.

## Environment artifacts worth knowing (not product bugs)

- The dev Clerk instance's hosted sign-in never completes its `redirect_url`
  leg from the built-in pane ("keys do not match" loop); the session syncs
  by loading the hosted page with `redirect_url=<origin>/`. Locally, then,
  the router is what delivers the approve page after a wall hit — Scenario A
  and B are indistinguishable. Production Clerk does complete `redirect_url`
  (the 16-of-17 recovery in v1's evidence is that leg).
- A cookie-less curl of an approval link on the dev instance is answered by
  Clerk's dev-browser handshake before middleware sees it; only the return
  visit (with a jar) records a wall hit. Production instances have no such
  handshake.
- Minted links carry `NEXT_PUBLIC_APP_URL` (`localhost:3000`) on a
  non-3000 dev server; the runner rewrote the port. Signature covers only
  `a/k/r/s`, so this is harmless to QA.

## Still open

- The one local non-route is unexplained. The skip event is the instrument;
  a production `skip` row whose per-rule counts are all zero, or a
  `lookup_failed` row, is the next thing to chase. Nothing in the evidence
  makes it worth more than that: the router's population in production was
  two renders by one owner in four days, both on a duplicate-load "wall
  hit" the owner had already opened past.
- Rows minted before this deploy have no stored link and never appear in
  the banner (v1's "no backfill").

## Verification (this revision)

- `npm run mcp:lint` (approval-routing tests extended, pending tests
  added), `tsc`, eslint on touched files, `db:migrate` against the dev
  branch.
- Local browser: banner render / Review / Dismiss as above; router repro
  report in the PR description.
- Preview (`/deploy-pr-preview`): capability 14 A18, 16 A27, 16 A23
  (router still fires; a second load emits `approval_wall_route_skipped
  {reason: 'skip', routed_already: 1}`).
