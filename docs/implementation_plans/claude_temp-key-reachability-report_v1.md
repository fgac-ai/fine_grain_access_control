# Temporary keys: report why the reachability check failed (v1)

Branch: `claude/temp-key-reachability-report` (from `integration/2026-10-08`; extends #197,
which is not on `main` yet). Landed onto train `integration/2026-10-08`.

## Problem

#197 tells agents to run `curl -sS <host>/api/proxy/ping` before minting a temporary key.
Two different failures produce the same nothing on our side:

- **Network blocked**: the sandbox's egress allowlist does not include fgac.ai. The fix is
  the user allowing the host in the sandbox's network settings.
- **Agent rules blocked**: the agent's own permission rules (e.g. Claude Code auto mode,
  an approval prompt the user declined) refuse to run the command. The network was never
  tried. The fix is approving or allowing the command. Telling this user to change network
  settings is wrong advice.

Neither request reaches FGAC, and the keyless ping was not captured at all (no key, no
person). After #197 we could only infer the check from a drop in mints. (Ken, 2026-10-09:
"capture checks before minting to distinguish between people not having access from
claude rules blocking access".)

## Design

The pre-mint ping cannot carry identity: tool descriptions are built once per process with
no sign-in context (`registerFgacTools` has no request). So the attributable signal is the
agent's own report, made on a tool it already has:

1. `create_temporary_api_key` gains optional `reachability` (`ok` | `unreachable` |
   `command_denied`) and `check_output`.
   - `ok` mints as before.
   - `unreachable` / `command_denied` mint nothing, return a cause-specific reply (what to
     tell the user, plus the windowed fallback) and emit `temp_api_key_check_failed`.
   - Omitted = legacy behaviour (mint). `temp_api_key_created.reachability` =
     `not_reported`, which measures how many agents skip the check.
2. The minted recipe's failure bullet asks for the same report if the keyed ping fails.
   `after_mint` (the connection has a live key) marks those.
3. The keyless ping emits anonymous `proxy_ping_checked` (one shared distinct id,
   `$process_person_profile: false`), to corroborate `ok` reports in aggregate.
4. `check_output` is the first line only, ≤160 chars, with `sk_proxy_…` and `Bearer …`
   redacted.

The description stays under the lint's 1,500-character cap: the fallback and user advice
moved from the description into the failure reply, so the description only has to say
"pass what happened as reachability".

**Limits (stated, not hidden):** the classification is the agent's word. An agent can
mislabel a proxy 403 as `command_denied`; sample `check_output` to audit. An agent
that runs no check and mints anyway still shows as `not_reported`.

## Measurement

`docs/monitoring.md` §7.34 (8): per client, `network_blocked` vs `agent_rules_blocked` vs
`minted_after_ok` vs `minted_unreported`, plus failures after a mint. The before figure is
zero by construction (nothing was observable). Analytics rows in `docs/analytics.md`.

## Validation

- Unit (`scripts/test-temporary-api-keys.ts`): reply text per cause, after-mint wording,
  output sanitising, the recipe's report line, route ordering (the failure is captured and
  returns before any key insert), `not_reported` on mints, the anonymous ping event. `tsc`,
  `mcp:lint` (incl. the description length cap) and eslint pass.
- QA: capability 23 **A15** (new) on the train preview, plus an A12 real-agent regression
  (the agent should now pass `reachability: "ok"` unprompted).
