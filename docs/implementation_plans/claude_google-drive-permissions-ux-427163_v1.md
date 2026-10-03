# Drive tree access behind a feature flag — implementation plan v1

Branch: `claude/google-drive-permissions-ux-427163` · Date: 2026-10-01 · Design:
the Design canvas "Drive Agent Permissions UX" (claude.ai artifact
`RyWBmktumgMvSuG8RmEZvo`, versions 11–13: the Default Profile page, the search
flow, and the folder view with its breadcrumb inheritance chain).

Related: `docs/implementation_plans/claude_great-dhawan-c05848_v8.md` (PR #152,
the research plan this build implements the flag strategy of) and its draft
capability `docs/QA_Acceptance_Test/capabilities/drafts/21_drive_folder_rules.md`.

## What ships

A per-user feature flag that turns on a new way to scope Google Drive for an
agent profile: the profile has a **default** for every file in Drive (Read
everything · Read & write everything · Only files I allow) and any folder or
file can carry an **override** (Read · Write · Block) or **Inherit** from the
nearest ancestor that has one. The dashboard shows the user's Drive as a tree
(My Drive, Shared with me, Shared drives), with search across the whole Drive
and a folder view whose breadcrumb is the inheritance chain. The MCP server and
the REST proxy enforce the same model by resolving a file's folder lineage at
call time.

Everything is gated twice:

1. **Feature flag** (`src/lib/featureFlags.ts`): `FGAC_DRIVE_TREE=1` turns it on
   for everyone (local dev, previews); `FGAC_DRIVE_TREE_USERS` is a
   comma-separated allowlist of Clerk user ids and/or email addresses for a
   beta in production. Neither set → the flag is off and no new code path is
   reachable; the dashboard, the MCP route and the proxy behave byte-for-byte as
   today.
2. **The live token carries the full `drive` scope.** A flagged user whose grant
   is still `drive.file` sees the legacy per-file cards plus an "Enable full
   Drive access" card; the engine applies to a call only once tokeninfo reports
   `https://www.googleapis.com/auth/drive` (the pre-flight in
   `googleTokenScopes.ts`, which already decides from the token, never from
   Clerk's record).

**The new scope is requested only for flagged users.** The "Enable full Drive
access" button runs the existing in-place `reauthorize` (consent prompt) with
`[gmail.modify, drive]`, and the nav's Clerk `UserButton` adds `drive` to its
`additionalOAuthScopes` only when the signed-in user is flagged. Nobody else's
sign-in, reconnect or Picker flow mentions `drive`.

## Decisions carried over from plan v8, and the two it changes

| v8 (2026-09-20) | this build | why |
| --- | --- | --- |
| Default: read everything, write nothing; one-click "Full Drive access (read & write)" per profile | Same default. The one-click grant is the **Read & write everything** quick option, and a third option **Only files I allow** exists for users who want deny-by-default | The canvas Ken approved on 2026-09-30 shows three quick options; "defaults apply to everything everywhere, scope by setting My Drive itself" |
| Three-level depth cap on folder inheritance | **No cap** — the nearest setting wins however deep; a 25-hop safety limit denies `lineage_too_deep` | The UX promises "inherits from the first parent folder with a state applied"; a cap would make the breadcrumb lie. Cost is bounded by the lineage cache (one `files.get` per uncached ancestor, ~80 ms each) |
| Blocked anywhere in the chain wins | **Nearest wins**: a Write on a file inside a Blocked folder is allowed; a Block on a file inside a Write folder blocks | Same reason; the folder view explains the chain so a nearer setting is never a surprise |
| Rules as `access_rules` rows with `service='drive'` and `target_kind` | Same, plus `proxy_keys.drive_default` for the quick option | Reuses global/assigned scoping, `get_my_permissions`, and the approval-link flow unchanged |
| Flag = env `FGAC_DRIVE_RULES` + token gate + `FGAC_DRIVE_BETA_USERS` allowlist | Same shape, renamed `FGAC_DRIVE_TREE` / `FGAC_DRIVE_TREE_USERS` (ids **or** emails) | one switch per concern |

Legacy per-file rules (`sheet_read` … `slide_block`, written by the Picker, the
approval links and the agent-created-file auto-grant) keep working: they are
evaluated as **file-level settings** in the lineage walk, so nothing an existing
user set up changes meaning when their flag turns on.

## Data model (migration `0019_drive_tree_access.sql`)

- `proxy_keys.drive_default text` — `NULL`/`'read'` = Read everything,
  `'write'` = Read & write everything, `'explicit'` = Only files I allow.
- `access_rules.target_kind text` — `NULL`/`'file'` (every existing row),
  `'folder'`, `'shared_drive'`, `'shared_with_me'` (pseudo-root, id
  `shared-with-me`), `'shared_drives'` (pseudo-root, id `shared-drives`).
- New `service='drive'` rows with `actionType` `drive_read` /
  `drive_read_write` / `drive_block`, `targetResourceId` = the Drive node id,
  `resourceName` = its name, assigned to the profile through
  `key_rule_assignments` like every other rule (an unassigned drive rule is
  global, as today).

## Resolution (`src/lib/driveTreeAccess.ts`, pure; `src/lib/driveLineage.ts`, Google)

```
lineage(F)  = [F, parent(F), parent²(F), …, root]        // root: My Drive folder,
                                                          // a shared drive (then 'shared-drives'),
                                                          // or 'shared-with-me' when the top
                                                          // visible node has no parent and is not mine
for node in lineage, nearest first:
    settings = drive rules naming node (any level) ∪ legacy kind rules (file level only)
    if none → continue
    block present → deny drive_blocked          (reads too)
    write needed and no read_write → deny drive_read_only
    allow  (rule_match_level = file|folder|shared_drive|shared_with_me, lineage_hops = index)
default = proxy_keys.drive_default:
    'explicit' → deny as not_exposed (the expose link is offered, exactly as today)
    'read'     → reads allowed, writes deny drive_read_only
    'write'    → allow
```

- `files.get(id, fields=id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails, supportsAllDrives)`
  per hop, with an in-process cache per `(clerkUserId, fileId)` for 10 minutes
  (max 5,000 entries) and the user's My Drive root id cached the same way. A
  404 mid-chain (an ancestor the user cannot see) ends the chain at the
  `shared-with-me` pseudo-root; any other Google error fails closed with
  `lineage_unavailable`.
- Shortcuts are evaluated by their own id and place (never grant to the target).
  Multi-parent files use `parents[0]`.
- `$mcp_tool_call` gains `drive_tree: true`, `rule_match_level`,
  `lineage_hops`, `lineage_cache_hit`, and `denial_code` ∈
  {`drive_blocked`, `drive_read_only`, `<service>_not_exposed` (explicit
  default), `lineage_unavailable`, `lineage_too_deep`}.

## Enforcement doors

| door | today | with the engine active |
| --- | --- | --- |
| `checkFilePermission` (typed Sheets/Docs/Slides tools, comments, raw `file` kind) | per-file rules only | lineage walk; approval actions unchanged (`expose` / `write`), blocks mint none |
| `checkDriveFileAccess` / `checkDriveFilePermission` (id-addressed Drive calls, copy, comments) | per-file rules, else mime lookup, else passthrough for "other" kinds | lineage walk for **every** file kind (the mime comes from the same `files.get`); non-Sheets/Docs/Slides files get a plain denial without a link |
| raw `GET drive/v3/files` listing | passthrough | the `fields` mask is widened to carry `parents,driveId,shortcutDetails`, every returned file is resolved through the same walk, Blocked files are withheld and the response says `withheld: n` |
| REST proxy Drive-file guard and per-kind handlers | per-file rules | same resolver (shared module) with the key owner's token; identical denial text |
| `get_my_permissions` | per-kind "DENIED unless exposed" | `defaults.drive` names the profile default and lists every folder / root setting with its level |

The engine context (token, scopes, flag) travels on a second AsyncLocalStorage
store in `toolCallContext.ts`, set by `resolveAccountAndToken`, so no tool
signature changes and the token never enters the analytics bag.

## Dashboard

- `loadDashboard.ts` reports `driveTree: { flagOn, hasFullScope }` and each
  profile's `driveDefault`; `googleAccess` gains `driveFull`.
- `AgentProfilesView`: flag off → unchanged. Flag on and no `drive` scope →
  `EnableDriveAccessCard` above the legacy cards. Flag on and `drive` →
  `DriveAccessCard` replaces the three per-kind cards (legacy file rules show
  inside the tree as file-level settings).
- `DriveAccessCard` (client): quick options (radio cards), toolbar (search,
  overrides-only, legend), the tree with lazy children, search results with the
  full path and "Open folder" / "Show in tree", the folder view with the
  breadcrumb chain and the "this folder" strip, and the Inherit · Read · Write ·
  Block control on every row (saves on change, optimistic, rolls back on
  failure). Effective access is computed client-side from the profile's rules
  and the chain the UI already knows.
- `GET /api/drive/children?parent=root|shared-with-me|shared-drives|<id>` and
  `GET /api/drive/search?q=` (paths resolved server-side through the lineage
  cache). Both 404 unless the flag is on and the token carries `drive`.
- Server actions: `setDriveDefault`, `setDriveNodeAccess`, `clearDriveOverrides`.
- `layout.tsx`: `drive` in `UserButton.additionalOAuthScopes` for flagged users.

## Files

New: `src/lib/featureFlags.ts`, `src/lib/driveTreeAccess.ts`,
`src/lib/driveLineage.ts`, `src/app/api/drive/children/route.ts`,
`src/app/api/drive/search/route.ts`, `src/app/dashboard/DriveAccessCard.tsx`,
`src/app/dashboard/EnableDriveAccessCard.tsx`, `src/db/migrations/0019_*.sql`,
`scripts/test-feature-flags.ts`, `scripts/test-drive-tree-access.ts`,
`docs/QA_Acceptance_Test/capabilities/drafts/22_drive_tree_access.md`.

Changed: `src/db/schema.ts`, `src/lib/googleTokenScopes.ts`,
`src/lib/toolCallContext.ts`, `src/app/api/mcp/route.ts`,
`src/app/api/proxy/[...path]/route.ts`, `src/app/dashboard/{loadDashboard,
googleAccess,googleReconnect,actions,AgentProfilesView}.ts(x)`,
`src/app/dashboard/agents/[slug]/page.tsx`, `src/app/dashboard/page.tsx`,
`src/app/layout.tsx`, `.claude/launch.json` (a `fgac-dev-drive-tree`
configuration with the flag on), `scripts/env-check.ts`, `package.json`
(`mcp:lint`), `docs/analytics.md`, `docs/architecture_and_strategy.md`,
`docs/user_guide.md`.

## Validation (recorded in v2)

- `npx tsc --noEmit`, `npm run mcp:lint` (two new unit scripts: flag
  resolution; resolver precedence, defaults, legacy file rules, shared roots,
  listing filter, hop cap).
- `npm run db:branch` → `npm run db:generate` → file + journal verified →
  `npm run db:migrate` on the branch DB.
- Local, flag on (`fgac-dev-drive-tree`), USER_A: enable full Drive access
  (consent), tree renders the three roots, search with paths, folder view chain,
  overrides save and re-render; flag off → legacy page identical.
- Enforcement: REST proxy with the Default Profile key (read of a never-picked
  sheet allowed under Read everything; write denied `drive_read_only`; folder
  Write override allows; Block denies reads; explicit default denies with the
  expose link); MCP path over a local bearer (qa-setup-driver) for the same
  cases plus `get_my_permissions` and listing withholding.
- No preview (ADR-002): the branch is pushed for the next integration train;
  Google consent for `drive` works against the dev Clerk instance locally.

## Out of scope / follow-ups

- Google verification of the restricted `drive` scope (CASA) before the flag
  goes beyond ≤100 test users in production — user action, plan v8 §5.
- A shared `drive_lineage_cache` table (v7 §2) if the in-process cache proves
  too cold on Vercel; a `drive_list_files` typed tool; sharing-requires-send
  parity (v7 §3.3).
- Folder-override conflict dialog ("Block Finance, keep inner settings?") from
  the canvas: nearest-wins makes inner settings survive by definition; the
  dialog is a UX refinement for a later train.
