/**
 * Shared client-side Google reconnect leg.
 *
 * One flow, several entry points: the Google Picker (adds drive.file before a
 * pick), the Accounts page's explicit "Reconnect Google" button (repairs a
 * broken/expired grant), and the dashboard's access card (including its
 * post-sign-in auto-repair). A verified account is reauthorized in place with
 * the extra scopes; anything else (expired/unverified — e.g. an abandoned
 * consent attempt) is destroyed and recreated, which is Clerk's designed
 * recovery. Returns the Google URL to send the user to; throws with a real
 * message when Clerk gives us nowhere to go — callers surface it, never
 * swallow it.
 */

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
/** The full Drive scope — requested only by the feature-flagged Drive tree card. */
export const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * Google's `prompt` for the reauthorize leg. `consent` always shows the
 * consent screen and is the only value Google returns a refresh token for —
 * a grant stored without one dies when its access token expires (the hourly
 * lockout seen on the dev instance, 2026-08-20). `select_account`/`none`
 * bounce straight back when Google already holds the scopes, but the
 * resulting grant may be access-token-only; use them only where measured.
 */
export type ReconnectPrompt = 'consent' | 'select_account' | 'none';

type ExternalAccountLike = {
  provider: string;
  verification?: { status?: string | null } | null;
  reauthorize: (opts: {
    additionalScopes: string[];
    redirectUrl: string;
    oidcPrompt?: string;
  }) => Promise<{ verification?: { externalVerificationRedirectURL?: { href?: string } | null } | null }>;
  destroy: () => Promise<unknown>;
};

export type ClerkUserLike = {
  externalAccounts: ExternalAccountLike[];
  createExternalAccount: (opts: {
    strategy: 'oauth_google';
    redirectUrl?: string;
    additionalScopes?: string[];
    oidcPrompt?: string;
  }) => Promise<{ verification?: { externalVerificationRedirectURL?: { href?: string } | null } | null }>;
};

export async function startGoogleReconnect(
  user: ClerkUserLike,
  redirectUrl: string,
  additionalScopes: string[] = [DRIVE_FILE_SCOPE],
  prompt: ReconnectPrompt = 'consent',
): Promise<string> {
  const existing = user.externalAccounts.find(
    acc => acc.provider === 'google' || acc.provider === 'oauth_google',
  );

  let verificationUrl: string | undefined;
  if (existing && existing.verification?.status === 'verified') {
    const response = await existing.reauthorize({
      additionalScopes,
      redirectUrl,
      oidcPrompt: prompt,
    });
    verificationUrl = response.verification?.externalVerificationRedirectURL?.href;
  } else {
    if (existing) {
      await existing.destroy();
    }
    // Same scopes and forced consent as the reauthorize branch — a recreated
    // grant that silently omitted drive.file was one leg of the 2026-08-30
    // scope-lockout incident class. Always `consent` here: a brand-new
    // external account needs the refresh token only a consent pass returns.
    const response = await user.createExternalAccount({
      strategy: 'oauth_google',
      redirectUrl,
      additionalScopes,
      oidcPrompt: 'consent',
    });
    verificationUrl = response.verification?.externalVerificationRedirectURL?.href;
  }

  if (!verificationUrl) {
    throw new Error('Clerk returned no verification redirect URL for the Google reconnect.');
  }
  return withGrantedScopes(verificationUrl);
}

/**
 * Google's incremental-authorization switch on the URL Clerk hands back.
 *
 * Clerk builds the Google authorization URL from the request alone, so a pass
 * that asks for fewer scopes than the user already granted — every plain
 * sign-in, and every drive.file reconnect for a user on the full `drive` scope
 * — comes back with a token, and a Clerk record, missing the rest. With
 * `include_granted_scopes=true` Google returns a token for the union of this
 * request and everything the user previously granted this OAuth client, and
 * Clerk stores that union as `approved_scopes` (measured 2026-10-04 on the dev
 * instance, chooser-only pass, plan claude_wizardly-shamir-8304cf_v1). Nothing
 * new is ever requested: the union holds only scopes the user already approved.
 * A URL that cannot be parsed is returned unchanged.
 */
export function withGrantedScopes(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('include_granted_scopes', 'true');
    return u.toString();
  } catch {
    return url;
  }
}
