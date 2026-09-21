# Approval context after the sign-in wall: why the router never fired, and the pending-approvals banner — v1

Branch: `claude/stoic-goldberg-0a916f`. Follows PR #146 (implementation plan
`claude_fgac-signin-context-loss-dee31b_v2`), which measured the approval
sign-in wall and shipped a post-sign-in router. Date: 2026-09-20.

## The question

The 2026-09-19 user-behaviour review found that PR #146's routing half had
never fired in production: 24 `approval_wall_recorded` rows, 0
`approval_wall_routed`, 0 `sign_in_completed {after_approval_wall: true}`,
and "0 of 20 walled targets later opened". Two readings were on the table:
(a) the marker cookie never survives to the dashboard (cross-browser by
construction for Claude desktop), or (b) the same-browser path is broken in
code. Establish which, then ship the durable fix.

## What the evidence says (PostHog, production, 2026-09-16 13:24Z → 09-20 22:45Z; production ledger read-only)

**Neither.** The router is not reached because nothing needs routing.

1. **"0 of 20 opened" was a join on a property the open event does not
   carry.** `approval_link_opened` has no `target_hash`; joined as
   `monitoring.md` 7.25 writes it (wall → mint on `action`+`target_hash` →
   open on `request_id`), 16 of the 17 walled requests were opened by their
   owner afterwards (median 12 s) and 14 were approved.
2. **Same-browser sign-ins come straight back to the approve page** through
   Clerk's own `redirect_url`. The page renders, `opened_at` stamps, and the
   router's "not seen since" rule correctly declines. `/dashboard` never
   renders on that path, which is also why `sign_in_completed` (mounted on
   dashboard pages only) never fired after a wall.
3. **Claude desktop bounces are repaired by the person**: every
   `claude_desktop` wall hit is followed 5–95 s later by an
   `approval_link_opened` with `client: 'browser'` from the owner's real
   browser (the app's "open in browser"). 10 of 11 such requests were opened.
4. **`client = 'browser'` wall hits over-count people.** Every `browser` hit
   whose owner was on the approve page at the time carried the owner's EXACT
   user-agent and fired within 150 ms of that owner's own signed-in open of
   the same link — a cookie-less duplicate load riding the click (link
   scanner / preview fetch), not a person. Two more came from a Windows
   Chrome 151 UA whose owner works on a Mac. The production ledger has
   `routed_at` NULL on every row, and the one dashboard render that met a
   routable row was this duplicate-load case — the router declining there
   was the right outcome, whatever the mechanism.
5. **The lost context sits outside the wall.** 47 of the 87 requests minted
   in the window were never opened at all (21 owners); 5 of those had the
   owner on a dashboard page within the week, shown the profile page with
   nothing about the request. The 2026-09-15 sizing (15 of 110 never-opened
   requests with an owner sign-in inside the hour) is the same population.

A local reproduction (runner, dev build, USER_A) exercised the three paths
directly; results are in the PR description.

## What ships

**Pending-approvals banner** — Ken's 2026-09-15 ask ("no extra user steps"),
the durable, cookie-free repair. Every dashboard page (`/dashboard` inline
branch and `/dashboard/agents/[slug]`) lists the owner's open requests from
the ledger alone, in whatever browser they sign in with.

- `approval_requests.link_query` — the link's own `a/k/r/s` query, stored at
  every mint (latest wins). The ledger never stored the target in the clear,
  and the approve page needs the signed query, so without this a row cannot
  be linked. `wall_query` (PR #146) is the same string for the walled
  subset and is the fallback. `approval_requests.dismissed_at` — the owner's
  "Dismiss". Migration `0015_approval_pending_banner.sql`.
- `src/lib/approvalPending.ts` (pure, unit-tested in
  `scripts/test-approval-pending.ts`, in `mcp:lint`): a row is pending when
  it is unapproved, minted within 7 days, not dismissed since its last
  mint (a re-mint after a dismissal resurfaces it — fresh denial is fresh
  demand), and has a stored link. Newest first, capped at 5.
- `src/lib/approvalGrantState.ts` — `grantActiveForApproval` moved out of
  `dashboard/actions.ts` ("use server") so the banner can re-check the live
  rules: a grant that is already active never shows ("granted elsewhere").
- `PendingApprovalsBanner.tsx` (server): reads the rows, re-verifies each
  stored query against the signed-in owner before rendering, describes the
  grant with the approve page's own `describeApproval`, names the profile.
  `PendingApprovalsList.tsx` (client): "Review" (a plain navigation to the
  approve page with `src=banner`) and "Dismiss" (server action
  `dismissPendingApproval`, owner-scoped).
- Events: `approval_banner_shown {pending_count, actions, request_ids,
  oldest_pending_s}`, `approval_banner_clicked {request_id, action,
  pending_count}`, `approval_banner_dismissed {request_id, action}`;
  `approval_link_opened.link_source` gains `'banner'`.
- The wall telemetry, the record route and the router are unchanged, so
  7.25's existing queries keep working. The router stays as the fast path
  for the case it was designed for (an owner who signs in from `/dashboard`
  inside 30 minutes of a real wall hit); the banner covers everything it
  cannot reach.

## What this deliberately does not do

- No change to the wall cookie or the router's rules — the evidence shows
  neither is where context is lost.
- No sign-in embedded on the approve page (v1 Proposal B of the earlier
  plan) — the same-browser path already works through `redirect_url`.
- No backfill: rows minted before this deploy have no stored link (unless
  walled) and never appear. The banner's population starts at the deploy.
- No filtering of scanner/preview hits out of `approval_sign_in_wall`; the
  monitoring text explains how to read the `browser` class instead.

## Docs

`docs/analytics.md` (three events, `link_source: 'banner'`, the read on
`approval_wall_routed`), `docs/monitoring.md` 7.25 (the corrected read, the
banner funnel queries), QA capability 14 A18 and 16 A27, schema comments.

## Verification

- `npm run mcp:lint` (includes the new test), `tsc`, eslint on touched
  files, `npm run db:migrate` against the dev branch.
- Local: banner renders for a freshly minted `request_access` request as
  USER_A; Review lands on the approve page with `src=banner`; approving and
  dismissing both clear it; re-mint resurfaces a dismissed one.
- Preview (`/deploy-pr-preview`): capability 14 A18, 16 A27.

## Success measure

`monitoring.md` 7.25, banner block: `requests_opened_via_banner` growing out
of the never-opened pool (47 of 87 this week), `pct_converted` near the
agent-link rate, dismissals low relative to clicks.
