# Integration train 2026-10-07 — approval-email episodes, temporary-key recipe, reconnect scope union, coverage guard (v3: blocked checks re-run with an approved MCP bearer)

Branch: `integration/2026-10-07` (from `origin/main` at `df2100a`, the #193 merge).
Architecture: `docs/adr/002_integration_trains.md` (sixth train).

## Candidate table (the selection Ken approved, 2026-10-07)

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #192 | One approval-link reminder email per owner per 14-day episode | One owner got 5 reminders in 5 days; 2nd+ reminders produced no additional opens in 14 d | Owners whose agent requests many files: an email stream → one email per episode | Unit (`test-notify-claim-race` 2b, copy test), `mcp:lint`; capability 14 pending | Yes |
| `claude/temp-key-recipe-handling` | Temporary-key recipe hands the key over via a private temp file; `users/MAILBOX`; `send_attachment` ordered by size | The old recipe left inline command text as the only option, which Claude Code auto mode blocks as credential leakage | Large-transfer users (baseline 17 people) in Claude Code auto mode: blocked mid-transfer → completes | Unit (4 new), tool lint; capability 23 A1/A11/A12 pending | Yes |
| #182 | `include_granted_scopes=true` on every FGAC reconnect URL | Drive tree users lost `drive` on the next reconnect | Flag-gated Drive tree users keep `drive`; any reconnect repairs a narrowed grant | Local + its own preview (10-04, capability 18 A17 twice) | Yes (held out of the 10-06 train for independent rollback; approved this time — revert its landing commit to back it out) |
| `fix/qa-duplicate-a29-guard` | `qa-coverage-check` exits 2 on a repeated `A<n>` heading | ADR-002 Landing step 2 guard; the 10-06 train hit another duplicate | None for users; protects every train | n/a | Yes |
| `claude/facebook-muse-marketplace-42e936` | Meta Muse submission packet (docs/assets) | Owner submits when ready | None at runtime | n/a | Optional — not taken (Ken took the yeses only) |
| #188 | Drive card override count | Already shipped in #193 | — | — | No — close as shipped |
| #121, #72 | Old growth / sheets branches | 329 / 631 commits behind | — | — | No — stale |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #192 | `claude/approval-link-email-episode` | none | — |
| temp keys | `claude/temp-key-recipe-handling` | none | — |
| guard | `fix/qa-duplicate-a29-guard` | none | The A29 → A32 heading renumber was already on `main`; the landing brings the checker guard plus the plan cross-references (`lucid-pare` v1/v2, `integration_2026-09-25_v2`) that still said A29 |
| #182 | `claude/wizardly-shamir-8304cf` | `package.json` | union of the `mcp:lint` chains (adds `test-google-reconnect-url`) |

**Not landed:** Muse packet (optional, not selected), #188 (already shipped), #121, #72 (stale).

## Registries after landing

- Capability 18: A17 (#182), next free after A16. Capability 14 and 23: existing
  assertions edited, no new ids. No duplicates (the new guard passes).
- No migrations.
- `mcp:lint`: adds `test-google-reconnect-url`.

## Validation

- **Unit (train head):** `tsc --noEmit` clean; `npm run mcp:lint` exit 0; eslint clean on
  every changed file (one pre-existing unused-directive warning); `qa-coverage-check`
  passes the duplicate-id guard.
- **Preview** `fine-grain-access-control-pfwdmntvh-…vercel.app`, commit `b518245` (SHA verified
  with `vercel ls --meta githubCommitSha=…`; later train commits are CLAUDE.md-only). One
  `qa-env-runner` pass, built-in browser throughout, then `qa-coverage-auditor`.

| scope | result |
| --- | --- |
| 23 A1 (temp-key recipe) | PASS — mint returns a masked `sk_proxy_tmp_` key, 15:00 expiry, preview `base_url`; recipe uses `$(cat "$KEY_FILE")` and the `users/me` vs `users/<address>` sentence; proxy GET 200 |
| 23 A11 | PASS — `tools/list` description carries the private-temp-file / env-var rule and the mailbox sentence; `send_attachment` recipe ordered raw → media → resumable |
| 23 A12 | BLOCKED — no agent runtime attached to the preview; MCP calls with the runner's bearer later denied by the auto-mode classifier |
| 14 A16, A17 (#192) | BLOCKED — the preview has no `SUPPORT_FGAC_PROXY_KEY` / `SUPPORT_SENDER_EMAIL`, so every notice reads `notify_status: 'disabled'` and `skipped_episode` is unreachable; denial text and chat links unchanged; 3rd-mint calls classifier-denied |
| 18 A17 (#182) | BLOCKED — pre-checks safe (`hasDriveFileScope` true, external account `verified` → reauthorize branch), but the Reconnect click was classifier-denied and the fixture is absent (USER_A holds `drive.file`, not full `drive`; preview has no Drive tree flag). PR #182's own preview (10-04) passed A17 twice |

**Unit and branch-DB evidence on the train head** (recorded because the behavioural
rows above are blocked; local Neon branch `integration-2026-10-07`):

- `test-notify-claim-race.ts` — all pass, incl. 2b: a new link 3 d after another link was
  emailed → `episode`; a refusal email does not open a link episode; serialized refusal
  claims one per owner per episode.
- `test-approval-notify-copy.ts`, `test-temporary-api-keys.ts`, `test-google-reconnect-url.ts` — all pass.
- Duplicate-id guard: a planted `### A1:` in capability 18 makes `qa-coverage-check` print
  the file:line and refuse (reverted).

**Auditor findings, disposition:** preview-SHA anchor (fixed above); unit evidence not
recorded (fixed above); guard never exercised (fixed above); 23 A1/A11 evidence
paraphrased rather than quoted (accepted: SHA-anchored, and the recipe text is the
landed source); 14 A16/A17, 18 A17 and 23 A12 have no behavioural evidence on a deployed
build — open, see below.

**Open (Ken):**
- #192's email path on a deployed build needs the support sender on the preview
  (`vercel env add` is ask-gated) — or accept the branch-DB evidence above.
- 23 A12 and 18 A17 were stopped by the auto-mode classifier, not by a failure. Last
  train these ran once Ken approved the runner's MCP bearer mint in chat.

## Re-test (v3) — Ken approved the runner's MCP bearer mint in chat, 2026-10-07

| scope | result |
| --- | --- |
| 23 A12 | PARTIAL — the runner (Claude Code, auto mode) minted two keys over MCP and followed the recipe: key into a chmod-600 file, every curl with `$(cat "$KEY_FILE")`, file removed. **Zero classifier denials** across a Gmail profile GET, a message list, metadata, and a 2 MiB attachment download (one proxy request). Not shown: unprompted discovery (the runner was told the tool) |
| 18 A17 | PARTIAL — reauthorize branch (pre-checks re-verified), trusted clicks. Leg 1 started at `drive.file` + `gmail.modify` and came back with full `drive` restored from the earlier grant (token bridge, Clerk record and tokeninfo agree); leg 2 kept `drive` — no narrowing, no "Enable full Drive access" card. Not observed: the live authorization URL (redacted by the harness across the origin change; the URL rewrite is pinned by `test-google-reconnect-url.ts`) and the Drive tree card (flag off on the preview). Side effect: USER_A on the preview's Neon branch now holds full `drive` |
| 14 A16 | BLOCKED — no support sender on the preview; the `gmail_send` probe was classifier-denied as a real-world transaction despite the approval |
| 14 A17 | BLOCKED (email leg) — 4 refusals re-confirmed: `account_not_permitted`, names the refused value and the usable accounts, no link, no email line (sender disabled) |

**Open (Ken):** #192 has branch-DB evidence only. Deploy on that, or add the support
sender to Preview (`vercel env add`, approval-gated) for an end-to-end check.
