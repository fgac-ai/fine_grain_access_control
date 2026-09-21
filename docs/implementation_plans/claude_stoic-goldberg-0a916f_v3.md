# Approval context after the sign-in wall — v3

Branch: `claude/stoic-goldberg-0a916f`, PR #157. Supersedes v2 with the
preview QA outcome and one router correction it surfaced. Everything else in
v2 stands.

## Preview QA (2026-09-21 03:00–03:06Z, USER_A, built-in browser)

Every assertion passed: capability 14 A18 (banner render, Review with
`src=banner`, two items newest first, Dismiss hides and stays hidden,
re-mint resurfaces), 16 A27 (shown / clicked / opened `link_source: banner`
/ dismissed rows, counts matching the render), 16 A23 (wall recorded,
first `/dashboard` load routed at 94 s, second load on the profile page with
`approval_wall_route_skipped {reason: skip, routed_already: 1}`). Report
in the PR.

## What changed since v2

- **`approval_requests.last_opened_at`** (migration `0016_approval_last_opened.sql`),
  stamped on every owner render of the approve page; `opened_at` keeps the
  first open for the funnel. The router's "not seen since the hit" rule now
  reads `coalesce(last_opened_at, opened_at)`. Preview QA F3: a request
  first opened BEFORE a wall hit and reached again AFTER it (Clerk's
  `redirect_url`, the banner, the link itself) looked unseen to the old
  rule, so a later `/dashboard` load could bounce the person back to a page
  they had just left — the exact annoyance the once-per-hit rule exists to
  prevent, and what the 2026-09-17 production owner would have hit had the
  router fired for them. Pure rules and tests unchanged; the read changed.
- Capability 14 A18 corrected: the `request_access` argument is
  `resourceName` (not `title`), and on a preview the minted link carries
  the production origin (`DASHBOARD_URL` prefers `NEXT_PUBLIC_APP_URL`) —
  rewrite the origin before opening.

## Verification (this revision)

`db:migrate` on the dev branch, `tsc`, routing tests, eslint; preview
re-run of 16 A23 scoped to the routing rule (open the link signed in
first, then wall-hit it signed out, then `/dashboard`: must NOT route,
skip row says `opened_since: 1`).
