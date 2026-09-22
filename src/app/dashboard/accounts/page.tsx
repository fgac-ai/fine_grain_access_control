import Link from 'next/link';
import { users, proxyKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getDelegationsToEmail, getDelegationsFromEmail } from '@/db/delegationQueries';
import { resolveDbUser } from '@/db/userHelpers';
import { currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { db } from '@/db';
import { Card, CardHeader, Badge, EmptyState, buttonSecondary } from '@/components/ui';
import { DelegateAccessButton } from '../DelegateAccessButton';
import { RevokeDelegationButton } from '../RevokeDelegationButton';
import { ExposedFilesManager } from '../ExposedFilesManager';
import { ACTIVE_DRIVE_FILE_KINDS } from '@/lib/driveFileKinds';
import { AddDelegatedAccountButton } from './AddDelegatedAccountButton';
import { ReconnectGoogleButton } from './ReconnectGoogleButton';
import { checkGoogleAccess } from '../googleAccess';
import { clerkPrimaryEmail } from '@/lib/clerkPrimaryEmail';
import { DELEGATE_TO_PARAM, isDelegateTarget } from '@/lib/secondAccount';
import { accountAgeSeconds, delegationAlreadyActive, delegationTargetById } from '@/lib/delegationTargets';
import { captureServerEvent } from '@/lib/posthogServer';
import { DelegateToPanel } from '../DelegateToPanel';
import { SecondAccountBanner } from '../SecondAccountBanner';

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await currentUser();

  if (!user) {
    redirect('/');
  }

  const currentEmail = clerkPrimaryEmail(user) ?? 'unknown';
  const dbUser = await resolveDbUser(user.id, currentEmail);

  const googleAccess = await checkGoogleAccess(user);
  const hasCompleteGoogleAccess = googleAccess.gmail && googleAccess.driveFile;

  // Reconnect links minted into agent-facing errors carry `for=<email>` — the
  // account whose grant needs repair. If this browser is signed in to a
  // DIFFERENT FGAC user, auto-firing reconnect would "fix" the wrong account
  // while telling everyone it succeeded (the 2026-08-30 incident): warn and
  // hold instead. The comparison is against every address this user could
  // legitimately be — identity drift between users.email and the Clerk/Google
  // records must not false-alarm.
  const sp = await searchParams;
  const rawFor = sp.for;
  const intendedFor = typeof rawFor === 'string' && rawFor.includes('@') ? rawFor : null;

  // Delegate link (src/lib/secondAccount.ts): `?delegate_to=<users.id>` names
  // the account that wants THIS mailbox. Whoever opens it signed in is the
  // mailbox owner, so the page renders the one-click confirm — or says why
  // not: it is their own link (open it as the other account), the target is
  // gone, or the delegation already exists.
  const rawTarget = sp[DELEGATE_TO_PARAM];
  let delegateLanding: React.ReactNode = null;
  if (isDelegateTarget(rawTarget)) {
    const target = await delegationTargetById(rawTarget);
    const isSelf = !!target && (target.userId === dbUser.id || target.email.toLowerCase() === dbUser.email.toLowerCase());
    const already = !!target && !isSelf && await delegationAlreadyActive(dbUser.email, target.email);
    const state = !target ? 'missing' : isSelf ? 'self' : already ? 'already_active' : 'offer';
    captureServerEvent(user.id, 'delegation_prompt_shown', {
      surface: 'accounts_link',
      state,
      account_age_s: accountAgeSeconds(dbUser.createdAt),
    });
    delegateLanding = state === 'offer' && target ? (
      <DelegateToPanel
        targetMasked={target.maskedEmail}
        signedInEmail={dbUser.email}
        surface="accounts_link"
        target={{ kind: 'user', userId: target.userId }}
        prominent
      />
    ) : (
      <div
        className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-testid="delegate-link-notice"
        data-state={state}
      >
        {state === 'self' && (
          <>
            <strong className="text-foreground">This is your own account link.</strong> It attaches
            another Gmail account to <strong className="text-foreground">{dbUser.email}</strong> — open it
            signed in as the account you want to add (sign out, then sign in with that Google account),
            or paste it into the browser profile where that account is signed in.
          </>
        )}
        {state === 'already_active' && target && (
          <>
            <strong className="text-foreground">{dbUser.email}</strong> is already attached to{' '}
            <strong className="text-foreground">{target.maskedEmail}</strong>&apos;s account — nothing more
            to do here. Manage it under Delegations You&apos;ve Granted below.
          </>
        )}
        {state === 'missing' && (
          <>The account this link points at no longer exists. Ask for a fresh link from its Accounts page.</>
        )}
      </div>
    );
  }
  const viewerEmails = new Set(
    [
      dbUser.email,
      ...user.emailAddresses.map(e => e.emailAddress),
      ...user.externalAccounts
        .filter(acc => acc.provider === 'oauth_google' || (acc.provider as string) === 'google')
        .map(acc => acc.emailAddress)
        .filter((e): e is string => !!e),
    ].map(e => e.toLowerCase()),
  );
  const intendedAccountMismatch =
    intendedFor !== null && !viewerEmails.has(intendedFor.toLowerCase());

  // The card below must show the account Google actually issued the grant
  // for — not `dbUser.email`. The two can differ (multiple addresses on one
  // Clerk user), and rendering the identity email here once sent a user
  // chasing a "wrong connected account" that was in fact correct.
  const googleAccount = user.externalAccounts.find(
    acc => acc.provider === 'oauth_google' || (acc.provider as string) === 'google',
  );
  const connectedGoogleEmail = googleAccount?.emailAddress ?? null;
  const googleAccountMismatch =
    connectedGoogleEmail !== null &&
    connectedGoogleEmail.toLowerCase() !== dbUser.email.toLowerCase();

  // Resolved by email, not by user row id — duplicate `users` rows for the same
  // email would otherwise hide existing delegations. See delegationQueries.ts.
  const delegationsToMe = await getDelegationsToEmail(dbUser.email);
  const delegationsFromMe = await getDelegationsFromEmail(dbUser.email);

  const userProxyKeys = await db.select().from(proxyKeys).where(eq(proxyKeys.userId, dbUser.id));
  const activeKeys = userProxyKeys.filter(k => !k.revokedAt).map(k => ({ id: k.id, label: k.label }));

  const activeDelegationsToMe = delegationsToMe.filter(d => d.status === 'active');

  return (
    <>
    <SecondAccountBanner currentClerkUserId={user.id} currentEmail={dbUser.email} accountCreatedAt={dbUser.createdAt} />
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {delegateLanding && <div className="max-w-2xl">{delegateLanding}</div>}
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Manage the Google accounts FGAC can access, and who else is allowed to build
          agent profiles on top of them.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          {/* ─── Connected Google Account ─────────────────────────────── */}
          <Card>
            <CardHeader
              title="Connected Google Account"
              subtitle="FGAC uses this account's OAuth grant to act on your behalf."
              action={
                <ReconnectGoogleButton
                  prominent={!hasCompleteGoogleAccess}
                  blockAutoReconnect={intendedAccountMismatch}
                />
              }
            />
            {intendedAccountMismatch && (
              <div className="mx-5 mb-3 rounded-sm border border-warning-foreground bg-warning px-4 py-3 text-[13px] text-warning-foreground">
                <p className="font-semibold">
                  This reconnect link is for a different account
                </p>
                <p className="mt-1">
                  The link you opened repairs Google access for{' '}
                  <strong>{intendedFor}</strong>, but you&apos;re signed in as{' '}
                  <strong>{dbUser.email}</strong>{' — '}reconnecting here would change
                  this account&apos;s Google grant and leave{' '}
                  <strong>{intendedFor}</strong> exactly as broken as before.
                  Sign out, sign back in as <strong>{intendedFor}</strong>, then
                  open the link again.
                </p>
              </div>
            )}
            <div className="px-5 pb-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-card px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary bg-primary-muted text-[13px] font-bold text-primary">
                    {(connectedGoogleEmail ?? dbUser.email).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-foreground">
                      {connectedGoogleEmail ?? 'No Google account connected'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {connectedGoogleEmail
                        ? 'Connected via Google OAuth'
                        : 'Click "Reconnect Google" to connect one'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* One badge per scope — Google's granular consent can grant
                      one checkbox and not the other, and a combined badge once
                      showed drive.file green on a Drive-blind account. */}
                  {googleAccess.gmail
                    ? <Badge tone="success">gmail.modify</Badge>
                    : <Badge tone="error">gmail.modify missing</Badge>}
                  {googleAccess.driveFile
                    ? <Badge tone="sheets">drive.file</Badge>
                    : <Badge tone="error">drive.file missing</Badge>}
                </div>
              </div>

              {googleAccountMismatch && (
                <div className="mt-3 rounded-sm border border-warning-foreground bg-warning px-4 py-3 text-[13px] text-warning-foreground">
                  <p className="font-semibold">
                    Connected Google account doesn&apos;t match your account email
                  </p>
                  <p className="mt-1">
                    Your FGAC account is <strong>{dbUser.email}</strong>, but the
                    Google grant is for <strong>{connectedGoogleEmail}</strong> —
                    agents reach <em>that</em> mailbox and Drive. If this is wrong,
                    click &quot;Reconnect Google&quot; and choose{' '}
                    <strong>{dbUser.email}</strong> on Google&apos;s account screen.
                  </p>
                </div>
              )}

              {!hasCompleteGoogleAccess && (
                <p className="mt-3 text-[13px] text-muted-foreground">
                  Click &quot;Reconnect Google&quot; above and approve Google&apos;s consent
                  screens to restore access. Until then, every rule that touches mail
                  or sheets is inert.
                </p>
              )}
            </div>
          </Card>

          {/* ─── Accessible Gmail accounts ────────────────────────────── */}
          <Card>
            <CardHeader
              title="Accessible Gmail Accounts"
              subtitle="Mailboxes you can scope agent profiles against."
              action={<AddDelegatedAccountButton userId={dbUser.id} />}
            />
            <div className="px-5 pb-5 space-y-2">
              <div className="flex items-center justify-between gap-2 rounded-sm border border-border bg-card px-4 py-3">
                <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                  {dbUser.email}
                </span>
                <div className="flex items-center gap-2">
                  <Badge tone="neutral">You</Badge>
                  {hasCompleteGoogleAccess
                    ? <Badge tone="success">Active</Badge>
                    : <Badge tone="error">Reconnect</Badge>}
                </div>
              </div>

              {activeDelegationsToMe.map(d => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-2 rounded-sm border border-border bg-card px-4 py-3"
                >
                  <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                    {d.counterpartEmail}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge tone="primary">Delegated to you</Badge>
                    <span className="text-[11px] text-subtle whitespace-nowrap">
                      since {d.createdAt.toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}

              <p className="pt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                Want your agent in another inbox? Click <strong>+ Add account</strong>{' '}
                above for a link: open it signed in as that Gmail account — your
                own second account or someone else&apos;s — and one click attaches
                the mailbox here. No second FGAC account needed. Walkthrough:{' '}
                <Link
                  href="/use-cases/multiple-gmail-accounts"
                  className="text-primary underline underline-offset-2"
                >
                  multiple Gmail accounts
                </Link>.
              </p>
            </div>
          </Card>

          {/* ─── Delegations granted ──────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Delegations You've Granted"
              subtitle={`Let another FGAC user build agent profiles against ${dbUser.email}.`}
              action={<DelegateAccessButton />}
            />
            <div className="px-5 pb-5 space-y-2">
              {delegationsFromMe.length === 0 ? (
                <EmptyState>
                  You haven&apos;t delegated your mailbox to anyone.
                </EmptyState>
              ) : (
                delegationsFromMe.map(d => (
                  <div
                    key={d.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-card px-4 py-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                        {d.counterpartEmail}
                      </span>
                      {d.status === 'active'
                        ? <Badge tone="success">Active</Badge>
                        : <Badge tone="error">Revoked</Badge>}
                      <span className="text-[11px] text-subtle whitespace-nowrap">
                        since {d.createdAt.toLocaleDateString()}
                      </span>
                    </div>
                    {d.status === 'active' && (
                      <RevokeDelegationButton delegationId={d.id} />
                    )}
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* Renders its own card chrome and header, and its horizontal
              header layout needs the full-width column — nesting it in the
              narrow side column wrapped the heading one word per line. */}
          {ACTIVE_DRIVE_FILE_KINDS.map(kind => (
            <ExposedFilesManager key={kind} kind={kind} activeKeys={activeKeys} />
          ))}
        </div>

        {/* ─── Side column ────────────────────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          <Card tone="primary" className="px-5 py-4">
            <h2 className="text-[13px] font-bold text-foreground">Your credentials stay with you</h2>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              FGAC never stores your Google password, and agents never see your OAuth
              token. Every request is brokered through the proxy and checked against the
              rules on the profile that made it.
            </p>
            <a href="/privacy" className={`${buttonSecondary} mt-3`}>
              How this works
            </a>
          </Card>
        </div>
      </div>
    </div>
    </>
  );
}
