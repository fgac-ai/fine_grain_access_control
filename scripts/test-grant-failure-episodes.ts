/**
 * Grant-failure ledger episodes and the scope-missing owner notice — DB-backed,
 * run against the branch database (`npm run db:branch` first). NOT part of
 * `npm run mcp:lint` (same convention as test-notify-claim-race.ts).
 *
 *   npx tsx scripts/test-grant-failure-episodes.ts
 *
 * Pins the rule PR #166 added to `recordGrantFailure`: an episode resets when
 * the previous failure is older than the gap OR of the other class (dead
 * grant ↔ scope-missing), while the two scope reasons share one class — and
 * runs `notifyOwnerOfDeadGrant` end to end for a scope reason with the send
 * seam captured, so the subject, body and one-per-episode outcome are checked
 * on the real claim path (advisory lock, cap, breaker) without Google.
 *
 * Why here and not capability 18 A14: the A14 fixture (a live token missing
 * drive.file) needs Google's consent screen to offer the checkbox, which it
 * only does after FGAC's access is removed on the Google side (measured
 * 2026-09-25: an account holding every scope gets a read-only consent
 * summary). That removal is a human step; this script covers the ledger and
 * the email until it is arranged.
 *
 * Fixture: a throwaway user on example.com, deleted (cascade) at the end.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { eq, sql } from 'drizzle-orm';

let failures = 0;
/** The Subject header, decoded (approvalEmailRaw encodes non-ASCII subjects as an RFC 2047 word). */
function subjectOf(raw: string): string {
  const line = raw.split('\r\n').find(l => l.startsWith('Subject: ')) ?? '';
  const m = /^Subject: =\?UTF-8\?B\?(.+)\?=$/.exec(line);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : line.slice('Subject: '.length);
}
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

(async () => {
  const { db } = await import('../src/db');
  const { googleGrantFailures, users } = await import('../src/db/schema');
  const { recordGrantFailure, claimGrantFailureNotification } = await import('../src/lib/googleGrantFailures');
  const { notifyOwnerOfDeadGrant } = await import('../src/lib/approvalNotify');
  const { NOTIFY_MAX_PER_DAY } = await import('../src/lib/approvalNotifyCopy');

  const tag = Date.now().toString(36);
  const email = `episodes-${tag}@example.com`;
  const [user] = await db.insert(users).values({ clerkUserId: `qa_episodes_${tag}`, email }).returning();
  const owner = { id: user.id, email, clerkUserId: user.clerkUserId };
  const rowNow = async () => (await db.select().from(googleGrantFailures).where(eq(googleGrantFailures.userId, user.id)))[0];

  try {
    console.log('episode 1 — dead grant');
    const r1 = await recordGrantFailure({ userId: user.id, accountEmail: email, reason: 'grant_revoked' });
    check('first failure inserts count 1, unnotified', !!r1 && r1.failureCount === 1 && r1.notifiedCount === 0 && r1.notifiedAt === null);
    const c1 = await claimGrantFailureNotification(r1!.id, user.id, NOTIFY_MAX_PER_DAY);
    check('claim stamps the dead-grant notice', c1.claimed);
    const r2 = await recordGrantFailure({ userId: user.id, accountEmail: email, reason: 'refresh_failed' });
    check('another dead-grant class extends the episode (count 2, still notified)', !!r2 && r2.failureCount === 2 && r2.notifiedCount === 1 && r2.notifiedAt !== null);

    console.log('episode 2 — class change dead → scope resets');
    const before = await rowNow();
    const r3 = await recordGrantFailure({ userId: user.id, accountEmail: email, reason: 'drive_file_scope_missing' });
    check('scope-missing after a dead grant starts a new episode (count 1, notices 0, stamp cleared)', !!r3 && r3.failureCount === 1 && r3.notifiedCount === 0 && r3.notifiedAt === null && r3.lastReason === 'drive_file_scope_missing');
    check('first_failed_at moved forward', !!r3 && r3.firstFailedAt.getTime() > before.firstFailedAt.getTime());
    const r4 = await recordGrantFailure({ userId: user.id, accountEmail: email, reason: 'gmail_scope_missing' });
    check('the other scope reason is the SAME class — extends, does not reset (count 2)', !!r4 && r4.failureCount === 2 && r4.notifiedCount === 0 && r4.lastReason === 'gmail_scope_missing');

    console.log('notice — scope reason end to end with the send seam');
    const sent: string[] = [];
    const sender = { proxyKey: 'sk_proxy_test_seam', address: 'support@example.com' };
    const send = async (_cfg: unknown, raw: string) => { sent.push(Buffer.from(raw, 'base64url').toString('utf8')); return { ok: true as const }; };
    const opts = {
      owner, accountEmail: email, keyOwnerEmail: email, agentLabel: 'Claude',
      reconnectUrl: `https://fgac.ai/dashboard/accounts?reconnect=1&for=${encodeURIComponent(email)}`,
      dashboardUrl: 'https://fgac.ai', sender, send,
    };
    const n1 = await notifyOwnerOfDeadGrant({ ...opts, reason: 'drive_file_scope_missing' });
    check('first scope refusal of the episode → sent', n1.status === 'sent' && n1.failureCount === 3 && n1.daysDead === 0 && n1.ccDelegate === false, n1);
    check('exactly one message went out', sent.length === 1);
    const msg = sent[0] ?? '';
    check('subject names the Drive file permission, not "disconnected"', /^Google access to .* is missing the Google Drive file permission — your agent is being refused$/.test(subjectOf(msg)) && !/disconnected/.test(subjectOf(msg)));
    check('To is the mailbox, no Cc on an own-mailbox notice', msg.includes(`To: ${email}`) && !/\r\nCc:/.test(msg));
    check('body: permission framing, surfaces, tick the box, link, only-email line', /connected to FGAC without a permission it needs/.test(msg) && /Every Sheets, Docs, Slides and Drive call/.test(msg) && /tick the box next to Google Drive/.test(msg) && msg.includes(opts.reconnectUrl) && /only email FGAC will send about this permission/.test(msg));
    const n2 = await notifyOwnerOfDeadGrant({ ...opts, reason: 'drive_file_scope_missing' });
    check('second scope refusal → already_sent, nothing sent', n2.status === 'already_sent' && n2.notifiedAt !== null && sent.length === 1, n2);
    const n3 = await notifyOwnerOfDeadGrant({ ...opts, reason: 'gmail_scope_missing' });
    check('the other scope inside the episode → already_sent (one class, one email)', n3.status === 'already_sent' && sent.length === 1, n3);

    console.log('episode 3 — class change scope → dead resets and emails again');
    const n4 = await notifyOwnerOfDeadGrant({ ...opts, reason: 'grant_revoked' });
    check('a dead grant after a scope episode is a new episode → sent', n4.status === 'sent' && n4.failureCount === 1 && sent.length === 2, n4);
    check('second message is the dead-grant subject', /is disconnected — your agent is being refused/.test(subjectOf(sent[1] ?? '')));

    console.log('episode 4 — the 14-day gap still resets within a class');
    await db.update(googleGrantFailures).set({ lastFailedAt: sql`now() - interval '15 days'` }).where(eq(googleGrantFailures.userId, user.id));
    const n5 = await notifyOwnerOfDeadGrant({ ...opts, reason: 'grant_revoked' });
    check('same class 15 days later → new episode → sent', n5.status === 'sent' && n5.failureCount === 1 && n5.daysDead === 0, n5);

    console.log('delegated scope notice carries the Cc');
    const n6 = await notifyOwnerOfDeadGrant({ ...opts, reason: 'drive_file_scope_missing', keyOwnerEmail: 'delegate@example.org', agentLabel: 'Nightly digest' });
    check('delegated class-change notice → sent with cc_delegate', n6.status === 'sent' && n6.ccDelegate === true, n6);
    const del = sent[sent.length - 1] ?? '';
    check('Cc the delegate, delegated subject, delegate paragraph', /\r\nCc: delegate@example\.org\r\n/.test(del) && /is missing the Google Drive file permission — an agent you delegated to is being refused/.test(subjectOf(del)) && /copied on this email/.test(del));

    check('the daily cap: this owner has now been claimed 4 times; the cap is 3 → the ledger is over the cap only because each claim was a new episode and the cap counts 24 h', NOTIFY_MAX_PER_DAY === 3);
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
    const left = await db.select().from(googleGrantFailures).where(eq(googleGrantFailures.userId, user.id));
    check('fixture deleted (cascade)', left.length === 0);
  }

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll grant-failure-episode checks passed.');
})().catch(e => { console.error(e); process.exit(1); });
