# Spike — full `drive` scope: can it read and edit Sheets/Docs/Slides alone?

Date: 2026-09-17 · Environment: local dev server, dev Clerk instance, dev
Google OAuth client, QA account USER_A · Runner: `qa-setup-driver` · Plan:
`docs/implementation_plans/claude_great-dhawan-c05848_v3.md`

## Status: INCOMPLETE — no `drive`-scoped token was obtained

The question (Ken, 2026-09-17): if a user grants FGAC the full `drive` scope,
can FGAC read and edit every Google Sheet and Doc they can reach in Drive,
and is a separate Sheets / Docs / Slides API scope needed?

What the documentation answers (fetched 2026-09-17, per-method scope tables):
`spreadsheets.values.update` accepts `drive`, `drive.file`, `spreadsheets`;
`documents.batchUpdate` accepts `documents`, `drive`, `drive.file`;
`presentations.batchUpdate` accepts `drive`, `drive.file`, `drive.readonly`,
`presentations`, `spreadsheets`, `spreadsheets.readonly`. FGAC already runs
Sheets and Docs in production on `drive.file` with no Sheets/Docs scope, and
`drive` is the superset of `drive.file` in every table. So the expected
measured answer is: **`drive` alone suffices, no separate content-API scope**,
bounded by the user's own Drive permission on each file. This spike was meant
to prove that with a token, and did not get one.

## What was measured

| stage | finding |
| --- | --- |
| Baseline token (`/api/auth/google-picker-token` → tokeninfo) | `drive.file`, `gmail.modify`, openid/email/profile. `hasDriveFileScope: true`, `appId` present. |
| Baseline calls with that token | `files.list` `in parents` on the probe folder → empty; `spreadsheets.get`, `documents.get`, `presentations.get` on user-created probe files → 404 (as expected under `drive.file`). |
| Clerk external account | `verification.status: verified`, so the in-place `reauthorize({ additionalScopes: ['…/auth/drive'], oidcPrompt: 'consent' })` path applied (never the destroy-and-recreate branch). |
| Google consent for the widened request | Google **accepted the undeclared restricted scope on the dev client**: the consent page listed exactly one new line, "See, edit, create, and delete all of your Google Drive files", with "already has some access — 5 services" and no per-scope checkboxes. The reauthorize URL carried `scope = drive.file drive openid email profile gmail.modify`, `prompt=consent`, `access_type=offline`. |
| Clerk callback (built-in browser) | Attempt 1 bounced into the accounts.dev hosted sign-in loop; attempt 2 (fresh tab, refreshed `__session`) returned `oauth_callback?err_code=authorization_invalid` (403). A control reauthorize with only `drive.file` failed the same way, so the failure is the pane's Clerk callback, not the scope. |
| Clerk callback (Path B CDP Chrome) | Sign-in succeeded there, but that Chrome profile was in use by another session's token flow, so the runner stopped. |
| Google-side residual | USER_A's grant to the dev client now shows "6 services" (full Drive was recorded on attempt 1). Clerk's refresh token predates it, so every token FGAC mints for USER_A is still the narrow baseline list. Functionally unchanged; cosmetically wider on `myaccount.google.com/permissions`. Not revoked, because "Remove access" drops every scope at once and the reconnect path was failing. |
| Alternative route | Obtaining a `drive`-only token from Google's OAuth Playground was refused by the session's permission classifier (reading an access token out of a page), so it was not attempted. |

Fixtures left in USER_A's My Drive for a retry: folder "FGAC folder-grant
probe 2026-09-17" containing two Sheets, one Doc ("probe-doc-1", body
"baseline text") and one Slides deck. Two third-party Sheets sit in Shared
with me, which is what question (5) below needs.

## Unmeasured, and what a retry needs

1. `drive` alone reads and writes Sheets and Docs — unmeasured.
2. A separate Sheets/Docs scope is needed — unmeasured (documentation says no).
3. Slides — unmeasured beyond the baseline 404; FGAC's GCP project also has
   the Slides API disabled (`SERVICE_DISABLED`), which is independent of scope.
4. Shared files bounded by USER_A's own Drive permission — unmeasured.

Retry path (about fifteen `fetch` calls once a token exists): a person signs in
to the local dashboard as USER_A in a normal browser and runs the reauthorize
snippet above once; Clerk then holds a `drive`-scoped refresh token and the
runner reads tokens through `/api/auth/google-picker-token` from the dashboard
tab in the built-in browser, which worked throughout. Afterwards restore the
narrow grant (Google "Remove access" for the dev client, then dashboard
Reconnect) so other QA runs keep the `drive.file` baseline.

## Collateral to know about

The runner restarted the shared Path B Chrome twice, closed three stale
accounts.dev tabs, killed five orphan daemons, and switched that profile's
Clerk session from USER_B to USER_A before noticing another session's flow was
running in it. That session's token flow will mint for USER_A until it signs
in again.
