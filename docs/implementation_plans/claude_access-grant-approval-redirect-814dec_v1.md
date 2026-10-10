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

## QA results (2026-10-10)
- Local: blocked — built-in pane refuses localhost; Path B profile has both
  QA Google accounts signed out (password prompt, stopped).
- Preview (`fine-grain-access-control-as46dxb5q…`), built-in browser, USER_A:
  - Real Default Profile link: back link = `/dashboard/agents/default-profile`
    on confirm, success (`profile=default-profile` in URL) and "Already
    approved" cards — pass.
  - `result=ok&profile=all-access` → href `/dashboard/agents/all-access`,
    click lands there — pass.
  - Bad `profile=` (`../accounts`, `//evil.example.com`, `Research-Bot`) →
    `/dashboard` — pass.
  - Real link for a NON-default profile: not obtained (stored QA bearer is
    bound to the default connection). Same code path (slug from the link's
    key label), but unexercised end to end.
  - Picker-recovery fallback: skipped (no approval routed there).
