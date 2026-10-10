/**
 * CLI Token Endpoint — /api/auth/cli-token
 *
 * Used by local scripts (OpenClaw skill, Claude Code CLI) to:
 * 1. Exchange a Clerk OAuth token for connection status
 * 2. Retrieve the assigned proxy key after dashboard approval
 *
 * Flow:
 *   Script does Clerk OAuth (DCR + PKCE) → gets access_token
 *   Script POSTs here with Bearer token
 *   → If new: creates pending connection, returns dashboard URL
 *   → If pending: returns dashboard URL
 *   → If approved: returns proxy key + accessible emails
 *   → If blocked: returns blocked status
 */
import { verifyClerkToken } from '@clerk/mcp-tools/next';
import { auth } from '@clerk/nextjs/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from '@/db';
import {
  agentConnections, users, proxyKeys, keyEmailAccess,
} from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { connectionsDeepLink } from '@/lib/dashboardAgentLinks';
import { linkBase } from '@/lib/linkOrigin';
import { requestOrigin } from '@/lib/temporaryApiKeys';
import { isKeyLive } from '@/lib/connectionState';

const DASHBOARD_URL = process.env.NEXT_PUBLIC_APP_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  || 'http://localhost:3000';

/**
 * Decode and verify a Clerk OAuth JWT directly against the Clerk JWKS endpoint.
 * This is the fallback when auth()+verifyClerkToken fails (common in CLI/non-browser contexts
 * where Clerk middleware doesn't intercept the request).
 */
async function verifyClerkJwtDirect(token: string): Promise<{ userId: string; clientId: string } | null> {
  try {
    // Decode the payload without verification first to get the issuer
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const issuer = payload.iss;
    if (!issuer) return null;

    // Verify signature against Clerk's JWKS
    const JWKS = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    const { payload: verified } = await jwtVerify(token, JWKS, {
      issuer,
      clockTolerance: 30,
    });

    const sub = verified.sub;
    const cid = (verified as Record<string, unknown>).client_id as string | undefined;

    if (!sub || !cid) return null;
    return { userId: sub, clientId: cid };
  } catch (err) {
    console.error('[CLI-Token] JWT direct verification failed:', err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    // --- Auth: verify Clerk OAuth token ---
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { status: 'error', message: 'Missing Authorization header' },
        { status: 401 }
      );
    }

    const bearerToken = authHeader.slice(7);
    let userId: string | undefined;
    let clientId: string | undefined;

    // Strategy 1: Direct JWT verification (most reliable for CLI/non-browser OAuth tokens)
    const direct = await verifyClerkJwtDirect(bearerToken);
    if (direct) {
      userId = direct.userId;
      clientId = direct.clientId;
      console.log(`[CLI-Token] Direct JWT verified: userId=${userId} clientId=${clientId}`);
    }

    // Strategy 2: Clerk auth() + verifyClerkToken (fallback for browser/session contexts)
    if (!userId || !clientId) {
      try {
        const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
        const authInfo = verifyClerkToken(clerkAuth, bearerToken);
        userId = authInfo?.extra?.userId as string | undefined;
        clientId = (authInfo as unknown as Record<string, unknown>)?.clientId as string | undefined;
      } catch (err) {
        console.warn('[CLI-Token] Clerk auth() also failed:', err);
      }
    }

    if (!userId || !clientId) {
      return NextResponse.json(
        { status: 'error', message: 'Invalid or expired token. Re-run: node auth.js --action login' },
        { status: 401 }
      );
    }


  // --- Resolve user ---
  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, userId),
  });

  if (!user) {
    return NextResponse.json(
      { status: 'error', message: 'User not found. Sign up at the dashboard first.' },
      { status: 404 }
    );
  }

  // --- Find or create agent connection ---
  let connection = await db.query.agentConnections.findFirst({
    where: and(
      eq(agentConnections.userId, user.id),
      eq(agentConnections.clientId, clientId),
    ),
  });

  // Parse client_name from request body if provided
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const clientName = (body.client_name as string) || clientId;

  if (!connection) {
    const [newConn] = await db.insert(agentConnections).values({
      userId: user.id,
      clientId,
      clientName,
      status: 'pending',
    }).returning();
    connection = newConn;

    console.log(`[CLI-Token] New connection: user=${user.email} client=${clientId} conn=${connection.id} status=PENDING`);
  }

  // Update last used
  await db.update(agentConnections)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentConnections.id, connection.id));

  // --- Return based on status ---
  if (connection.status === 'pending') {
    const dashboardUrl = await connectionsDeepLink(linkBase(DASHBOARD_URL, process.env, requestOrigin(request)), user.id);
    return NextResponse.json({
      status: 'pending',
      message: '⚠️ This connection has not been approved yet.',
      dashboard_url: dashboardUrl,
      instructions: [
        'Ask the user to visit their FGAC dashboard to approve this connection.',
        'Once approved, re-run this auth command to retrieve your proxy key.',
      ],
    });
  }

  if (connection.status === 'blocked') {
    return NextResponse.json({
      status: 'blocked',
      message: '🚫 This connection has been blocked by the user.',
    }, { status: 403 });
  }

  // --- Approved: return proxy key + emails ---
  if (!connection.proxyKeyId) {
    return NextResponse.json({
      status: 'approved_no_key',
      message: 'Connection approved but no proxy key assigned. Ask user to assign one in the dashboard.',
      dashboard_url: await connectionsDeepLink(linkBase(DASHBOARD_URL, process.env, requestOrigin(request)), user.id),
    });
  }

  const proxyKey = await db.query.proxyKeys.findFirst({
    where: eq(proxyKeys.id, connection.proxyKeyId),
  });

  if (!proxyKey) {
    return NextResponse.json({
      status: 'error',
      message: 'Assigned proxy key not found.',
    }, { status: 500 });
  }

  // Revoked/expired profile: the key would be refused by the proxy anyway —
  // say why and where to re-attach instead of handing out a dead key.
  if (!isKeyLive(proxyKey)) {
    return NextResponse.json({
      status: 'profile_revoked',
      message: '🚫 This connection has been blocked: the agent profile it was attached to was revoked.',
      dashboard_url: await connectionsDeepLink(linkBase(DASHBOARD_URL, process.env, requestOrigin(request)), user.id),
      instructions: [
        'Ask the user to attach this connection to an active profile in their FGAC dashboard.',
        'Then re-run this auth command to retrieve the new proxy key.',
      ],
    }, { status: 403 });
  }

  // Get accessible emails
  const emailAccess = await db.query.keyEmailAccess.findMany({
    where: eq(keyEmailAccess.proxyKeyId, proxyKey.id),
  });

  return NextResponse.json({
    status: 'approved',
    proxy_key: proxyKey.key,
    key_label: proxyKey.label,
    nickname: connection.nickname,
    emails: emailAccess.map((e) => e.targetEmail),
    proxy_endpoint: DASHBOARD_URL.replace('://fgac.ai', '://gmail.fgac.ai').replace('://localhost:3000', '://localhost:3000'),
  });

  } catch (err) {
    console.error('[CLI-Token] Unhandled error:', err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { status: 'error', message: 'Internal server error', detail },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/auth/cli-token',
    description: 'Exchange a Clerk OAuth token for FGAC proxy key credentials.',
    usage: 'POST with Authorization: Bearer <clerk_oauth_token>',
  });
}
