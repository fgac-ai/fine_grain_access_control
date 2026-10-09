import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { temporaryApiKeys, users } from '@/db/schema';
import { captureServerEvent } from '@/lib/posthogServer';
import { isTemporaryKey, hashTemporaryKey, PING_OK } from '@/lib/temporaryApiKeys';

/**
 * Reachability check for code an agent runs (create_temporary_api_key).
 *
 * Many sandboxes allow only listed hosts while the rest of the internet
 * works, so "do you have network access?" is not the question that decides
 * whether a temporary key can be used — "can you reach this host?" is. In
 * the week after launch about half of claude-code's keys were minted and
 * never used, concentrated on accounts where no key ever worked, each mint
 * followed by more windowed MCP reads (plan:
 * docs/implementation_plans/claude/temp-key-never-used_v1.md).
 *
 * Without a key: answers `fgac-proxy-ok`, so an agent can check BEFORE
 * minting. With a temporary key as the Bearer: also says whether the key
 * the script read from its temp file is the one FGAC issued, so a broken
 * hand-off is told apart from a blocked network. Nothing here touches
 * Google. A static segment, so it wins over the [...path] catch-all.
 */
export const dynamic = 'force-dynamic';

function text(body: string, status = 200) {
  return new NextResponse(`${body}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function ping(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return text(PING_OK);
  const keyValue = auth.slice('Bearer '.length).trim();
  if (!isTemporaryKey(keyValue)) return text(`${PING_OK} key-not-temporary`, 401);

  const tempKey = await db.select().from(temporaryApiKeys)
    .where(eq(temporaryApiKeys.keyHash, hashTemporaryKey(keyValue)))
    .limit(1).then(r => r[0]);
  if (!tempKey) return text(`${PING_OK} key-invalid`, 401);

  const outcome = tempKey.revokedAt ? 'revoked' : tempKey.expiresAt < new Date() ? 'expired' : 'valid';
  const owner = await db.select({ clerkUserId: users.clerkUserId }).from(users)
    .where(eq(users.id, tempKey.userId)).limit(1).then(r => r[0]);
  if (owner?.clerkUserId) {
    captureServerEvent(owner.clerkUserId, 'temp_api_key_pinged', {
      temp_key_id: tempKey.id, outcome, purpose: tempKey.purpose,
      user_agent: request.headers.get('user-agent')?.slice(0, 120) ?? undefined,
    });
  }
  return outcome === 'valid' ? text(`${PING_OK} key-valid`) : text(`${PING_OK} key-${outcome}`, 401);
}

export async function GET(request: NextRequest) {
  return ping(request);
}

export async function HEAD(request: NextRequest) {
  const res = await ping(request);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
