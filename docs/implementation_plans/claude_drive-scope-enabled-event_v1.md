# `drive_scope_enabled` never fires — v1

Branch: `claude/drive-scope-enabled-event` · 2026-10-09

## Problem

The Drive tree beta's success event `drive_scope_enabled` has 0 rows in
PostHog (project 343912), ever. Meanwhile flagged users clearly hold the full
`drive` scope: USER_A (QA) has 167 `$mcp_tool_call{drive_tree: true}` in 14
days, and one production beta user made 54 `drive_tree` calls starting about
2h after their single `drive_scope_enable_started` (2026-10-06 00:32Z).

## Root cause (observed)

`EnableDriveAccessCard` captured the event in its return-leg effect
(`?drive_scope=1`). But `AgentProfilesView` renders that card **only while the
server sees no full scope** (`driveTree.flagOn && !hasFullScope`). After a
successful consent, the return leg's server render (`loadDashboardData` →
`checkGoogleAccess` → tokeninfo) already sees `…/auth/drive` and renders
`DriveAccessCard` instead. The card never mounts, so its effect never runs and
neither `returned` nor `enabled` is captured.

PostHog evidence (HogQL over `drive_scope%` events + `$pageview` on
`?drive_scope=1`, 14 days):

- The production beta user's return leg DID load
  `/dashboard/agents/default-profile?drive_scope=1` with posthog-js running (a
  `$pageview` 23s after `started`), and no `drive_scope_enable_returned`
  followed. This rules out "the return URL lacks `?drive_scope=1`" and
  "posthog not loaded".
- Every one of the 4 `drive_scope_enable_returned` rows is followed by
  `drive_scope_enable_incomplete`. The return leg only ran when the server did
  NOT see the scope.
- Ruled out by the code: the `scopes` shape (the token bridge returns a
  string array from tokeninfo, and `includes(DRIVE_FULL_SCOPE)` is correct),
  and a `router.replace` race (the capture came before the replace and was
  never reached).
- A second, separate gap: grants made through the nav UserButton's
  connect-account scopes (`NavUserButton.tsx`) have no event anywhere.

A side effect of the same bug: the return leg's `setDriveDefault` write never
ran on success. So a profile was never marked as "on the tree model", and a
later loss of the scope showed the first-time "Enable" card instead of
"Re-enable".

## Fix

1. **Server-side source of truth.** New column `users.drive_full_scope_since`
   (migration `0022`). `src/lib/driveScopeEpisode.ts` (DB-free, unit-tested)
   and `driveScopeEpisodeServer.ts` (Drizzle store):
   - When the scope is held: `UPDATE … SET since = now() WHERE since IS NULL
     RETURNING`. Only the winning write captures `drive_scope_enabled`
     {`reenable`, `surface`, `return_leg`}, so it fires exactly once per
     episode across tabs, refreshes, concurrent renders and tool calls. The
     same write saves `drive_default = 'read'` on active profiles that have
     none (what NULL already meant), which restores the re-enable detection.
   - When the scope is gone and **certain** (a dashboard tokeninfo answer, not
     `disconnected`): clear the marker and capture `drive_scope_lost`. The MCP
     path reports gains only, because its verdict can fall back to Clerk's
     record.
   - Observers: `loadDashboardData` (every dashboard render; the slug page
     passes `returnLeg` from `?drive_scope=1`) and the MCP `resolveTarget`
     path when `driveTreeActive`. MCP keeps a per-instance cache, so this is
     one UPDATE per user per instance. Dashboard observations bypass the
     cache.
2. **Client return leg lifted out of the card.** New
   `useDriveScopeReturnLeg` hook, called by `AgentProfilesView` for every
   flagged user, so `drive_scope_enable_returned` {`scope_seen_by_server`}
   fires on success too. It strips `?drive_scope=1` and polls only when the
   server has not seen the scope yet. The client no longer captures
   `drive_scope_enabled`, which avoids double counting. It uses an unmount
   guard instead of per-effect cancellation, so a Strict Mode re-run cannot
   cancel the only poll.

Known one-off: users holding the scope at deploy (USER_A and the one
production beta user) get one catch-up `drive_scope_enabled` (`return_leg:
false`) on their first post-deploy observation. Documented in
`docs/analytics.md`.

## Tests

- `scripts/test-drive-scope-episode.ts` (added to `mcp:lint`) covers:
  - once across repeated and concurrent observations;
  - the MCP-only (nav UserButton) path;
  - the hot-path cache doing no writes;
  - flag off and uncertain loss as no-ops;
  - lost → re-enable (`reenable: true`);
  - a stale MCP cache never masking a dashboard observation.
- `scripts/test-drive-scope-gating.ts`: the new hook is allow-listed as a
  READER of the scope.

## Validation plan

- Local: `npm run mcp:lint` (all script tests); `db:migrate` applied `0022`
  on branch `claude-drive-scope-enabled-event`.
- Preview (`/deploy-pr-preview`): run the drive-tree draft capability's A3 as
  USER_A. USER_A already holds the scope, so expect the one catch-up
  `drive_scope_enabled{surface: dashboard}` on the first dashboard load and
  none on reloads. Verify with HogQL on `drive_scope_enabled` filtered to
  `environment = 'preview'`.
- Production check after Ken's deploy:
  `SELECT count(), uniq(person_id) FROM events WHERE event =
  'drive_scope_enabled' AND timestamp > <deploy>` should be ≥ 1 within a day
  (the production beta user's catch-up event on their next tool call).
