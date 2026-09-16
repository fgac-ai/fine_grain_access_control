/**
 * Account-refusal ledger — one row per (proxy key, requested account) for
 * the caller-chosen `account_not_permitted` refusal (`resolveAccountAndToken`
 * in the MCP route: the agent passed an `account` the key cannot use).
 *
 * Why a table of its own: that refusal mints no approval link (only the
 * owner can add an account to a key), so the reminder-email ledger on
 * approval_requests never sees it — and a scheduled job was refused ~8
 * times a day for a week (2026-09-09 → 09-16, production) with the refused
 * value recorded nowhere. The row is both the trigger's counter and the
 * diagnosis the analytics lacked.
 *
 * Every write is best-effort and one statement; a refusal must never fail
 * because bookkeeping failed.
 */
import { db } from '@/db';
import { accountRefusals } from '@/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recentNotificationCountSql } from './approvalRequests';

/** The window that decides "the same wrong value keeps coming": refusals
 * older than this restart the count. Rolling, not calendar. */
export const ACCOUNT_REFUSAL_WINDOW_MS = 24 * 60 * 60_000;

export interface AccountRefusalRow {
  id: string;
  refusalCount: number;
  windowCount: number;
  windowStartedAt: Date;
  firstRefusedAt: Date;
  notifiedAt: Date | null;
}

/** Normalise the caller's value the way the access check compares it. */
export function normalizeRequestedEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, 254);
}

/**
 * Record one refusal. First refusal inserts; later ones increment the
 * ever-count, and either extend the current 24 h window or start a new one
 * when the previous refusal is older than the window. Returns the resulting
 * row, or null if the write failed.
 */
export async function recordAccountRefusal(opts: {
  proxyKeyId: string; userId: string; requestedEmail: string; tool?: string | null;
}): Promise<AccountRefusalRow | null> {
  try {
    const stale = sql`${accountRefusals.lastRefusedAt} < now() - interval '24 hours'`;
    const [row] = await db.insert(accountRefusals)
      .values({
        proxyKeyId: opts.proxyKeyId,
        userId: opts.userId,
        requestedEmail: normalizeRequestedEmail(opts.requestedEmail),
        lastTool: opts.tool || null,
      })
      .onConflictDoUpdate({
        target: [accountRefusals.proxyKeyId, accountRefusals.requestedEmail],
        set: {
          refusalCount: sql`${accountRefusals.refusalCount} + 1`,
          windowCount: sql`case when ${stale} then 1 else ${accountRefusals.windowCount} + 1 end`,
          windowStartedAt: sql`case when ${stale} then now() else ${accountRefusals.windowStartedAt} end`,
          lastRefusedAt: sql`now()`,
          lastTool: sql`coalesce(excluded.last_tool, ${accountRefusals.lastTool})`,
        },
      })
      .returning({
        id: accountRefusals.id,
        refusalCount: accountRefusals.refusalCount,
        windowCount: accountRefusals.windowCount,
        windowStartedAt: accountRefusals.windowStartedAt,
        firstRefusedAt: accountRefusals.firstRefusedAt,
        notifiedAt: accountRefusals.notifiedAt,
      });
    return row ?? null;
  } catch (err) {
    console.error('[accountRefusals] refusal record failed:', err);
    return null;
  }
}

/**
 * Claim the right to email the owner about this row: flips `notified_at`
 * from NULL to now() atomically, and only while the owner is under
 * `maxPerDay` reminder emails in the last 24 h across both ledgers. Once
 * claimed, the row is never emailed again (released only on a definite
 * non-send).
 */
export async function claimAccountRefusalNotification(id: string, userId: string, maxPerDay: number): Promise<
  { claimed: true; notifiedAt: Date | null }
  | { claimed: false; notifiedAt: Date | null; reason: 'already' | 'capped' | 'missing' | 'error' }
> {
  try {
    const [row] = await db.update(accountRefusals)
      .set({ notifiedAt: sql`now()` })
      .where(and(
        eq(accountRefusals.id, id),
        isNull(accountRefusals.notifiedAt),
        sql`${recentNotificationCountSql(userId)} < ${maxPerDay}`,
      ))
      .returning({ notifiedAt: accountRefusals.notifiedAt });
    if (row) return { claimed: true, notifiedAt: row.notifiedAt };
    const existing = await db.select({ notifiedAt: accountRefusals.notifiedAt })
      .from(accountRefusals)
      .where(eq(accountRefusals.id, id))
      .limit(1).then(r => r[0]);
    if (!existing) return { claimed: false, notifiedAt: null, reason: 'missing' };
    if (existing.notifiedAt) return { claimed: false, notifiedAt: existing.notifiedAt, reason: 'already' };
    return { claimed: false, notifiedAt: null, reason: 'capped' };
  } catch (err) {
    console.error('[accountRefusals] notification claim failed:', err);
    return { claimed: false, notifiedAt: null, reason: 'error' };
  }
}

/** Undo a claim whose send definitely did not happen, so a later refusal can try again. */
export async function releaseAccountRefusalNotification(id: string): Promise<void> {
  try {
    await db.update(accountRefusals)
      .set({ notifiedAt: null })
      .where(eq(accountRefusals.id, id));
  } catch (err) {
    console.error('[accountRefusals] notification release failed:', err);
  }
}
