# Drive tree: agent-created files stay writable for the creating profile — v1

> Renumbered on `integration/2026-10-05`: draft 22 **A21 → A23** (A21 is #181's, A22 #183's). References below use the original numbers.


Branch `claude/drive-tree-create-autogrant`. Bug found 2026-10-03 during local QA of
PR #179; it belongs to the feature-flagged Drive tree model (PR #177).

## Symptom
QA account with the `drive_tree` flag and the full `drive` scope, Default Profile drive
default **Read everything**. A file the agent creates (REST `POST drive/v3/files`,
`POST upload/drive/v3/files?uploadType=media|resumable`, MCP `google_api_modify POST
drive/v3/files`) is refused on a later rename/update: 403 "Read-only … by the profile's
default".

## Root cause (confirmed on main 9b55482)
1. **MCP** — `grantDriveCreatedFile` auto-grants only kinds with a per-kind rule model
   (`kindForMimeType` → Sheets/Docs/Slides). Every other kind (text, PDF, image, binary,
   folder) returned early, "left ungated". That was correct under `drive.file` (Google
   itself scoped the app to its own files) but under the tree engine every file is gated,
   so with no setting the profile default decides. Native kinds were unaffected: the
   per-kind rule they get is read by the resolver as a file-level setting.
2. **REST proxy** — no create auto-grant at all, and `proxyDriveTreeEngine` did not match
   `upload/drive/v3/files`, so upload paths skipped the engine entirely.
3. **Resumable uploads** — Google returns a session URI and no file; the bytes go straight
   to Google, so FGAC never sees the created id.

Reproduced as a failing unit test before the fix: with main's grant logic, the new
`agent-created files` block in `scripts/test-drive-tree-access.ts` failed 8 checks
(text/plain, octet-stream, PDF, PNG under Read; text under "Only files I allow"; file-level
decision; tree rule in tree mode; folder node) while the three native kinds passed.

## Fix
- `src/lib/agentCreatedFiles.ts` (pure): `agentCreatedGrant(mimeType, treeActive)` —
  native kinds keep the per-kind Read & Write rule (works with the flag on or off); other
  kinds get `service: 'drive'`, `drive_read_write`, `target_kind` `file` (or `folder`)
  in tree mode only. Plus `createdDriveFileFromBody`, `isDriveCreatePath`,
  `isResumableInitiation`, `injectCreateId`.
- MCP `grantDriveCreatedFile`: writes the tree rule for non-native kinds when the engine is
  active; stamps `drive_tree_auto_granted`.
- REST proxy: engine matches `upload/drive/v3/files`; after a 2xx POST create (metadata,
  media/multipart upload, or `files/{id}/copy`) the created file is granted to the key
  (`drive_file_auto_granted` event). Resumable initiations are pre-named: one
  `files.generateIds` call, the id injected into the initiation metadata, granted once
  Google accepts the initiation. A caller-chosen `id` is never adopted (it could name an
  existing file and hand the agent Read & Write on it) — the upload proceeds ungranted.

## Decisions to flag
- **Agent-created folders** get a folder-level Read & Write setting, which the tree
  inherits to everything inside — including files the user later moves in. Treated as
  intent (the user moved them into the agent's folder); revisit if that reads wrong.
- **A dangling rule** is possible when a resumable session is initiated but never
  completed (rule for an id that never materialises). Harmless — fresh random id.

## Out of scope (noted)
- REST proxy with the flag OFF still has no create auto-grant (legacy `drive.file` users
  hitting REST creates get "not exposed" on the follow-up). Same helper applies.
- REST `files/{id}/copy` is gated as a write on the source (the MCP route requires Read).
- MCP resumable uploads: the MCP tool has no way to hand back the session URI.

## Validation
Unit: `npm run mcp:lint` green (includes `test-drive-tree-access.ts`). Typecheck clean.
Local + preview: capability 22 A21 (new) and A14/A15 — results recorded below.

### Local results (2026-10-05, dev server with FGAC_DRIVE_TREE=1, USER_A full `drive` scope)
- First run BLOCKED: USER_A's dev grant had narrowed to `drive.file` (engine inactive) — re-enabled via A3.
- A3 pass. A21 pass — MCP media + metadata creates and renames 200; REST metadata, media
  and resumable creates and renames 200; each new id has a `drive` / `drive_read_write` /
  `file` rule assigned to the key; the never-created control is still denied "Read-only …
  by the profile's default" on both surfaces. A14 pass (Sheet created inside a Blocked
  folder is writable; the folder itself stays invisible). A15 pass (identical denial text).
- A proxy batch run while another session's sign-in had narrowed the grant was discarded and re-run.
- Not verified locally: the `rule_match_level` / `drive_tree_auto_granted` /
  `drive_file_auto_granted` analytics props (dev logs do not carry them; no PostHog query path).
- Observation: the tree card's override count includes the agent-created files' auto-grants
  (5 after the run). Visible by design (the user can see what the agent made), but it grows.
