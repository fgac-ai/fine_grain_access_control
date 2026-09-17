# Google Slides Support — Implementation Plan (v1)

**Branch**: `claude/practical-meninsky-d8c66c`
**Status**: Implemented on the branch; local QA in progress.
**Pattern source**: the Google Docs integration
(`google-docs-support-plan-b36c1c_v5.md`) and the `drive.file` kind
descriptor it introduced (`src/lib/driveFileKinds.ts`).

## 0. Why now

The 2026-09-17 daily review surfaced a healthcare customer who installed FGAC
himself and asked support "Any plans to add Google Slides access?". PostHog
(7 d) showed 4 `$mcp_tool_call` rows from 2 users on `raw_api_family='slides'`
(`GET slides/v1/presentations/{id}` and the bare `GET v1/presentations/{id}`
spelling), all `outcome=error`, `error_status=403`. The Docs feature laid the
pattern, and the `slide` descriptor entry was already fully written and
excluded only by `ACTIVE_DRIVE_FILE_KINDS`.

## 1. What the spike established (2026-09-17, local dev, USER_A)

Run by a `qa-setup-driver` runner against this worktree's dev server:

| question | answer | evidence |
|---|---|---|
| Is the 403 `SERVICE_DISABLED`? | **Not reproducible locally.** With USER_A's Clerk-issued Google token, `GET slides.googleapis.com/v1/presentations/<app-created id>` returns **200** directly from Google — the Slides API is **enabled on the dev GCP project 627660126377** (tokeninfo `aud`/`azp` prefix). | runner report, direct-to-Google control |
| Do dev and prod share a GCP project? | **No.** Production sign-in (`accounts.fgac.ai` → Google chooser, read-only) uses client id prefix **727876597677**. The recorded production 403s are consistent with the Slides API being disabled on **that** project only. | runner report, prod chooser URL |
| New OAuth scope needed? | **No.** The token's scopes are exactly `gmail.modify` + `drive.file` (+ identity), and it read an app-created presentation. Presentations behave like docs under `drive.file`. | tokeninfo scope list |
| Fixtures | app-created presentation (Drive-side create), a `POST slides/v1/presentations` create (auto-granted through the new `file_create` branch once the route compiled), and an external never-picked presentation created in the Slides UI. Ids live in the local QA state only. | runner report |

**Ken action (the first blocker for production):** enable the Google Slides
API on GCP project **727876597677** (the project behind the production OAuth
client; the dev project 627660126377 already has it). No consent-screen copy
changes — the scope set is unchanged, so no Google re-verification.

## 2. Design decisions

### D1 — Same `drive.file` + Picker mechanism, no new scope (as Docs D1)
Verified in §1. The Picker gets the `PRESENTATIONS` view from the descriptor.

### D2 — Slides is a descriptor entry, and the descriptor grows to absorb the ternaries
The Docs plan's acceptance test for the abstraction was "adding Slides touches
`driveFileKinds.ts`, tool defs/registrations, and QA docs — nothing else". In
practice the code had grown a dozen `kind === 'sheet' ? … : …` ternaries
(profile cards, approval flow, settling card, grant recovery, rule handlers,
server actions, approve page) that would have **silently treated a slide as a
doc**. Rather than grow them into three-way branches, every one was folded
into new descriptor fields:

`productName`, `shortNoun`, `idKey` (`spreadsheetId`/`documentId`/`presentationId`),
`requestTypes`, `grantAnalytics` (`*_grant_verification` / `*_grant_recovered`),
`rulesKey`, `grantPath`/`verifyPath`, `hasSetupVideo`, `apiHost`,
`apiCollection`, `apiPathPrefix`, `urlPathSegment`, `tools` (read/edit names),
`tone`, `createdFile(data)` (id + title out of a native create response),
plus lookup helpers `kindForActionType`, `kindForApprovalAction`,
`kindForRequestType`.

Sheets and Docs behavior is byte-identical: route paths, action names, param
names (`sid`/`did`), analytics event and prop names all come from the same
values that were previously hardcoded.

### D3 — Raw-call classification is generic: `file` / `file_create`
`RawCallClass` replaces `sheets`/`sheets_create`/`docs`/`docs_create` with
`{ kind: 'file', fileKind, fileId, isMutating }` and
`{ kind: 'file_create', fileKind }`, produced by one loop over
`ACTIVE_DRIVE_FILE_KINDS` keyed on the descriptor's `apiCollection`
(`spreadsheets` / `documents` / `presentations`). The route's per-kind
branches collapse to one each. `raw_api_family` for Slides becomes
**`presentations`** (the collection name, like `spreadsheets`/`documents`);
the passthrough era stamped `slides` — documented in `docs/analytics.md`.

### D4 — Typed surface: `slides_get_presentation` + `slides_edit`
Following Docs D4: the read returns the raw `presentations.get` resource
verbatim with the `fields` mask and the windowed envelope as size levers; the
edit is a byte-faithful `presentations.batchUpdate` passthrough under Read &
Write. No `slides_create` tool — creation is `google_api_modify POST
v1/presentations` (or a Drive-side create), auto-granted like sheets/docs.
Comments ride the existing `comments_read`/`comments_add` pair, which resolve
the kind from the file's rules. No read-back verification: the docs_edit
delete check is a Docs body-index concern with no Slides analogue.

### D5 — Raw-API behavior change
`slides/v1/…` and `v1/presentations` move from scope-backstop passthrough to
the enforced class: per-presentation rule required, denials mint
`slides_expose` / `slides_write` links. Strictly a tightening; nothing that
worked regresses (nothing worked in production — every call 403ed).

### D6 — Approval funnel
`slides_expose` / `slides_write` actions (`presentationId`), picker-first
approve flow, `/dashboard/slides-setup?pid=…` recovery, `request_access`
types `slides_read` / `slides_write`. `approvalLinks.ts` gained
`fileApprovalActionFor` / `approvalFileKind` / `approvalFileId` so the approve
page and server actions no longer enumerate actions.

### D7 — Proxy route
The duplicated Sheets and Docs handlers became one per-kind handler driven
by `apiCollection` / `apiHost` / `apiPathPrefix`; the Drive per-file guard
unions every active kind's rules. `proxy_request.service` gains `slides`.

## 3. Files

- `src/lib/driveFileKinds.ts` — descriptor fields above; `slide` active.
- `src/app/api/mcp/googleApiPolicy.ts` — generic `file`/`file_create`,
  `extractDriveFileKindId`, `fileApprovalAction`, descriptor-driven
  `parseDriveFileId` (wrong-kind refusal names the URL's product tools).
- `src/app/api/mcp/route.ts` — two Slides tools, `slidesFetch`, generic
  create/per-file branches and host routing, request_access, list_accounts,
  get_my_permissions, server instructions.
- `src/app/api/mcp/toolDefs.ts` — two defs; Sheets/Docs/Slides wording in the
  raw tools and request_access; `google_api_modify` trimmed under the
  1500-char lint cap.
- `src/lib/approvalLinks.ts` — slides actions + helpers.
- `src/app/api/proxy/[...path]/route.ts` — one per-kind handler.
- `src/app/api/rules/fileAccessHandlers.ts` + `grant-slides-access` /
  `verify-slides-access` routes.
- Dashboard: `AgentProfilesView.tsx` (cards iterate kinds; each card owns its
  Picker hook), `ExposedFilesManager.tsx`, `accounts/page.tsx`,
  `EditRuleButton.tsx`, `actions.ts` (`exposeFilesOfKindFromPicker`,
  `needsFileGrant` / `grantedFile`), `approve/page.tsx`,
  `FileApprovalFlow.tsx`, `ApprovedSettling.tsx`, `FileGrantRecovery.tsx`,
  `slides-setup/page.tsx`, `useGooglePicker.ts`, `loadDashboard.ts`.
- `src/components/ui.tsx` + `globals.css` — `slides` tone (amber).
- Tests: `test-google-api-policy.ts`, `test-approval-links.ts`,
  `test-drive-file-id.ts`; `mcp-tool-lint.ts` fallback map.
- Docs: `analytics.md`, `monitoring.md` (7.27), `user_guide.md`,
  `architecture_and_strategy.md`, `connector_submission/listing_copy.md`,
  site copy (`page.tsx`, `setup/page.tsx`, `docs/page.tsx`).
- QA: `capabilities/21_slides_management.md`, runbooks 01–04, `setup/03`,
  `10_raw_google_api.md`, `15_request_access_tool.md` (A9).

## 4. Testing & rollout

- Unit: `npm run mcp:lint` (policy, approval links, drive-file-id suites
  extended with Slides cases) — green.
- Local QA: capability 21 plus targeted re-runs of 09, 10, 14, 15, 17, 19
  (the generalization touches their code paths).
- `/deploy-pr-preview` → preview QA; user runs `/deploy-prod` **after**
  enabling the Slides API on 727876597677 — deploying first would turn every
  Slides denial into an honest per-file 🚫 that a Picker pick cannot fix.
- Connector-directory listing update is a follow-up (tool count 19 → 21),
  gated on the API being live in production.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Descriptor refactor regresses sheets/docs flows | Values are the previously hardcoded ones; unit suites cover the classifier and links; targeted QA re-run of 09/10/14/15/17/19 |
| Production Slides API still disabled after deploy | 7.27 query flags `SERVICE_DISABLED` explicitly; capability 21 A14 records it as `blocked`, never as a rule failure |
| `raw_api_family` rename (`slides` → `presentations`) splits historical queries | Documented in analytics.md; 7.27 queries both values |
| Read & Write on a deck is full-deck edit (batchUpdate can delete) | Rule UI copy mirrors the docs caveat; `slides_edit` is `destructive: true` |
