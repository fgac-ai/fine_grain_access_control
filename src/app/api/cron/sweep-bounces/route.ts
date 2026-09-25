/**
 * Bounce sweep cron — hourly (vercel.json). Reads the support mailbox's
 * delivery-status reports through FGAC's own proxy API and files each on the
 * bounce ledger, so a mailbox that returned a notice as undeliverable is
 * never emailed again and the agent behind it gets a truthful stop instead
 * of a dead reconnect link (src/lib/emailBounceSweep.ts). Hourly, not daily:
 * the agent is refused on every call, and each hour of lag is another hour
 * of the dead link. `disabled` where the sender is not configured (local and
 * preview by default).
 */
import { NextRequest, NextResponse } from 'next/server';
import { sweepBounces } from '@/lib/emailBounceSweep';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.get('Authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await sweepBounces();
  console.log(`[Cron:sweep-bounces] ${result.status} listed=${result.listed} fresh=${result.fresh} gone=${result.recorded.mailbox_gone} rejected=${result.recorded.rejected} transient=${result.recorded.transient} unmatched=${result.recorded.unmatched} failed=${result.failed}`);
  return NextResponse.json(result, { status: result.status === 'failed' ? 502 : 200 });
}
