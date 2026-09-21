/**
 * Unit tests for the pending-approvals banner selection (src/lib/approvalPending.ts).
 * Run: npx tsx scripts/test-approval-pending.ts  (part of `npm run mcp:lint`)
 *
 * The clearing rules that must hold: approved rows never show; a dismissal
 * hides a row only until the agent mints it again; nothing older than the
 * window shows; rows without a stored link cannot show; newest first, capped.
 */
import {
  BANNER_LINK_SOURCE_VALUE, PENDING_LIMIT, PENDING_WINDOW_MS,
  parseLinkQuery, pendingApprovalPath, selectPendingApprovals, type PendingApprovalRow,
} from '../src/lib/approvalPending';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  x ${name}`); }
  else console.log(`  ok ${name}`);
}

const NOW = 1_760_000_000_000;
const at = (msAgo: number) => new Date(NOW - msAgo);
const Q = 'a=sheets_expose&k=11111111-2222-3333-4444-555555555555&r=1AbC&s=abcdefabcdefabcdefabcdefabcdefab';
function row(over: Partial<PendingApprovalRow> & { requestId: string }): PendingApprovalRow {
  return { action: 'sheets_expose', linkQuery: Q, lastMintedAt: at(60_000), approvedAt: null, dismissedAt: null, ...over };
}
const ids = (rows: PendingApprovalRow[]) => rows.map(r => r.requestId);

console.log('clearing rules:');
check('a fresh open request shows', ids(selectPendingApprovals([row({ requestId: 'r1' })], NOW)).join() === 'r1');
check('an approved request does not', selectPendingApprovals([row({ requestId: 'r1', approvedAt: at(10) })], NOW).length === 0);
check('a request without a stored link does not', selectPendingApprovals([row({ requestId: 'r1', linkQuery: null })], NOW).length === 0);
check('a request minted inside the window shows', ids(selectPendingApprovals([row({ requestId: 'r1', lastMintedAt: at(PENDING_WINDOW_MS - 1) })], NOW)).join() === 'r1');
check('a request minted before the window does not', selectPendingApprovals([row({ requestId: 'r1', lastMintedAt: at(PENDING_WINDOW_MS + 1) })], NOW).length === 0);

console.log('dismissal:');
check('dismissed after the last mint hides it', selectPendingApprovals([row({ requestId: 'r1', lastMintedAt: at(120_000), dismissedAt: at(60_000) })], NOW).length === 0);
check('a re-mint after the dismissal resurfaces it', ids(selectPendingApprovals([row({ requestId: 'r1', lastMintedAt: at(30_000), dismissedAt: at(60_000) })], NOW)).join() === 'r1');
check('dismissed at exactly the last mint counts as dismissed', selectPendingApprovals([row({ requestId: 'r1', lastMintedAt: at(60_000), dismissedAt: at(60_000) })], NOW).length === 0);

console.log('ordering and cap:');
{
  const rows = Array.from({ length: PENDING_LIMIT + 3 }, (_, i) => row({ requestId: `r${i}`, lastMintedAt: at((i + 1) * 1000) }));
  const picked = selectPendingApprovals(rows.slice().reverse(), NOW);
  check(`caps at ${PENDING_LIMIT}`, picked.length === PENDING_LIMIT);
  check('newest first', ids(picked)[0] === 'r0' && ids(picked)[PENDING_LIMIT - 1] === `r${PENDING_LIMIT - 1}`);
}

console.log('link:');
check('the approve path is the stored query plus the banner marker',
  pendingApprovalPath(row({ requestId: 'r1' })) === `/dashboard/approve?${Q}&src=${BANNER_LINK_SOURCE_VALUE}`);
{
  const p = parseLinkQuery(Q);
  check('parseLinkQuery round-trips a/k/r/s', p.a === 'sheets_expose' && p.k === '11111111-2222-3333-4444-555555555555' && p.r === '1AbC' && p.s === 'abcdefabcdefabcdefabcdefabcdefab');
  check('parseLinkQuery leaves a missing target undefined', parseLinkQuery('a=send_all&k=x&s=y').r === undefined);
}

if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall pending-approval tests passed');
