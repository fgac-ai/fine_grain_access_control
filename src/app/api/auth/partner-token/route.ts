/**
 * Partner Token Exchange — /api/auth/partner-token
 *
 * A partner server exchanges its Clerk OAuth access token for the connection's
 * sk_proxy_ key, for use against the REST proxy (gmail.fgac.ai) with stock
 * Google SDKs. Sibling of /api/auth/cli-token with partner-flow semantics:
 * a consented partner connection is already approved, so the normal outcome is
 * an immediate key. Pending/blocked map to the same fail-safe behavior the MCP
 * server enforces.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { agentConnections, users, proxyKeys, keyEmailAccess } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { verifyClerkOauthToken } from '@/lib/partner/clerkOauth';
import { filterLiveDelegatedAccess } from '@/db/delegationQueries';
import { connectionsDeepLink } from '@/lib/dashboardAgentLinks';
import { linkBase } from '@/lib/linkOrigin';
import { requestOrigin } from '@/lib/temporaryApiKeys';

const DASHBOARD_URL = process.env.NEXT_PUBLIC_APP_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  || 'http://localhost:3000';

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ status: 'error', message: 'Missing Authorization header' }, { status: 401 });
  }

  const verified = await verifyClerkOauthToken(authHeader.slice(7));
  if (!verified) {
    return NextResponse.json({ status: 'error', message: 'Invalid or expired token' }, { status: 401 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, verified.userId),
  });
  if (!user) {
    return NextResponse.json({ status: 'error', message: 'User not found' }, { status: 404 });
  }

  const connection = await db.query.agentConnections.findFirst({
    where: and(
      eq(agentConnections.userId, user.id),
      eq(agentConnections.clientId, verified.clientId),
    ),
  });

  if (!connection || connection.status === 'pending' || !connection.proxyKeyId) {
    return NextResponse.json({
      status: 'pending',
      message: '⏳ This connection is awaiting user approval.',
      dashboard_url: await connectionsDeepLink(linkBase(DASHBOARD_URL, process.env, requestOrigin(request)), user.id),
    });
  }
  if (connection.status === 'blocked') {
    return NextResponse.json({
      status: 'blocked',
      message: '🚫 This connection has been blocked by the user.',
    }, { status: 403 });
  }

  const key = await db.query.proxyKeys.findFirst({
    where: eq(proxyKeys.id, connection.proxyKeyId),
  });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) {
    return NextResponse.json({
      status: 'blocked',
      message: '🚫 The key behind this connection is revoked or expired.',
    }, { status: 403 });
  }

  const emailRows = await db.select().from(keyEmailAccess)
    .where(eq(keyEmailAccess.proxyKeyId, key.id));
  const liveAccess = await filterLiveDelegatedAccess(emailRows);

  await db.update(agentConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentConnections.id, connection.id));

  return NextResponse.json({
    status: 'approved',
    proxy_key: key.key,
    key_label: key.label,
    connection_id: connection.id,
    emails: liveAccess.map(e => e.targetEmail),
    proxy_endpoint: DASHBOARD_URL.includes('localhost')
      ? DASHBOARD_URL
      : DASHBOARD_URL.replace('://', '://gmail.'),
  });
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/auth/partner-token',
    description: 'Exchange a Clerk OAuth token from the partner handoff for the connection\'s FGAC proxy key.',
    usage: 'POST with Authorization: Bearer <clerk_oauth_access_token>',
  });
}
