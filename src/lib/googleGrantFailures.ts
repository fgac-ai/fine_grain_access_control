/**
 * Dead-grant ledger — one row per (mailbox owner, mailbox) whose Google grant
 * a reconnect would repair (`reconnectRepairs` in googleTokenFailure.ts).
 * Feeds the third owner notice (`notifyOwnerOfDeadGrant` in approvalNotify.ts).
 *
 * Why a table of its own: the failure is stateless per call — a scheduled job
 * was refused on the same delegated mailbox once a day for 30 days (production,
 * 2026-08-21 → 09-19) and nothing recorded that it was the SAME mailbox, so
 * nothing could decide "first time" vs "still broken after a week". The row is
 * the trigger's memory: when the episode began, how many refusals, how many
 * notices, when the last one went out.
 *
 * Every write is best-effort and one statement; a refusal must never fail
 * because bookkeeping failed.
 */
import { db } from '@/db';
import { googleGrantFailures } from '@/db/schema';
import { and, eq, or, isNull, lt, sql } from 'drizzle-orm';
import { recentNotificationCountSql } from './approvalRequests';
import {
  GRANT_DEAD_EPISODE_GAP_MS, GRANT_DEAD_MAX_NOTICES, GRANT_DEAD_REPEAT_AFTER_MS, grantNoticeDue, normalizeAccountEmail,
  type DeadGrantReason,
} from './googleGrantNotifyCopy';

export { grantNoticeDue, normalizeAccountEmail };

export interface GrantFailureRow {
  id: string;
  lastReason: string;
  firstFailedAt: Date;
  lastFailedAt: Date;
  failureCount: number;
  notifiedCount: number;
  notifiedAt: Date | null;
}

/**
 * Record one reconnect-repairable failure. First failure inserts; later ones
 * either extend the current episode or — when the previous failure is older
 * than the episode gap — start a new one (count and notices reset). Returns
 * the resulting row, or null if the write failed.
 */
export async function recordGrantFailure(opts: {
  userId: string; accountEmail: string; reason: DeadGrantReason;
}): Promise<GrantFailureRow | null> {
  try {
    const gapSeconds = Math.round(GRANT_DEAD_EPISODE_GAP_MS / 1000);
    // Compile-time constant, so it is inlined rather than bound (a bound
    // parameter inside an interval expression has no inferable type).
    const stale = sql`${googleGrantFailures.lastFailedAt} < now() - ${sql.raw(`interval '${gapSeconds} seconds'`)}`;
    const [row] = await db.insert(googleGrantFailures)
      .values({
        userId: opts.userId,
        accountEmail: normalizeAccountEmail(opts.accountEmail),
        lastReason: opts.reason,
      })
      .onConflictDoUpdate({
        target: [googleGrantFailures.userId, googleGrantFailures.accountEmail],
        set: {
          lastReason: sql`excluded.last_reason`,
          failureCount: sql`case when ${stale} then 1 else ${googleGrantFailures.failureCount} + 1 end`,
          firstFailedAt: sql`case when ${stale} then now() else ${googleGrantFailures.firstFailedAt} end`,
          notifiedCount: sql`case when ${stale} then 0 else ${googleGrantFailures.notifiedCount} end`,
          notifiedAt: sql`case when ${stale} then null else ${googleGrantFailures.notifiedAt} end`,
          lastFailedAt: sql`now()`,
        },
      })
      .returning({
        id: googleGrantFailures.id,
        lastReason: googleGrantFailures.lastReason,
        firstFailedAt: googleGrantFailures.firstFailedAt,
        lastFailedAt: googleGrantFailures.lastFailedAt,
        failureCount: googleGrantFailures.failureCount,
        notifiedCount: googleGrantFailures.notifiedCount,
        notifiedAt: googleGrantFailures.notifiedAt,
      });
    return row ?? null;
  } catch (err) {
    console.error('[googleGrantFailures] failure record failed:', err);
    return null;
  }
}

/**
 * Claim the right to email the owner about this row: bumps `notified_count`
 * and stamps `notified_at` atomically, and only while (a) the episode is under
 * GRANT_DEAD_MAX_NOTICES, (b) the previous notice is old enough for a repeat
 * (or there is none), and (c) the owner is under `maxPerDay` reminder emails
 * in the last 24 h across all three ledgers. One statement, so two refusals
 * landing together cannot both claim.
 */
export async function claimGrantFailureNotification(id: string, userId: string, maxPerDay: number): Promise<
  { claimed: true; notifiedAt: Date | null; noticeNumber: number }
  | { claimed: false; notifiedAt: Date | null; reason: 'already' | 'capped' | 'missing' | 'error' }
> {
  try {
    const repeatSeconds = Math.round(GRANT_DEAD_REPEAT_AFTER_MS / 1000);
    const [row] = await db.update(googleGrantFailures)
      .set({ notifiedAt: sql`now()`, notifiedCount: sql`${googleGrantFailures.notifiedCount} + 1` })
      .where(and(
        eq(googleGrantFailures.id, id),
        lt(googleGrantFailures.notifiedCount, GRANT_DEAD_MAX_NOTICES),
        or(
          isNull(googleGrantFailures.notifiedAt),
          sql`${googleGrantFailures.notifiedAt} <= now() - ${sql.raw(`interval '${repeatSeconds} seconds'`)}`,
        ),
        sql`${recentNotificationCountSql(userId)} < ${maxPerDay}`,
      ))
      .returning({ notifiedAt: googleGrantFailures.notifiedAt, notifiedCount: googleGrantFailures.notifiedCount });
    if (row) return { claimed: true, notifiedAt: row.notifiedAt, noticeNumber: row.notifiedCount };
    const existing = await db.select({ notifiedAt: googleGrantFailures.notifiedAt, notifiedCount: googleGrantFailures.notifiedCount })
      .from(googleGrantFailures)
      .where(eq(googleGrantFailures.id, id))
      .limit(1).then(r => r[0]);
    if (!existing) return { claimed: false, notifiedAt: null, reason: 'missing' };
    // Not due (recent notice, or episode cap reached) reads as `already`: the
    // owner HAS been told and the denial line says when.
    if (existing.notifiedAt && !grantNoticeDue(existing, new Date())) {
      return { claimed: false, notifiedAt: existing.notifiedAt, reason: 'already' };
    }
    return { claimed: false, notifiedAt: existing.notifiedAt, reason: 'capped' };
  } catch (err) {
    console.error('[googleGrantFailures] notification claim failed:', err);
    return { claimed: false, notifiedAt: null, reason: 'error' };
  }
}

/**
 * Undo a claim whose send definitely did not happen, so a later failure can
 * try again. The previous stamp is not recoverable; clearing it makes the next
 * failure eligible immediately, which is the right side to err on for a lost
 * email (the alternative is an owner who is never told).
 */
export async function releaseGrantFailureNotification(id: string): Promise<void> {
  try {
    await db.update(googleGrantFailures)
      .set({
        notifiedAt: null,
        notifiedCount: sql`greatest(${googleGrantFailures.notifiedCount} - 1, 0)`,
      })
      .where(eq(googleGrantFailures.id, id));
  } catch (err) {
    console.error('[googleGrantFailures] notification release failed:', err);
  }
}
