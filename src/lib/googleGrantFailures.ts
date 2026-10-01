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
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { recentNotificationCountSql } from './approvalRequests';
import { claimSerialized } from './notifyClaimLock';
import {
  GRANT_DEAD_EPISODE_GAP_MS, GRANT_DEAD_GLOBAL_HOURLY_MAX, GRANT_DEAD_NOTICES_PER_EPISODE, grantNoticeDue, isScopeMissingReason, normalizeAccountEmail,
  type GrantNoticeReason,
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
 * Record one reconnect-repairable failure — a dead grant, or since 2026-09-25
 * a grant missing a scope. First failure inserts; later ones either extend
 * the current episode or start a new one (count and notices reset) when the
 * previous failure is older than the episode gap OR belongs to the other
 * class: a dead grant the owner reconnects with a checkbox unchecked flips
 * from `grant_revoked` to `drive_file_scope_missing`, and that reconnect is a
 * new event whose email says what the first could not (tick the box). The
 * two scope reasons are ONE class — a mailbox missing both scopes is told
 * once, and the reconnect repairs both. Returns the resulting row, or null
 * if the write failed.
 */
export async function recordGrantFailure(opts: {
  userId: string; accountEmail: string; reason: GrantNoticeReason;
}): Promise<GrantFailureRow | null> {
  try {
    const gapSeconds = Math.round(GRANT_DEAD_EPISODE_GAP_MS / 1000);
    const scopeClass = isScopeMissingReason(opts.reason);
    // Compile-time constant, so it is inlined rather than bound (a bound
    // parameter inside an interval expression has no inferable type).
    const aged = sql`${googleGrantFailures.lastFailedAt} < now() - ${sql.raw(`interval '${gapSeconds} seconds'`)}`;
    const classChanged = sql`(${googleGrantFailures.lastReason} IN ('gmail_scope_missing', 'drive_file_scope_missing')) IS DISTINCT FROM ${scopeClass}`;
    const stale = sql`(${aged} OR ${classChanged})`;
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

/** Notices sent to ANY owner in the last hour — the circuit breaker's count. */
function recentGlobalNoticeCountSql() {
  return sql`(SELECT count(*) FROM ${googleGrantFailures} AS recent_global
              WHERE recent_global.notified_at > now() - interval '1 hour')`;
}

/**
 * Claim the right to email the owner about this row: stamps `notified_at` and
 * bumps `notified_count` atomically, and only while (a) the episode has not
 * been notified, (b) the owner is under `maxPerDay` reminder emails in the
 * last 24 h across all three ledgers, and (c) fewer than
 * GRANT_DEAD_GLOBAL_HOURLY_MAX notices went to anyone in the last hour. One
 * statement, so two refusals on the same row cannot both claim — and run
 * under the owner's advisory lock AND the global one (notifyClaimLock.ts),
 * because (b) and (c) count OTHER rows, which a statement's own snapshot
 * cannot see being stamped concurrently.
 */
export async function claimGrantFailureNotification(id: string, userId: string, maxPerDay: number): Promise<
  { claimed: true; notifiedAt: Date | null }
  | { claimed: false; notifiedAt: Date | null; reason: 'already' | 'capped' | 'global_capped' | 'missing' | 'error' }
> {
  try {
    const [row] = await claimSerialized(userId, db.update(googleGrantFailures)
      .set({ notifiedAt: sql`now()`, notifiedCount: sql`${googleGrantFailures.notifiedCount} + 1` })
      .where(and(
        eq(googleGrantFailures.id, id),
        isNull(googleGrantFailures.notifiedAt),
        lt(googleGrantFailures.notifiedCount, GRANT_DEAD_NOTICES_PER_EPISODE),
        sql`${recentNotificationCountSql(userId)} < ${maxPerDay}`,
        sql`${recentGlobalNoticeCountSql()} < ${GRANT_DEAD_GLOBAL_HOURLY_MAX}`,
      ))
      .returning({ notifiedAt: googleGrantFailures.notifiedAt }), { global: true });
    if (row) return { claimed: true, notifiedAt: row.notifiedAt };
    const [existing] = await db.select({
      notifiedAt: googleGrantFailures.notifiedAt,
      notifiedCount: googleGrantFailures.notifiedCount,
      globalRecent: recentGlobalNoticeCountSql(),
    })
      .from(googleGrantFailures)
      .where(eq(googleGrantFailures.id, id))
      .limit(1);
    if (!existing) return { claimed: false, notifiedAt: null, reason: 'missing' };
    if (existing.notifiedAt || !grantNoticeDue(existing)) {
      return { claimed: false, notifiedAt: existing.notifiedAt, reason: 'already' };
    }
    if (Number(existing.globalRecent) >= GRANT_DEAD_GLOBAL_HOURLY_MAX) {
      return { claimed: false, notifiedAt: null, reason: 'global_capped' };
    }
    return { claimed: false, notifiedAt: null, reason: 'capped' };
  } catch (err) {
    console.error('[googleGrantFailures] notification claim failed:', err);
    return { claimed: false, notifiedAt: null, reason: 'error' };
  }
}

/**
 * Undo a claim whose send definitely did not happen, so the next failure can
 * try again — the right side to err on for a refused send (the alternative is
 * an owner who is never told).
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
