/**
 * Unit tests for the per-user feature flag resolver (src/lib/featureFlags.ts).
 * Run: npx tsx scripts/test-feature-flags.ts  (part of `npm run mcp:lint`)
 */
import { resolveDriveTreeFlag, resolveDriveTreeFlagAsync, describeDriveTreeFlag, _resetFlagCache, DRIVE_TREE_FLAG, type FlagEvaluator } from '../src/lib/featureFlags';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

console.log('resolveDriveTreeFlag:');

check('nothing set → off', !resolveDriveTreeFlag({}, { clerkUserId: 'user_1', email: 'someone@example.com' }));
check('FGAC_DRIVE_TREE=1 → on for anyone, even with no identity', resolveDriveTreeFlag({ FGAC_DRIVE_TREE: '1' }, {}));
check('FGAC_DRIVE_TREE=true / on / yes accepted', ['true', 'ON', ' yes '].every(v => resolveDriveTreeFlag({ FGAC_DRIVE_TREE: v }, {})));
check('FGAC_DRIVE_TREE=0 → off', !resolveDriveTreeFlag({ FGAC_DRIVE_TREE: '0' }, { clerkUserId: 'user_1' }));

const allow = { FGAC_DRIVE_TREE_USERS: 'user_abc, Ken@Example.com ,user_def' };
check('allowlist by Clerk id', resolveDriveTreeFlag(allow, { clerkUserId: 'user_def' }));
check('allowlist by email, case-insensitive', resolveDriveTreeFlag(allow, { email: 'ken@example.com' }));
check('allowlist: other user off', !resolveDriveTreeFlag(allow, { clerkUserId: 'user_zzz', email: 'other@example.com' }));
check('allowlist: an email entry never matches an id, nor the reverse',
  !resolveDriveTreeFlag({ FGAC_DRIVE_TREE_USERS: 'user_abc' }, { email: 'user_abc' }) &&
  !resolveDriveTreeFlag({ FGAC_DRIVE_TREE_USERS: 'ken@example.com' }, { clerkUserId: 'ken@example.com' }));
check('empty allowlist entries ignored', !resolveDriveTreeFlag({ FGAC_DRIVE_TREE_USERS: ' , ,' }, { clerkUserId: '' }));
check('global on wins over an allowlist that excludes the user',
  resolveDriveTreeFlag({ FGAC_DRIVE_TREE: '1', FGAC_DRIVE_TREE_USERS: 'user_other' }, { clerkUserId: 'user_me' }));

console.log('describeDriveTreeFlag:');
check('off / PostHog description never lists users', !describeDriveTreeFlag({}).includes('@'));
check('global description', describeDriveTreeFlag({ FGAC_DRIVE_TREE: '1' }).startsWith('ON for everyone'));
check('allowlist description counts, never lists', describeDriveTreeFlag(allow).startsWith('ON for 3 allowlisted users') && !describeDriveTreeFlag(allow).includes('@'));

console.log('resolveDriveTreeFlagAsync (PostHog path, cached, fail closed):');
(async () => {
  const calls: Array<{ key: string; email?: string | null }> = [];
  const make = (answer: () => Promise<boolean | undefined>): FlagEvaluator => async (key, user) => { calls.push({ key, email: user.email }); return answer(); };
  const me = { clerkUserId: 'user_me', email: 'Me@Example.com' };

  _resetFlagCache();
  check('env override wins without asking PostHog', await resolveDriveTreeFlagAsync({ FGAC_DRIVE_TREE: '1' }, me, make(async () => false)) === true && calls.length === 0);

  _resetFlagCache();
  check('PostHog true → on, asked with the flag key', await resolveDriveTreeFlagAsync({}, me, make(async () => true)) === true && calls.length === 1 && calls[0].key === DRIVE_TREE_FLAG);
  check('second call within the TTL is served from the cache', await resolveDriveTreeFlagAsync({}, me, make(async () => false)) === true && calls.length === 1);
  check('the cache expires after 60 s', await resolveDriveTreeFlagAsync({}, me, make(async () => false), Date.now() + 61_000) === false && calls.length === 2);

  _resetFlagCache();
  check('PostHog undefined (no verdict) → off', await resolveDriveTreeFlagAsync({}, me, make(async () => undefined)) === false);
  _resetFlagCache();
  check('PostHog throwing → off (fail closed)', await resolveDriveTreeFlagAsync({}, me, make(async () => { throw new Error('boom'); })) === false);
  _resetFlagCache();
  check('a failure is cached too, so an outage costs one call per user per minute', (await resolveDriveTreeFlagAsync({}, me, make(async () => { throw new Error('boom'); })), calls.length) === (await resolveDriveTreeFlagAsync({}, me, make(async () => true)), calls.length));
  _resetFlagCache();
  check('no identity at all → off without asking', await resolveDriveTreeFlagAsync({}, {}, make(async () => true)) === false);
  _resetFlagCache();
  const before = calls.length;
  await resolveDriveTreeFlagAsync({}, { clerkUserId: 'user_a', email: 'a@example.com' }, make(async () => true));
  await resolveDriveTreeFlagAsync({}, { clerkUserId: 'user_b', email: 'b@example.com' }, make(async () => true));
  check('the cache is per user', calls.length === before + 2);

  if (failures > 0) {
    console.error(`\n${failures} feature flag check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll feature flag checks passed');
})();
