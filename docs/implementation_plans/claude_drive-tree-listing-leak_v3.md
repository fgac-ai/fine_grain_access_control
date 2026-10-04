# Drive tree: no unfiltered discovery path — v3

Branch `claude/drive-tree-listing-leak`. Security fix for the feature-flagged
Drive tree engine (PR #177). Found 2026-10-03 by an adversarial code review
(code reading, not reproduced in production).

## Problem

With the `drive_tree` flag on and the full `drive` scope, the engine withheld
Blocked files from Drive listings only when the path was exactly
`drive/v3/files` (MCP: a regex in the `passthrough` branch; REST proxy:
`isDriveListPath`). Every other listing-shaped Drive read went to Google
unfiltered and returned names, `thumbnailLink` and `exportLinks` of Blocked
files:

| path | MCP | REST proxy |
| --- | --- | --- |
| `drive/v3/files/` (trailing slash) | passthrough, unfiltered | Next may 308 to the filtered path; not guaranteed |
| `drive/v2/files` | passthrough, unfiltered | engine built, but not filtered |
| `drive/v3/changes`, `drive/v2/changes` | passthrough, unfiltered | engine not even built (`drive/v[23]/files` only) |
| `drive/v2/files/{folder}/children` | passthrough (v2 ids were never gated) | gated on the folder, child ids returned |
| `drive/v3/drives`, `drive/v3/teamdrives` | shared-drive names, unfiltered | same |

Found while reading the classifier: `drive/v2/files/{id}` (including
`?alt=media` and exportLinks) was unknown-family passthrough in the MCP
classifier — not gated per file at all, flag or no flag. The REST proxy has
always gated v2 ids.

## Fix

1. **Shared discovery classifier** — `classifyDriveDiscovery(path, method)` in
   `src/lib/driveTreeAccess.ts`, called by both surfaces when the engine is on.
   Fail-closed allowlist:
   - `GET drive/v3/files` (any spelling) → filtered through the lineage
     resolver (existing `filteredDriveListing` / `proxyFilterDriveListing`).
   - `GET drive/v3/drives` → Blocked shared drives withheld (`filterSharedDrives`,
     settings only — a shared drive is a root).
   - `GET drive/v3/drives/{id}` → denied `drive_blocked` when that drive is
     Blocked, decided before any Google call.
   - `about`, `changes/startPageToken`, `apps`, `files/generateIds` → pass.
   - id-addressed file calls → `null` (the per-file guards gate them).
   - everything else (changes v2/v3 and `changes/watch`, v2 files list, v2
     `children`, `teamdrives`, v2 `drives`, unknown endpoints) → refused with
     guidance to use `GET drive/v3/files` (children → `'<id>' in parents`,
     changes → `orderBy=modifiedTime desc`). MCP `denial_code:
     drive_discovery_unfiltered`; REST 403.
   Refusing rather than filtering changes/v2 keeps the surface small: their
   response shapes differ (`items`, `change.file`, `childReference`) and
   agents have a filtered equivalent for each.
2. **One spelling per Drive path** — `canonicalizeGoogleApiPath` drops a
   trailing slash and collapses repeated slashes on `drive/` and
   `upload/drive/` paths. The REST proxy now canonicalises `fullPath` too, so
   its guards and the forwarded URL agree (`files//{id}` can no longer miss
   the id guard; bare `v3/files/…` now reaches Drive and is guarded).
3. **v2 ids gated** — the MCP classifier's `drive_file` match is
   `drive/v[23]/files/{id}`.
4. REST engine is built for every `drive/` path, not only `drive/v[23]/files`.
5. `get_my_permissions` tree-mode text tells agents which listing to use.

## Tests (written first, commit 9815b65)

- `scripts/test-drive-tree-access.ts`: discovery classification for every
  path above, shared-drive filtering, and a static wiring check that both
  routes call `classifyDriveDiscovery` and the exact-path matchers are gone.
- `scripts/test-google-api-policy.ts`: canonicalisation and v2 `drive_file`.

## Docs

- `docs/analytics.md`: `drive_discovery_unfiltered`, drives listing props.
- Capability draft 22 gains A21 (every discovery path, MCP + REST).

## Out of scope (flagged separately)

Delegated mailboxes skip the tree engine. If the delegating owner's token
carries the full `drive` scope, the legacy path (which assumes `drive.file`)
leaves listings unfiltered and lets non-Sheets/Docs/Slides files through.
Spawned as its own task.

## Validation

- Unit: `npm run mcp:lint`, `tsc --noEmit`, eslint clean.
- Local (dev server with `FGAC_DRIVE_TREE=1`, USER_A, Path B Chrome — the
  built-in pane refuses localhost): one folder set to Block, then every path
  below run through MCP `google_api_get` and the REST proxy with the Default
  Profile's key. Blocked file name absent from every listing/discovery body.

| path | MCP | REST |
| --- | --- | --- |
| `drive/v3/files?q=name contains '<blocked>'` | 200, 0 files, withheld 1 | same |
| `drive/v3/files/?q=…` (trailing slash) | 200, 0 files, withheld 1 | Next 308 → no-slash path → same filtered result |
| `drive/v3/files?q='<folder>' in parents` | 200, 0 files, withheld 4 | same |
| `drive/v2/files`, `drive/v3/changes`, `drive/v2/changes`, v2 `children`, `teamdrives` | 🚫 refusal pointing at drive/v3/files | 403, same text |
| `drive/v3/changes/startPageToken`, `drive/v3/about` | 200 | 200 |
| `drive/v2/files/<blocked id>`, `drive/v3/files/<blocked id>` | 🚫 Blocked (identical) | 403, same |
| `drive/v3/drives` | 200 (QA account has no shared drives) | same |

  Cleanup: folder back to Inherit, listing returns the file again.

Observations (not changed here):
- A per-id read of a Blocked file names the file and the blocking folder in
  the denial — pre-existing PR #177 wording, reachable only by a caller that
  already holds the id.
- Shared-drive Block was not exercised live (no shared drive on the QA
  account); covered by unit tests.

- Preview (PR #181, commit 987879b, flag `drive_tree` from PostHog, USER_A,
  built-in browser end to end): the identical matrix on MCP and REST, same
  outcomes as local — filtered listings withheld the Blocked file (withheld 1
  / 4), changes / v2 / children / teamdrives refused with the drive/v3/files
  guidance, about and startPageToken answered, v2 and v3 by-id reads denied
  Blocked. The Blocked file name appeared only in the by-id denial text.
  USER_A's preview grant was re-widened to the full `drive` scope first (the
  enable card showed). Cleanup: folder back to Inherit, file listed again.
  A DCR client "FGAC QA drive-tree preview" stays connected to USER_A's
  Default Profile on the preview DB.
