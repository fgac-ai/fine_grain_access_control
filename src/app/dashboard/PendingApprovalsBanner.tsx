import { verifyApprovalParams, describeApproval } from '@/lib/approvalLinks';
import { grantActiveForApproval } from '@/lib/approvalGrantState';
import { listPendingApprovalRows } from '@/lib/approvalRequests';
import { PENDING_WINDOW_MS, parseLinkQuery, pendingApprovalPath, selectPendingApprovals } from '@/lib/approvalPending';
import { captureServerEvent } from '@/lib/posthogServer';
import { PendingApprovalsList, type PendingApprovalItem } from './PendingApprovalsList';

/**
 * The dashboard's "approvals waiting for you" card (src/lib/approvalPending.ts
 * has the rules and the why). Server-rendered on every dashboard page from
 * the request ledger, so it reaches the owner in whatever browser they sign
 * in with -- including the person whose agent showed a link they never
 * clicked, and the Claude desktop user whose click bounced off the sign-in
 * wall in the in-app browser. Renders nothing when there is nothing pending.
 *
 * Each row is re-verified before it shows: the stored query must still sign
 * against this owner (it always does -- links are permanent -- but a row is
 * never trusted over the signature), and a grant that is already active is
 * left out rather than shown as pending (the "granted elsewhere" clearing
 * rule). Every lookup is best-effort: the dashboard must never fail because
 * the banner could not load.
 */
export async function PendingApprovalsBanner({
  userId,
  clerkUserId,
  profiles,
}: {
  userId: string;
  clerkUserId: string;
  profiles: ReadonlyArray<{ id: string; label: string }>;
}) {
  let items: PendingApprovalItem[] = [];
  try {
    const rows = selectPendingApprovals(await listPendingApprovalRows(userId, PENDING_WINDOW_MS));
    const labels = new Map(profiles.map(p => [p.id, p.label]));
    for (const row of rows) {
      if (!row.linkQuery) continue;
      const verified = await verifyApprovalParams(userId, parseLinkQuery(row.linkQuery));
      if (!verified.ok) continue;
      const payload = verified.payload;
      if (row.resourceName && !payload.resourceName) payload.resourceName = row.resourceName;
      if (await grantActiveForApproval(payload, payload.proxyKeyId)) continue;
      items.push({
        requestId: row.requestId,
        action: row.action,
        description: describeApproval(payload),
        profileLabel: labels.get(row.proxyKeyId) ?? null,
        path: pendingApprovalPath(row),
        lastMintedAt: row.lastMintedAt.toISOString(),
        mintCount: row.mintCount,
      });
    }
  } catch (err) {
    console.error('[PendingApprovalsBanner] load failed:', err);
    items = [];
  }
  if (items.length === 0) return null;

  captureBannerShown(clerkUserId, items);

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8">
      <PendingApprovalsList items={items} />
    </div>
  );
}

/** One `approval_banner_shown` per render that had something to show. */
function captureBannerShown(clerkUserId: string, items: PendingApprovalItem[]): void {
  const oldestMintMs = Math.min(...items.map(i => Date.parse(i.lastMintedAt)));
  captureServerEvent(clerkUserId, 'approval_banner_shown', {
    pending_count: items.length,
    actions: items.map(i => i.action),
    request_ids: items.map(i => i.requestId),
    oldest_pending_s: Math.max(0, Math.round((Date.now() - oldestMintMs) / 1000)),
  });
}
