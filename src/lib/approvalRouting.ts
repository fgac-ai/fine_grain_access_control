/**
 * Post-sign-in routing decision for the approval sign-in wall.
 *
 * `/dashboard` is where every sign-in ends up (Clerk's Home URL, the hosted
 * sign-in page's fallback, the nav link) — including the sign-in a person
 * makes AFTER an approval link bounced them off the wall in a browser that
 * held no session. This module decides, from the owner's ledger rows, whether
 * that person should be sent straight back to the approval instead of the
 * profile page. Pure, so the rules are unit-tested; the DB reads live in
 * `approvalRequests.ts`.
 *
 * Rules, each a concrete exit rather than a guess:
 *   - recent: the wall hit is under ROUTE_WINDOW_MS old. A hit from yesterday
 *     is history, not intent.
 *   - not seen since: the approve page has not been opened by the owner since
 *     the hit (opened_at stamps on every owner render). If they already got
 *     there — same-browser sign-in where Clerk honoured redirect_url — there
 *     is nothing to route.
 *   - once per hit: routed_at is null (a re-hit resets it). Someone who backs
 *     out of the approve page to the dashboard must not be bounced back.
 *   - newest hit wins when several qualify; the rest stay reachable through
 *     the pending-approvals surface (implementation plan, Proposal A).
 */

export const ROUTE_WINDOW_MS = 30 * 60_000;

export interface WallHitRow {
  requestId: string;
  action: string;
  wallQuery: string;
  wallHitAt: Date;
  openedAt: Date | null;
  routedAt: Date | null;
}

export function pickRoutableWallHit<T extends WallHitRow>(rows: readonly T[], nowMs = Date.now()): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const age = nowMs - row.wallHitAt.getTime();
    if (age < 0 || age > ROUTE_WINDOW_MS) continue;
    if (row.routedAt && row.routedAt.getTime() >= row.wallHitAt.getTime()) continue;
    if (row.openedAt && row.openedAt.getTime() >= row.wallHitAt.getTime()) continue;
    if (!row.wallQuery) continue;
    if (!best || row.wallHitAt.getTime() > best.wallHitAt.getTime()) best = row;
  }
  return best;
}

/** The redirect target for a chosen hit: the approve page with the link's
 *  own query string, exactly as it was minted. */
export function approvalRoutePath(hit: Pick<WallHitRow, 'wallQuery'>): string {
  return `/dashboard/approve?${hit.wallQuery}`;
}

/** Only a/k/r/s survive — the stored query is exactly the signed link, never
 *  a result/notice/sid parameter a redirect may have appended. */
export function canonicalWallQuery(searchParams: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const key of ['a', 'k', 'r', 's'] as const) {
    const v = searchParams.get(key);
    if (v) q.set(key, v);
  }
  return q.toString();
}

/** Why nothing routed, per rule, for a set of candidate rows. Captured as
 *  `approval_wall_route_skipped` so production can tell "no candidate row"
 *  from "a rule excluded it" from "the lookup failed" -- the three read
 *  identically (no `approval_wall_routed`) until 2026-09-20, when a local
 *  repro produced one unexplained non-route in six with a routable row. */
export interface WallRouteSkip {
  candidates: number;
  stale: number;
  routed_already: number;
  opened_since: number;
  no_query: number;
  future: number;
}

export function explainWallRouteSkip(rows: readonly WallHitRow[], nowMs = Date.now()): WallRouteSkip {
  const skip: WallRouteSkip = { candidates: rows.length, stale: 0, routed_already: 0, opened_since: 0, no_query: 0, future: 0 };
  for (const row of rows) {
    const age = nowMs - row.wallHitAt.getTime();
    if (age < 0) skip.future++;
    else if (age > ROUTE_WINDOW_MS) skip.stale++;
    if (row.routedAt && row.routedAt.getTime() >= row.wallHitAt.getTime()) skip.routed_already++;
    if (row.openedAt && row.openedAt.getTime() >= row.wallHitAt.getTime()) skip.opened_since++;
    if (!row.wallQuery) skip.no_query++;
  }
  return skip;
}
