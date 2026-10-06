# Integration train 2026-10-05 — large transfers + REST/Drive enforcement parity as one release (v2: preview validated, ready for deploy-prod)

Branch: `integration/2026-10-05` (from `origin/main` at `9b55482`).
Architecture: `docs/adr/002_integration_trains.md` (fourth train).

## Candidate table (the selection Ken approved, 2026-10-05)

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #179 (incl. #176) | Temporary API keys; streamed downloads; 4 MB chunked uploads through FGAC with first-chunk recipient checks. #176: the REST proxy runs the shared classifier | Large files needed many windowed calls and uploads were impossible; #176 closes REST policy holes (upload/, batch, DELETE, Cc/Bcc) | 60 of 210 callers pull attachments, 25 hit the cap, 17 need 8+ calls each; uploads become possible | Local + preview, including the agent-unprompted tests | Anchor |
| #180 | The send-recipient parser fails closed on every send path | Unparseable recipients rode along beside a whitelisted address | Every sender protected. Cost: UTF-8 and IP-literal addresses can no longer be sent | Unit tests + trial merge | Yes (needs capability 10 A17) |
| #181 | Drive tree: every discovery path filtered or refused | Blocked files' names and links leaked through v2, changes, trailing slash | Flagged QA account only today; required before the beta widens | Local + preview | Yes |
| #183 | Drive tree: full-scope tokens outside the engine fail closed | A delegate could list a flagged owner's whole Drive | Flagged owners only (about 0.9% of Drive calls are delegated) | Local | Yes |
| #184 | Drive tree: agent-created files stay writable (every kind, MCP + REST) | Agents' own uploads became read-only under "Read everything" | Flagged account only today | Local | Yes |
| #185 (stacked on #184) | Per-file model: REST create/copy parity with MCP; copy is a read of its source | Same gap as #179's `5c3b104`, plus copy | Every REST user who uploads or copies | Local + its own preview (A16 12/12, A22 6/6) | Yes, merged with #179's fix |
| #175 | Monitoring 7.32 revision (docs) | Prevents misreading the client-mix metric | None (docs) | Production queries | Yes |
| #182 | `include_granted_scopes` on the reconnect leg | Tree users lost `drive` on every reconnect | Changes everyone's reconnect step | Local + preview | **No** (independent rollback) |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #179 (+#176) | `claude/large-api-payload-options-75c2d2` | none (first) | — |
| #175 | `claude/mcp-client-name-shared-registrations` | none | — |
| #180 | `claude/send-recipients-fail-closed` | policy parser, MCP route, capability 10 | #180's parser; `checkSendWhitelist` stays in `gmailRules.ts` (#176) with #180's refusal copy; the REST drafts/send union uses `draftSendRecipients`; capability 10 keeps A16 + A17 |
| #181 | `claude/drive-tree-listing-leak` | proxy route, policy comment, analytics | `classifyDriveDiscovery` wired into the classifier dispatch: refusals right after the tree engine resolves; file and shared-drive listing filters in `forwardDriveCall` (where Drive listings flow since #176); REST refusals stamp `drive_discovery_unfiltered` / `drive_blocked` |
| #183 | `claude/drive-tree-delegated-scope` | MCP + proxy routes, `package.json`, analytics, draft 22 | MCP passthrough keeps #181's engine discovery and adds #183's unconfined check; REST refuses unconfined discovery when the engine is off; **the train's no-rule non-Sheets/Docs/Slides file branch (from #179/#185) also refuses full-scope tokens** (#183 assumed REST refused every unruled file, which #179/#185 changed), failing closed with 503 when tokeninfo cannot say; draft 22 **A21 → A22** |
| #184 + #185 | `claude/drive-tree-create-autogrant`, `claude/drive-legacy-create-autogrant` (stacked, landed together) | proxy route (6 hunks), capability 10, draft 22, analytics | **One implementation**: #185's tree-aware `grantProxyCreatedFile` (`agentCreatedGrant`) replaces #179's per-kind helper, applied to creates and copies in `forwardDriveCall` and on the completing chunk of a resumable create. #184's `generateIds` pre-naming is not used: it exists because on main the resumable bytes never return through FGAC, but on the train's relay they do and the final chunk names the file (its lib helpers stay tested but unused by the proxy). `driveFileDenial` takes #185's rules: copy = read of source; copies and comments on a no-rule file refused; `drive_file_gate`. Capability 10 **A16 → A18**, draft 22 **A21 → A23**, **A22 → A24**; both plans annotated |
| train-owned | — | — | stray `a.json` (`{}`, from a #184 commit) removed; `test-drive-tree-access.ts` `require()` → ES imports (eslint); 2 route-level copy checks in `test-rest-proxy-policy.ts`; test stubs answer tokeninfo; CLAUDE.md "Bundling Threads Into One Validation/Deployment Cycle" (Ken, 2026-10-05) |

**Not landed:** #182 (held out; ships on its own). #176 is superseded by this
train (its commits arrive via #179) and should be closed by the release PR.

## Registries after landing

- Capability 10: A16 (#176), A17 (#180), A18 (#185). Draft 22: A21 (#181), A22
  (#183), A23 (#184), A24 (#185). Capabilities 23/24 (#179). No duplicates.
- Migrations: 0020, 0021 (#179 only), contiguous.
- `mcp:lint`: 43 test scripts, union of all branches.

## Validation

- **Unit (train head `2f419be`):** `tsc` clean; `npm run mcp:lint` exit 0 (43 scripts); eslint clean on every changed file.
- **Preview `bc9a6ab` / `2f419be`** (fresh `preview/integration/2026-10-05` Neon branch; built-in browser + DCR bearers; QA runners):

| Scope | Result |
| --- | --- |
| Capability 23, temporary keys: A1–A11, A13 | pass (A12 passed on #179 locally in auto mode, with no code change in its path) |
| Capability 24, large transfer: A1–A8, A10 | pass, including Vercel's 5 MB 413 (`FUNCTION_PAYLOAD_TOO_LARGE`, no FGAC row) and the rename of a resumable-created file (200, #184's grant on REST). A3's cross-profile chunk bullet passed in pass B, using a USER_B temporary key. A9 passed on #179. |
| Capability 10 A16, REST shared classifier (#176) | pass |
| Capability 10 A17, recipient parser fails closed (#180) | pass on MCP, REST JSON send and drafts/send |
| Capability 10 A18, REST per-file Drive parity (#185) | pass after `2f419be`. Pass B found `drive_file_gate` missing on flag-off rows: a #184/#185 landing slip, fixed and re-tested. |
| Capability 01, send whitelist A1/A2 spot check | pass |
| Draft 22 A21, discovery (#181) | pass (no shared drive to test the shared-drive bullet) |
| Draft 22 A22, unconfined full scope (#183) | **not exercisable on this preview**: the USER_A→USER_B delegation reads "no longer active" because the copied-production DB holds two USER_A rows and the owner lookup by email picks the wrong one (known: `docs/bug_reports/duplicate_user_rows_break_delegation.md`; code path untouched by the train). Covered by #183's local validation and `test-drive-unconfined-scope.ts`. |
| Draft 22 A23, agent-created files writable (#184) | pass on MCP and REST (metadata, media and resumable creates) |
| Draft 22 A24, copy is a read (#185) | pass |

Coverage check: all in-scope assertions accounted for, 0 fail. The four draft-22 rows show as unknown ids, as expected because drafts aren't parsed.

## Follow-ups found during train QA (none introduced by the train)

- USER_A's full `drive` scope narrows on every Google sign-in, and once dropped on its own. **#182** addresses the reconnect leg; the sign-in leg is still open.
- Approval links, the "Write denied" link and the profile MCP URL use `https://fgac.ai` on preview hosts.
- Drive-tree settings appear in the Gmail Rules card. The tree view shows an agent-created file as "Read" until refreshed.
- The REST drafts/send refusal for an unparseable stored draft tells the caller to send a JSON `raw` body, which is wrong for drafts/send.
- Dashboard banner copy: "recentlywith", and "it" used for 2 agents.
- Duplicate user rows break delegation on copied-production previews (existing bug report).
