import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { proxyKeys } from '@/db/schema';
import { verifyApprovalParams } from '@/lib/approvalLinks';
import { canonicalWallQuery } from '@/lib/approvalRouting';
import { recordApprovalWallHit } from '@/lib/approvalRequests';
import { captureServerEvent } from '@/lib/posthogServer';

export const dynamic = 'force-dynamic';

/**
 * Records an approval sign-in wall hit against the link's OWNER.
 *
 * Called by middleware (fire-and-forget) when a signed-out document
 * navigation lands on an approval link. Middleware runs on the edge with no
 * database, so the ledger write happens here. Deliberately public and
 * unauthenticated: the request body is the link's own a/k/r/s parameters,
 * the key resolves to its owner, and the signature is verified against that
 * owner — so only a link FGAC minted can plant a hit, and the worst a replay
 * can do is send the owner to their own approve page once, which they can
 * leave. Nothing is granted here.
 *
 * Answers 204 in every outcome except a malformed body: the caller does not
 * wait for it, and a lookup failure must never surface anywhere.
 */
export async function POST(request: NextRequest) {
  let body: { a?: string; k?: string; r?: string; s?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const params = { a: str(body.a), k: str(body.k), r: str(body.r), s: str(body.s) };
  if (!params.a || !params.k || !params.s) return new NextResponse(null, { status: 204 });

  try {
    const owner = await db.select({ userId: proxyKeys.userId })
      .from(proxyKeys)
      .where(eq(proxyKeys.id, params.k))
      .limit(1).then(r => r[0]);
    if (!owner) return new NextResponse(null, { status: 204 });

    const verified = await verifyApprovalParams(owner.userId, params);
    if (!verified.ok) return new NextResponse(null, { status: 204 });

    const q = new URLSearchParams();
    if (params.a) q.set('a', params.a);
    if (params.k) q.set('k', params.k);
    if (params.r) q.set('r', params.r);
    if (params.s) q.set('s', params.s);
    const recorded = await recordApprovalWallHit(verified.payload.requestId, canonicalWallQuery(q));
    captureServerEvent('anonymous-approve-wall', 'approval_wall_recorded', {
      action: verified.payload.action,
      request_id: verified.payload.requestId,
      recorded,
    });
  } catch (err) {
    console.error('[approval-wall] record failed:', err);
  }
  return new NextResponse(null, { status: 204 });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : undefined;
}
