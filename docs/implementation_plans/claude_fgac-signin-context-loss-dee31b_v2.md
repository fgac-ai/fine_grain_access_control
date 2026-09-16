# Approval context lost at sign-in — v2

Branch: `claude/fgac-signin-context-loss-dee31b` · 2026-09-16 · supersedes v1
(same file name, `_v1`) after Ken's direction mid-build.

## What changed since v1

v1 proposed a pending-approvals banner (Proposal A) as the durable fix and an
embedded-sign-in approve page (Proposal B). Ken's refinement: **make the
post-sign-in landing page a router.** We know, before the sign-in, that this
same person visited an inaccessible approval link — so send them to it once
they are signed in, instead of to the profile page.

The insight that makes it work without a cookie: **the wall hit identifies
the owner by itself.** The `k` parameter in the link is a proxy key, the key
resolves to one user, and the link's signature verifies against that user
(the same check `resolveWrongAccountLink` already does). So a signed-out hit
can be filed under the owner server-side, with no session, and no unsigned
request can plant one. That is what makes the router cross-browser — the
Claude desktop pane hits the wall, the person's real browser (already signed
in) lands on `/dashboard`, and `/dashboard` knows.

## Shipped

### Telemetry (from v1, verified)

- `approval_sign_in_wall` (edge middleware event), deduped per browser for
  5 min via the marker cookie — a dev sign-in callback loop had produced 28
  rows for one sign-in.
- `fgac_approval_wall` marker cookie on Clerk's sign-in redirect. **Attached
  by the outer middleware wrapper**: in `@clerk/nextjs` 7.3 the middleware
  `redirectToSignIn()` *throws* a control-flow error that `clerkMiddleware`
  turns into the redirect, so nothing after `auth.protect()` runs. The first
  cut set the cookie on a response that was never returned; QA caught it
  (no `Set-Cookie` on the 307), the fix stashes the hit on the request
  object and sets the cookie on whatever redirect Clerk produced.
- `sign_in_completed` gains `client`, `landing_path`, `after_approval_wall`
  and the wall's action / hash / age. Still useful after routing ships: it
  counts the sign-ins the router did *not* catch.

### Server-side wall record

- `approval_requests` gains `wall_hit_at`, `wall_query` (the link's own
  `a/k/r/s` query string, stored verbatim so the redirect needs no
  re-signing), `routed_at`. Migration `0013_approval_wall_routing.sql`.
- `POST /api/approval-wall` (Node runtime; the edge has no database):
  resolves the key's owner, verifies the signature against that owner,
  stamps the row. Public and unauthenticated on purpose — the body *is* the
  signed link, and the worst a replay can do is route the owner to their own
  approve page once, which they can leave. Emits `approval_wall_recorded`.
- Middleware calls it fire-and-forget (`event.waitUntil`) for human document
  navigations only (`client != 'agent'`): an agent fetching the link is not
  an owner about to sign in.

### The router

- `/dashboard` — Clerk's Home URL and the hosted sign-in's fallback both
  point here, so it is where every sign-in ends — now asks the ledger before
  redirecting to the profile page. Rules (`src/lib/approvalRouting.ts`, unit
  tested):
  - the wall hit is under **30 min** old (a hit from yesterday is history);
  - the approve page has **not been opened by the owner since** the hit
    (`opened_at` stamps on every owner render — if Clerk's `redirect_url`
    did bring them back, there is nothing to repair);
  - **once per hit** (`routed_at`; a re-hit resets it) — someone who backs
    out of the approve page to the dashboard is not bounced back;
  - newest qualifying hit wins.
- Redirect target is `/dashboard/approve?<wall_query>` — the link exactly
  as minted. Emits `approval_wall_routed {request_id, seconds_since_wall}`.

No Clerk configuration change is needed: the Home URL already lands on
`/dashboard`, and `/dashboard` is now the routing page.

### What this does NOT need

- No new step for the person. The sign-in they were going to make anyway
  now ends on the approval instead of the profile page.
- No guessing. Every route is backed by a signed link the owner's own key
  minted, hit within the last half hour, not yet seen.

## Still open (from v1, unchanged in scope)

- **Pending-approvals surface** (v1 Proposal A) for anything the router
  misses: hits older than 30 min, several requests at once, a person who
  never hits the wall because their agent's link was pasted somewhere else.
  The clearing rules in v1 (approved / substituted / granted elsewhere /
  superseded by a later same-kind approval / dismissed / 7-day TTL on
  `last_minted_at`) stand; the `target` column is still required for it.
- **Embedded sign-in on the approve page** (v1 Proposal B) — worth less now:
  the router repairs the cross-browser case the embedded component cannot.
- Clerk's signed-in behaviour on `accounts.*/sign-in?redirect_url=…` remains
  documented-not-measured; with the router in place it no longer matters
  which page Clerk chooses.

## Verification

- Unit: `scripts/test-approval-wall.ts`, `scripts/test-approval-routing.ts`
  (both in `mcp:lint`); `tsc`; eslint on touched files.
- Local (curl): wall 307 carries the marker cookie; repeat bounce records
  nothing (one PostHog row for two probes); signed-in visit with a stale
  marker clears it; `/api/approval-wall` answers 400 / 204 / 204 for a bad
  body / no params / a bad signature.
- Local (QA runner, built-in browser, real link minted through
  `request_access`): see the PR for the run report — same-browser and
  cross-browser routing, once-per-hit, and the PostHog chain
  `approval_sign_in_wall → approval_wall_recorded → approval_wall_routed →
  approval_link_opened` on one `request_id`.
- Preview: capability 16 A22 + A23.

## Success measure (monitoring §7.24)

`approval_wall_routed` per wall request rises from 0; the lost-context share
of `sign_in_completed` (`after_approval_wall: true` landing on a profile
page) falls towards 0; `pct_recovered` in the wall query rises from its
2026-09-15 baseline (15 of 26 sign-ins within an hour of a mint recovered on
their own).
