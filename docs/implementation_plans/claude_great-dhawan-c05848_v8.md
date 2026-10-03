# Folder-inherited access rules on the full `drive` scope — plan v8 (feature-flag strategy, posture decisions, QA-first)

Branch: `claude/great-dhawan-c05848` · Date: 2026-09-20 · Supersedes v7 for the
sections below; v7 §2 (lineage resolver), §3 (enforcement doors), §4 (approvals
and MCP surface) and §5 (verification / CASA rollout) stand unless amended here.

## Decisions folded in (Ken, 2026-09-20)

1. **Default profile posture: read every file in Drive, write none.** Reads
   need no rule at all; writes need a Read & Write rule that reaches the file.
2. **One-click "Full Drive access (read & write)" per profile**, the twin of
   Gmail's "Send to Anyone": a reusable `service='drive'`, `target_kind='all'`,
   `actionType='drive_read_write'` rule assigned to that profile, toggled from
   the profile card and offered on the approval page.
3. **Depth cap: three levels.** A write on file F is allowed only if a Read &
   Write rule sits on F itself, F's folder, its grandparent folder or its
   great-grandparent folder. Anything higher is not consulted. The denial
   message says exactly that and names the nearest checked folders, so a
   grant on a very high folder does not read as a mystery failure.
4. **QA capability doc first**, aligned before code:
   `docs/QA_Acceptance_Test/capabilities/drafts/21_drive_folder_rules.md`
   (21 assertions; Ken's six example cases are A3–A5, A7, A8, A9; A10 is the
   depth cap; A13 is the one-click grant).

## 1. Feature-flag strategy: run it in dev without touching production

Three layers, each independently reversible, so the feature can be developed,
QA'd and beta'd while production stays exactly on `drive.file`.

### 1.1 Server flag — `FGAC_DRIVE_RULES`

- Read once in `src/lib/featureFlags.ts` (new): `driveRulesEnabled()` returns
  `process.env.FGAC_DRIVE_RULES === '1'`. Set in Vercel **development** env only
  (so `vercel env pull` puts it in every worktree's `.env.local`); absent in
  preview and production until the beta step. `npm run env:check` prints it.
- Everything new is behind it: the Drive card's beta button, the folder rule
  editor and Picker Folders view, the `drive` service in the rule API, the
  `defaults.drive` block in `get_my_permissions`, the `drive_*` denial codes,
  the lineage resolver. With the flag off, no new code path is reachable and
  capabilities 09/13/17/19 behave byte-for-byte as today (capability 21 A1).

### 1.2 Per-user gate — the live token carries `drive`

- The engine applies to a call only when the flag is on **and**
  `googleTokenScopes.ts` reports `https://www.googleapis.com/auth/drive` on
  the user's live token (tokeninfo, the source the pre-flight already trusts).
  A flag-on user still on `drive.file` gets the legacy path unchanged, so a
  mixed population is the normal state, not an edge case.
- Widening is per user through the existing in-place
  `reauthorize({ additionalScopes: ['…/auth/drive'], oidcPrompt: 'consent' })`
  in `googleReconnect.ts` (measured working on the dev client 2026-09-18). The
  dev Clerk connection's scope list is **not** changed, so no other dev
  session or QA capability is affected; USER_A is widened for a capability 21
  run and restored at its end (A21).
- The verdict is cached per token like the rest of the scope pre-flight, so
  the gate costs nothing per call.

### 1.3 Environment matrix

| environment | flag | who has `drive` | behaviour |
| --- | --- | --- | --- |
| local dev (`dev:qa`) | on | QA account after the beta button | full engine; capability 21 runs here |
| preview | on (per-branch env) | nobody unless a runner widens | engine reachable for PR validation, legacy for everyone else |
| production, now | **off** | nobody | unchanged |
| production, beta | on | invited users who click the beta button (≤100, unverified screen until Google approves) | engine for them, legacy for all others |
| production, GA | on | `drive` requested at connect; upgrade card for existing users | engine by default |

The beta button's visibility in production is additionally gated by an
allowlist env var of Clerk user ids (`FGAC_DRIVE_BETA_USERS`, comma-separated,
never committed), so "flag on in prod" and "who can opt in" are separate
switches.

## 2. Rule evaluation with the decisions applied

```
checkDriveAccess(userId, keyId, fileId, isMutating):
  rules   = visible rules for keyId (global + assigned), service in {drive, sheets, docs, slides}
  chain   = [F, parent(F), parent²(F), parent³(F)]      // resolver stops at 3 ancestors
  for level, node in chain:                            // nearest first
      matching = rules on node (file rules at level 0, folder rules at 1..3)
      if none: continue
      if any block      → deny  drive_blocked      (reads too)
      if isMutating and none read_write → deny drive_read_only
      allow (rule_match_level = file|folder, lineage_hops = level)
  allRule = rules with target_kind = 'all'
  if allRule block → deny drive_blocked
  if not isMutating → allow (rule_match_level = allRule ? 'all' : 'default')
  if allRule read_write → allow (rule_match_level = 'all')
  deny drive_read_only, lineage_checked = min(3, depth), lineage_truncated = depth > 3
```

- The three-level cap bounds the resolver's Google calls to at most three
  `files.get` per cache miss (plus F's own metadata), which is also the
  recursion guard Ken asked for; there is no unbounded walk anywhere.
- Denial text for `drive_read_only` (capability 21 A6/A9/A10):
  > 🚫 Write denied: no Read & Write rule covers "<file>", its folder
  > "<parent>", or the two folders above it — FGAC checks three folder levels
  > up, so a rule on a higher folder does not reach this file. Grant the file,
  > "<parent>", or turn on Full Drive access for this agent: <link>
  When the chain was truncated the second sentence becomes "a rule on "<name
  of the first unchecked ancestor, if known>" is higher than the three levels
  FGAC checks — grant "<parent>", "<grandparent>" or "<great-grandparent>"
  instead". The approval page offers file / parent folder / Full Drive access.
- Blocks are honoured at any of the four checked levels for reads as well,
  which is the only way the read-all default can be narrowed ("read everything
  except HR/").
- Shortcuts and multi-parent files: as v7 §1.2 (shortcut lineage never grants
  to its target; blocked anywhere wins).

Impact on capability 13 (Default Profile): A4 "default posture denies Sheets"
becomes "denies Sheets **writes**; reads succeed" once the user holds `drive`.
Under the flag-off / `drive.file` condition A4 is unchanged; the capability doc
gets a two-branch expectation in the shipping PR.

## 3. Schema and API deltas (unchanged from v7 except the cap and the `all` shortcut)

- `access_rules.target_kind` (`file` default | `folder` | `shared_drive` | `all`),
  `service='drive'` actions `drive_read` / `drive_read_write` / `drive_block`.
  Migration `0015_drive_folder_rules.sql`; `npm run db:branch` before
  `db:migrate`.
- `drive_lineage_cache` as v7 §2, entries capped at three ancestors.
- `POST /api/rules/drive` (folder / all rules), reusing the profile-scoping
  semantics of the sheets/docs grant routes; the one-click grant reuses the
  `grantSendToAnyone` shape (reusable global row + per-profile assignment).
- No Sheets/Docs/Slides scope is requested anywhere.

## 4. Order of work

| step | what | gate |
| --- | --- | --- |
| 0 | **Align capability 21** (this PR): Ken edits/approves the 21 assertions and fixture tree | Ken |
| 1 | Flag + per-user gate + beta button on the dev client; capability 21 A1, A2, A21 pass | — |
| 2 | Resolver with the three-level cap + `checkDriveAccess` + denial copy; unit tests for precedence, cap, shortcuts, multi-parent; A3–A12 pass | — |
| 3 | Every Drive door through the choke point (v7 §3), list filtering, sharing/trash rules; A15–A19 pass | — |
| 4 | One-click Full Drive access, approval page choices, `get_my_permissions`, analytics fields; A13, A14, A20 pass; move the doc out of `drafts/`, add the agents/ runbook sections | full local QA |
| 5 | Preview validation via `/deploy-pr-preview` with the flag on for the branch | — |
| 6 | Production beta (flag on, allowlist) — only after Google verification is submitted; GA after approval | Ken (v7 §5) |

## 5. Open items for Ken

1. Approve or edit the capability 21 assertions and the fixture tree (names
   are the contract; ids stay out of the repo).
2. Confirm the message wording in §2 or supply your own.
3. Beta allowlist mechanism: env var of ids (proposed) versus a dashboard
   admin toggle.
4. CASA status for `gmail.modify` (still unconfirmed; gates step 6 only).
