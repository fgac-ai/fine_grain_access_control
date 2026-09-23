/**
 * Unit tests for the second-account markers (src/lib/secondAccount.ts).
 * Run: npx tsx scripts/test-second-account.ts  (part of `npm run mcp:lint`)
 *
 * What must hold: markers round-trip and reject garbage; a switch records the
 * previous account with the right timestamps; the same account does not churn
 * the cookie; the prior-account candidate only fires for ADJACENT sessions
 * inside the window and never names the current account; the delegate link
 * carries a uuid and nothing else.
 */
import {
  ADJACENT_SESSION_MS, PRIOR_ACCOUNT_WINDOW_MS, LAST_ACCOUNT_REFRESH_MS, DELEGATE_TO_PARAM,
  decodeLastAccount, decodePrevAccount, encodeLastAccount, encodePrevAccount,
  transitionAccountMarkers, priorAccountCandidate, priorSessionMatches, isDelegateTarget, delegateLinkPath,
} from '../src/lib/secondAccount';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  x ${name}`); }
  else console.log(`  ok ${name}`);
}

const NOW = 1_760_000_000_000;
const A = 'user_2mAbCdEfGhIjKlMnOpQrStUvWx';
const B = 'user_2nZyXwVuTsRqPoNmLkJiHgFeDc';

console.log('encoding:');
const lastA = { clerkUserId: A, seenAt: NOW - 90_000 };
check('last marker round-trips (second precision)', decodeLastAccount(encodeLastAccount(lastA))?.clerkUserId === A
  && decodeLastAccount(encodeLastAccount(lastA))?.seenAt === Math.floor(lastA.seenAt / 1000) * 1000);
const prevA = { clerkUserId: A, lastSeenAt: NOW - 90_000, switchedAt: NOW - 30_000 };
const prevBack = decodePrevAccount(encodePrevAccount(prevA));
check('prev marker round-trips', prevBack?.clerkUserId === A && prevBack?.lastSeenAt === Math.floor(prevA.lastSeenAt / 1000) * 1000 && prevBack?.switchedAt === Math.floor(prevA.switchedAt / 1000) * 1000);
check('garbage decodes to null', decodeLastAccount('nope') === null && decodeLastAccount('') === null && decodeLastAccount(undefined) === null
  && decodePrevAccount('user_abc.12') === null && decodePrevAccount('x.1.2') === null);
check('an email never decodes as an id', decodeLastAccount('someone@example.com.1700000000') === null);

console.log('transition:');
const first = transitionAccountMarkers(null, A, NOW);
check('first sight stamps last only', first.last?.clerkUserId === A && first.last?.seenAt === NOW && first.prev === null);
const sameFresh = transitionAccountMarkers({ clerkUserId: A, seenAt: NOW - LAST_ACCOUNT_REFRESH_MS + 1 }, A, NOW);
check('same account inside the refresh interval touches nothing', sameFresh.last === null && sameFresh.prev === null);
const sameStale = transitionAccountMarkers({ clerkUserId: A, seenAt: NOW - LAST_ACCOUNT_REFRESH_MS - 1 }, A, NOW);
check('same account past the interval re-stamps last, not prev', sameStale.last?.seenAt === NOW && sameStale.prev === null);
const sw = transitionAccountMarkers(lastA, B, NOW);
check('a switch records the previous account with its last-seen and the switch time',
  sw.last?.clerkUserId === B && sw.prev?.clerkUserId === A && sw.prev?.lastSeenAt === lastA.seenAt && sw.prev?.switchedAt === NOW);

console.log('prior-account candidate:');
check('no markers → none', priorAccountCandidate(null, null, B, NOW) === null);
check('unrotated last naming another account counts (first request after the switch)',
  priorAccountCandidate(lastA, null, B, NOW)?.clerkUserId === A && priorAccountCandidate(lastA, null, B, NOW)?.gapS === 90);
check('prev naming another account counts', priorAccountCandidate({ clerkUserId: B, seenAt: NOW }, prevA, B, NOW)?.clerkUserId === A);
check('prev naming the current account does not', priorAccountCandidate({ clerkUserId: A, seenAt: NOW }, prevA, A, NOW) === null);
check('a gap longer than the adjacency window does not',
  priorAccountCandidate({ clerkUserId: A, seenAt: NOW - ADJACENT_SESSION_MS - 1000 }, null, B, NOW) === null);
check('a gap inside the window does',
  priorAccountCandidate({ clerkUserId: A, seenAt: NOW - ADJACENT_SESSION_MS + 1000 }, null, B, NOW) !== null);
check('a switch older than the prompt window does not',
  priorAccountCandidate({ clerkUserId: B, seenAt: NOW }, { clerkUserId: A, lastSeenAt: NOW - PRIOR_ACCOUNT_WINDOW_MS - 10_000, switchedAt: NOW - PRIOR_ACCOUNT_WINDOW_MS - 1000 }, B, NOW) === null);
check('last wins over a stale prev (A → B → A: A is offered B, not itself)',
  priorAccountCandidate({ clerkUserId: B, seenAt: NOW - 1000 }, prevA, A, NOW)?.clerkUserId === B);
check('priorSessionMatches is true only for the owner', priorSessionMatches(lastA, null, B, A, NOW) && !priorSessionMatches(lastA, null, B, B, NOW));

console.log('delegate link:');
const uuid = '11111111-2222-3333-4444-555555555555';
check('uuid is a target', isDelegateTarget(uuid));
check('email / clerk id / empty are not', !isDelegateTarget('someone@example.com') && !isDelegateTarget(A) && !isDelegateTarget('') && !isDelegateTarget(undefined));
check('link path carries the uuid under the param', delegateLinkPath(uuid) === `/dashboard/accounts?${DELEGATE_TO_PARAM}=${uuid}`);

if (failures > 0) { console.error(`\n${failures} second-account check(s) failed`); process.exit(1); }
console.log('\nsecond-account checks passed');
