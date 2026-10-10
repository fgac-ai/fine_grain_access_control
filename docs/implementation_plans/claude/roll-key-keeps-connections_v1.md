# Roll key keeps connections — v1 (2026-10-10)

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
- [x] unit (`mcp:lint`, 22 new checks), tsc, eslint
- [ ] local UI
- [ ] preview + qa-env-runner (key lifecycle A3/A4/A9)
