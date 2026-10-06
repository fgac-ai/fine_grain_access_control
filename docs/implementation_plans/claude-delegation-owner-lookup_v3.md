# Delegated-mailbox owner lookup picks the wrong `users` row — v3

Branch: `claude/delegation-owner-lookup` · found 2026-10-05 during local QA on
`claude/drive-tree-delegated-scope`.

## Bug

Three places resolve a delegated mailbox's owner by picking ONE `users` row by
address, then checking for an active delegation from that row:

| file | path |
| --- | --- |
| `src/app/api/mcp/route.ts` `getGoogleToken` | MCP tools |
| `src/app/api/proxy/[...path]/route.ts` §7 | REST proxy |
| `src/lib/partner/provision.ts` | partner key provisioning |

`db.select().from(users).where(eq(users.email, targetEmail)).limit(1)` — no
ordering, no tombstone filter, case-sensitive. When an address has several
`users` rows (Clerk re-issued ids; every fresh `db:branch` copies the prod-id rows
next to the dev-id row), Postgres may return a row that is not the delegation's
`ownerUserId`, and a live delegation reads as `delegation_inactive` (MCP) /
"revoked or is not delegated to you" (proxy).

Repro: fresh `db:branch`, delegate USER_A → USER_B on the Accounts page, call any
tool on USER_A's mailbox with USER_B's key.

## Real-world size (read-only prod query, 2026-10-05, counts only)

- 2 of 343 live addresses have more than one live `users` row (9 rows total).
- Both are internal/QA accounts.
- 0 of 94 active delegations are owned by a duplicated address.

So no customer is affected today; the bug is latent (any future Clerk id
re-issue on a delegation owner would trigger it) and it breaks delegated QA on
every fresh branch.

## Fix

New helper `findActiveDelegationOwner(targetEmail, delegateUserId)` in
`src/db/delegationOwner.ts`: one query,
`email_delegations ⋈ users ON owner_user_id = users.id` filtered by
`lower(users.email) = lower(target)`, `delegate_user_id = key owner`,
`status = 'active'`, `users.deleted_at IS NULL`, newest delegation first. All
three call sites use it. The query builder is split out
(`activeDelegationOwnerQuery(qb, …)`) so the test can render its SQL with
drizzle's connection-free `QueryBuilder`.

Out of scope: `src/lib/notifications/gmail.ts` already tries every live row in
recency order; `dashboard/actions.ts`, `defaultProfile.ts`, `userHelpers.ts`
already filter tombstones and do not gate on a delegation.

## Test (failing first)

`scripts/test-delegation-owner-lookup.ts` (added to `mcp:lint`):
- the helper's SQL joins delegations to users on the owner id, filters on the
  delegate, `active`, `deleted_at is null`, and a lower-cased address;
- structural: none of the three call sites still contains the
  `eq(users.email, …)` + `.limit(1)` owner lookup, and each imports the helper.

## Validation

- Local: fresh `db:branch`, delegation USER_A → USER_B, USER_B's key reads
  USER_A's mailbox over MCP (was `delegation_inactive`).
- Preview via `/deploy-pr-preview`, hosted-MCP delegation assertions.

## Validation record (v2, 2026-10-05)

- `npm run mcp:lint` passes, including the new test. The test failed first:
  13 checks failed against a stub.
- **Local data repro (read-only, fresh branch `claude-delegation-owner-lookup`).**
  USER_A has 4 live `users` rows. A USER_A → USER_B delegation, created through
  the Accounts page by the QA runner, points at the newest of them. The old
  address-first `limit(1)` returned the same row on all 20 runs, and it was NOT
  the delegation owner, so the bug is deterministic on this branch rather than
  flaky. `findActiveDelegationOwner` returned the delegation owner and the
  delegation, including with the address upper-cased.
- **Local end-to-end call (USER_B key → USER_A mailbox over MCP and proxy):**
  blocked. The built-in pane refuses localhost origins. The shared Path B Chrome
  was in use by another session and then hit a Google password challenge, so
  USER_B could not sign in. This moves to the preview, which the built-in pane
  can open.

## Preview validation (v3, 2026-10-06)

Preview `fine-grain-access-control-wcl0w4fpg-kenyesh-gmailcoms-projects.vercel.app`,
commit 20e1b79. Built-in browser only.
- USER_A delegated their mailbox to USER_B on the Accounts page. On the
  preview branch, USER_A's address has several rows copied from production.
- USER_B used a DCR bearer for MCP. `list_accounts` returned 200, and USER_A
  came back `delegated: true, google_token: ok`, with both scopes `granted`.
  `gmail_list` on USER_A returned 200 with messages.
- USER_B's proxy key on `GET /api/proxy/gmail/v1/users/<USER_A>/messages`
  returned 200 with the same messages.
- Capability 04 A8 had recorded preview `owner_not_found` on delegated
  mailboxes as expected behaviour. That was this bug, so the caveat now says
  `owner_not_found` there is a FAIL.
- Side note, not from this PR: `/api/mcp` given a proxy key as Bearer answers
  401 "No authorization provided". The status is right (MCP is OAuth-only) but
  the wording is misleading.
- State left on the preview branch: the USER_A → USER_B delegation and a DCR
  connection "qa-setup-driver-pr189" on USER_B's Default Profile.
