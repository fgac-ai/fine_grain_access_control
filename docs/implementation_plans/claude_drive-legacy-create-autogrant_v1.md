# REST proxy Drive parity with MCP (per-file model) — v1

Branch: `claude/drive-legacy-create-autogrant`, stacked on
`claude/drive-tree-create-autogrant` (4a535a2 — not yet on main; it introduced
`grantProxyCreatedFile` and `src/lib/agentCreatedFiles.ts`, which this change
generalises). Land both together.

## Problem

With the `drive_tree` flag OFF (the per-file `drive.file` model every user but
the QA account is on), the REST proxy disagreed with the MCP route on three
Drive calls:

| call | MCP route | REST proxy (before) |
| --- | --- | --- |
| `POST drive/v3/files`, `upload/drive/v3/files`, `files/{id}/copy` creating a Sheet/Doc/Slides | auto-grants a per-kind Read & Write rule (`grantDriveCreatedFile`) | wrote nothing → the next id-addressed call on the agent's own file denied "not exposed" |
| `POST files/{id}/copy` | Read on the source suffices (a copy is a read) | counted as a WRITE on the source → Read Only sources refused; same bug in tree mode |
| id-addressed call on a file no rule names | asks Google the mimeType: Sheets/Docs/Slides → not exposed, anything else → forwarded under drive.file (`checkDriveFileAccess`) | flat "not exposed" → the agent's own text/PDF creations stranded |
| `upload/drive/v3/files/{id}` (media update of an existing file) | gated like any `drive_file` call | never matched the guard's `^drive/` regex → **ungated in both modes** |
| `files/{id}/comments` on a file no rule names | not exposed (`file_comments`) | not exposed (kept; classified as `comments` so the new mimeType passthrough never applies) |

## Decision: parity with MCP

- Creates: `agentCreatedGrant(mimeType, treeActive)` on both modes. Per-file
  model → Sheets/Docs/Slides only (non-native kinds get no rule, exactly like
  MCP). Resumable initiations are pre-named in the per-file model only when
  the metadata names a native kind, so ordinary uploads are untouched.
- Copy: classified separately (`classifyProxyDriveCall` → `copy`) and gated as
  a read of the source in both modes. Per-file model: an unruled source is
  "not exposed" whatever its kind (MCP `checkDriveFilePermission` parity).
- No-rule id-addressed calls: one metadata GET with the owner's token
  (`legacyUnruledDriveDecision`): native → "not exposed", other → forward,
  Google 4xx/5xx → Google's own answer with nothing forwarded.
- `upload/` media updates of an existing file are now gated.
- Telemetry: `proxy_request.drive_file_gate` (same values as MCP);
  `drive_file_auto_granted.drive_tree`.

## Known shared edge (not changed here)

The "other kinds ride drive.file" passthrough assumes the token is `drive.file`.
A flag-OFF user who still holds the full `drive` scope (flag rolled back after
opting in) would have every non-native file reachable by id on BOTH surfaces —
MCP has had this since 2026-09-16. Only flagged users can acquire `drive`
today, so the population is the QA account. Worth a follow-up: treat a
flag-off `drive` token as tree-engine-or-deny.

## Files

- `src/lib/agentCreatedFiles.ts` — `classifyProxyDriveCall`,
  `legacyUnruledDriveDecision`, `createMetadataMimeType`.
- `src/app/api/proxy/[...path]/route.ts` — guard rewrite, `fetchDriveMimeType`,
  token memo, `grantProxyCreatedFile(token, treeActive, …)`.
- `scripts/test-drive-tree-access.ts` — "per-file (flag off) model — REST/MCP
  parity" block (18 checks).
- `docs/QA_Acceptance_Test/capabilities/10_raw_google_api.md` A16;
  `drafts/22_drive_tree_access.md` A22; `docs/analytics.md`.

## Validation

- [x] `npx tsx scripts/test-drive-tree-access.ts` — all pass.
- [x] `tsc --noEmit` (only pre-existing missing-module errors), eslint clean.
- [x] Local (2026-10-05, USER_B, flag off, `drive.file` token, Path B Chrome —
  the built-in pane refused localhost): A16 11/11 steps PASS. Rule rows
  confirmed read-only: "Agent-created: QA rest sheet" and "…copy of R" are
  `sheet_read_write` on the Default Profile; no row for the text note; no copy
  of B or of the other-key sheet N was created. Telemetry props
  (`drive_file_gate`, `drive_file_auto_granted.drive_tree`) not yet checked.
- [x] Local A22: BLOCKED locally (passed on the preview below) — USER_A (flag on) holds `drive.file` only (dashboard
  "needs re-enabling"); a concurrent session was mid drive-scope flow on the
  shared Chrome. Run on the preview once USER_A has the full scope.
- Note: the REST proxy cannot create a sheet via `POST v4/spreadsheets`
  (400 "Invalid Google Sheets API path" — the per-file handler requires an
  id). Pre-existing; creating through `POST drive/v3/files` works.
- [x] Preview (2026-10-05, PR #185 preview 45fx5vmkm, commit ff16996, Path B
  Chrome): A16 12/12 PASS as USER_B (flag off) — dashboard shows Read & Write
  rows for the created sheet and the copy of R, none for the text note; no
  copy of B or N created. A22 6/6 PASS as USER_A (flag on, full `drive`
  re-granted via the verified reauthorize branch): copy of a Read-default file
  200, rename of the copy 200, copy of a Blocked source 403 with no file
  created, source restored to Inherit. USER_A left with the full scope.
  Telemetry props not checked (no PostHog connector in this session).
- Findings outside this change (filed as follow-ups): the Drive card's
  "N overrides" counter excludes auto-granted file settings; the new-profile
  form can create a key with no mailbox and no way to add one later.
