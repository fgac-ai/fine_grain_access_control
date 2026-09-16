# MCP Drive per-file guard + deletion invariant — implementation plan v1

Branch: `claude/mcp-drive-perfile-guard` (based on
`claude/fgac-drive-oauth-scope-a4c435`, PR #143, still open at branch time) ·
Date: 2026-09-16

Closes the two "Out of scope" items of
`claude_fgac-drive-oauth-scope-a4c435_v1.md`.

## Item 1 — id-addressed Drive calls on the MCP route bypassed per-file rules

### Problem

`classifyGoogleApiCall` sent `drive/v3/files/{id}` PATCH/PUT, `…/permissions`
POST, `/revisions`, `/export`, `/watch` (everything id-addressed except
`/comments` and `/copy`) to `passthrough`, and the passthrough branch forwards
with no rule lookup. The REST proxy has required a sheets/docs rule for any
`drive/v3/files/{id}` call since the Drive guard landed. Verified locally
2026-09-16: a spreadsheet whose rule was Blocked could be trashed via
`PATCH drive/v3/files/{id} {"trashed":true}` through the MCP route; in
production an agent renamed, shared and trashed files as passthrough.

### Change

1. **Classifier** (`googleApiPolicy.ts`): new kind
   `drive_file { fileId, isMutating }` for any `drive/v3/files/{id}…` path
   (canonicalized bare spelling and `upload/` media-update variant included)
   that is not `/comments` (→ `file_comments`) or `/copy` (→ `drive_copy`).
   `generateIds` in the id slot, listing (`GET drive/v3/files`), `about`,
   `changes`, `drives` stay `passthrough` — discovery is never gated.
   `rawApiFamily` reports `drive/v3`.
2. **Route** (`route.ts`): `checkDriveFilePermission` split into
   `driveFileKindFromRules` + `checkResolvedDriveFile` (behaviour unchanged for
   copy/comments callers); new `checkDriveFileAccess` for the `drive_file`
   branch. Rule-resolved files run the standard `checkFilePermission`
   (Blocked denies; mutations need Read & Write; reads pass with any rule) with
   `withGrantGrace` and `fileGrantErrorResult` on the Google leg, exactly like
   the sheets/docs branches.
3. **No-rule policy (decided here).** The proxy denies files no rule names;
   the MCP route instead resolves the kind with one metadata GET
   (`?fields=mimeType`, the account's own token):
   - Sheets/Docs mimeType → `checkFilePermission` not-exposed denial **with an
     approval link** for the denied level (read → `*_expose`, write →
     `*_write`), `drive_file_gate: 'mime_gated'`. This is the branch that
     closes the observed hole.
   - any other mimeType → forwarded under `drive.file` as before
     (`drive_file_gate: 'mime_other'`, `raw_api_passthrough: true` kept).
     Rationale: FGAC has rule types only for Sheets and Docs; a flat denial
     would strand every other kind forever — the agent's own `text/plain`
     creations (A13, `file_created_kind: 'other'`), user-picked PDFs, Slides
     until that kind ships. Google's per-file grant is the gate there, and
     `mime_other` volume is the demand signal for per-file rules on other kinds.
   - lookup 404 → the file is invisible to the token; answered with
     `passthroughErrorResult`'s id-addressed 🚫 `file_grant_missing_at_google`
     text without a second call (`drive_file_gate: 'invisible'`).
4. **Analytics** (`docs/analytics.md`): `drive_file` added to `raw_api_kind`;
   `drive_file_gate` documented; passthrough-id 404 wording and
   `file_grant_missing_at_google` unchanged. Historical `passthrough` rows with
   a `drive/v3/files/{id}…` template are this kind's pre-deploy volume.
5. **Tool catalog** (`toolDefs.ts`): `google_api_get` / `google_api_modify`
   descriptions state the real model (listing ungated; id-addressed Drive calls
   follow the file's rule; other kinds ride `drive.file`) and link the Drive API
   docs; both stay under the 1500-char lint cap.
   `get_my_permissions.defaults.rawApi` updated to match.
6. **Docs**: `distribution_architecture.md` bullets; QA capability 10 A3/A13
   notes and new **A14**; hosted-MCP runbook lines for A13/A14.

## Item 2 — "DELETE is never available" rested on the method enum alone

### Invariant

Deletion is never forwarded by any tool. It is now enforced at four layers,
all derived from one constant, and pinned by
`scripts/test-raw-method-guard.ts` (in `npm run mcp:lint`, hence `npm run
build`):

| layer | mechanism |
| --- | --- |
| constant | `RAW_READ_METHODS = ['GET']`, `RAW_MODIFY_METHODS = ['POST','PUT','PATCH']` in `googleApiPolicy.ts` |
| tool schema | `google_api_modify` `method: z.enum(RAW_MODIFY_METHODS)` — the SDK rejects DELETE before the handler runs (tested through a real in-memory MCP server/client) |
| catalog | `TOOL_DEFS.*.freeformMethods` are the constants by identity; `mcp-tool-lint` still forbids DELETE there |
| classifier + executor | `classifyGoogleApiCall` returns `denied` / `raw_api_method_unsupported` for any other method before account resolution; `executeRawGoogleCall` re-checks with `isForwardableGoogleMethod` as the last line before the network call |

Why Google would not backstop a slip: `drive.file` accepts `files.delete`
(permanent, bypasses trash) on every app-created or user-picked file, and
`files/trash` (emptyTrash) is DELETE-only. Gmail `messages/batchDelete` stays
refused by path (`gmail_write_unsupported`).

`get_my_permissions.defaults.deletion` now says DELETE is rejected by the
schema and again server-side; the reversible alternatives (trash) are named in
the denial text.

## Validation

- `npm run mcp:lint` — new classifier cases (drive_file, generateIds/list
  stay passthrough, method gate) and `test-raw-method-guard.ts` all pass;
  `tsc --noEmit` and eslint clean.
- Local MCP run of capability 10 A14 via a `qa-setup-driver` runner (bearer
  minted with the manual DCR recipe, dev server on an autoPort): 23/23 rows
  PASS on 2026-09-16 — Read & Write rename/trash/untrash/share/export/
  revisions succeed; Read Only trash denied with a `sheets_write` link;
  Blocked denied with no link; a no-rule sheet denied not-exposed with
  `sheets_write` / `sheets_expose` links via the `mime_gated` branch and NOT
  trashed at Google; a nonexistent id gets the invisible-file 🚫; listing and
  `generateIds` pass; raw JSON-RPC DELETE is rejected by the schema
  (`-32602 … expected POST|PUT|PATCH`); copy and comments regressions hold.
  Observation, pre-existing and cosmetic: denial approval links use the
  configured dashboard URL (`localhost:3000`) rather than the autoPort.
- Preview run of the same matrix via `/deploy-pr-preview` (PR #147).

## Out of scope

- Per-file rules for non-Sheets/Docs kinds (Slides, PDFs) — `mime_other`
  counts are the demand signal.
- Aligning the REST proxy's flat no-rule denial with the MCP route's
  mimeType resolution.
