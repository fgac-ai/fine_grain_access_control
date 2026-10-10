/**
 * Agent Connections API — Spike
 *
 * GET  /api/connections          — List all connections for the current user
 * POST /api/connections          — Approve/block/update a connection
 *
 * TODO: Move to proper route structure after spike.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { agentConnections, users, proxyKeys, partnerApps } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { cancelSubscriptionsForConnection } from '@/lib/notifications/subscriptions';
import { connectionState, isKeyLive } from '@/lib/connectionState';

export async function GET() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, clerkUserId),
  });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // Get all connections with their bound proxy key details
  const connections = await db.query.agentConnections.findMany({
    where: eq(agentConnections.userId, user.id),
  });

  // Partner provenance for the dashboard badge
  const partnerIds = [...new Set(connections.map(c => c.partnerAppId).filter((id): id is string => !!id))];
  const partners = partnerIds.length > 0
    ? await db.select().from(partnerApps).where(inArray(partnerApps.id, partnerIds))
    : [];
  const partnerById = new Map(partners.map(p => [p.id, p]));

  // Also get user's proxy keys for the approval dropdown
  const keys = await db.query.proxyKeys.findMany({
    where: eq(proxyKeys.userId, user.id),
  });

  const keysById = new Map(keys.map(k => [k.id, k]));
  const now = new Date();

  return NextResponse.json({
    connections: connections.map(c => {
      // `state` is what the dashboard renders: an approved row bound to a
      // revoked/expired profile is `profile_revoked`, shown on every tab with
      // a re-attach action instead of vanishing (src/lib/connectionState.ts).
      const state = connectionState(c, keysById, now);
      const boundKey = c.proxyKeyId ? keysById.get(c.proxyKeyId) : undefined;
      return {
      id: c.id,
      clientId: c.clientId,
      clientName: c.clientName,
      nickname: c.nickname,
      status: c.status,
      state,
      proxyKeyId: c.proxyKeyId,
      revokedProfile: state === 'profile_revoked'
        ? {
            label: boundKey?.label ?? null,
            revokedAt: boundKey?.revokedAt ?? null,
            expiresAt: boundKey?.expiresAt ?? null,
          }
        : null,
      createdAt: c.createdAt,
      approvedAt: c.approvedAt,
      lastUsedAt: c.lastUsedAt,
      partnerApp: c.partnerAppId && partnerById.has(c.partnerAppId)
        ? {
            name: partnerById.get(c.partnerAppId)!.name,
            logoUrl: partnerById.get(c.partnerAppId)!.logoUrl,
          }
        : null,
      };
    }),
    availableKeys: keys.map(k => ({
      id: k.id,
      label: k.label,
      revokedAt: k.revokedAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, clerkUserId),
  });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const body = await req.json();
  const { connectionId, action, proxyKeyId, nickname } = body;

  if (!connectionId || !action) {
    return NextResponse.json(
      { error: 'connectionId and action are required' },
      { status: 400 }
    );
  }

  // Verify the connection belongs to this user
  const connection = await db.query.agentConnections.findFirst({
    where: and(
      eq(agentConnections.id, connectionId),
      eq(agentConnections.userId, user.id),
    ),
  });

  if (!connection) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
  }

  switch (action) {
    case 'approve': {
      if (!proxyKeyId) {
        return NextResponse.json(
          { error: 'proxyKeyId is required for approval' },
          { status: 400 }
        );
      }

      // Verify the proxy key belongs to this user
      const key = await db.query.proxyKeys.findFirst({
        where: and(
          eq(proxyKeys.id, proxyKeyId),
          eq(proxyKeys.userId, user.id),
        ),
      });
      if (!key) {
        return NextResponse.json(
          { error: 'Proxy key not found' },
          { status: 404 }
        );
      }
      // Attaching to a revoked/expired profile would look approved here and
      // be refused by MCP — the same dead end this endpoint exists to repair.
      if (!isKeyLive(key)) {
        return NextResponse.json(
          { error: 'That profile has been revoked. Attach the connection to an active profile.' },
          { status: 409 }
        );
      }

      await db.update(agentConnections)
        .set({
          status: 'approved',
          proxyKeyId,
          nickname: nickname || connection.nickname,
          approvedAt: new Date(),
        })
        .where(eq(agentConnections.id, connectionId));

      console.log(`\n=== CONNECTION APPROVED ===`);
      console.log(`Connection: ${connectionId}`);
      console.log(`Client ID: ${connection.clientId}`);
      console.log(`Bound to key: ${key.label} (${proxyKeyId})`);
      console.log(`Nickname: ${nickname || connection.nickname || 'none'}`);
      console.log(`==========================\n`);

      return NextResponse.json({ status: 'approved', proxyKeyId });
    }

    case 'block': {
      const detachedKeyId = connection.proxyKeyId;

      await db.update(agentConnections)
        .set({ status: 'blocked', proxyKeyId: null })
        .where(eq(agentConnections.id, connectionId));

      // Partner-provisioned keys exist 1:1 for their connection (created by the
      // consent interstitial, never user-shared) — detaching the connection
      // must kill the REST-proxy path too, so revoke the key outright.
      // Agent-profile keys (no partnerAppId) are user-owned and stay usable.
      if (connection.partnerAppId && detachedKeyId) {
        await db.update(proxyKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(proxyKeys.id, detachedKeyId), eq(proxyKeys.userId, user.id)));
      }

      // A blocked partner must also stop being NOTIFIED — cancel its
      // subscriptions and stop the Gmail watch if no one else needs it.
      try {
        await cancelSubscriptionsForConnection(connectionId);
      } catch (err) {
        console.error(`[Connections] Subscription teardown failed for ${connectionId}:`, err);
      }

      return NextResponse.json({ status: 'blocked' });
    }

    case 'update_nickname': {
      if (!nickname) {
        return NextResponse.json(
          { error: 'nickname is required' },
          { status: 400 }
        );
      }

      await db.update(agentConnections)
        .set({ nickname })
        .where(eq(agentConnections.id, connectionId));

      return NextResponse.json({ status: 'updated', nickname });
    }

    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 }
      );
  }
}
