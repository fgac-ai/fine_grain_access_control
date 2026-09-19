# Spike — full `drive` scope: does it read and edit Sheets/Docs/Slides alone?

Date: 2026-09-17 (attempt 1, incomplete) and 2026-09-18 (attempt 2, complete) ·
Environment: local dev server, dev Clerk instance, dev Google OAuth client, QA
account USER_A · Runner: `qa-setup-driver` · Plan:
`docs/implementation_plans/claude_great-dhawan-c05848_v6.md`

## Verdict

**Yes. The full `drive` scope alone reads and writes Google Sheets, Docs and
Slides. No `spreadsheets`, `documents` or `presentations` scope is needed.**
Access is bounded by the user's own Drive permission per file (a read-only
shared Sheet reads 200 and writes 403), and whole-Drive listing works. Under
`drive.file` the same un-picked files stay 404.

The question (Ken, 2026-09-17): if a user grants FGAC the full `drive` scope,
can FGAC read and edit every Google Sheet and Doc they can reach, and is a
separate Sheets / Docs / Slides API scope needed?

## Method

1. Baseline token from `/api/auth/google-picker-token`, scopes read from
   Google's tokeninfo endpoint.
2. Grant widened through FGAC's own mechanism, the Clerk external account's
   `reauthorize({ additionalScopes: ['…/auth/drive'], oidcPrompt: 'consent' })`
   (the same call `src/app/dashboard/googleReconnect.ts` makes), consent
   driven in the Path B Chrome (Clerk's OAuth callback fails in the built-in
   pane with `authorization_invalid` 403, also for a plain `drive.file`
   reconnect; it succeeds from a normal Chrome).
3. Twelve API calls with the widened token against user-created probe files
   in USER_A's My Drive that FGAC had never touched (folder "FGAC
   folder-grant probe 2026-09-17": two Sheets, one Doc with body "baseline
   text", one Slides deck) and against files in Shared with me.
4. Every write reverted, then the grant restored: Google account permissions
   → "Dev FGAC AI" → Remove all access, then `reauthorize` with no extra
   scopes and `prompt=consent`.

## Token scopes (tokeninfo)

| stage | scope |
| --- | --- |
| baseline | `drive.file`, `gmail.modify`, openid / email / profile |
| widened | baseline **plus `https://www.googleapis.com/auth/drive`** |
| restored | identical to baseline |

No Sheets, Docs or Slides scope was present at any stage. Clerk's
`verification.status` stayed `verified` throughout, so the in-place reauthorize
path applied and the destroy-and-recreate branch was never entered.

## Consent wording

Attempt 1 showed the new line exactly once: "See, edit, create, and delete all
of your Google Drive files", with no per-scope checkboxes. Attempt 2 (Google
already remembered the scope from attempt 1) showed the summary form "already
has some access — see the 6 services". The restore consent showed checkboxes
for `drive.file` and Gmail only.

## Results with the `drive` token (ids redacted)

| # | call | HTTP | summary |
| --- | --- | --- | --- |
| 1 | `files.list` `'<folder>' in parents` | 200 | 4 children (Doc, Slides, both Sheets) — under `drive.file` the same call listed only the app-visible deck |
| 2 | `spreadsheets.get` child-1 | 200 | title |
| 3 | `values.update` A1 | 200 | 1 cell updated |
| 4 | `values.get` A1 | 200 | value read back |
| 5 | `spreadsheets.batchUpdate` addSheet, then deleteSheet | 200 / 200 | tab created and removed |
| 6 | `documents.get` doc-1 | 200 | title |
| 7 | `documents.batchUpdate` insertText | 200 | 43 chars inserted |
| 8 | `documents.get` body | 200 | inserted text followed by "baseline text" |
| 9 | `presentations.get`, `presentations.batchUpdate` createSlide | 200 / 200 | slide created (dev GCP project has the Slides API enabled) |
| 10 | `files.list` `sharedWithMe` with `capabilities` | 200 | 5 items; one Sheet `canEdit: false`, one Sheet `canEdit: true`, a folder and two non-Google files |
| 11 | read-only shared Sheet: `spreadsheets.get`, then `values.update` ZZ999 | 200 / **403** | `PERMISSION_DENIED — The caller does not have permission`; `canEdit` predicts it. Editable shared Sheet: title read only, no write attempted |
| 12 | `files.list` pageSize 1, `about` storageQuota | 200 / 200 | whole-Drive listing works |

Revert: A1 cleared (200), deleteContentRange (200, body back to "baseline
text"), deleteObject for the slide (200), tab already removed.

## Restore

Google account permissions listed "Dev FGAC AI" with `drive.file`, Gmail and
full Drive; "Remove all access" removed the entry (the production app's entry
untouched). The plain reauthorize then re-consented `drive.file` + Gmail.
Verified: Clerk `approvedScopes`, fresh tokeninfo without bare `drive`,
`hasDriveFileScope: true`, and the folder listing back to the single
app-visible file. Final state of USER_A: `drive.file` + `gmail.modify` on a
fresh refresh token, Google-side grant exactly those scopes, probe files left
in place and clean.

## What this settles for the plan

- Design C/D need only `drive` (or `drive.readonly` for read paths); the
  content-API scopes add nothing.
- Slides is scope-agnostic in the same way. (An earlier draft of this doc said
  the production GCP project had the Slides API disabled; that was true until
  2026-09-16 and is stale — production Slides calls succeed since the Slides
  release on 2026-09-17, per `$mcp_tool_call` data on 2026-09-18.)
- Google enforces the user's own sharing permission underneath any FGAC rule;
  FGAC's rule engine would be the only gate *within* what the user can reach.
- The incremental-consent mechanism works end to end on the dev client with
  one extra consent line and no console change, though a restricted scope
  would still need verification before production users see it without the
  unverified-app screen.

## Harness notes

- Built-in pane: dev server only. Path B (Playwright CLI on the CDP Chrome,
  port 9222): sign-in, consent, all API calls, the Google permissions page.
- Attempt 1 also left a Google-side residual (full Drive recorded before the
  Clerk callback failed) that attempt 2's restore cleared, and it disturbed a
  shared Path B Chrome another session was using; run this kind of spike only
  when no other agent holds that browser.
