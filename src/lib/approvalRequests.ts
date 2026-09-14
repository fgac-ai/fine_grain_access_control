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
import { approvalRequests } from '@/db/schema';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

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

/**
 * Claim the right to email this request's link: flips `notified_at` from
 * NULL to now() atomically, so two concurrent mints (or a looping agent)
 * cannot both send. Returns `claimed: true` with the stamp, or the existing
 * stamp when the request was already notified. A DB error reads as "already
 * notified" — the safe direction: a lost email costs a channel, a duplicate
 * costs trust.
 */
export async function claimApprovalNotification(requestId: string): Promise<
  { claimed: true; notifiedAt: Date | null } | { claimed: false; notifiedAt: Date | null; reason: 'already' | 'missing' | 'error' }
> {
  try {
    const [row] = await db.update(approvalRequests)
      .set({ notifiedAt: sql`now()` })
      .where(and(eq(approvalRequests.requestId, requestId), isNull(approvalRequests.notifiedAt)))
      .returning({ notifiedAt: approvalRequests.notifiedAt });
    if (row) return { claimed: true, notifiedAt: row.notifiedAt };
    const existing = await db.select({ notifiedAt: approvalRequests.notifiedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.requestId, requestId))
      .limit(1).then(r => r[0]);
    // No ledger row (the mint record failed): there is nothing to claim on,
    // and "already emailed" would be a lie — report it as missing instead.
    if (!existing) return { claimed: false, notifiedAt: null, reason: 'missing' };
    return { claimed: false, notifiedAt: existing.notifiedAt, reason: 'already' };
  } catch (err) {
    console.error('[approvalRequests] notification claim failed:', err);
    return { claimed: false, notifiedAt: null, reason: 'error' };
  }
}

/** Undo a claim whose send did not happen, so the next mint can try again. */
export async function releaseApprovalNotification(requestId: string): Promise<void> {
  try {
    await db.update(approvalRequests)
      .set({ notifiedAt: null })
      .where(eq(approvalRequests.requestId, requestId));
  } catch (err) {
    console.error('[approvalRequests] notification release failed:', err);
  }
}

/** Emails sent to this owner in the last hour (the per-owner cap input). */
export async function countRecentApprovalNotifications(userId: string): Promise<number> {
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.userId, userId), gt(approvalRequests.notifiedAt, sql`now() - interval '1 hour'`)));
    return row?.n ?? 0;
  } catch (err) {
    console.error('[approvalRequests] notification count failed:', err);
    // Unknown = treat as capped: never risk a burst on a broken read.
    return Number.MAX_SAFE_INTEGER;
  }
}
