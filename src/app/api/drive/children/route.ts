import { NextRequest, NextResponse } from 'next/server';
import { requireDriveTreeSession, listRoots, listChildren } from '@/lib/driveTreeServer';

export const dynamic = 'force-dynamic';

/**
 * Drive tree card: `?parent=roots` returns the three roots (My Drive by its
 * real id, Shared with me, Shared drives); any other value lists that node's
 * children (a folder id, a shared drive id, or a pseudo-root id). Gated by
 * the feature flag and the full `drive` scope (requireDriveTreeSession).
 */
export async function GET(request: NextRequest) {
  const session = await requireDriveTreeSession();
  if (session instanceof NextResponse) return session;
  const parent = request.nextUrl.searchParams.get('parent') ?? 'roots';
  const pageToken = request.nextUrl.searchParams.get('pageToken');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(parent)) {
    return NextResponse.json({ error: 'Invalid parent id' }, { status: 400 });
  }
  const result = parent === 'roots' ? await listRoots(session.token) : await listChildren(session.token, parent, pageToken);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status === 404 ? 404 : 502 });
  return NextResponse.json(result);
}
