import { notFound, redirect } from 'next/navigation';
import { ConnectGoogleWarning } from '../../ConnectGoogleWarning';
import { SignInTelemetry } from '../../SignInTelemetry';
import { PendingApprovalsBanner } from '../../PendingApprovalsBanner';
import { SecondAccountBanner } from '../../SecondAccountBanner';
import { AgentProfilesView } from '../../AgentProfilesView';
import { loadDashboardData } from '../../loadDashboard';
import { slugifyProfileLabel } from '@/lib/profileSlugs';

/**
 * One agent profile's own page. The slug is the profile label's URL slug —
 * the same identifier that already addresses /api/mcp/<slug> — unique per
 * user and immutable (labels can't be edited after creation), so these URLs
 * are stable enough to bookmark and share between the account's own tabs.
 * The route group is Clerk-protected by middleware; slugs resolve only
 * within the signed-in user's own profiles.
 */
export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await loadDashboardData();
  if (!data) redirect('/');

  const active = data.profiles.filter(p => !p.revokedAt);
  const profile = active.find(p => slugifyProfileLabel(p.label) === slug);
  if (!profile) {
    // A just-revoked profile's URL (stale tab, bookmark) lands back on the
    // dashboard rather than a 404 — the profile existed, it's just gone.
    if (data.profiles.some(p => slugifyProfileLabel(p.label) === slug)) {
      redirect('/dashboard');
    }
    notFound();
  }

  return (
    <>
      <SignInTelemetry
        lastSignInAt={data.lastSignInAt}
        access={data.googleAccess}
        needsDriveFile={data.needsDriveFile}
      />
      <PendingApprovalsBanner userId={data.userId} clerkUserId={data.clerkUserId} profiles={data.profiles} />
      <SecondAccountBanner currentClerkUserId={data.clerkUserId} currentUserId={data.userId} currentEmail={data.email} accountCreatedAt={data.accountCreatedAt} />
      {!data.hasCompleteGoogleAccess && (
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8">
          <ConnectGoogleWarning
            access={data.googleAccess}
            needsDriveFile={data.needsDriveFile}
            lastSignInAt={data.lastSignInAt}
          />
        </div>
      )}

      <AgentProfilesView
        profiles={data.profiles}
        rules={data.rules}
        accessibleEmails={data.accessibleEmails}
        mcpEndpoint={data.mcpEndpoint}
        hasCompleteGoogleAccess={data.hasCompleteGoogleAccess}
        activeId={profile.id}
      />
    </>
  );
}
