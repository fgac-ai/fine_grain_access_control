# Drive tree access behind a feature flag — plan v3 (flag moves to PostHog)

Branch: `claude/google-drive-permissions-ux-427163` · Date: 2026-10-03 · Supersedes
v2's description of the flag; everything else in v1/v2 stands.

## Change

Ken (2026-10-03): manage who is on the feature in PostHog, not with environment
variables and redeploys. So the gate is now the **PostHog feature flag
`drive_tree`**, evaluated server-side (`src/lib/featureFlags.ts`):

- `posthog-node`'s remote evaluation with the project key the server already
  holds; distinct id = the Clerk user id, the user's email passed as a person
  property so an `email` release condition works across the dev and production
  Clerk instances and before the person has ever visited the dashboard.
- Cached per user for 60 s (one PostHog round-trip per user per minute at most,
  so the MCP hot path never pays per tool call); a 3 s timeout, no verdict, or
  any error **fails closed** to the legacy behaviour.
- `$feature_flag_called` events are not sent per evaluation (`drive_tree: true`
  on our own events is the usage signal).
- `FGAC_DRIVE_TREE=1` / `FGAC_DRIVE_TREE_USERS` remain as overrides for local
  dev and CI only (the `fgac-dev-drive-tree` launch configuration), so QA runs
  never depend on PostHog. Either override wins; neither set → PostHog decides.
- Every caller (`loadDashboard`, `/api/drive/*`, the MCP route's account
  resolution and `get_my_permissions`, the REST proxy) awaits the same
  function. `npm run env:check` prints which source is in effect.

The second gate is unchanged: the engine applies only when the live token
carries the full `drive` scope, and that scope is requested only from flagged
users.

## The flag

PostHog project 343912, feature flag `drive_tree` (id 929626):
https://us.posthog.com/project/343912/feature_flags/929626 — active, server
evaluation only, one release condition on person property `email` (100 % of
matches), seeded with the USER_A QA account so the preview test can start.

## Operating it

- Add or remove a person: edit the `drive_tree` flag's release conditions in
  PostHog (person property `email`, or the Clerk id as distinct id). Takes
  effect within a minute, no deploy.
- Preview testing: the preview deployment reads the same flag (same PostHog
  project), so no Vercel env change is needed — add the sign-in account to the
  flag, open the preview, enable full Drive access, add the connector.
- Rollout to GA later: a percentage or cohort condition on the same flag.

## Validation

- `scripts/test-feature-flags.ts`: env override wins without asking PostHog;
  true → on; undefined / throw → off (fail closed, and the failure is cached so
  an outage costs one call per user per minute); 60 s cache expiry; per-user
  cache; no identity → off. `npx tsc --noEmit` clean; `npm run mcp:lint` exit 0.
- Live evaluation against the PostHog project is exercised by the preview test
  (v2's blocked browser QA, once a signed-in QA browser exists).
