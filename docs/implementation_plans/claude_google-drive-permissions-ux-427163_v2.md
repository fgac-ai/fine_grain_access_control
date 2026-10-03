# Drive tree access behind a feature flag — plan v2 (built; local validation status)

Branch: `claude/google-drive-permissions-ux-427163` · Date: 2026-10-01 · Supersedes v1's
"Validation" section; everything else in v1 stands.

## What changed since v1

- **Built as planned.** Commits on the branch: the feature (`feat(drive)`), the
  docs (`docs(drive)` ×2), and one addition driven by customer evidence relayed
  from the daily analytics review on 2026-10-01 (`feat(mcp)`): when a denial
  knows the file's Drive title — the tree engine always does — the approval
  action is minted with `resourceName`, so the approval page, the owner email
  and the quotable relay line name the file instead of its id, and
  `policyDenialWithLink`'s relay line now says what is being approved for every
  link ("FGAC needs your approval for the spreadsheet “Q3 Budget” before I can
  continue: <url> …"). `AGENT_APPROVAL_PROTOCOL` is unchanged.
- **One resolver refinement**: a tree setting on a node outranks legacy
  per-file rules on the same node (otherwise a legacy Read & Write would beat a
  user's new Read on the same file). Unit-tested.
- **Capability draft** `docs/QA_Acceptance_Test/capabilities/drafts/22_drive_tree_access.md`
  (20 assertions) replaces PR #152's draft 21 for this model.
- `.claude/launch.json` gains `fgac-dev-drive-tree` (flag on for local runs).

## Validation

### Static and unit (this worktree, Node 22, Neon branch `claude-google-drive-permissions-ux-427163`)

| check | result |
| --- | --- |
| `npm run db:branch` → `npm run db:generate` → `npm run db:migrate` | `0019_drive_tree_access.sql` generated (`access_rules.target_kind`, `proxy_keys.drive_default`), journal idx 19, applied on the branch; 0001–0018 idempotent |
| `npx tsc --noEmit` | clean |
| `npm run mcp:lint` | exit 0, **1,468** checks (1,408 before this branch); new: `test-feature-flags.ts` (14), `test-drive-tree-access.ts` (46: precedence, nearest-wins both ways, legacy file-level rules, tree-over-legacy on one node, shared roots, listing-field widening, partition, lineage walk over a fake Drive incl. cache partition, 404-ancestor → shared-with-me, shared drive → shared-drives, file_not_found, fail-closed, hop cap) |
| `npx eslint` on every new/changed file | clean |
| unauthenticated route sanity (runner, curl) | `/api/drive/{children,search,flag}` 401; proxy 401; MCP tools/list 401; no 500s |
| dev server with the flag (`fgac-dev-drive-tree`) | up; the listener descends from the `FGAC_DRIVE_TREE=1` launcher; `preview_logs` error filter empty throughout |

### Browser / enforcement QA — BLOCKED (user action required)

A `qa-setup-driver` runner was dispatched for capability-22 assertions A2, A3,
A4, A5, A7, A8, A9, A12, A13, A15, A17, A18 (the consent flow, the tree card,
REST-proxy and MCP enforcement). It could not obtain a signed-in USER_A
dashboard on either browser path:

- **Built-in pane**: every `http://localhost:3000` navigation except
  `/favicon.ico` answers "navigation was denied or failed". The server is
  healthy (curl follows the same chain to Clerk's hosted sign-in in 5 hops);
  the pane refuses Clerk's `dev-browser-missing` handshake redirect chain
  (`localhost → accounts.dev/v1/client/handshake → localhost?__clerk_handshake=…`),
  with or without the stale localhost Clerk cookies (the runner expired them —
  FGAC's own `fgac_prev_account` / `fgac_last_account` cookies were left alone).
- **Path B (CDP Chrome on :9222)**: localhost and the Clerk redirects load, but
  the profile's Google session has lapsed — "Continue with Google" lands on
  Google's identifier page (password next), which QA never types.
- Two workarounds (a redirect-shape probe via a throwaway server; seeding the
  Clerk dev-browser cookie on localhost from the pane) were refused by the
  auto-mode classifier and were not pursued. Decision belongs to Ken.

**USER ACTION REQUIRED (cheapest first):** sign USER_A (and USER_B) back in to
Google in the CDP Chrome window on :9222 (it is sitting on Clerk's hosted
sign-in page), then this session re-dispatches the runner on Path B for the
twelve assertions above. Alternative: set `FGAC_DRIVE_TREE_USERS=<USER_A>` on the
Vercel preview environment and push a `[preview]` commit so the built-in
browser can run the same assertions against a preview URL.

USER_A's Google grant is untouched (still `drive.file`). Nothing was widened.

## Hand-off state

- Branch pushed (ADR-002: no PR; lands on the next integration train).
- Flag off everywhere outside the local `fgac-dev-drive-tree` configuration:
  production and previews run the legacy code paths byte-for-byte.
- Before the flag goes to beta in production: Google verification (CASA) of
  the restricted `drive` scope is pending (user action, plan v8 §5 of PR #152);
  until then the unverified consent screen caps the beta at 100 test users.

## Open items

1. Run the blocked capability-22 assertions once a signed-in QA browser exists
   (above); fold the results into v3 and promote the capability doc out of
   `drafts/` when the flag reaches beta.
2. Per-connection (per-chat) scoping — the second half of the 2026-09-30
   customer ask — is a product decision outside this branch (19 accounts run
   2+ connections on one Default Profile).
3. Sharing-requires-send parity, a typed `drive_list_files` tool, and the
   folder-override conflict dialog from the canvas (later train).
