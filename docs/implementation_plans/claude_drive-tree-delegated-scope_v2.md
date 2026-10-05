# Full-scope Drive tokens outside the tree engine — v2 (2026-10-05)

> v2: Ken chose (a) on 2026-10-05 after the usage check below; `isDriveApiPath`
> hardened (case, `upload/`, leading slash); PR #181 overlap noted.

Branch: `claude/drive-tree-delegated-scope` (from main 9b55482). Sibling of
`claude/drive-tree-listing-leak` (unpushed at time of writing; touches the
same passthrough block in `src/app/api/mcp/route.ts` — expect a small merge).

## Problem

The Drive tree engine (`src/lib/driveTreeAccess.ts`) is active only when the
key owner's flag is on, the call targets the key owner's OWN mailbox, and the
live token carries the full `drive` scope. Every other call takes the legacy
per-file path, which assumes the token holds only `drive.file` — Google itself
hides every file the user never picked, so:

- Drive passthrough (`drive/v3/files` listing, `changes`, `drives`, …) is
  forwarded unfiltered;
- `checkDriveFileAccess` lets a no-rule, non-Sheets/Docs/Slides file through
  as `gate: 'mime_other'` ("rides the per-file drive.file grant").

Two states break that assumption:

1. **Delegated mailbox** whose owner is flagged and granted `drive`: another
   user's key with that delegation could list the owner's whole Drive and
   download every PDF/image via `google_api_get`, ignoring the owner's tree
   settings. (Reported case.)
2. **Own mailbox, flag switched off** after the grant: same, for the owner's
   own keys. The REST proxy has this case too (listings only — its legacy
   per-file guard already denies any file no rule names).

The REST proxy has no delegated-mailbox path at all (verified: it only ever
uses the key owner's token; the per-kind handler stamps
`accountDelegated = false`).

## Decision: (a) fail closed — DECIDED by Ken 2026-10-05

- (a) **Refuse** Drive discovery and `mime_other` reads whenever the token
  carries `drive` and the engine is not confining it. Sheets/Docs/Slides with
  per-file rules keep working by id. **Implemented.**
- (b) Apply the owner's tree settings to the delegated key. Open question for
  Ken: are the owner's profile-level settings (set per *their* agent profile)
  the right policy for *someone else's* key? Not obvious — a delegate's key
  has no profile on the owner's side. Deferred.

Cost of (a): a delegate loses non-Sheets/Docs/Slides files on a full-scope
owner's mailbox (previously they "worked" only because of the leak). Under
the flag today that is USER_A only.

## Usage evidence (PostHog, 90 days to 2026-10-03, internal accounts excluded)

- Drive-family MCP calls on a delegated mailbox: 349 of ~41,000 (~0.9%), 13
  people; almost all typed Sheets/Docs/Slides by id, which (a) leaves alone.
- Delegated Drive listings: 6 calls, 3 people. Delegated `mime_other` reads:
  0 successes (4 attempts, all `invisible`).
- Contrast: delegated Gmail is 26,300 calls / 31 people (~35% of Gmail calls).
- (a) changes behaviour only when the delegating owner holds the full scope,
  which is flag-gated (USER_A only today) — zero external users affected.

## Overlap with PR #181 (drive tree discovery leak)

Both edit the passthrough block, the proxy engine gate, the capability draft
and analytics.md. #181 moves the engine listing filter above the per-kind
dispatch (`driveTreeDiscovery`) and canonicalizes proxy paths. Whichever
merges second resolves; the unconfined check must stay AFTER the engine
discovery branch and apply to every `drive/` path when the engine is off.

## Changes

- `src/lib/driveTreeAccess.ts`: `driveScopeUnconfined(ctx)`,
  `isDriveApiPath(path)`, `unconfinedDriveDenialText(...)`.
- `src/app/api/mcp/route.ts`:
  - `checkDriveFileAccess`: before the final `mime_other` return, refuse when
    unconfined (`drive_file_gate: 'unconfined'`). Placed after the mimeType
    lookup so an unexposed Sheet/Doc still gets its normal approval link.
  - passthrough branch: any `drive/v2|v3/…` path refused when unconfined
    (after the engine's filtered-listing branch).
  - `denial_code: 'drive_full_scope_unconfined'`, `drive_scope_unconfined: true`.
- `src/app/api/proxy/[...path]/route.ts`: `proxyUnconfinedDriveDiscovery` —
  when the engine is off, a Drive discovery path checks the live scope; full
  scope → 403, tokeninfo unavailable → 503 retryable (fail closed).
  Id-addressed `files/{id}` calls are skipped (the legacy guard denies them).
  Cost: one Clerk token fetch + cached tokeninfo per proxy Drive listing.
- Tests: `scripts/test-drive-unconfined-scope.ts` (added to `mcp:lint`),
  committed failing first (4ee40e8).
- Docs: capability draft 22 A21; `docs/analytics.md` new denial code.

## Validation

- [x] `scripts/test-drive-unconfined-scope.ts` fails before (missing helpers),
      passes after; full `npm run mcp:lint` and `tsc --noEmit` clean.
- [ ] Local: A21 via qa-env-runner (needs a USER_A → USER_B delegation and a
      USER_B key; USER_A flagged with full scope).
- [ ] Preview (`/deploy-pr-preview`) with the `drive_tree` flag on: A21 plus
      A1–A16 regression on the owner's own mailbox.
