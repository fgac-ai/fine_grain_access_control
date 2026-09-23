/**
 * Pending-approvals banner: the cookie-free, browser-independent repair for
 * approval context lost between an agent's reply and the dashboard.
 *
 * Why this exists (measured 2026-09-16 -> 09-20, monitoring 7.25): the
 * sign-in wall's post-sign-in router (approvalRouting.ts) never fired in
 * production, and the ledger shows why it had nothing to do -- 16 of the 17
 * walled requests reached the approve page anyway (Clerk's own redirect_url
 * in the same browser, or the person re-opening the link in the browser they
 * are signed in to). The context that IS lost sits elsewhere: 47 of the 87
 * requests minted in that window were never opened at all, and the owners
 * who came to the dashboard afterwards found nothing there about them. This
 * banner lists the owner's open requests on every dashboard page, from the
 * ledger alone -- no cookie, no wall hit, no particular browser required.
 *
 * This module is the PURE part: which ledger rows count as pending, and the
 * link each one opens. The DB reads live in approvalRequests.ts, the render
 * in src/app/dashboard/PendingApprovalsBanner.tsx.
 *
 * Clearing rules, each a concrete exit:
 *   - approved: approved_at is stamped by every approval path. Gone.
 *   - granted elsewhere: the grant is already active (rule added from the
 *     dashboard, or an earlier same-file approval). The banner re-checks the
 *     live rules before rendering (approvalGrantState.ts); such a row never
 *     shows, and the approve page would only say "already active" anyway.
 *   - dismissed: the owner clicked "Dismiss". Hidden until the agent mints the
 *     link AGAIN (last_minted_at moves past dismissed_at) -- a fresh denial is
 *     fresh demand, and a dismissal must not silence it forever.
 *   - expired: nothing minted in the last PENDING_WINDOW_MS. A week-old denial
 *     the agent never repeated is history, not a to-do.
 *   - unlinkable: rows minted before link_query existed (and never walled)
 *     have no stored link and cannot be shown -- the approve page needs the
 *     signed query and the ledger never stored the target in the clear.
 *   - newest first, capped at PENDING_LIMIT: a looping agent can mint dozens;
 *     the banner shows the freshest few, and approving one re-renders it.
 */

export const PENDING_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const PENDING_LIMIT = 5;

/** `src=banner` on the approve URL: the open is attributed to the banner
 *  (approval_link_opened.link_source), the way `src=email` marks the reminder. */
export const BANNER_LINK_SOURCE_VALUE = 'banner';

export interface PendingApprovalRow {
  requestId: string;
  action: string;
  /** The link's own a/k/r/s query (link_query, else wall_query). */
  linkQuery: string | null;
  lastMintedAt: Date;
  approvedAt: Date | null;
  dismissedAt: Date | null;
}

export function selectPendingApprovals<T extends PendingApprovalRow>(rows: readonly T[], nowMs = Date.now()): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    if (row.approvedAt) continue;
    if (!row.linkQuery) continue;
    const age = nowMs - row.lastMintedAt.getTime();
    if (age > PENDING_WINDOW_MS) continue;
    if (row.dismissedAt && row.dismissedAt.getTime() >= row.lastMintedAt.getTime()) continue;
    kept.push(row);
  }
  kept.sort((a, b) => b.lastMintedAt.getTime() - a.lastMintedAt.getTime());
  return kept.slice(0, PENDING_LIMIT);
}

/** The approve page for a pending row: the link exactly as minted, plus the
 *  banner's delivery marker. */
export function pendingApprovalPath(row: Pick<PendingApprovalRow, 'linkQuery'>): string {
  return `/dashboard/approve?${row.linkQuery}&src=${BANNER_LINK_SOURCE_VALUE}`;
}

/** Parse a stored link query back into the approve page's search params. */
export function parseLinkQuery(linkQuery: string): { a?: string; k?: string; r?: string; s?: string } {
  const q = new URLSearchParams(linkQuery);
  const pick = (key: string) => q.get(key) ?? undefined;
  return { a: pick('a'), k: pick('k'), r: pick('r'), s: pick('s') };
}
