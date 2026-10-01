/**
 * Unit tests for the per-user feature flag resolver (src/lib/featureFlags.ts).
 * Run: npx tsx scripts/test-feature-flags.ts  (part of `npm run mcp:lint`)
 */
import { resolveDriveTreeFlag, describeDriveTreeFlag } from '../src/lib/featureFlags';

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
check('off description', describeDriveTreeFlag({}) === 'off (FGAC_DRIVE_TREE / FGAC_DRIVE_TREE_USERS not set)');
check('global description', describeDriveTreeFlag({ FGAC_DRIVE_TREE: '1' }).startsWith('ON for everyone'));
check('allowlist description counts, never lists', describeDriveTreeFlag(allow) === 'ON for 3 allowlisted users (FGAC_DRIVE_TREE_USERS)');

if (failures > 0) {
  console.error(`\n${failures} feature flag check(s) failed`);
  process.exit(1);
}
console.log('\nAll feature flag checks passed');
