# Roll key keeps connections — v2 (2026-10-10)

v2: validation recorded (preview QA, audit, one re-test round). Design unchanged from v1.

Branch: `claude/roll-key-keeps-connections`

## Bug
`rollProxyKey` inserted a new `proxy_keys` row, copied `key_email_access` and
`key_rule_assignments`, then revoked the old row. Every other reference to
`proxy_keys.id` stayed on the revoked row, so every MCP connection on a rolled
profile became `profile_revoked` (src/lib/connectionState.ts on
`claude/revoked-key-orphaned-connections`) and was refused until re-attached.
The copy also dropped `is_default` (a rolled Default Profile stopped being the
default), `drive_default`, and `public_key` (the credentials JSON flow broke).

## Reachability (observed)
Roll was **unreachable from the UI**. `KeyControls` is mounted twice: as the
"+ New profile" button (`variant="button"`, no key list) and on the no-profile
page with `existingKeys={[]}`. The panel list holding the Roll button never
rendered. The exported server action was still callable.

Decision: **fix, and expose it on the profile header** as "Rotate key". The
profile secret is still live (REST proxy, CLI/partner token routes, service
account JSON), so a compromise control is worth having, and the QA assertion
needs a real UI path. The dead Roll button in the legacy panel is removed (it
would have discarded the new key).

## Fix: rotate in place
`src/db/rotateProfileKey.ts` updates `key` (and `public_key`, when the profile
has one) on the SAME row. Because the id never changes, every reference
follows by construction — there is no list of tables to re-point and keep in
sync as tables are added.

Reference audit (`references(() => proxyKeys.id`, 7 total):

| table | on rotation | why |
| --- | --- | --- |
| `agent_connections.proxy_key_id` | follows | the bug; their OAuth bearer, not the secret, authenticates them |
| `key_email_access` | follows | profile config |
| `key_rule_assignments` | follows | profile config |
| `approval_requests` | follows | links resolve the profile by id; history |
| `account_refusals` | follows | per-profile ledger |
| `resumable_uploads.parent_key_id` | follows | chunks must still authenticate as the profile |
| `temporary_api_keys.parent_key_id` | **revoked** | a leaked standing key can mint temp keys via the REST proxy |

`notification_subscriptions` (and `webhook_deliveries`) hang off
`agent_connections`, so they follow too.

Both writes (key update scoped to owner + unrevoked; temp-key revoke) run in one
`db.batch` — a single transaction on neon-http (see src/lib/notifyClaimLock.ts).
Telemetry: `agent_profile_key_rotated` (`temp_keys_revoked`, `has_service_account`).

No schema change, no migration.

## Tests
- `scripts/test-key-rotation.ts` in `npm run mcp:lint`: no insert, id unchanged,
  scoped WHERE (rendered SQL), connection still usable, temp keys revoked, new
  keypair for service-account profiles, refusals, and a 7-reference audit pin.
- QA: `07_key_lifecycle.md` A3/A4 rewritten for Rotate; new **A9 Connections
  survive a rotation**. Throwaway profile + throwaway connection only — never the
  profile bound to the stored QA bearer (`scripts/qa-mcp-token.ts`).

## Validation
- [x] unit: `scripts/test-key-rotation.ts` (22 checks) in `npm run mcp:lint`; tsc, eslint clean
- [x] local: dev server on the branch's own Neon branch booted, `env:check` consistent.
  The dashboard leg was **blocked locally** — the built-in pane refuses localhost and the
  Path B CDP profile's Google sessions had lapsed — so the branch opted into one preview
  (`[preview]` commit bba5885, ADR-002's deployed-URL exception).
- [x] preview QA (qa-env-runner, built-in browser), key lifecycle A3/A4/A9 — pass:
  - A3: old key 200 → 401 after rotation; new key 200 (`me` and mailbox forms); a temp key
    minted ~50 s before the rotation went 200 → 401 with ~14 min of TTL left (expiry ruled
    out); second rotation made the round-1 key 401 too. Panel text and "Download Service
    Account JSON" rendered; no native dialog.
  - A4: profile with 2 rules and Drive default "Only files I allow" — BEFORE/AFTER snapshot
    (slug, tabs, mailboxes, rules, Drive card, Connected Agents) identical except the
    Temporary keys row, which rotation revokes by design.
  - A9: throwaway DCR connection bound to the throwaway profile before rotation;
    `list_accounts` with the unchanged bearer byte-identical after the second rotation;
    connection still Approved under the same tab, no `profile_revoked` / re-attach state.
- [x] qa-coverage-auditor: round 1 upheld A3/A9 and called A4 weak (empty rules, no Drive
  setting, no before snapshot); one re-test round closed every finding above.
- Untestable in the pane: the Copy button (isolated clipboard).
- Stored QA bearer: never rotated/revoked; `qa-mcp-token.ts check` 200 after the run. The
  runner registered its throwaway client via `start --new-client`, moved it to a scratch
  store (`scratch_A.json` in the main clone's `.secrets/qa-mcp/`) and restored `user_A.json`.

## Follow-ups (not in this branch)
- `KeyControls`' `variant="panel"` key list is dead code (no mount passes keys); the
  user guide's "Managing API Keys → Viewing Your Keys" still describes it.
