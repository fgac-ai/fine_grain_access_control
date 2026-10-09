# Temporary keys minted and never used: v1

Branch `claude/temp-key-never-used`. Source: the 2026-10-08 daily analytics review.
Production PostHog project, internal accounts excluded. Each claim below is marked
**observed** (it came out of a query), **inferred** (a reading of what was observed), or
**unknown**.

## What the data says (re-verified 2026-10-08, ~20:00Z)

Window: keys minted in the last 7 days, excluding the last 60 minutes so every key has had
time to be used. "Used" means at least one `proxy_request` with the same `temp_key_id`
(§7.34 (2)). The user agent comes from the `$mcp_tool_call` row of the mint, which carries
`temp_key_id`.

| client_name | user_agent | window | mints | never used | people (never-used) |
|---|---|---|---|---|---|
| claude-code | Claude-User | 10-06 → 01:00Z 10-08 deploy | 62 | 36 | 24 (19) |
| claude-code | Claude-User | after deploy | 47 | 20 | 15 (9) |
| claude-code | claude-code/* (direct CLI registration) | all | 2 | 0 | 1 (0) |
| Anthropic/ClaudeAI | Claude-User | before | 14 | 6 | 9 (5) |
| Anthropic/ClaudeAI | Claude-User | after | 16 | 4 | 4 (2) |

1. **Observed:** the finding's numbers hold. Since the post-deploy window has filled in,
   claude-code's never-used share after the deploy is 43% (20 of 47), not the 69% reported
   from the first 13 mints. Anthropic/ClaudeAI is at 25%.
2. **Observed:** every never-used key came through `Claude-User`, the claude.ai-managed
   connector. **Unknown:** which Claude Code surface (CLI, desktop, web, Cowork) sits behind
   each one. `Claude-User` hides the surface (monitoring 7.32), and the direct-CLI sample is
   two keys.
3. **Observed:** the problem is concentrated on **accounts**, not spread across keys. 54 of
   the 66 never-used keys sit on 18 accounts where no key ever worked. Accounts whose keys
   work almost always use them: one minted 29 and used 28, another minted 22 and used 18.
   The top three no-working-key accounts minted 19, 8 and 6 keys, all unused.
4. **Observed:** on those accounts the agent mints a key and then keeps going with windowed
   MCP calls (`gmail_get_attachment[w]`, `gmail_read[w]`, `sheets_read_range`). The pattern
   repeats once per task over two days, so the agent does not learn between sessions. 13 of
   25 never-used `download` keys were followed within 30 minutes by windowed attachment
   reads, against 0 of 12 used `download` keys.
5. **Observed:** no re-mint loop. Never-used keys come one per task, not in bursts. The
   10-key cap was never hit (no `temp_api_key_refused` rows).
6. **Observed:** the key hand-off is not failing. The proxy saw about 10 key 401s all week
   (`missing` ×9 from one account, `invalid` ×1). If the recipe's temp-file hand-off were
   broken, the 401s would come from the never-used accounts.
7. **Inferred:** these are sandboxes that block outbound traffic to `fgac.ai`. An
   environment-level wall explains every observation above: accounts split into
   always-works and never-works, the fallback to windowed reads, no requests and no 401s.
   We cannot observe it directly, because a blocked request never reaches us.
8. **Inferred:** the tool description invites the mint. It said "requires code execution
   with network access". An allow-listing sandbox *does* have network access (pip and the
   package registries work), so the agent reasonably concludes it qualifies.

**Rejected directions:**
- *Recipe or hand-off bug*: rejected per (6).
- *Re-mint loop*: rejected per (5).
- *Steering by surface*: needs a harness signal we don't have per (2). Steering every
  `Claude-User` client away would cut off the accounts in (3) where the key works, and
  those carry ~47k successful requests a week.

## Change

1. **`GET|HEAD /api/proxy/ping`** (new static route, so it wins over the `[...path]`
   catch-all). Without a key it answers `fgac-proxy-ok`, uncached. With a temporary key as
   the Bearer it answers `fgac-proxy-ok key-valid`, or a 401 with `key-expired` /
   `key-revoked` / `key-invalid` / `key-not-temporary`, and emits `temp_api_key_pinged`. It
   never calls Google.
2. **Tool description** (`create_temporary_api_key`): replace "network access" with a check
   the agent can run before minting: `curl -sS https://fgac.ai/api/proxy/ping` prints
   `fgac-proxy-ok`. On anything else: do not mint, use the named windowed fallback, and tell
   the user that allowing `fgac.ai` in their sandbox network settings enables large
   transfers. The description stays under the 1500-character lint (1360).
3. **Recipe** (`temporaryKeyRecipe`): the first command is the authenticated ping on the
   serving host. Its failure branch says to stop using the key, not to mint another this
   session, which tools to use instead, and which host the user should allow. `key-invalid`
   gets its own fix line (re-write the temp file).
4. **Pointers**: `gmail_get_attachment` and the large-file hint condition on "code you run
   can reach fgac.ai" instead of "network access".
5. **Docs**: `docs/analytics.md` row for `temp_api_key_pinged`; capability 23 gets A14 and
   an A11 update; `docs/monitoring.md` §7.34 (7) holds the before/after query and baseline.

Not changed: the proxy itself, the key lifetime and cap, and `gmail_send` /
`google_api_modify`. Those two defer to this tool, so they inherit the check.

## After-measure

`docs/monitoring.md` §7.34 (7). Before: claude-code 111 mints, 56 never used (50%); 54
never-used mints on 18 accounts with no working key. Target within a week of the prod
deploy: claude-code never-used share under 20%, driven by fewer mints on no-working-key
accounts, with mints on working accounts and their windowed-read volume (§7.34 (5)) flat.
`never_used_but_pinged` near zero. If it rises, agents reach FGAC and then drop the key,
which reopens the recipe question.

Caveat: the no-key pre-check is not captured, because it carries no person. The evidence
that agents run it is indirect: mints on the walled accounts fall.

## Validation

- Unit: `scripts/test-temporary-api-keys.ts` (ping route: no key, valid, expired, invalid,
  standing key, HEAD; recipe ordering and fallback; description pre-check). `npm run
  mcp:lint` and `tsc` are green.
- Preview: `/deploy-pr-preview`, then curl the ping with no key, then capability 23 A1, A11
  and A14 via `qa-env-runner` (hosted MCP).
- Production QA is not part of this change.
