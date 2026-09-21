/**
 * Unit tests for post-sign-in approval routing (src/lib/approvalRouting.ts).
 * Run: npx tsx scripts/test-approval-routing.ts  (part of `npm run mcp:lint`)
 *
 * The rules that must hold: only a RECENT wall hit routes, only if the owner
 * has not opened the approve page since the hit, only once per hit, newest
 * hit wins, and the redirect carries exactly the signed link's query.
 */
import { approvalRoutePath, canonicalWallQuery, explainWallRouteSkip, pickRoutableWallHit, ROUTE_WINDOW_MS, type WallHitRow } from '../src/lib/approvalRouting';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const NOW = 1_760_000_000_000;
const at = (msAgo: number) => new Date(NOW - msAgo);
const Q = 'a=sheets_expose&k=11111111-2222-3333-4444-555555555555&r=1AbC&s=abcdefabcdefabcdefabcdefabcdefab';
function row(over: Partial<WallHitRow> & { requestId: string }): WallHitRow {
  return { action: 'sheets_expose', wallQuery: Q, wallHitAt: at(60_000), openedAt: null, routedAt: null, ...over };
}

console.log('recency:');
check('a hit 1 min ago routes', pickRoutableWallHit([row({ requestId: 'r1' })], NOW)?.requestId === 'r1');
check('a hit 29 min ago routes', pickRoutableWallHit([row({ requestId: 'r1', wallHitAt: at(ROUTE_WINDOW_MS - 1) })], NOW)?.requestId === 'r1');
check('a hit 31 min ago does not', pickRoutableWallHit([row({ requestId: 'r1', wallHitAt: at(ROUTE_WINDOW_MS + 60_000) })], NOW) === null);
check('a hit in the future does not (clock skew)', pickRoutableWallHit([row({ requestId: 'r1', wallHitAt: new Date(NOW + 60_000) })], NOW) === null);

console.log('seen since / routed once:');
check('opened after the hit → no route', pickRoutableWallHit([row({ requestId: 'r1', openedAt: at(30_000) })], NOW) === null);
check('opened BEFORE the hit (earlier session) → still routes', pickRoutableWallHit([row({ requestId: 'r1', openedAt: at(3_600_000) })], NOW)?.requestId === 'r1');
check('already routed for this hit → no route', pickRoutableWallHit([row({ requestId: 'r1', routedAt: at(30_000) })], NOW) === null);
check('routed for an OLDER hit, then re-hit → routes again', pickRoutableWallHit([row({ requestId: 'r1', routedAt: at(120_000) })], NOW)?.requestId === 'r1');
check('empty query never routes', pickRoutableWallHit([row({ requestId: 'r1', wallQuery: '' })], NOW) === null);

console.log('selection:');
const picked = pickRoutableWallHit([
  row({ requestId: 'old', wallHitAt: at(600_000) }),
  row({ requestId: 'new', wallHitAt: at(30_000) }),
  row({ requestId: 'stale', wallHitAt: at(ROUTE_WINDOW_MS * 3) }),
], NOW);
check('newest qualifying hit wins', picked?.requestId === 'new');
check('no rows → null', pickRoutableWallHit([], NOW) === null);

console.log('redirect target:');
check('route path is the approve page with the stored query', approvalRoutePath(row({ requestId: 'r1' })) === `/dashboard/approve?${Q}`);
check('canonical query keeps only a/k/r/s', canonicalWallQuery(new URLSearchParams(`${Q}&result=ok&notice=x`)) === Q);
check('canonical query drops empty target', canonicalWallQuery(new URLSearchParams('a=send_all&k=K&r=&s=S')) === 'a=send_all&k=K&s=S');

console.log('skip explanation:');
{
  const skip = explainWallRouteSkip([
    row({ requestId: 's1', wallHitAt: at(ROUTE_WINDOW_MS + 60_000) }),
    row({ requestId: 's2', routedAt: at(30_000) }),
    row({ requestId: 's3', openedAt: at(30_000) }),
    row({ requestId: 's4', wallQuery: '' }),
    row({ requestId: 's5', wallHitAt: new Date(NOW + 60_000) }),
  ], NOW);
  check('counts every candidate', skip.candidates === 5);
  check('names the stale one', skip.stale === 1);
  check('names the already-routed one', skip.routed_already === 1);
  check('names the opened-since one', skip.opened_since === 1);
  check('names the query-less one', skip.no_query === 1);
  check('names the future-dated one', skip.future === 1);
  const clean = explainWallRouteSkip([row({ requestId: 'ok' })], NOW);
  check('a routable row trips no rule', clean.candidates === 1 && clean.stale + clean.routed_already + clean.opened_since + clean.no_query + clean.future === 0);
}

if (failures) { console.error(`\n${failures} approval-routing check(s) failed`); process.exit(1); }
console.log('\nall approval-routing checks passed');
