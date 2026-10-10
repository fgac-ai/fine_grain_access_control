/**
 * Unit tests for effective connection state (src/lib/connectionState.ts).
 * Run: npx tsx scripts/test-connection-state.ts  (part of `npm run mcp:lint`)
 *
 * The invariant that matters: an approved connection whose profile is
 * revoked, expired, or deleted is `profile_revoked` — never `approved` (MCP
 * would let it through) and never dropped (the dashboard would hide it with
 * no way to re-attach, the 2026-10-09 regression).
 */
import { connectionState, isKeyLive, reviewTarget, type KeyLiveness } from '../src/lib/connectionState';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const now = new Date('2026-10-09T12:00:00Z');
const keys = new Map<string, KeyLiveness>([
  ['live', { revokedAt: null, expiresAt: null }],
  ['live-future-expiry', { revokedAt: null, expiresAt: '2026-10-10T00:00:00Z' }],
  ['revoked', { revokedAt: new Date('2026-10-09T11:00:00Z'), expiresAt: null }],
  ['revoked-iso', { revokedAt: '2026-10-09T11:00:00.000Z' }],
  ['expired', { revokedAt: null, expiresAt: new Date('2026-10-09T11:59:59Z') }],
]);

console.log('isKeyLive:');
check('live key', isKeyLive(keys.get('live'), now));
check('future expiry is live', isKeyLive(keys.get('live-future-expiry'), now));
check('revoked (Date) is dead', !isKeyLive(keys.get('revoked'), now));
check('revoked (ISO string from JSON) is dead', !isKeyLive(keys.get('revoked-iso'), now));
check('past expiry is dead', !isKeyLive(keys.get('expired'), now));
check('missing key is dead', !isKeyLive(undefined, now) && !isKeyLive(null, now));

console.log('connectionState:');
const CASES: Array<[string, { status: string; proxyKeyId: string | null }, string]> = [
  ['pending stays pending', { status: 'pending', proxyKeyId: null }, 'pending'],
  ['blocked stays blocked', { status: 'blocked', proxyKeyId: null }, 'blocked'],
  ['blocked wins over a revoked key', { status: 'blocked', proxyKeyId: 'revoked' }, 'blocked'],
  ['approved on live key', { status: 'approved', proxyKeyId: 'live' }, 'approved'],
  ['approved on revoked key → profile_revoked', { status: 'approved', proxyKeyId: 'revoked' }, 'profile_revoked'],
  ['approved on expired key → profile_revoked', { status: 'approved', proxyKeyId: 'expired' }, 'profile_revoked'],
  ['approved on deleted key (SET NULL) → profile_revoked', { status: 'approved', proxyKeyId: null }, 'profile_revoked'],
  ['approved on unknown key id → profile_revoked', { status: 'approved', proxyKeyId: 'someone-elses' }, 'profile_revoked'],
];
for (const [name, conn, expected] of CASES) {
  check(name, connectionState(conn, keys, now) === expected);
}

console.log('reviewTarget (banner "below" must be true):');
check('no recent → null', reviewTarget([], 'a') === null);
check('all on active tab → below', reviewTarget([{ proxyKeyId: 'a' }, { proxyKeyId: 'a' }], 'a') === 'below');
const other = reviewTarget([{ proxyKeyId: 'b' }], 'a');
check('on another tab → link to that profile', typeof other === 'object' && other?.profileId === 'b');
const mixed = reviewTarget([{ proxyKeyId: 'a' }, { proxyKeyId: 'b' }], 'a');
check('mixed → link to the one not below', typeof mixed === 'object' && mixed?.profileId === 'b');
const noActive = reviewTarget([{ proxyKeyId: 'b' }], null);
check('no active profile → never "below"', noActive !== 'below' && typeof noActive === 'object' && noActive?.profileId === 'b');

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll connection-state tests passed.');
