# Integration train 2026-10-01 — approve-page wall sign-up fix (#172 + #171), gmail_list `maxResults` alias, directory-gap record (v2: four landings, first preview validated)

Branch: `integration/2026-10-01` (from `origin/main` at `464e0e7`, train #173 merged).
Architecture: `docs/adr/002_integration_trains.md` (third train). Release PR: #174.

> **v2 changes:** Ken asked for PR #171 and `claude/gmail-list-maxresults-alias`
> to join the train. #171 is landed as a `--no-ff` merge with its conflicts
> resolved in favour of the implementation already on the train (which carried
> #171's instrumentation as a fold-in since v1), so it is no longer
> "superseded" — it is on the train, net source change one comment. The
> gmail_list branch landed with one documentation conflict (both sides had
> extended the `$mcp_tool_call` catalogue row; the resolution keeps both
> additions). The first train preview (e350b83, before these two landings)
> passed capability 14 A20 with the A5 owner and A7 tamper controls, and the
> PostHog rows carry the folded-in properties; results below. A second preview
> covers the gmail_list change.

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | change | capabilities / ids | migration |
| --- | --- | --- | --- | --- |
| PR #172 | `claude/silly-varahamihira-6e9c5e` | `/dashboard/approve` provisions the signed-in visitor's `users` row with the dashboard's own `resolveDbUser` call, so a brand-new account created by the sign-in wall's Google chooser reaches the wrong-account card and PR #158's one-click delegation instead of "Invalid link"; `invalid` carries `invalid_reason` (`signed_out` / `unprovisioned` / `signature`) | 14 **A20** (new); A5, A7, A19 regression; runbook 7.25 addendum | none |
| (no PR) | `claude/suspicious-lederberg-bef39d` | investigation record of the 2026-09-27..30 directory-connection gap — every FGAC/Clerk hop verified, no code change; runbook **7.33** | none (docs) | none |
| train-owned | — | fold-in of #171's additive instrumentation: `visitor_row_provisioned` + `visitor_account_age_s` on `approval_link_opened`, `visitor_row_provisioned` + `account_age_s` on the wall's `delegation_prompt_shown`; runbook **7.29d**; `docs/analytics.md` rows; A20 names the property | 14 A20 (property); runbook 7.29d | none |
| PR #171 | `claude/funny-easley-11ccbe` | the same approve-page fix, built in parallel. Landed as a merge; conflicts in `actions.ts`, `analytics.md` and capability 14 resolved to the train's versions (already a superset), the duplicated event properties and second 7.29d block from the auto-merge removed. Kept from #171 as-is: its plan file (`claude_funny-easley-11ccbe_v1.md`, with its own local round 1 and preview round 2) and its comment on the invalid card | 14 A20 (same assertion) | none |
| (no PR, local branch) | `claude/gmail-list-maxresults-alias` | `gmail_list` accepts `maxResults` / `max_results` / `limit` as aliases of `max` (the Gmail API's own name was silently dropped by Zod and the call returned the default 10); every `$mcp_tool_call` carries `arg_unknown_keys` / `arg_unknown_key_count` for keys no schema has and no alias claimed; `scripts/test-argument-guidance.ts` extended; runbook 7.10a gains "Silently dropped keys" | 16 (argument tolerance, PR #160 family); runbook 7.10a | none |

Plan files: `claude_silly-varahamihira-6e9c5e_v1.md`, `claude_suspicious-lederberg-bef39d_v1.md`,
`claude_funny-easley-11ccbe_v1.md`, `claude-gmail-list-maxresults-alias_v1.md` / `_v2.md`.

## Conflicts

| landing | conflict | resolution |
| --- | --- | --- |
| #172, lederberg | none | `monitoring.md` auto-merged (7.25 insert vs 7.33 append) |
| #171 | `src/app/dashboard/actions.ts`, `docs/analytics.md`, `14_magic_link_approvals.md` (content); `approve/page.tsx` and `monitoring.md` auto-merged but DUPLICATED (#171's two event properties were added a second time → `TS1117`; a second `7.29d` block) | train versions kept for the three; the duplicate properties and block removed; `git diff` of `src/` against the pre-landing train head is one comment |
| gmail_list | `docs/analytics.md` — the `$mcp_tool_call` row was extended by main (bounce-ledger notice statuses, train #173) and by the branch (`arg_unknown_keys`) | one row carrying both additions |

Registry check after all four landings: no duplicate monitoring section ids
(7.29d is unique; last sections 7.30–7.33), no duplicate `### A<n>:` in any
capability file, migrations unchanged (0016–0018).

## Validation

Local (this worktree, Neon branch `integration-2026-10-01`, Node 22), after the fourth landing:

| check | result |
| --- | --- |
| `npm run db:branch` / `npm run db:migrate` | branch from main; 0018 applied, 0001–0017 idempotent |
| `npx tsc --noEmit` | clean (after removing the #171 duplicate properties) |
| `npm run mcp:lint` | exit 0, 1,408 checks (1,390 before the gmail_list branch's 18 new argument-guidance checks) |
| registry check | none |

Preview 1 — `https://fine-grain-access-control-89a8y8flb-kenyesh-gmailcoms-projects.vercel.app`,
commit `e350b83` (= #172 + lederberg + fold-in; source identical to the final
train for the approve page except one comment), fresh preview Neon branch,
qa-setup-driver in the built-in browser, 2026-10-01 00:58–01:01Z:

| assertion | result |
| --- | --- |
| 14 A20 — signed-out link → wall (`Clerk.client.sessions` empty on the wall page) → chooser → USER_A on USER_B's link | **PASS**: "This link belongs to a different account"; `wrong-account-notice` (owner masked, visitor in full); `delegate-panel` `surface=approve_wall`, `prominent=false`; sign-out control; "Invalid link" absent; approve GET 200, no console errors |
| `/dashboard` as USER_A afterwards | "Default Profile", no error |
| repeat open | identical card |
| 14 A5 owner control | **PASS**: "Approve agent permission?", Picker step 1 |
| 14 A7 tamper control | **PASS**: generic "Invalid link" |

PostHog (`environment = 'preview'`, same window): `approval_sign_in_wall` 00:59:12 →
`approval_link_opened{status: wrong_account, delegate_offer: true,
visitor_row_provisioned: true, visitor_account_age_s: 11156037}` +
`delegation_prompt_shown{surface: approve_wall, visitor_row_provisioned: true}`
01:00:01 → repeat open and prompt with `visitor_row_provisioned: false` 01:00:46 →
owner open `{status: fresh, visitor_row_provisioned: false}` 01:01:01 → tampered
open `{status: invalid, invalid_reason: signature}` 01:01:18. The age is USER_A's
real dev-instance account age (the fixture adopts an existing email row, so
"provisioned" means adopted here; a genuinely new identity in production takes
the create branch of the same call).

Lederberg's 7.33 query, run verbatim against production PostHog on 2026-10-01:
reproduces the record's table (connections 4/4/6 on 09-23..25, 1 on 09-26,
0/0/0 on 09-27..29, 1 on 09-30; `inspector_handshakes` tracking connections).

Preview 2 (the gmail_list landing): filled in below once the build is Ready —
scope is the branch's own live table (`gmail_list` with `maxResults` /
`max_results` / `limit` / canonical-plus-alias / bogus key over a freshly
minted MCP bearer on the preview; message counts and the `$mcp_tool_call`
`arg_aliases` / `arg_unknown_keys` props in PostHog `environment = 'preview'`)
plus a re-open of the A20 card as a smoke check that the approve page still
renders on the final commit.
