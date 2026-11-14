# Scope `key_rule_assignments` reads to the owner — v1

Branch: `claude/scope-rule-assignment-reads` · 2026-11-14

## Problem

Neon public network transfer for the production project grew from 7.4 GB
(September) to 69.2 GB (October) to 80.9 GB in the first 14 days of November,
on flat compute (~42 CU-h/week). The Launch plan includes 100 GB/month.

Weekly transfer stepped up the week temporary API keys shipped (3.5 GB →
13.9 GB, week of 2026-10-04) and has tracked REST-proxy request volume since
(51 GB in the week of 2026-11-08, against ~165k proxy requests). That is roughly
200–300 KB of database transfer per proxy request, and the per-request figure
has been rising.

## Cause (observed in code; production row count not measured)

Eight call sites answered "is this rule global or assigned to specific keys?"
by reading the entire `key_rule_assignments` table — every owner's rows — and
then looking up only the caller's own rule ids:

| site | path |
| --- | --- |
| `loadApplicableRules` | `src/lib/gmailRules.ts` (MCP + REST + notification filter) |
| `loadProxyDriveTree`, `proxyDriveFileDenial`, typed file gate | `src/app/api/proxy/[...path]/route.ts` (3 sites) |
| `checkDriveFileAccess`, `loadDriveTreeSettings`, `get_my_permissions` | `src/app/api/mcp/route.ts` (3 sites) |
| rules listing | `src/app/api/rules/fileAccessHandlers.ts` |
| dashboard loader | `src/app/dashboard/loadDashboard.ts` |

The table grows with every user and every auto-granted or agent-created file
rule, which fits the rising per-request cost. The link between this read and
the transfer volume is inferred from the code and the timing; it is confirmed
only when transfer per request falls after deploy (see Measurement).

## Change

`src/lib/ruleAssignments.ts` adds `loadRuleAssignmentsForUser(userId)`:

```sql
select … from key_rule_assignments
where access_rule_id in (select id from access_rules where user_id = $1)
```

All eight sites call it with the same owner id they already use to load that
owner's `access_rules`. No schema change, no migration.

**Why behaviour is unchanged.** Every consumer of the old full-table result
either builds `Set(accessRuleId)` and tests membership for the owner's own
rule ids, or filters by `proxyKeyId` and then tests membership for the owner's
own rule ids, or groups rows under the owner's own rules. Rows belonging to
other owners' rules were never read after loading. Restricting the read to the
owner's rules returns exactly the rows that were used.

A subquery (not `inArray(ids)`) is used so an owner with thousands of
agent-created rules does not turn into thousands of bind parameters.

## Regression guard

`scripts/test-rule-assignment-reads.ts` (wired into `npm run mcp:lint`) fails
when any `.from(keyRuleAssignments)` in `src/` is not immediately followed by
`.where` / a join, and asserts the helper filters by owner.

## Validation

| check | status |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm run mcp:lint` (incl. the new guard) | pass |
| `eslint` on the changed files | pass (repo-wide eslint has pre-existing errors in unrelated files) |
| Generated SQL inspected via drizzle `QueryBuilder.toSQL()` | matches the statement above |
| Local run against a `db:branch` database | **not run** |
| Preview deploy + QA suites | **not run** |

QA scope when it runs: this touches rule resolution on every enforcement path,
so the rule-scoping capabilities matter most — global vs profile-assigned
rules on Gmail read/send, the Sheets/Docs/Slides file gates over both MCP and
the REST proxy (standing and temporary keys), `get_my_permissions`, and the
dashboard rules page showing per-profile assignments.

## Measurement after deploy

`bash ~/.claude/fgac-usage-budget.sh` prints period-to-date public egress;
the daily series comes from Neon's
`/consumption_history/v2/projects?…&granularity=daily&metrics=public_network_transfer_bytes`.
Before-figures: 51.3 GB in the week of 2026-11-08; 7–15 GB on the three
busiest days (11-11 → 11-13). Success = daily transfer falls by well over half
at similar proxy volume (`proxy_request` count in PostHog for the same days).
If it does not, the full-table read was not the main source and the next
suspect is whatever else the proxy path selects per request.

## Not in this change

- No index on `key_rule_assignments.access_rule_id`. The unique index leads
  with `proxy_key_id`, so the scoped read is a sequential scan of a small
  table inside the database — cheap, and no longer shipped to the client. An
  index would need a migration and can follow if query time ever shows up.
