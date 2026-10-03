import { NextRequest, NextResponse } from 'next/server';
import { requireDriveTreeSession, searchDrive } from '@/lib/driveTreeServer';

export const dynamic = 'force-dynamic';

/**
 * Drive tree card search: name matches across the whole Drive, each with its
 * folder path so the card can show where a result lives and what it
 * inherits. Gated like the children route.
 */
export async function GET(request: NextRequest) {
  const session = await requireDriveTreeSession();
  if (session instanceof NextResponse) return session;
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2 || q.length > 100) return NextResponse.json({ results: [] });
  const result = await searchDrive(session, q);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
