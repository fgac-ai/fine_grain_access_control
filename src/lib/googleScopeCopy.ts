/**
 * Copy for the dashboard's "Google access is incomplete" card, derived from
 * which scopes the live token actually carries (googleAccess.ts).
 *
 * Pure and client-safe (no Clerk import) so the card and its unit test share
 * one decision table. The card once said "you have not granted access to
 * your Gmail" to users whose Gmail was fine and whose Drive permission had
 * just been reset by a Google sign-in — the copy must name the scope that is
 * missing and, for drive.file, the reason it goes missing.
 */

export type GoogleAccessLike = {
  gmail: boolean;
  driveFile: boolean;
  /** A Google account is linked but its grant is dead (googleAccess.ts). */
  disconnected?: boolean;
};

export type MissingGoogleScope = 'gmail' | 'drive_file';

export type GoogleWarningCopy = {
  title: string;
  body: string;
  button: string;
  missing: MissingGoogleScope[];
};

export function describeMissingGoogleAccess(
  access: GoogleAccessLike,
  /** The user has Sheets/Docs rules — drive.file is load-bearing for them. */
  needsDriveFile: boolean,
): GoogleWarningCopy | null {
  if (access.gmail && access.driveFile) return null;

  if (access.gmail && !access.driveFile) {
    return {
      title: 'Action Required: Grant Google Drive file access',
      // Since drive.file joined the sign-in scope set (2026-09-04) a plain
      // sign-in no longer strips it; the accounts still missing it were
      // connected before FGAC asked, or declined the box. Measured 7 d to
      // 2026-09-25: 9 of 9 refused accounts had exactly one sign-in ever.
      body: needsDriveFile
        ? 'Gmail is connected, but the Google Drive file permission (drive.file) that your Sheets and Docs rules depend on is missing — every Sheets and Docs call fails until it is restored. ' +
          'Either this account was connected before FGAC asked for it, or the Drive box was left unchecked on Google\'s consent screen (an older sign-in could also reset it). Reconnect and tick the Google Drive box to restore it.'
        : 'Gmail is connected, but the Google Drive file permission (drive.file) is missing, so Sheets and Docs tools will fail. ' +
          'Reconnect Google and tick the Google Drive box on Google\'s consent screen — a permission that was declined before comes back unchecked.',
      button: 'Reconnect Google',
      missing: ['drive_file'],
    };
  }

  if (!access.gmail && access.driveFile) {
    return {
      title: 'Action Required: Grant Gmail access',
      body: 'Google Drive file access is connected, but Gmail access (gmail.modify) is missing — most likely the Gmail checkbox was left unchecked on Google\'s consent screen. ' +
        'Every Gmail tool fails until you reconnect and approve Gmail.',
      button: 'Reconnect Google',
      missing: ['gmail'],
    };
  }

  if (access.disconnected) {
    // Linked, but Google no longer honours the grant (revoked under the Google
    // account's third-party access, a password change, an aged-out grant).
    // Every agent call on this account is being refused with a reconnect link
    // — the owner email (PR: dead-grant notice) points here. Say so, and say
    // "reconnect": to a user whose agent worked yesterday, "connect your
    // Google account" reads like the wrong page.
    return {
      title: 'Action Required: Reconnect Google',
      body: 'Google has expired or revoked FGAC\'s access to this account — this happens when FGAC is removed under your Google account\'s third-party access, when your Google password changes, or when a grant ages out. ' +
        'Every agent call on this account is refused until you reconnect; reconnecting shows Google\'s consent screen again and takes one click.',
      button: 'Reconnect Google',
      missing: ['gmail', 'drive_file'],
    };
  }

  return {
    title: 'Action Required: Connect Google Account',
    body: 'FGAC has no usable Google access for this account. Connect your Google account and approve both Gmail and Google Drive file access to enable API access.',
    button: 'Sign in with Google',
    missing: ['gmail', 'drive_file'],
  };
}
