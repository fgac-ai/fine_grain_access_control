# Integration train 2026-09-25 — PRs #161, #162, #163, #165, #166 as one release

Branch: `integration/2026-09-25` (from `origin/main` at `c5237a9`, PR #164 merged).
Architecture this pilots: `docs/adr/002_integration_trains.md`.

## What landed (in landing order, each a `--no-ff` merge)

| PR | branch | change | capabilities / ids | migration |
| --- | --- | --- | --- | --- |
| #166 | `claude/funny-montalcini-d812e6` | scope-missing refusals email the mailbox owner once per episode (fourth trigger on the dead-grant ledger; class-change episodes) | 16 **A30**, 18 A14; runbook 7.30/7.30e | none — `schema.ts` change is a comment on `last_reason` only; table already created by `0017_google_grant_failures.sql` on main |
| #165 | `claude/elegant-engelbart-8cebb0` | Grok and Cursor classified as named third-party products; growth ledger; runbook 7.21f | 16; runbook 7.21f | none |
| #163 | `claude/zealous-dhawan-5e92b4` | `clerk_auth_redirect` event from the middleware outer wrapper, one row per sign-in / handshake hop; PostHog alert on `bounce_count >= 5` | 16 **A31** (was A30 on the PR); runbook **7.31** | none |
| #162 | `claude/angry-haibt-7bf8a3` | directory inspector's `client_name` (Anthropic/Toolbox) no longer sticks to every later tool call; latest product handshake wins | runbook **7.32** (was 7.31 on the PR) | none |
| #161 | `claude/goofy-khorana-7b992f` | placeholder `account` values (example.com, templates) get a "placeholder, ask the user" refusal, never ledgered or emailed | 14; `notify_status: skipped_placeholder`, prop `account_requested_placeholder` | none |

## Conflicts resolved at land time

Three were registry collisions that git cannot resolve, the rest were
same-line appends:

| file | PRs | resolution |
| --- | --- | --- |
| `package.json` `mcp:lint` | 161, 162, 163 (vs main's 160/164) | union of the script lists, main's order first |
| `docs/QA_Acceptance_Test/capabilities/16_analytics_events.md` | 163 vs 166 | both wrote `### A30:`; 166 keeps A30 (landed first), 163's clerk-redirect assertion becomes **A31**; the four references in 163's plan updated |
| `docs/monitoring.md` | 162 vs 163 | both wrote section **7.31**; 163 keeps 7.31 (its live PostHog alert `XKnzwDVm` is described against it), 162's inspector section becomes **7.32** with 7.32a/7.32b; 8 cross-references in `analytics.md`, `growth-channels.md`, the 162 plan and a route comment rewritten |
| `src/app/api/mcp/route.ts` imports | 162 vs 160 (main) | union: `normalizeValidationIssue` from main plus the `mcpClientName` import from 162 |
| `src/lib/approvalNotifyCopy.ts` `NotifyStatus` | 161 vs 164 (main) | both variants kept (`skipped_burst` + `skipped_placeholder`) |
| `docs/analytics.md` event table | 161 vs 166 + 164 | four rows where both sides inserted text into the same cell; three-way merged at character level (edit spans were disjoint) |

Nothing was dropped from any PR. `git log --first-parent origin/main..integration/2026-09-25`
lists the five landings.

## Validation

Local (worktree, Neon branch `integration-2026-09-25`, Node 22):

| check | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run mcp:lint` (39 scripts incl. the 7 the PRs added) | exit 0 |
| `npm run db:migrate` on the branch DB | 0017 applied, idempotent re-run ok |
| `npx tsx scripts/test-grant-failure-episodes.ts` (166's branch-DB test, not in `mcp:lint`) | all episode / class-change / cap checks pass, fixture cascaded |
| `npm run env:check` | DB + Clerk consistent (dev); PostHog key not in `.env.local` (known gap) |

Preview (`https://fine-grain-access-control-k9uip7jxj-kenyesh-gmailcoms-projects.vercel.app`,
confirmed via `vercel ls --meta githubCommitSha=ff69603…` — built from the train head,
Ready, 54 s build):

| check | result |
| --- | --- |
| `/`, `/pricing` | 200 |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/mcp-registry-auth`, `/.well-known/mcp/server-card.json` | 200, expected bodies |
| `POST /api/mcp` unauthenticated | 401 `invalid_token` |
| `/dashboard` signed out, browser-like fetch | 307 to the Clerk dev handshake (same shape as production: bare fetch 404, navigation 307) |
| PR #163 on the merged build | that handshake hop produced one `clerk_auth_redirect` row in PostHog (`kind: handshake`, `reason: dev-browser-missing`, `path: /dashboard`, `bounce_count: 1`, `environment: preview`) |

Not re-run on the train: the browser-driven QA legs each PR already recorded on its own
preview (14 placeholder refusal, 16 A30 both legs, 16 A31 signed-out/signed-in, 18 A14
scope fixture, 7.21f ledger). The merge points between the five (`route.ts`,
`approvalNotify.ts`, `mcpClientSignals.ts`) are covered by the unit bundle and the
branch-DB test above; a targeted `qa-env-runner` pass scoped to capabilities 14, 16 and
18 against this preview is the remaining step before `/deploy-prod`, and is what the
train workflow makes the single QA run.

## Environment notes for whoever picks this up

- `gh` is unusable from this machine right now: the keyring token is invalid
  (`gh auth status`) and HTTPS to `api.github.com` fails certificate verification
  (a self-signed certificate in the chain — `git` and the Vercel CLI are unaffected).
  The release PR therefore has to be opened from the browser:
  `https://github.com/fgac-ai/fine_grain_access_control/compare/main...integration/2026-09-25`
- The five source PRs stay open until the train merges, then close with a pointer to
  the release PR (ADR-002 rollout step 4).

## v2 — scoped QA on the train preview (2026-09-25, qa-env-runner, built-in browser)

Scope: the assertions whose code paths the five PRs share; everything else `skip`
("out of train scope"). `npx tsx scripts/qa-coverage-check.ts`: 49 in-scope, 2 pass /
0 fail / 47 skip / 0 blocked.

| capability | assertion | result | evidence |
| --- | --- | --- | --- |
| 14 magic-link approvals | A17 placeholder account (PR #161) | pass | three `sheets_read_range` calls with an example.com `account` → placeholder refusal each time; PostHog `account_requested_placeholder: reserved_domain`, `notify_status: skipped_placeholder`, never ledgered. A real-looking unknown account → ordinary refusal, ledgered once, `notify_status: disabled` (no support sender on preview, expected) |
| 16 analytics | A31 clerk_auth_redirect (PR #163) | pass | signed-out `/dashboard`: one `handshake` row (`dev-browser-missing`, bounce 1) then one `sign_in` row (bounce 2); two signed-in navigations added zero rows |
| hosted-MCP smoke | merged `/api/mcp` route (PRs #162, #165) | pass | DCR + PKCE bearer for USER_A on the preview; `list_accounts` and `gmail_list` succeed; `$mcp_tool_call.client_name` follows the latest `initialize` name (PR #162's rule) |

Finding for a later train, not fixed here: `16_analytics_events.md` on `main` already
has two `### A29:` headings (argument aliases from PR #160, dead-grant notice from
PR #156) — the same registry collision this train hit with A30 and 7.31, and the
coverage checker's set-based parser collapses the two into one slot. ADR-002's
duplicate-id guard is the structural fix; renumbering the second A29 is the
one-line one.
