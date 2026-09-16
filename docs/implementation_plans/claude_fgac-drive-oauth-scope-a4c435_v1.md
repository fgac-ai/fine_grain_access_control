# Drive copy/create auto-grant — implementation plan v1

Branch: `claude/fgac-drive-oauth-scope-a4c435` · Date: 2026-09-16

## Problem

On 2026-09-16 (claude-code client, one production account) the agent ran
`POST drive/v3/files/{id}/copy` on two sheets it had created earlier, was
denied `sheets_not_exposed` when it wrote cells in a copy, and then renamed,
shared (`POST …/permissions`) and trashed (`PATCH {trashed:true}`) both copies
— every Drive call landed as `raw_api_passthrough: true, outcome: success`.

Root cause is FGAC-side, not Google-side:

- Google's `drive.file` scope is per-file by **provenance**: any file the app
  created or the user picked is fully writable (files.update, permissions.create,
  files.copy, and files.delete all list `drive.file` as an accepted scope). A copy
  the app makes is an app-created file, so Google authorised every Drive write.
- FGAC's auto-grant (`sheets_create` / `docs_create` in `route.ts`) only fires for
  `POST v4/spreadsheets` and `POST v1/documents`. `files/{id}/copy`,
  `POST drive/v3/files`, and the `upload/` variant classify as `passthrough`, so no
  rule is written. The file is app-owned at Google and unknown to FGAC's rule
  table: Drive calls pass, Sheets/Docs content calls deny.

## Change

1. **Classifier** (`src/app/api/mcp/googleApiPolicy.ts`): two new kinds.
   `drive_copy { fileId }` for `POST drive/v3/files/{id}/copy`; `drive_create` for
   `POST drive/v3/files` (bare or `upload/`-prefixed). Both report family `drive/v3`.
   Drive listing (GET), `PATCH files/{id}`, and `permissions` stay passthrough.
2. **Kind descriptor** (`src/lib/driveFileKinds.ts`): `mimeType` and
   `createdAnalytics { event, idProp, toolCallProp }` per kind, plus
   `kindForMimeType()`. Shared code keys off the descriptor, per the module's rule.
3. **Route** (`src/app/api/mcp/route.ts`):
   - `autoGrantAgentCreatedFile(conn, keyId, kind, id, title, origin)` — the
     rule+assignment insert and analytics that `sheets_create` / `docs_create`
     each inlined before; both now call it with `origin: 'create'`.
   - `grantDriveCreatedFile()` reads `id/name/mimeType` from the Drive File
     response, fetches metadata when a `fields` mask stripped `mimeType`, maps the
     mimeType to a kind, stamps `file_created_kind` (`sheet` / `doc` / `other`),
     and grants Read & Write for sheet/doc. Other mime types stay ungated.
   - `drive_copy` branch: id shape check → `checkDriveFilePermission` (renamed
     from `checkCommentsPermission`; same logic) with `isMutating: false` — the
     **source** must be exposed to the key (Read Only suffices, Blocked denies;
     unexposed sources deny with the standard not-exposed message) → grant-grace
     fetch → `fileGrantErrorResult` on 403/404 → auto-grant the copy `origin: 'copy'`.
   - `drive_create` branch: forward, then auto-grant `origin: 'drive_create'`.
   - `get_my_permissions.defaults.rawApi` names the two new create paths.
4. **Tool description** (`toolDefs.ts` google_api_modify): create list now includes
   `POST drive/v3/files` and `files/{id}/copy` with the source-exposure rule.
5. **Analytics**: `agent_sheet_created` / `agent_doc_created` gain `origin`
   (`create` | `copy` | `drive_create`); `$mcp_tool_call` gains
   `file_created_origin` and `file_created_kind` on these calls.

## Design decisions (confirmed with Ken 2026-09-16)

- A copy is a **read** of the source: a Read Only rule on the source allows it.
  The copy is the agent's own output and gets Read & Write, like a created file.
- Copies of files with **no** FGAC rule are now denied (previously scope-backstop
  passthrough). This matches the REST proxy, which already gates
  `drive/v3/files/{id}` on a sheets/docs rule.
- Out of scope, flagged for a follow-up: the MCP passthrough for
  `PATCH drive/v3/files/{id}` and `POST …/permissions` still has no per-file
  guard, unlike the REST proxy. "DELETE is never available" continues to rest on
  the `POST/PUT/PATCH` method enum alone; `drive.file` would honour
  `files.delete` on app-owned files.

## Validation

- `npx tsx scripts/test-google-api-policy.ts` — new cases for copy / create /
  bare-spelling copy / list-stays-passthrough / PATCH-stays-passthrough / family.
- Local MCP run (capability 10 A13): copy of an exposed sheet succeeds and the
  copy is immediately writable via `sheets_update_range`; copy of a blocked or
  unexposed file is denied; `POST drive/v3/files` with the Sheets mimeType is
  auto-granted; a PDF create is `file_created_kind: 'other'` with no rule.
