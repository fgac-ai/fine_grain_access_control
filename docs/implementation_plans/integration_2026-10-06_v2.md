# Integration train 2026-10-06 — delegation owner lookup, profile mailboxes, Drive card fixes, Gmail layout (v2: preview QA — all non-MCP scope passes; #191 gate blocked)

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
- **Preview** `fine-grain-access-control-cnbqqgbgz-…vercel.app`, commit `4757d30` (SHA verified with `vercel ls --meta`). One `qa-env-runner` pass, built-in pane throughout; results in `docs/QA_Acceptance_Test/qa-results.json` (coverage check clean).

| scope | result |
| --- | --- |
| 01 A6 (gate for #191) | **BLOCKED** — the runner's MCP bearer mint (DCR + PKCE authorize in the pane) was denied by the auto-mode classifier; no send, no delivered MIME. `gmail_send` is MCP-only, so the REST proxy cannot stand in |
| 04 A1, A2, A4, A5, A7 (REST analog), A9 (#189) | PASS — fresh USER_A→USER_B delegation reads 200 with both profile keys; revoke → 403; re-delegate → 200; no `delegation_inactive` |
| 04 A6, A8 | BLOCKED (MCP-only) |
| 07 A7, A8 (#186) | PASS — own mailbox pre-ticked, Create disabled when empty, in-dialog "Profile created" panel; mailbox-less profile repaired via Add (REST 403 → 200) |
| draft 22 A18 | PASS |
| draft 22 A23 | PARTIAL — REST surface 6/6; MCP surface not run |
| draft 22 A25 (#188) | PASS (REST) — "0 overrides" with 3 agent files kept; 3 user settings → "3 overrides"; Clear (3) → 0, agent files writable again |
| Inherit on a legacy per-file file | PASS — Demo Spreadsheet goes to the Read default and stays there after reload |
| Inherit on an agent-created Sheet (landing's semantic fix) | PASS — Read → REST write 403; Inherit → back to Read & write with the "created by agent" tag, write 200 |
| #190 image | PASS — 200 `image/png` |

Observation (not a failure): a prod-copy delegation whose owner had never signed in on the preview read "could not fetch Google access token" until that owner signed in; a dead dev grant, not #189's row mix-up.

**Open:** 01 A6 needs an MCP bearer on the preview (Ken's call: allow the mint, or decide #191 without the delivered-copy check).
