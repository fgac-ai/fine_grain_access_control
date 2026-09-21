import { currentUser, clerkClient } from '@clerk/nextjs/server';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
// The broader legacy Gmail grant also covers every Gmail call — mirror of the
// MCP route's GMAIL_SCOPES so dashboard and tool layer never disagree.
const GMAIL_FULL_SCOPE = 'https://mail.google.com/';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

type ClerkUser = NonNullable<Awaited<ReturnType<typeof currentUser>>>;

export type GoogleAccess = {
  /** Token is live and carries a Gmail scope. */
  gmail: boolean;
  /** Token is live and carries drive.file (or full drive). */
  driveFile: boolean;
  /** A verified Google account IS linked, but no usable token came back —
   * Clerk could not refresh it (Google revoked / expired the grant) or Google
   * rejected it. The card then says "reconnect", not "connect": this is the
   * dead-grant state the agent-facing 🚫 refusal and the owner email describe,
   * and it must not read like a first-time setup to a user whose agent worked
   * yesterday. Absent when no Google account is linked at all. */
  disconnected?: boolean;
};

const NO_ACCESS: GoogleAccess = { gmail: false, driveFile: false };
const DISCONNECTED: GoogleAccess = { gmail: false, driveFile: false, disconnected: true };

/**
 * Which of the Google scopes FGAC needs are actually usable right now.
 *
 * Clerk's cached token can sit in a "limbo" state — still present in Clerk's DB
 * after the user revoked it on Google's side — so a scope check against Clerk
 * alone is not enough. We ping Google's tokeninfo endpoint to confirm the token
 * is both live and carries the scopes, and report each scope independently:
 * Google's granular consent lets a user grant one checkbox and not the other,
 * and a single combined boolean once rendered a green drive.file badge on a
 * Drive-blind account (2026-08-30 support case).
 *
 * Shared by the Agent Profiles and Accounts pages so the two never disagree
 * about connection health.
 */
export async function checkGoogleAccess(user: ClerkUser): Promise<GoogleAccess> {
  const googleAccount = user.externalAccounts.find(acc =>
    (acc.provider === 'oauth_google' || acc.provider === 'google') &&
    acc.verification?.status === 'verified'
  );

  if (!googleAccount) return NO_ACCESS;

  try {
    const clerk = await clerkClient();
    // Provider takes no `oauth_` prefix — the prefixed form is deprecated and
    // removed in Clerk's next major.
    const oauthTokens = await clerk.users.getUserOauthAccessToken(user.id, 'google');
    if (oauthTokens.data.length === 0) return DISCONNECTED;

    const tokenInfo = oauthTokens.data[0];
    if (!tokenInfo.token) return DISCONNECTED;

    const ping = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokenInfo.token}`);
    if (!ping.ok) {
      console.error('Token rejected by Google (likely revoked or expired in limbo state).', ping.status);
      return DISCONNECTED;
    }

    const tokenData = await ping.json();
    const scopes: string[] = typeof tokenData.scope === 'string' ? tokenData.scope.split(' ') : [];
    return {
      gmail: scopes.includes(GMAIL_MODIFY_SCOPE) || scopes.includes(GMAIL_FULL_SCOPE),
      driveFile: scopes.includes(DRIVE_FILE_SCOPE) || scopes.includes(DRIVE_FULL_SCOPE),
    };
  } catch (error) {
    // Clerk threw: a 400 oauth_token_retrieval_error (Google: invalid_grant) or
    // a 422 cannot-refresh — the same dead-grant classes the MCP route refuses
    // on (src/lib/googleTokenFailure.ts). The account is linked; the grant is not.
    console.error('Failed to validate Google OAuth token. Account is likely disconnected in Clerk.', error);
    return DISCONNECTED;
  }
}
