# Approval "Back to dashboard" returns to the changed profile — v1

## Problem
Every card on `/dashboard/approve` (and the Picker recovery pages reached
from it) linked "Back to dashboard" to bare `/dashboard`, which redirects to
the DEFAULT profile. Approving a grant for a non-default profile and clicking
back showed a profile without the new rule.

## Change
- `profileDashboardHref(slug)` in `src/lib/profileSlugs.ts`: valid slug →
  `/dashboard/agents/<slug>`, anything else → `/dashboard`.
- `approveMagicLink` returns `profileSlug` on every ok result (replay, file
  grants, send grants). `resolveApprovalLink` returns it for fresh /
  already_granted links.
- Approve page: `Card` takes `dashboardHref`; success redirect carries
  `&profile=<slug>`; the needs-file-grant redirect carries it to the setup
  page, whose `FileGrantRecovery` uses it for its back link.
- `qa:mint-link --profile <slug>` so QA can mint for a non-default profile.

## Validation
- `scripts/test-profile-slugs.ts` — helper cases incl. traversal / open
  redirect inputs.
- `tsc --noEmit`, eslint on changed files.
- QA: capability 14 (magic-link approvals) A21, local then preview.
