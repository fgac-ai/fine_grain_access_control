/**
 * Unit tests for profile-addressed MCP URL slugs (src/lib/profileSlugs.ts).
 * Run: npx tsx scripts/test-profile-slugs.ts  (part of `npm run mcp:lint`)
 *
 * The invariant that matters: every slug slugifyProfileLabel produces must be
 * accepted by PROFILE_SLUG_RE and by the middleware's MCP_PROFILE_PATH_RE —
 * otherwise the dashboard would advertise a connect URL the middleware
 * refuses to route, which surfaces as "MCP endpoint not found" in the client.
 */
import {
  slugifyProfileLabel,
  PROFILE_SLUG_RE,
  MCP_PROFILE_PATH_RE,
  profileDashboardHref,
} from '../src/lib/profileSlugs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

console.log('slugifyProfileLabel:');
const CASES: Array<[label: string, slug: string]> = [
  ['Default Profile', 'default-profile'],
  ['All Access', 'all-access'],
  ['Research Bot', 'research-bot'],
  ['research-bot', 'research-bot'],          // idempotent on an existing slug
  ['  Padded  Label  ', 'padded-label'],
  ['Émile’s Agent', 'mile-s-agent'],         // non-ascii stripped, no leading -
  ['__weird--label__', 'weird-label'],
  ['ALL CAPS', 'all-caps'],
  ['a', 'a'],                                // single char is a valid slug
  ['!!!', ''],                               // nothing usable → empty
];
for (const [label, expected] of CASES) {
  const got = slugifyProfileLabel(label);
  check(`'${label}' → '${expected}'`, got === expected);
}

console.log('every non-empty slug is URL- and middleware-routable:');
for (const [label] of CASES) {
  const slug = slugifyProfileLabel(label);
  if (!slug) continue;
  check(`'${slug}' matches PROFILE_SLUG_RE`, PROFILE_SLUG_RE.test(slug));
  check(`/api/mcp/${slug} matches MCP_PROFILE_PATH_RE`,
    MCP_PROFILE_PATH_RE.test(`/api/mcp/${slug}`));
}

console.log('length cap:');
const long = slugifyProfileLabel('x'.repeat(200));
check('≤64 chars', long.length <= 64);
check('capped slug still routable', PROFILE_SLUG_RE.test(long));
const trailingAfterCap = slugifyProfileLabel(`${'x'.repeat(63)}-y`);
check('no trailing hyphen after cap', !trailingAfterCap.endsWith('-'));

console.log('the regexes refuse what the middleware must not route:');
const MUST_REJECT_PATHS = [
  '/api/mcp',                    // bare endpoint is NOT a profile path
  '/api/mcp/',
  '/api/mcp/UPPER',              // case-sensitive by design
  '/api/mcp/has space',
  '/api/mcp/a/b',                // only one segment
  '/api/mcp/-leading',
  '/api/mcp/trailing-',
  `/api/mcp/${'a'.repeat(65)}`,  // over-long
  '/api/mcp/../mcp',             // traversal shapes
];
for (const p of MUST_REJECT_PATHS) {
  check(`rejects ${JSON.stringify(p)}`, !MCP_PROFILE_PATH_RE.test(p));
}

console.log('collision detection (the createProxyKey rule):');
check("'Research Bot' collides with 'research-bot'",
  slugifyProfileLabel('Research Bot') === slugifyProfileLabel('research-bot'));
check("'Research Bot' collides with 'RESEARCH.BOT'",
  slugifyProfileLabel('Research Bot') === slugifyProfileLabel('RESEARCH.BOT'));
check("'Research Bot' does not collide with 'Research Bot 2'",
  slugifyProfileLabel('Research Bot') !== slugifyProfileLabel('Research Bot 2'));

console.log('profileDashboardHref (approval "Back to dashboard"):');
check('valid slug → that profile', profileDashboardHref('research-bot') === '/dashboard/agents/research-bot');
check('missing slug → /dashboard', profileDashboardHref(undefined) === '/dashboard');
check('empty slug → /dashboard', profileDashboardHref('') === '/dashboard');
check('path-traversal slug → /dashboard', profileDashboardHref('../accounts') === '/dashboard');
check('open-redirect slug → /dashboard', profileDashboardHref('//evil.example.com') === '/dashboard');
check('uppercase slug → /dashboard', profileDashboardHref('Research-Bot') === '/dashboard');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll profile-slug tests passed.');
