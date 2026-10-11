# Integration train 2026-10-10b — approve page returns to the changed profile, in-place key rotation, Claude directory plugin (v1: landed, unit validation)

Branch: `integration/2026-10-10b` (from `origin/main` at `cfec532`, the #203 merge).
Architecture: `docs/adr/002_integration_trains.md`.
Sidebar group: `Train 2026-10-10b` (this session, #204's session, roll-key's session). #198's
session stays in the `Directory listings` group, which tracks every listing thread.

## Candidate table (Ken approved 2026-10-10: "Yes, build it as recommended")

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #204 | Approve page "Back to dashboard" returns to `/dashboard/agents/<slug>` of the profile the approval changed | Bare `/dashboard` redirects to the default profile, so non-default approvals looked lost | Multi-profile users see the rule they just approved (count not measured) | Unit, tsc/eslint, preview QA cap 14 A21 | Yes |
| `claude/roll-key-keeps-connections` | Rotate the profile key in place (same row); "Rotate key" on the profile header | The old Roll inserted a new row and revoked the old one, orphaning every connection; it was unreachable from the UI (observed) | No one hit it yet; users get a working rotation that keeps their agents connected | 22 unit checks; preview QA cap 07 A3/A4/A9 after one audit re-test | Yes |
| #198 | `fgac-mcp` plugin v1.1.0, Claude-first, plus skill eval suite; no server code | New connections fell 85–90% from 09-26 (observed); in-chat search finds plugins by name but not Community connectors (observed) | After Ken submits the listing: one-click add when asked for by name (inferred) | `claude plugin validate`, eval 17/18 both arms | Yes |
| #194 | ChatGPT directory packet | — | Blocked (generic API tools, reviewer MFA) | stale | No; its RFC 9728 route duplicates the one #196 shipped |
| #121, #72 | Growth digest / Sheets instrumentation | — | — | stale (Sept / Aug) | No; recommend closing |
| #188 | Drive override count | — | — | already in main | No; close as shipped |

## What landed (each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #204 | `claude/access-grant-approval-redirect-814dec` | none | — |
| roll-key | `claude/roll-key-keeps-connections` | `package.json` (`mcp:lint`) | union: main's list plus `test-key-rotation.ts` (the branch predated #203 and lacked `test-connection-state`, `test-link-origin`, `test-drive-scope-episode`) |
| #198 | `claude/claude-directory-plugin` | `docs/distribution_architecture.md` | took #198's row 6 (adds the Claude directory) and kept main's rows 7 (Hermes) and 8 (ClawHub) |

**Semantic check:** #204 and roll-key both edit `src/app/dashboard/actions.ts`. Approval
links resolve the profile by `proxyKeyId`, and rotation now keeps both the id and the
label, so the new `profileSlug` redirect survives a rotation. Under the OLD roll (new
row, old revoked) a link minted before a roll would have hit "no longer exists"; the train
removes that failure as well.

## Registries after landing

- Migrations: none.
- Assertions: cap 07 gains A9 (A3/A4 rewritten); cap 14 gains A21. No duplicate ids.
- `mcp:lint`: adds `test-key-rotation`.

## Validation

- **Unit (train head):** `tsc --noEmit` clean; `npm run mcp:lint` exit 0; eslint clean on
  every changed `.ts/.tsx` (the 8 repo-wide eslint errors are in files the train doesn't
  touch and are already on main); `scripts/test-profile-slugs.ts` pass.
- **Preview + QA:** pending. Scope:
  - capability 14 (magic-link approvals): A21 (non-default profile approval → Back to
    dashboard lands on that profile) + regression of the rest;
  - capability 07 (key lifecycle): all, including A9 (connections survive a rotation).
    Throwaway profile + connection only, never the profile bound to the stored QA bearer;
  - plugin smoke: `public/skills/fgac-mcp/` manifests served by the preview (version 1.1.0).
