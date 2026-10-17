# Integration train 2026-10-10b — approve page returns to the changed profile, in-place key rotation, Claude directory plugin (v2: preview QA, 0 train fails; A6 pre-existing)

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
- **Preview:** https://fine-grain-access-control-971o2pq2f-kenyesh-gmailcoms-projects.vercel.app
  (commit `03060c7`), built in 1m10s. Plugin manifests (.claude/.cursor/.grok) served at
  1.1.0; discovery and unauthenticated `/api/mcp` responses match production.
- **Scoped QA** (hosted MCP runbook, built-in browser for every flow including Google
  Picker/consent; initial run + round 1 after audit): **29/29 in scope, 25 pass, 1 fail
  (pre-existing), 3 blocked (preview infra)**.

| capability | assertion | result | evidence (short) |
| --- | --- | --- | --- |
| magic-link approvals (14) | **A21** | pass | Non-default profile `qa-rotate-probe`: Back href `/dashboard/agents/qa-rotate-probe` on the confirm, success, Already-approved, `ApprovedSettling` and pick-first cards, and on the sheets/docs/slides setup pages with `from=approval&profile=`; it lands on that profile with the new rule. Malformed `profile=` values (`../accounts`, `//evil…`, `/evil`, uppercase, absent) → `/dashboard`; the wrong-account and invalid cards → `/dashboard`. Caveat: the natural rule-written-but-unreachable redirect couldn't be induced, so the setup pages were opened with the URL shape it emits |
| magic-link approvals (14) | combined | pass | A link minted before a rotation resolved afterwards, approved, and Back landed on that profile (also 14 A12: byte-identical re-emit across the rotation) |
| magic-link approvals (14) | A1–A3, A5, A7–A15, A18, A19 | pass | Round 1 closed A14 (two-tab stale page: one rule, "already approved" body) and A15 (server half: double `requestSubmit` → one rule, success card) |
| magic-link approvals (14) | A6 | **fail, pre-existing** | Signed-out open of a link whose recipient has `+` (also `&`, `%`) comes back from the Clerk/Google sign-in leg with the query decoded, so the owner sees "Invalid link". Reproduced identically on the previous train's preview (main's code); the train changes neither `middleware.ts` nor `approvalLinks.ts`. Spun off as its own task |
| magic-link approvals (14) | A16, A17 | blocked | Previews have no support sender (known infra gap) |
| magic-link approvals (14) | A20 | blocked | Needs a never-seen Clerk id / fresh branch; no new accounts. Runnable locally on a fresh `db:branch` (auditor) |
| key lifecycle (07) | **A3, A4, A9** | pass | Old key 401 / new key 200; a pre-rotation temp key is refused. A4 profile had 2 send rules, a `drive_read` rule and Drive "Only files I allow" with 1 override, all unchanged after rotation. A9: a fresh DCR connection's `list_accounts` was byte-identical before/after on the unchanged bearer, still Approved |
| key lifecycle (07) | A1, A2, A5–A8 | pass | Round 1 A5: an outsider's bearer on the `rollProxyKey`/`deleteRule` server actions → Clerk `protect-rewrite`; a USER_B session on USER_A's ids → refused, nothing changed |

- **Audit:** 12 findings. 1–5 and 9 were re-tested in round 1 (all pass except A6, which is confirmed
  pre-existing). 6–8 (A20 local route, A16/A17 local email legs, A19 non-prominent ordering)
  are deferred: they cover paths this train doesn't touch. 10–11 accepted. 12 (mask
  addresses) applied: evidence uses `<owner>+tag@example.com`.
- **Observation (not a train change):** USER_B's `deleteRule` on another user's rule id returns
  HTTP 500 with an opaque digest (same as a nonexistent id). It's refused safely, but a 4xx
  would be cleaner.
- **QA leftovers (preview DB only):** profiles "QA Rotate Probe", "QA Mailboxless Probe",
  "QA Revoke Probe" (revoked); connection `qa-throwaway`; the probe rules; two USER_B Drive
  sheets ("QA r1 … probe B") shared with USER_A; test mail between the QA accounts only.
