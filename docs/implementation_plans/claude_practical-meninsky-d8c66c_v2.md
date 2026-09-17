# Google Slides Support — Implementation Plan (v2)

**Branch**: `claude/practical-meninsky-d8c66c` · **PR**: #153
**Status**: Implemented; local QA run complete (0 fails); preview QA in progress.
**Supersedes**: `claude_practical-meninsky-d8c66c_v1.md` (design and spike findings
unchanged — read that for §0–§2). This revision records what the local QA run
and the eight-angle code review changed.

## 1. Review follow-ups shipped (commits `2e21b08`, `f485ae5`)

| finding | change |
|---|---|
| A production `SERVICE_DISABLED` 403 would have been answered as a missing Picker grant and looped the user through `/dashboard/slides-setup` (whose verify probe 403s the same way) | `fileGrantErrorResult` special-cases `reason === 'SERVICE_DISABLED'` (new `denial_code=api_disabled`, names the product API and support@fgac.ai, no setup link); `verifyFileGrant` reports it as `unknown`, never `missing`, so no chip/recovery page claims a pick will fix it |
| `..` path segments (plain or `%2e`) let the per-file check authorize one id while the URL parser fetched another — pre-existing on main, on both the MCP raw tools and the REST proxy | `hasDotSegment` refuses them in the classifier (`raw_api_path_malformed`) and the proxy (400); three unit cases added |
| The rewritten proxy handler had its own kind detection (substring) and id regex (no bare spelling, unpinned version) — disagreeing with the MCP classifier | proxy now calls the classifier's `driveFileKindForPath` / `extractDriveFileKindId`; per-kind regexes compiled once with the descriptor's new `apiVersion` |
| Bare `presentations/{id}` spelling was accepted by the classifier but forwarded without a version segment (Google 400) — same for the sheets/docs bare spellings on main | `rawUrl` and the proxy insert `apiVersion` when the path lacks one; verified locally |
| Two untyped constructors for the approval-action union (casts could pair `slides_write` with `documentId`) | `approvalLinks.fileApprovalActionFor` is the one typed constructor (explicit per-kind switch, no casts); policy exports the level decision and delegates |
| `describeApproval` default branch could render a raw action slug on the consent page | exhaustive switch restored |
| Three Picker hook instances each injected `api.js` and a late mount could skip `gapi.load('picker')` | module-level `loadGapiPicker()` promise shared by every instance |
| `ExposedFilesManager.KIND_UI` re-hardcoded `grantPath`/`verifyPath`/`rulesKey` and grew three-way accent ternaries | reads the descriptor; per-kind class-name record |
| Dead `exposeSheetsFromPicker` / `exposeDocsFromPicker` server actions and `SHEET_ACTION_TYPES` | removed; `exposeFilesFromPicker(kind, …)` is the single action |
| `setupIdParam` string casts on the approve page; `'file'` pseudo-kind in `parseDriveFileId` | literal union in the descriptor; `null` means kind-agnostic id |
| Monitoring funnel queries filtered `sheets_*`/`docs_*` only | `slides_*` added to §7.13-era queries; §7.27 is the Slides-specific one |
| `comments_*` param docs named docs/sheets only | name presentation ids too |

Accepted as-is (noted, not changed): the per-kind alias wrappers still used by
the sheets/docs typed tools (`checkSheetsPermission`, `withDocsGrace`, …);
the three thin `*-setup` pages; `SHEETS_GRACE_*` constant names; the
descriptor carrying UI fields (`tone`, `hasSetupVideo`) alongside API facts.

## 2. QA state

- **Local (dev server, hosted-MCP runbook, scoped 21 + 09/10/14/15/17/19):**
  76 pass, 0 fail, 4 skip, 13 blocked. Capability 21 A1–A10 and A13 pass;
  A14 skipped (Slides API enabled on the dev project).
- **Blocked, and why they matter:** the REST proxy assertions (21/A11,
  19/A11, and 09/A5–A7, which the runner ran over MCP instead of the proxy)
  because no `sk_proxy_` bearer could be materialized — the session's safety
  classifier denied both "Reveal Key" and reading a key from the branch DB.
  **The generic proxy handler therefore has no live-request coverage.** It
  now shares its parsing with the unit-tested classifier, which narrows the
  untested surface to the handler body itself. Grant-recovery A12 for
  docs/slides needs a Picker completion that both browser paths failed this
  session (Path B CDP attach exited after 30 s).
- **Coverage-auditor downgrades to note:** 14/A8 passed by analogy (no real
  Gmail read-block denial triggered); 19/A14 covered only 2 of 4 tiers;
  17/A6–A7 rode an account-level token expiry rather than a single stranded
  file.
- **Pre-existing bug found, not fixed here:** approving a write-upgrade link
  for a file that already has a Read Only rule inserts a second rule row
  instead of upgrading it (spawned as a separate task).

## 3. Before `/deploy-prod` (owner)

1. Enable the **Google Slides API** on GCP project **727876597677** (the
   production OAuth client's project). Until then every Slides call in
   production answers `api_disabled` (honest, non-looping, but unusable).
2. Optionally run the proxy assertions with a provisioned `sk_proxy_` key
   (`docs/QA_Acceptance_Test/capabilities/21_slides_management.md` A11 and
   `19_docs_management.md` A11).
3. Connector-directory listing update (tool count 19 → 21) after the API is
   live — see `docs/connector_submission/listing_copy.md`.
