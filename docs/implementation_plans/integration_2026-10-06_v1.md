# Integration train 2026-10-06 — delegation owner lookup, profile mailboxes, Drive card fixes, Gmail layout (v1: landed, unit validation)

Branch: `integration/2026-10-06` (from `origin/main` at `5d22236`).
Architecture: `docs/adr/002_integration_trains.md` (fifth train).

## Candidate table (the selection Ken approved, 2026-10-06)

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #189 | Delegated mailbox owner resolved from the delegation, not one `users` row by address | A live delegation read as revoked when an address has several rows | No customer today (2 of 343 addresses, both internal); breaks delegated QA on every fresh branch | Unit + local repro; preview end-to-end pending | Yes, first |
| #186 | Profiles cannot be created without a mailbox; mailbox-less profiles repaired from the profile page; key no longer in a native alert | Mailbox-less keys were dead with no fix in the UI | Any user who created a profile without ticking a box; first-session dead end | Static; key lifecycle A7/A8 pending | Yes |
| #188 | Drive card override count = what Clear removes; agent-created files neither counted nor cleared | "0 overrides" next to two settings; Clear could strand agent output | Flag-gated (USER_A only) | Static; local QA blocked by lapsed Google session | Yes (stacked base already merged) |
| `claude/demo-spreadsheet-inherit-bug-eb730e` | Inherit on a file also clears its legacy per-file rules | Demo Spreadsheet snapped back to Write | Flag-gated | Its own preview | Yes |
| #190 | Hosted Drive card image for the early-access email | Campaign needs the prod URL | Unblocks the paused campaign | Preview serves the file | Yes |
| #191 | Every FGAC-built email gets a `text/html` alternative | Gmail re-folds text/plain at ~72 columns | All agent sends via `gmail_send` + owner notices | Unit; delivered-copy check never ran | Conditional on capability 01 A6 |
| #182 | `include_granted_scopes` on the reconnect leg | Tree users lost `drive` on reconnect | Changes everyone's reconnect URL | Preview 10-04 | **No** (independent rollback, held out again) |
| docs | `claude/suspicious-lederberg-bef39d` (7.33 alert, connect-gap v2/v3), `claude/drive-tree-create-autogrant` (plan record) | Record | None | n/a | Yes |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #189 | `claude/delegation-owner-lookup` | `package.json`, MCP + proxy route imports | union; MCP route drops its now-unused `emailDelegations` import. The proxy's remaining `emailDelegations` reads go by delegation id (temporary-key and fallback paths), so the bug does not apply |
| Inherit fix | `claude/demo-spreadsheet-inherit-bug-eb730e` | `actions.ts` import | union |
| #188 | `claude/drive-tree-override-count` | MCP + proxy route imports, `actions.ts` import | train's lists + #188's helpers; #188's pre-train helpers (`isResumableInitiation`, `injectCreateId`, …) stay unused. **Semantic fix**: the Inherit fix pulled every legacy per-kind rule for the file into the Inherit cleanup, which would delete the agent's own create auto-grant on a native file — the stranding #188 prevents. Agent-created rules are filtered out of that set. Draft 22 **A23 → A25** (A23 is #184's) |
| #186 | `claude/profile-mailbox-required` | `AgentProfilesView.tsx` import | union |
| #190 | `claude/email-drive-access-preview-image` | none | — |
| #191 | `claude/xenodochial-meitner-8b1f5b` | `package.json`, `toolDefs.ts` | `gmail_send`: #191's text + the train's >1 MB attachment sentence. `google_api_modify`: train text + #191's re-fold note, tightened to stay under the 1500-char lint cap |
| docs | `claude/suspicious-lederberg-bef39d` | `docs/monitoring.md` | 7.33 alert paragraph at the end of 7.33, before 7.34 |
| docs | `claude/drive-tree-create-autogrant` | none | — |

**Not landed:** #182 (held out). Stale and not considered: #121, #72,
`claude/great-dhawan-c05848`, `claude/facebook-muse-marketplace-42e936`,
`fix/qa-duplicate-a29-guard` (worth reviving: this train hit another
duplicate id).

## Registries after landing

- Capability 01: A6 (#191). Capability 07: A7, A8 (#186). Draft 22: A25 (#188).
  Capability 04 gains a note (#189), no new id. No duplicates.
- No migrations.
- `mcp:lint`: union, adds `test-delegation-owner-lookup` and `test-mime-text`.

## Validation

- **Unit (train head):** `tsc` clean; `npm run mcp:lint` exit 0; eslint clean on every changed file; `qa-coverage-check` reports no duplicate ids.
- **Preview + QA:** pending. Scope:
  - capability 04 delegation end-to-end (MCP + REST) on the preview's fresh branch (#189);
  - capability 07 A7, A8 (#186);
  - draft 22 A18, A23 (regression), A25, plus Inherit on a file with a legacy per-file rule (snaps to the default) **and** Inherit on an agent-created Sheet (keeps Write via the auto-grant — the landing's semantic fix), drive_tree flag on (USER_A);
  - capability 01 A6: a real send between the QA accounts, delivered copy read with `format=raw` — gate for #191; on failure, revert the #191 landing commit;
  - `/email/drive-access-preview.png` served (#190).
