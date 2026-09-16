/**
 * Agent-profile adoption, counts only (docs/monitoring.md 7.24).
 *
 * Answers "is anyone using a profile other than the Default Profile?" from the
 * database, because no PostHog event carries a proxy-key id. Read-only: every
 * statement is a SELECT.
 *
 *   npx tsx scripts/profile-usage.ts                          # branch database
 *   npx tsx scripts/profile-usage.ts --prod                   # PRODUCTION (read-only)
 *   npx tsx scripts/profile-usage.ts --prod --since 2026-09-09
 *
 * --prod reads .secrets/prod.env (pull it with
 * `npx vercel env pull .secrets/prod.env --environment=production`; delete it
 * when done). Without --prod the development env file and branch database are
 * used, exactly like scripts/funnel-scopes.ts.
 *
 * Output is counts plus, for non-default profiles, the label's slug, the
 * owner's email DOMAIN, and usage figures — never an address or a key. It is
 * still production data: keep it in the session, never in an issue or PR.
 */
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';
import { slugifyProfileLabel } from '../src/lib/profileSlugs';

const PROD = process.argv.includes('--prod');
const sinceIdx = process.argv.indexOf('--since');
const SINCE = sinceIdx > -1 ? process.argv[sinceIdx + 1] : '2026-08-16'; // connector-directory launch
const PROD_ENV_PATH = '.secrets/prod.env';

if (PROD) {
  if (!existsSync(PROD_ENV_PATH)) {
    console.error(`--prod requires ${PROD_ENV_PATH} (npx vercel env pull ${PROD_ENV_PATH} --environment=production)`);
    process.exit(1);
  }
  config({ path: PROD_ENV_PATH });
} else {
  config({ path: '.env.local' });
}

// Internal + QA accounts to exclude — the same list every monitoring.md §7
// query uses. Never inlined here (public repo): the QA pair comes from the
// gitignored .qa_test_emails.json when present, the rest from
// REVIEW_EXCLUDED_EMAILS (comma-separated). The daily review passes all five.
const EXCLUDED: string[] = Array.from(new Set([
  ...(existsSync('.qa_test_emails.json')
    ? Object.values(JSON.parse(readFileSync('.qa_test_emails.json', 'utf8')) as Record<string, unknown>).filter((v): v is string => typeof v === 'string')
    : []),
  ...(process.env.REVIEW_EXCLUDED_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean),
].map(e => e.toLowerCase())));
if (EXCLUDED.length === 0) console.warn('warning: no internal accounts excluded — set REVIEW_EXCLUDED_EMAILS');

async function main() {
  const url = PROD
    ? (process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL)
    : process.env.neon__POSTGRES_URL;
  if (!url) throw new Error(PROD ? 'no production database url in .secrets/prod.env' : 'no neon__POSTGRES_URL — run npm run db:branch');
  const sql = neon(url);

  console.log(`Agent profiles (${PROD ? 'PRODUCTION' : 'branch'}, read-only; "new" = created since ${SINCE}) — counts only`);

  const dist = await sql`
    SELECT active_keys, nondefault_active, count(*)::int AS users FROM (
      SELECT u.id,
             count(k.id) FILTER (WHERE k.revoked_at IS NULL)::int AS active_keys,
             count(k.id) FILTER (WHERE k.revoked_at IS NULL AND NOT k.is_default)::int AS nondefault_active
      FROM users u LEFT JOIN proxy_keys k ON k.user_id = u.id
      WHERE u.deleted_at IS NULL AND u.email <> ALL(${EXCLUDED})
      GROUP BY u.id) t
    GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log('\nlive_keys|nondefault_live|users');
  for (const r of dist) console.log(`${r.active_keys}|${r.nondefault_active}|${r.users}`);

  const nd = await sql`
    SELECT k.label, k.created_at::date AS created, (k.revoked_at IS NOT NULL) AS revoked,
           split_part(u.email, '@', 2) AS owner_domain,
           (SELECT count(*) FROM agent_connections c WHERE c.proxy_key_id = k.id)::int AS conns,
           (SELECT max(c.last_used_at) FROM agent_connections c WHERE c.proxy_key_id = k.id)::date AS last_used,
           (SELECT count(*) FROM key_rule_assignments r WHERE r.proxy_key_id = k.id)::int AS rules,
           (SELECT count(*) FROM key_email_access a WHERE a.proxy_key_id = k.id)::int AS accounts,
           (SELECT count(*) FROM agent_connections c WHERE c.user_id = u.id)::int AS owner_conns,
           (SELECT count(*) FROM proxy_keys k2 WHERE k2.user_id = u.id AND k2.revoked_at IS NULL)::int AS owner_live_keys
    FROM proxy_keys k JOIN users u ON u.id = k.user_id
    WHERE NOT k.is_default AND u.deleted_at IS NULL AND u.email <> ALL(${EXCLUDED})
    ORDER BY k.created_at`;
  const newOnes = nd.filter(r => new Date(r.created as string) >= new Date(SINCE));
  console.log(`\nnon-default profiles: ${nd.length} total, ${newOnes.length} new, ${nd.filter(r => r.conns > 0).length} bound to a connection, ${nd.filter(r => r.revoked).length} revoked`);
  console.log('slug|created|revoked|owner_domain|conns|last_used|rules|accounts|owner_conns|owner_live_keys');
  for (const r of nd) {
    const created = new Date(r.created as string).toISOString().slice(0, 10);
    const lastUsed = r.last_used ? new Date(r.last_used as string).toISOString().slice(0, 10) : '-';
    console.log(`${slugifyProfileLabel(r.label as string)}|${created}|${r.revoked}|${r.owner_domain}|${r.conns}|${lastUsed}|${r.rules}|${r.accounts}|${r.owner_conns}|${r.owner_live_keys}`);
  }

  const conns = await sql`
    SELECT k.is_default, count(*)::int AS conns,
           count(*) FILTER (WHERE c.last_used_at > now() - interval '14 days')::int AS used_14d,
           count(DISTINCT c.user_id)::int AS users
    FROM agent_connections c JOIN proxy_keys k ON k.id = c.proxy_key_id JOIN users u ON u.id = c.user_id
    WHERE u.deleted_at IS NULL AND u.email <> ALL(${EXCLUDED})
    GROUP BY 1 ORDER BY 1`;
  console.log('\nagent connections by profile type:');
  for (const r of conns) console.log(`${r.is_default ? 'default profile' : 'non-default'}: connections ${r.conns}, used_14d ${r.used_14d}, users ${r.users}`);

  const pending = await sql`
    SELECT count(*)::int AS n, count(DISTINCT c.user_id)::int AS users
    FROM agent_connections c JOIN users u ON u.id = c.user_id
    WHERE c.proxy_key_id IS NULL AND u.deleted_at IS NULL AND u.email <> ALL(${EXCLUDED})`;
  console.log(`connections with no profile (pending): ${pending[0].n} (${pending[0].users} users)`);

  // The population separate profiles are designed for: several agents on one
  // account. How many of them still run everything on the Default Profile?
  const multi = await sql`
    SELECT count(*)::int AS users,
           count(*) FILTER (WHERE nondefault = 0)::int AS all_on_default
    FROM (
      SELECT c.user_id, count(*) FILTER (WHERE NOT k.is_default)::int AS nondefault
      FROM agent_connections c JOIN users u ON u.id = c.user_id
      LEFT JOIN proxy_keys k ON k.id = c.proxy_key_id
      WHERE u.deleted_at IS NULL AND u.email <> ALL(${EXCLUDED})
      GROUP BY c.user_id HAVING count(*) >= 2) t`;
  console.log(`users with 2+ agent connections: ${multi[0].users}, of which every connection is on the Default Profile: ${multi[0].all_on_default}`);
  console.log('Read with docs/monitoring.md 7.24 (attempts come from PostHog: agent_profile_created / agent_profile_create_failed).');
}

main().catch(err => { console.error(err); process.exit(1); });
