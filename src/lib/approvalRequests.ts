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
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

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

// ─── Approval sign-in wall → post-sign-in routing ───────────────────────────
// A signed-out visit to an approval link (the Claude desktop in-app browser
// on every click) is recorded against the link's OWNER — the key in the link
// resolves to a user and the signature verifies against that user, so no
// session is needed and nothing unsigned can plant a hit. When that owner
// then signs in and lands on /dashboard, `findRoutableWallHit` sends them
// straight back to the approval. Cross-browser by construction: the hit is
// keyed on the owner, not on a cookie.

/** Stamp a verified wall hit. `wallQuery` is the link's own a/k/r/s query
 *  string, stored verbatim so the redirect needs no re-signing. */
export async function recordApprovalWallHit(requestId: string, wallQuery: string): Promise<boolean> {
  try {
    const rows = await db.update(approvalRequests)
      .set({ wallHitAt: new Date(), wallQuery, routedAt: null })
      .where(eq(approvalRequests.requestId, requestId))
      .returning({ requestId: approvalRequests.requestId });
    return rows.length > 0;
  } catch (err) {
    console.error('[approvalRequests] wall hit record failed:', err);
    return false;
  }
}

export interface RoutableWallHit {
  requestId: string;
  action: string;
  wallQuery: string;
  wallHitAt: Date;
}

/** Candidate rows for routing: this owner's requests with a wall hit and no
 *  approval. The pure decision (recency, opened-since, routed-once) lives in
 *  `src/lib/approvalRouting.ts` so it can be unit-tested. */
export async function listWallHitsForRouting(userId: string): Promise<Array<RoutableWallHit & { openedAt: Date | null; routedAt: Date | null }>> {
  try {
    const rows = await db.select({
      requestId: approvalRequests.requestId,
      action: approvalRequests.action,
      wallQuery: approvalRequests.wallQuery,
      wallHitAt: approvalRequests.wallHitAt,
      openedAt: approvalRequests.openedAt,
      routedAt: approvalRequests.routedAt,
    })
      .from(approvalRequests)
      .where(and(
        eq(approvalRequests.userId, userId),
        isNull(approvalRequests.approvedAt),
        isNotNull(approvalRequests.wallHitAt),
        isNotNull(approvalRequests.wallQuery),
      ));
    return rows.flatMap(r => r.wallHitAt && r.wallQuery
      ? [{ requestId: r.requestId, action: r.action, wallQuery: r.wallQuery, wallHitAt: r.wallHitAt, openedAt: r.openedAt, routedAt: r.routedAt }]
      : []);
  } catch (err) {
    console.error('[approvalRequests] wall hit lookup failed:', err);
    return [];
  }
}

/** Stamp that /dashboard routed the owner to this request — once per hit. */
export async function markApprovalRequestRouted(requestId: string): Promise<void> {
  try {
    await db.update(approvalRequests)
      .set({ routedAt: new Date() })
      .where(eq(approvalRequests.requestId, requestId));
  } catch (err) {
    console.error('[approvalRequests] route record failed:', err);
  }
}

/** The /dashboard decision in one call (keeps the clock out of render):
 *  the route to send a freshly signed-in owner to, stamped as routed, or
 *  null. Rules in src/lib/approvalRouting.ts. */
export async function resolveWallRoute(userId: string): Promise<{ path: string; requestId: string; action: string; secondsSinceWall: number } | null> {
  const { pickRoutableWallHit, approvalRoutePath } = await import('./approvalRouting');
  const now = Date.now();
  const hit = pickRoutableWallHit(await listWallHitsForRouting(userId), now);
  if (!hit) return null;
  await markApprovalRequestRouted(hit.requestId);
  return {
    path: approvalRoutePath(hit),
    requestId: hit.requestId,
    action: hit.action,
    secondsSinceWall: Math.max(0, Math.round((now - hit.wallHitAt.getTime()) / 1000)),
  };
}
