'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { usePostHog } from 'posthog-js/react';
import { Card, CardHeader, Badge, buttonPrimary } from '@/components/ui';
import {
  startGoogleReconnect, DRIVE_FULL_SCOPE, GMAIL_MODIFY_SCOPE, type ClerkUserLike,
} from './googleReconnect';
import type { DriveScopeVerify } from './useDriveScopeReturnLeg';

/**
 * Shown on a feature-flagged user's profile page while their Google grant is
 * still `drive.file`. The button runs the in-place Clerk reauthorize with the
 * full `drive` scope (consent prompt, so Google returns a refresh token) and
 * comes back here with ?drive_scope=1. The return leg lives in
 * useDriveScopeReturnLeg (mounted by AgentProfilesView, because on success
 * this card is no longer rendered) and the enable is recorded server-side.
 * The scope is requested from nobody who is not flagged — this card and the
 * nav UserButton are the only places that ask for it.
 */
export function EnableDriveAccessCard({ reenable, verify }: {
  /** The profile already uses the tree model (a quick option saved, or folder settings): the scope was LOST, not never granted. */
  reenable: boolean;
  /** Return-leg state from useDriveScopeReturnLeg. */
  verify: DriveScopeVerify;
}) {
  const { user, isLoaded } = useUser();
  const pathname = usePathname();
  const posthog = usePostHog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    posthog?.capture('drive_scope_enable_started', { reenable });
    try {
      const url = await startGoogleReconnect(
        user as unknown as ClerkUserLike,
        `${window.location.origin}${pathname}?drive_scope=1`,
        [GMAIL_MODIFY_SCOPE, DRIVE_FULL_SCOPE],
        'consent',
      );
      window.location.href = url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      posthog?.capture('picker_flow_error', { stage: 'drive_scope_enable', message });
      setError(`Could not start Google authorization (${message}). Retry in a moment; if it keeps failing, sign out and back in, then try again.`);
      setBusy(false);
    }
  };

  return (
    <Card tone={reenable ? 'default' : 'primary'} testId="enable-drive-access" className={reenable ? 'border-warning-foreground' : ''}>
      <CardHeader
        title={<span className="inline-flex items-center gap-2">{reenable ? 'Google Drive access needs re-enabling' : 'Google Drive access'} <Badge tone={reenable ? 'warning' : 'primary'}>{reenable ? 'Action needed' : 'Beta'}</Badge></span>}
        subtitle={reenable ? 'Your Google token lost the Drive permission; your folder settings are kept' : 'Scope this agent by folder instead of file by file'}
        action={
          <button className={buttonPrimary} onClick={start} disabled={busy || !isLoaded}>
            {busy ? 'Opening Google…' : reenable ? 'Re-enable full Drive access' : 'Enable full Drive access'}
          </button>
        }
      />
      <div className="px-5 pb-5 space-y-2 text-[13px] text-foreground">
        {reenable ? (
          <p>
            Your Google account no longer carries the Drive permission FGAC needs for folder-based access —
            this can happen after a Google sign-in or a token refresh. Until you re-enable it, this profile
            is back on per-file access and your agent is told to stop and ask you. Your quick option and
            every folder setting are kept and apply again the moment you re-enable.
          </p>
        ) : (
          <p>
            Today this profile reaches only the files you expose one at a time. With full Drive access,
            every file in your Drive is <strong>readable by default</strong>, and you set folders or files to
            Read, Read &amp; write, or Blocked — a setting on a folder applies to everything inside it, and
            the nearest setting wins.
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Google will ask you once to let FGAC see and edit your Google Drive files. FGAC only asks for this
          permission because your account is in the beta.
        </p>
        {verify === 'checking' && <p className="text-[11px] text-muted-foreground">Confirming Google permissions…</p>}
        {verify === 'failed' && (
          <p className="text-[11px] text-destructive [overflow-wrap:anywhere]">
            Google finished the flow WITHOUT granting Drive access. Google leaves a permission that was
            declined before UNCHECKED on the consent screen, so continuing without ticking it changes nothing.
            Click Enable full Drive access again and tick the Google Drive box before you continue.
          </p>
        )}
        {error && <p className="text-[11px] text-destructive [overflow-wrap:anywhere]">{error}</p>}
      </div>
    </Card>
  );
}
