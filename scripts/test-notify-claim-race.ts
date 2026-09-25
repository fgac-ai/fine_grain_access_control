/**
 * Owner-notice claims under concurrency — DB-backed, run against the branch
 * database (`npm run db:branch` first). NOT part of `npm run mcp:lint`.
 *
 *   npx tsx scripts/test-notify-claim-race.ts
 *
 * Two halves:
 *
 *  1. ESTABLISH the race on the pre-fix statement shape. Each claim used to
 *     be a single UPDATE whose WHERE counted the owner's OTHER rows (the
 *     daily cap, the refusal episode). Under READ COMMITTED each statement
 *     evaluates those subqueries in its own snapshot, so two claims on two
 *     rows of one owner started together both pass. Reproduced here with
 *     `pg_sleep` inside the statement to hold both snapshots open — the same
 *     shape production hit on 2026-09-17 (108 ms) and 09-21 (271 ms).
 *
 *  2. VERIFY the shipped claims (src/lib/notifyClaimLock.ts: per-owner
 *     advisory lock, then the UPDATE, in one transaction) hold under N-way
 *     concurrency on N rows: one link reminder per turn, one refusal notice
 *     per episode, the daily cap exact across mailboxes.
 *
 * Fixtures are a throwaway user on example.com plus one profile key,
 * deleted (cascade) at the end, whatever happened.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { sql } from 'drizzle-orm';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

(async () => {
  const { db } = await import('../src/db');
  const { accountRefusals, approvalRequests, googleGrantFailures, proxyKeys, users } = await import('../src/db/schema');
  const { claimApprovalNotification } = await import('../src/lib/approvalRequests');
  const { claimAccountRefusalNotification } = await import('../src/lib/accountRefusals');
  const { claimGrantFailureNotification } = await import('../src/lib/googleGrantFailures');
  const { NOTIFY_MAX_PER_DAY } = await import('../src/lib/approvalNotifyCopy');

  const tag = Math.random().toString(36).slice(2, 10);
  const [user] = await db.insert(users).values({ clerkUserId: `qa_race_${tag}`, email: `race-${tag}@example.com` }).returning();
  const [key] = await db.insert(proxyKeys).values({ userId: user.id, key: `sk_proxy_race_${tag}`, label: 'Race fixture' }).returning();
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);

  async function linkRows(n: number, prefix: string): Promise<string[]> {
    const ids = Array.from({ length: n }, (_, i) => `${prefix}-${tag}-${i}`);
    await db.insert(approvalRequests).values(ids.map(requestId => ({
      requestId, userId: user.id, proxyKeyId: key.id, action: 'sheets_expose', mintCount: 2, firstMintedAt: tenMinAgo, lastMintedAt: new Date(),
    })));
    return ids;
  }
  async function refusalRows(n: number, prefix: string): Promise<string[]> {
    const rows = await db.insert(accountRefusals).values(Array.from({ length: n }, (_, i) => ({
      proxyKeyId: key.id, userId: user.id, requestedEmail: `${prefix}-${i}-${tag}@example.com`, windowCount: 3, refusalCount: 3,
    }))).returning({ id: accountRefusals.id });
    return rows.map(r => r.id);
  }
  async function grantRows(n: number, prefix: string): Promise<string[]> {
    const rows = await db.insert(googleGrantFailures).values(Array.from({ length: n }, (_, i) => ({
      userId: user.id, accountEmail: `${prefix}-${i}-${tag}@example.com`, lastReason: 'grant_revoked',
    }))).returning({ id: googleGrantFailures.id });
    return rows.map(r => r.id);
  }
  async function clearStamps() {
    await db.update(approvalRequests).set({ notifiedAt: null }).where(sql`${approvalRequests.userId} = ${user.id}`);
    await db.update(accountRefusals).set({ notifiedAt: null }).where(sql`${accountRefusals.userId} = ${user.id}`);
    await db.update(googleGrantFailures).set({ notifiedAt: null, notifiedCount: 0 }).where(sql`${googleGrantFailures.userId} = ${user.id}`);
  }

  try {
    console.log('1. establish — the pre-fix statement shape races across rows');
    {
      const [a, b] = await linkRows(2, 'prefix-link');
      // The claim as it was on main at 6645aa9 (cap predicate only), plus a
      // half-second hold so both statements are certain to overlap. Cap = 1,
      // so a correct implementation lets exactly one through.
      const preFixCapClaim = (requestId: string) => db.execute(sql`
        UPDATE ${approvalRequests} SET notified_at = now()
        WHERE request_id = ${requestId} AND notified_at IS NULL
          AND (SELECT count(*) FROM ${approvalRequests} AS recent
               WHERE recent.user_id = ${user.id} AND recent.notified_at > now() - interval '24 hours') < 1
          AND (SELECT 0 FROM pg_sleep(0.5)) = 0
        RETURNING request_id`);
      const results = await Promise.all([preFixCapClaim(a), preFixCapClaim(b)]);
      const claimed = results.filter(r => r.rows.length === 1).length;
      check('pre-fix cap predicate: two concurrent claims on two rows BOTH pass a cap of 1 (the race)', claimed === 2, { claimed });
    }
    {
      const [a, b] = await refusalRows(2, 'prefix-ref');
      // The episode guard as PR #156 shipped it: an EXISTS over the owner's other rows.
      const preFixEpisodeClaim = (id: string) => db.execute(sql`
        UPDATE ${accountRefusals} SET notified_at = now()
        WHERE id = ${id} AND notified_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${accountRefusals} AS episode_rows
                          WHERE episode_rows.user_id = ${user.id} AND episode_rows.notified_at > now() - interval '14 days')
          AND (SELECT 0 FROM pg_sleep(0.5)) = 0
        RETURNING id`);
      const results = await Promise.all([preFixEpisodeClaim(a), preFixEpisodeClaim(b)]);
      const claimed = results.filter(r => r.rows.length === 1).length;
      check('pre-fix episode guard: two concurrent claims on two rows BOTH pass "no episode" (the race)', claimed === 2, { claimed });
    }
    await clearStamps();

    console.log('2. verify — serialized claims: link reminders, one per owner per turn');
    {
      const ids = await linkRows(6, 'link');
      const results = await Promise.all(ids.map(id => claimApprovalNotification(id, user.id, NOTIFY_MAX_PER_DAY, user.email)));
      const claimed = results.filter(r => r.claimed).length;
      const reasons = results.flatMap(r => r.claimed ? [] : [r.reason]);
      check('six concurrent due links → exactly one email', claimed === 1, { claimed, reasons });
      check('the other five are refused as a same-turn burst, not capped', reasons.length === 5 && reasons.every(r => r === 'burst'), reasons);
      const winner = ids[results.findIndex(r => r.claimed)];
      const again = await claimApprovalNotification(winner, user.id, NOTIFY_MAX_PER_DAY, user.email);
      check('re-claiming the emailed request says already', !again.claimed && again.reason === 'already' && again.notifiedAt instanceof Date);
      const stamped = await db.select({ n: sql<number>`count(*)` }).from(approvalRequests)
        .where(sql`${approvalRequests.userId} = ${user.id} AND ${approvalRequests.notifiedAt} IS NOT NULL`);
      check('ledger holds exactly one stamp for the owner', Number(stamped[0].n) === 1, stamped[0]);
    }
    await clearStamps();

    console.log('3. verify — serialized claims: refusal notices, one per owner per episode');
    {
      const ids = await refusalRows(4, 'ref');
      const results = await Promise.all(ids.map(id => claimAccountRefusalNotification(id, user.id, NOTIFY_MAX_PER_DAY, user.email)));
      const claimed = results.filter(r => r.claimed).length;
      const reasons = results.flatMap(r => r.claimed ? [] : [r.reason]);
      check('four values refused together → exactly one email', claimed === 1, { claimed, reasons });
      check('the other three are refused by the episode rule', reasons.length === 3 && reasons.every(r => r === 'episode'), reasons);
    }
    await clearStamps();

    console.log('4. verify — serialized claims: the daily cap is exact across mailboxes');
    {
      const ids = await grantRows(NOTIFY_MAX_PER_DAY + 2, 'grant');
      const results = await Promise.all(ids.map(id => claimGrantFailureNotification(id, user.id, NOTIFY_MAX_PER_DAY, user.email)));
      const claimed = results.filter(r => r.claimed).length;
      const reasons = results.flatMap(r => r.claimed ? [] : [r.reason]);
      check(`${ids.length} dead mailboxes at once → exactly ${NOTIFY_MAX_PER_DAY} emails (the cap)`, claimed === NOTIFY_MAX_PER_DAY, { claimed, reasons });
      check('the rest are capped, not errors', reasons.length === 2 && reasons.every(r => r === 'capped'), reasons);
      const stamped = await db.select({ n: sql<number>`count(*)` }).from(googleGrantFailures)
        .where(sql`${googleGrantFailures.userId} = ${user.id} AND ${googleGrantFailures.notifiedAt} IS NOT NULL`);
      check('ledger holds exactly the cap', Number(stamped[0].n) === NOTIFY_MAX_PER_DAY, stamped[0]);
    }
  } finally {
    await db.delete(users).where(sql`${users.id} = ${user.id}`);
    const left = await db.select({ n: sql<number>`count(*)` }).from(approvalRequests).where(sql`${approvalRequests.userId} = ${user.id}`);
    check('fixtures removed (cascade)', Number(left[0].n) === 0);
  }

  if (failures) { console.error(`\n${failures} notify-claim race check(s) failed`); process.exit(1); }
  console.log('\nAll notify-claim race checks passed');
})().catch(err => { console.error(err); process.exit(1); });
