import { kindForService } from '@/lib/driveFileKinds';
import { proxyKeys, keyEmailAccess, accessRules, keyRuleAssignments, temporaryApiKeys, agentConnections } from '@/db/schema';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { getActiveDelegationsToEmail, filterLiveDelegatedAccess } from '@/db/delegationQueries';
import { resolveDbUser } from '@/db/userHelpers';
import { currentUser } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { linkBase } from '@/lib/linkOrigin';
import { db } from '@/db';
import { checkGoogleAccess, type GoogleAccess } from './googleAccess';
import { clerkPrimaryEmail } from '@/lib/clerkPrimaryEmail';
import { slugifyProfileLabel } from '@/lib/profileSlugs';
import type { Profile, Rule } from './AgentProfilesView';
import { driveTreeFlagOn } from '@/lib/featureFlags';
import { normalizeDriveDefault } from '@/lib/driveTreeAccess';

/**
 * Everything the dashboard needs to render one signed-in user's profiles.
 * Extracted from dashboard/page.tsx when agent profiles got their own routes
 * (/dashboard/agents/[slug]) — both pages load the identical data set, and
 * the slug page must not drift from the index. Returns null when signed out.
 */
export interface DashboardData {
  profiles: Profile[];
  rules: Rule[];
  accessibleEmails: {
    email: string;
    type: 'own' | 'delegated';
    delegationId?: string;
    hasCompleteGoogleAccess?: boolean;
  }[];
  mcpEndpoint: string;
  hasCompleteGoogleAccess: boolean;
  /** Per-scope view behind hasCompleteGoogleAccess — the access card names the missing one. */
  googleAccess: GoogleAccess;
  /** The user has Sheets/Docs rules, so drive.file is load-bearing (post-sign-in auto-repair gate). */
  needsDriveFile: boolean;
  /** Clerk's last sign-in (ms) — keys the once-per-sign-in telemetry and auto-repair. */
  lastSignInAt: number | null;
  /** FGAC users.id — the owner key the approval ledger is filed under. */
  userId: string;
  /** Clerk user id — the distinct id for server-side PostHog events. */
  clerkUserId: string;
  /** The signed-in account's own address (users.email) and age — the
   *  second-account prompt names the mailbox and measures how new it is. */
  email: string;
  accountCreatedAt: Date;
  /** Drive tree model (feature-flagged): whether this user is flagged, and
   *  whether their live token already carries the full `drive` scope. */
  driveTree: { flagOn: boolean; hasFullScope: boolean };
}

/**
 * Slug of the profile /dashboard should land on: the default profile, else
 * the first active one — skipping any legacy label that slugifies to nothing.
 */
export function defaultProfileSlug(profiles: Profile[]): string | null {
  const active = profiles.filter(p => !p.revokedAt);
  const ordered = [...active.filter(p => p.isDefault), ...active.filter(p => !p.isDefault)];
  for (const p of ordered) {
    const slug = slugifyProfileLabel(p.label);
    if (slug) return slug;
  }
  return null;
}

export async function loadDashboardData(): Promise<DashboardData | null> {
  const user = await currentUser();
  if (!user) return null;

  // Resolves by Clerk id, adopts an existing row for the same email if Clerk
  // reissued the id, and keeps the email in sync — all handled in one place.
  const currentEmail = clerkPrimaryEmail(user) ?? 'unknown';
  const dbUser = await resolveDbUser(user.id, currentEmail);

  const googleAccess = await checkGoogleAccess(user);
  const hasCompleteGoogleAccess = googleAccess.gmail && googleAccess.driveFile;
  // Drive tree feature flag (PostHog, cached; env override for local dev).
  const driveTreeFlag = await driveTreeFlagOn({ clerkUserId: user.id, email: currentEmail });

  // ─── Emails this user can build profiles against ─────────────────────────
  // Resolved by email rather than user row id: duplicate `users` rows for one
  // email (Clerk re-issuing a user id) otherwise hide the delegation entirely,
  // and the delegate loses access with no error. See delegationQueries.ts.
  const delegationsToMe = await getActiveDelegationsToEmail(dbUser.email);

  const accessibleEmails = [
    { email: dbUser.email, type: 'own' as const, hasCompleteGoogleAccess },
    ...delegationsToMe.map(d => ({
      email: d.counterpartEmail,
      type: 'delegated' as const,
      delegationId: d.id,
    })),
  ];

  // ─── Agent profiles (proxy keys) and what each can reach ─────────────────
  const userProxyKeys = await db.select().from(proxyKeys).where(eq(proxyKeys.userId, dbUser.id));
  // Stale rows from revoked delegations must not appear as reachable mailboxes.
  const allKeyEmailAccess = await filterLiveDelegatedAccess(
    await db.select().from(keyEmailAccess),
  );

  // Live temporary keys (create_temporary_api_key), shown under their parent
  // profile so the user can see and revoke what their agents minted.
  const liveTemporaryKeys = await db
    .select({
      id: temporaryApiKeys.id,
      parentKeyId: temporaryApiKeys.parentKeyId,
      last4: temporaryApiKeys.keyLast4,
      purpose: temporaryApiKeys.purpose,
      expiresAt: temporaryApiKeys.expiresAt,
      createdAt: temporaryApiKeys.createdAt,
      nickname: agentConnections.nickname,
      clientName: agentConnections.clientName,
      clientId: agentConnections.clientId,
    })
    .from(temporaryApiKeys)
    .innerJoin(agentConnections, eq(agentConnections.id, temporaryApiKeys.connectionId))
    .where(and(
      eq(temporaryApiKeys.userId, dbUser.id),
      isNull(temporaryApiKeys.revokedAt),
      gt(temporaryApiKeys.expiresAt, new Date()),
    ));

  const profiles = userProxyKeys.map(k => ({
    id: k.id,
    key: k.key,
    label: k.label,
    isDefault: k.isDefault,
    createdAt: k.createdAt.toISOString(),
    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    driveDefault: normalizeDriveDefault(k.driveDefault),
    driveConfigured: k.driveDefault !== null,
    emailAccess: allKeyEmailAccess
      .filter(kea => kea.proxyKeyId === k.id)
      .map(kea => kea.targetEmail),
    temporaryKeys: liveTemporaryKeys
      .filter(t => t.parentKeyId === k.id)
      .map(t => ({
        id: t.id,
        last4: t.last4,
        purpose: t.purpose,
        agentName: t.nickname || t.clientName || t.clientId,
        createdAt: t.createdAt.toISOString(),
        expiresAt: t.expiresAt.toISOString(),
      })),
  }));

  // ─── Rules and their per-profile assignments ─────────────────────────────
  const userRules = await db.select().from(accessRules).where(eq(accessRules.userId, dbUser.id));
  const allKeyRuleAssignments = await db.select().from(keyRuleAssignments);

  const rules = userRules.map(rule => ({
    id: rule.id,
    ruleName: rule.ruleName,
    service: rule.service,
    actionType: rule.actionType,
    regexPattern: rule.regexPattern,
    targetResourceId: rule.targetResourceId,
    targetKind: rule.targetKind,
    resourceName: rule.resourceName,
    targetEmail: rule.targetEmail,
    assignedKeyIds: allKeyRuleAssignments
      .filter(kra => kra.accessRuleId === rule.id)
      .map(kra => kra.proxyKeyId),
  }));

  // Trim and strip a trailing slash — the pulled env value carries stray
  // whitespace, which rendered as "http://localhost:3000 /api/mcp".
  // Production keeps the configured URL; a preview or local build shows its
  // own host, or users copy an endpoint that points at production.
  const appUrl = linkBase((process.env.NEXT_PUBLIC_APP_URL ?? 'https://fgac.ai').trim().replace(/\/+$/, ''), process.env, await pageOrigin());
  const mcpEndpoint = `${appUrl}/api/mcp`;

  // Sheets/Docs rules are what drive.file is for; a user without any can lose
  // the scope to a Google sign-in and notice nothing, while one with them has
  // every Sheets/Docs call failing.
  const needsDriveFile = userRules.some(r => kindForService(r.service) !== null);

  return {
    profiles, rules, accessibleEmails, mcpEndpoint, hasCompleteGoogleAccess,
    googleAccess, needsDriveFile, lastSignInAt: user.lastSignInAt, userId: dbUser.id, clerkUserId: user.id,
    email: dbUser.email, accountCreatedAt: dbUser.createdAt,
    driveTree: {
      flagOn: driveTreeFlag,
      hasFullScope: googleAccess.driveFull,
    },
  };
}

/** The host serving this page render, if the request names one. */
async function pageOrigin(): Promise<string | undefined> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return undefined;
  const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
}
