# Integration train 2026-10-10 — preview-origin links, revoked-profile connections, drive_scope_enabled episodes, legacy sign-in rule repair, Vercel build gating (v1: landed, unit validation)

Branch: `integration/2026-10-10` (from `origin/main` at `321c66a`, the #199 merge).
Architecture: `docs/adr/002_integration_trains.md`.
Sidebar group: `Train 2026-10-10`.

## Candidate table (the selection Ken approved, 2026-10-10: "build it with what's ready now, inflight work can catch the next train")

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| `claude/preview-origin-links` | Approval, reconnect and dashboard links name the serving deployment on previews | QA rewrote origins by hand; preview links pointed at prod, where the request does not exist | None in production (byte-identical); reliable preview QA | Preview QA cap 14 A9 | Yes, landed first (based on the 10-08 train helper) |
| `claude/revoked-key-orphaned-connections` | Connections on a revoked profile stay visible and re-attachable; revoked profiles shown with timestamp | Revoking a profile made its agents vanish from every page with no recovery | Users who revoke a profile can find and re-attach their agent instead of losing it | Preview QA cap 06 A11/A14, cap 07 A2 | Yes |
| #202 | `drive_scope_enabled` recorded server-side once per enable episode (migration 0022) | Drive tree beta success event had 0 rows ever | None visible to users (flag-gated); first real Drive-beta conversion measure | `mcp:lint` incl. new episode test; preview evidence | Yes, plus the postmortem (`determined-nash`, docs only) |
| #201 | Data migration moves 14 legacy "Block Sign In Alerts" rows to `sign-in` | Legacy pattern blocks ordinary "sign in to …" mail: 16–17 blocks/week vs 1–5 | 12 live accounts stop having normal mail refused | Unit, branch-DB migrate (14→21 `sign-in`), preview | Yes, migration renumbered to 0023 |
| #200 | Vercel Ignored Build Step | October projected $20.68 vs $20 credit; 72/95 builds were feature branches | None for users; ~−55% builds, ~−$5.40/cycle | 18/18 script tests + live probes | Yes |
| `claude/roll-key-keeps-connections` | Rolling a key moves connections to the new key | Follow-up flagged by the revoked-key plan | — | In flight, uncommitted | No, next train (Ken) |
| #198, #194 | Directory plugin / ChatGPT packet | Directory listings thread | — | — | No; #194's PRM alias duplicates merged #196 |
| #188 | Drive override count | Already in main | — | — | No, close as shipped |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| preview links | `claude/preview-origin-links` | none | — |
| revoked profile | `claude/revoked-key-orphaned-connections` | `package.json`, `cli-token/route.ts` imports | union; **semantic**: the new `profile_revoked` links in `cli-token` and the MCP route used the old `DASHBOARD_URL` constant (removed from the MCP route by preview-origin-links, so it would not compile) — both now go through `linkBase(...)` / `dashboardUrl()` so previews name the preview |
| #202 | `claude/drive-scope-enabled-event` | `package.json`, MCP route imports | union |
| postmortem | `47fcd0b` (cherry-pick, local-only commit from `claude/determined-nash-7f21a0`) | none | — |
| #201 | `claude/legacy-signin-rule-overblock` | migration number | `0022_tighten_legacy_sign_in_template_rule.sql` → `0023_…`. #202 owns 0022 (drizzle journal + snapshot); #201's is a hand-written idempotent data migration picked up by `migrate.ts`'s sorted `readdirSync`, so renumbering (not regenerating) is correct. References in the #201 plan, the read-rule bug report and `test-rule-patterns.ts` updated |
| #200 | `claude/vercel-build-cost` | none | — |

## Registries after landing

- Migrations: `0022_drive_full_scope_since` (journal), `0023_tighten_legacy_sign_in_template_rule` (data, hand-written).
- Assertions: cap 06 gains A14; cap 07 A2, cap 14 A9/A18, cap 18 notes, draft 22 A3 edited. No duplicate ids.
- `mcp:lint`: adds `test-link-origin`, `test-connection-state`, `test-drive-scope-episode`.

## Validation

- **Unit (train head):** `tsc --noEmit` clean; `npm run mcp:lint` exit 0; eslint clean on
  every changed `.ts/.tsx`; `scripts/test-vercel-should-build.sh` all pass; no duplicate
  `### A<n>` ids in touched capability docs.
- **Preview + QA:** pending. Scope:
  - capability 06 (connection lifecycle) A11, A14 — revoked-profile connection visible, re-attach works, MCP refusal names the revoked profile;
  - capability 07 (key lifecycle) A1, A2 — revoked profile shown with timestamp;
  - capability 14 (magic-link approvals) A9 — every approval link names the preview host;
  - capability 18 (Google reconnect) — reconnect links name the preview host (check `hasDriveFileScope` + `verification.status` first);
  - capability 02 (read blacklist) — Shield template rule blocks a sign-in alert and lets "sign in to …" prose through; migration 0023 ran on the preview branch;
  - draft 22 (Drive tree) A3 — one server-side `drive_scope_enabled` on a real enable / re-enable;
  - #200: the train's preview builds (integration branch), and a docs-only push to the train logs `SKIP — docs-only change`.
