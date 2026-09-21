import { kindForService } from '@/lib/driveFileKinds';
import { proxyKeys, keyEmailAccess, accessRules, keyRuleAssignments } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getActiveDelegationsToEmail, filterLiveDelegatedAccess } from '@/db/delegationQueries';
import { resolveDbUser } from '@/db/userHelpers';
import { currentUser } from '@clerk/nextjs/server';
import { db } from '@/db';
import { checkGoogleAccess, type GoogleAccess } from './googleAccess';
import { clerkPrimaryEmail } from '@/lib/clerkPrimaryEmail';
import { slugifyProfileLabel } from '@/lib/profileSlugs';
import type { Profile, Rule } from './AgentProfilesView';

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

  const profiles = userProxyKeys.map(k => ({
    id: k.id,
    key: k.key,
    label: k.label,
    isDefault: k.isDefault,
    createdAt: k.createdAt.toISOString(),
    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    emailAccess: allKeyEmailAccess
      .filter(kea => kea.proxyKeyId === k.id)
      .map(kea => kea.targetEmail),
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
    resourceName: rule.resourceName,
    targetEmail: rule.targetEmail,
    assignedKeyIds: allKeyRuleAssignments
      .filter(kra => kra.accessRuleId === rule.id)
      .map(kra => kra.proxyKeyId),
  }));

  // Trim and strip a trailing slash — the pulled env value carries stray
  // whitespace, which rendered as "http://localhost:3000 /api/mcp".
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://fgac.ai').trim().replace(/\/+$/, '');
  const mcpEndpoint = `${appUrl}/api/mcp`;

  // Sheets/Docs rules are what drive.file is for; a user without any can lose
  // the scope to a Google sign-in and notice nothing, while one with them has
  // every Sheets/Docs call failing.
  const needsDriveFile = userRules.some(r => kindForService(r.service) !== null);

  return {
    profiles, rules, accessibleEmails, mcpEndpoint, hasCompleteGoogleAccess,
    googleAccess, needsDriveFile, lastSignInAt: user.lastSignInAt, userId: dbUser.id, clerkUserId: user.id,
  };
}
