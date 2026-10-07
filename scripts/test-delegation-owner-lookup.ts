/**
 * Pins the delegated-mailbox owner lookup (src/db/delegationOwner.ts).
 * Run: npx tsx scripts/test-delegation-owner-lookup.ts  (part of `npm run mcp:lint`)
 *
 * Background (2026-10-05 local QA): the MCP route, the REST proxy and partner
 * provisioning each picked ONE `users` row by address
 * (`eq(users.email, target)).limit(1)` — unordered, tombstones included) and
 * then asked whether THAT row had delegated to the key owner. An address with
 * several rows (Clerk id re-issue; every fresh db:branch) could return a row
 * that is not the delegation's owner, so a live delegation read as
 * `delegation_inactive`. The lookup must start from the delegation instead.
 *
 * The SQL is rendered with drizzle's connection-free QueryBuilder, so this
 * needs no database.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { activeDelegationOwnerQuery } from '../src/db/delegationOwner';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const owner = ['Owner', 'Example.com'].join('@');
const { sql, params } = activeDelegationOwnerQuery(new QueryBuilder(), owner, 'delegate-id').toSQL();
const q = sql.toLowerCase().replace(/\s+/g, ' ');

check('starts from email_delegations', /from "email_delegations"/.test(q));
check('joins users on the delegation owner id',
  /join "users" on "email_delegations"\."owner_user_id" = "users"\."id"/.test(q));
check('filters on the delegate', q.includes('"email_delegations"."delegate_user_id" = $'));
check('only active delegations', q.includes('"email_delegations"."status" = $') && params.includes('active'));
check('excludes tombstoned owners', q.includes('"users"."deleted_at" is null'));
check('address match is case-insensitive', q.includes('lower("users"."email") = $')
  && params.includes(owner.toLowerCase()));
check('newest delegation wins', /order by "email_delegations"\."created_at" desc/.test(q));
check('single row', / limit \$?\d*/.test(q));

// ---- Structural: no call site keeps the row-first lookup -------------------
const root = join(__dirname, '..');
const sites = [
  'src/app/api/mcp/route.ts',
  'src/app/api/proxy/[...path]/route.ts',
  'src/lib/partner/provision.ts',
];
for (const file of sites) {
  const src = readFileSync(join(root, file), 'utf8');
  check(`${file} uses findActiveDelegationOwner`, src.includes('findActiveDelegationOwner('));
  check(`${file} has no row-first owner lookup`,
    !/\.from\(users\)\s*\.where\(eq\(users\.email,[^)]*\)\)\s*\.limit\(1\)/.test(src));
}

if (failures) {
  console.error(`\n${failures} delegation-owner check(s) failed`);
  process.exit(1);
}
console.log('\nAll delegation-owner checks passed');
