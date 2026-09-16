/**
 * Approval-request ledger — one row per request, keyed by the deterministic
 * request_id from approvalLinks.ts.
 *
 * Why this exists: before 2026-08-25 the only durable record of an approval
 * was `approval_consumptions` (a jti per CONSUMED link), so "how many people
 * asked for access, and how many never saw the link?" could only be answered
 * from analytics events keyed on a per-mint id. Every agent retry minted a
 * new id, so retries were indistinguishable from fresh demand and the funnel
 * read far worse than it was.
 *
 * Every write here is best-effort: an approval denial must never fail because
 * bookkeeping failed. Callers do not await correctness, only completion.
 */
import { db } from '@/db';
import { accountRefusals, approvalRequests } from '@/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Record one mint ATTEMPT. First attempt inserts; retries increment
 * `mintCount` so demand (rows) stays separable from retry pressure.
 * Returns the resulting mint count, or null if the write failed.
 */
export async function recordApprovalMint(opts: {
  requestId: string;
  userId: string;
  proxyKeyId: string;
  action: string;
  targetHash?: string;
  /** Agent-supplied file title (request_access). First non-empty value wins:
   * a later mint without a name never erases one, and a later mint WITH a
   * name fills a row that was minted nameless by a policy denial. */
  resourceName?: string;
}): Promise<number | null> {
  try {
    const [row] = await db.insert(approvalRequests)
      .values({
        requestId: opts.requestId,
        userId: opts.userId,
        proxyKeyId: opts.proxyKeyId,
        action: opts.action,
        targetHash: opts.targetHash ?? null,
        resourceName: opts.resourceName ?? null,
      })
      .onConflictDoUpdate({
        target: approvalRequests.requestId,
        set: {
          mintCount: sql`${approvalRequests.mintCount} + 1`,
          lastMintedAt: new Date(),
          resourceName: sql`coalesce(${approvalRequests.resourceName}, excluded.resource_name)`,
        },
      })
      .returning({ mintCount: approvalRequests.mintCount });
    return row?.mintCount ?? null;
  } catch (err) {
    console.error('[approvalRequests] mint record failed:', err);
    return null;
  }
}

/**
 * Title stored at mint time, if any — the approve page's only source of a
 * human-readable name for a file Google does not share with FGAC yet (the
 * URL never carries one, and Drive cannot resolve an unshared id). Read-only
 * and best-effort: a lookup failure renders the id, never an error.
 */
export async function getApprovalRequestResourceName(requestId: string): Promise<string | null> {
  try {
    const row = await db.select({ resourceName: approvalRequests.resourceName })
      .from(approvalRequests)
      .where(eq(approvalRequests.requestId, requestId))
      .limit(1).then(r => r[0]);
    return row?.resourceName?.trim() || null;
  } catch (err) {
    console.error('[approvalRequests] resource name lookup failed:', err);
    return null;
  }
}

/** Stamp the first time a request's approve page was loaded. */
export async function markApprovalRequestOpened(requestId: string): Promise<void> {
  try {
    await db.update(approvalRequests)
      .set({ openedAt: sql`coalesce(${approvalRequests.openedAt}, now())` })
      .where(eq(approvalRequests.requestId, requestId));
  } catch (err) {
    console.error('[approvalRequests] open record failed:', err);
  }
}

/** Stamp the first time a request was approved. */
export async function markApprovalRequestApproved(requestId: string): Promise<void> {
  try {
    await db.update(approvalRequests)
      .set({ approvedAt: sql`coalesce(${approvalRequests.approvedAt}, now())` })
      .where(eq(approvalRequests.requestId, requestId));
  } catch (err) {
    console.error('[approvalRequests] approve record failed:', err);
  }
}

// ─── Out-of-band notification bookkeeping (approvalNotify.ts) ───────────────

/** What the reminder needs to decide whether this mint is "the agent asked again". */
export async function getApprovalNotificationState(requestId: string): Promise<
  | { kind: 'row'; mintCount: number; firstMintedAt: Date; openedAt: Date | null; notifiedAt: Date | null }
  | { kind: 'missing' } | { kind: 'error' }
> {
  try {
    const row = await db.select({
      mintCount: approvalRequests.mintCount,
      firstMintedAt: approvalRequests.firstMintedAt,
      openedAt: approvalRequests.openedAt,
      notifiedAt: approvalRequests.notifiedAt,
    })
      .from(approvalRequests)
      .where(eq(approvalRequests.requestId, requestId))
      .limit(1).then(r => r[0]);
    return row ? { kind: 'row', ...row } : { kind: 'missing' };
  } catch (err) {
    console.error('[approvalRequests] notification state read failed:', err);
    return { kind: 'error' };
  }
}

/**
 * How many reminder emails this owner has been sent in the last 24 h, across
 * BOTH ledgers (approval-link reminders on approval_requests, account-refusal
 * notices on account_refusals). Both claims embed this in their UPDATE so the
 * two triggers share one per-person budget and concurrent claims cannot each
 * pass a separate count.
 */
export function recentNotificationCountSql(userId: string) {
  return sql`((SELECT count(*) FROM ${approvalRequests} AS recent_links
               WHERE recent_links.user_id = ${userId} AND recent_links.notified_at > now() - interval '24 hours')
            + (SELECT count(*) FROM ${accountRefusals} AS recent_refusals
               WHERE recent_refusals.user_id = ${userId} AND recent_refusals.notified_at > now() - interval '24 hours'))`;
}

/**
 * Claim the right to email this request's link: flips `notified_at` from
 * NULL to now() atomically, and only while the owner is under `maxPerDay`
 * emails in the last 24 h (both ledgers) — cap and claim in ONE statement, so concurrent
 * mints cannot each pass a separate count check. Returns the stamp when
 * claimed; otherwise says why (already emailed, capped, no ledger row, or a
 * DB error — the last two are delivery failures, never "already emailed").
 */
export async function claimApprovalNotification(requestId: string, userId: string, maxPerDay: number): Promise<
  { claimed: true; notifiedAt: Date | null }
  | { claimed: false; notifiedAt: Date | null; reason: 'already' | 'capped' | 'missing' | 'error' }
> {
  try {
    const [row] = await db.update(approvalRequests)
      .set({ notifiedAt: sql`now()` })
      .where(and(
        eq(approvalRequests.requestId, requestId),
        isNull(approvalRequests.notifiedAt),
        sql`${recentNotificationCountSql(userId)} < ${maxPerDay}`,
      ))
      .returning({ notifiedAt: approvalRequests.notifiedAt });
    if (row) return { claimed: true, notifiedAt: row.notifiedAt };
    const existing = await db.select({ notifiedAt: approvalRequests.notifiedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.requestId, requestId))
      .limit(1).then(r => r[0]);
    if (!existing) return { claimed: false, notifiedAt: null, reason: 'missing' };
    if (existing.notifiedAt) return { claimed: false, notifiedAt: existing.notifiedAt, reason: 'already' };
    return { claimed: false, notifiedAt: null, reason: 'capped' };
  } catch (err) {
    console.error('[approvalRequests] notification claim failed:', err);
    return { claimed: false, notifiedAt: null, reason: 'error' };
  }
}

/** Undo a claim whose send definitely did not happen, so the next repeat can try again. */
export async function releaseApprovalNotification(requestId: string): Promise<void> {
  try {
    await db.update(approvalRequests)
      .set({ notifiedAt: null })
      .where(eq(approvalRequests.requestId, requestId));
  } catch (err) {
    console.error('[approvalRequests] notification release failed:', err);
  }
}
