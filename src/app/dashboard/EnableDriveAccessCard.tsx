'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { usePostHog } from 'posthog-js/react';
import { Card, CardHeader, Badge, buttonPrimary } from '@/components/ui';
import {
  startGoogleReconnect, DRIVE_FULL_SCOPE, GMAIL_MODIFY_SCOPE, type ClerkUserLike,
} from './googleReconnect';
import { setDriveDefault } from './actions';
import type { DriveDefault } from '@/lib/driveTreeAccess';

const SCOPE_POLL_ATTEMPTS = 6;
const SCOPE_POLL_INTERVAL_MS = 1500;

/**
 * Shown on a feature-flagged user's profile page while their Google grant is
 * still `drive.file`. The button runs the in-place Clerk reauthorize with the
 * full `drive` scope (consent prompt, so Google returns a refresh token) and
 * comes back here with ?drive_scope=1; the return leg polls the token bridge
 * until tokeninfo shows the scope, then refreshes the server-rendered page
 * so the Drive tree card takes over. The scope is requested from nobody who
 * is not flagged — this card is the only place that asks for it.
 */
export function EnableDriveAccessCard({ profileId, driveDefault, reenable }: {
  profileId: string;
  driveDefault: DriveDefault;
  /** The profile already uses the tree model (a quick option saved, or folder settings): the scope was LOST, not never granted. */
  reenable: boolean;
}) {
  const { user, isLoaded } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const posthog = usePostHog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<'checking' | 'failed' | null>(null);
  const returned = params.get('drive_scope') === '1';
  const verifyStarted = useRef(false);

  useEffect(() => {
    if (!returned || verifyStarted.current) return;
    verifyStarted.current = true;
    let cancelled = false;
    (async () => {
      setVerify('checking');
      posthog?.capture('drive_scope_enable_returned');
      for (let attempt = 0; attempt <= SCOPE_POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, SCOPE_POLL_INTERVAL_MS));
        if (cancelled) return;
        try {
          const res = await fetch('/api/auth/google-picker-token');
          const data = await res.json();
          if (res.ok && Array.isArray(data.scopes) && data.scopes.includes(DRIVE_FULL_SCOPE)) {
            posthog?.capture('drive_scope_enabled', { reenable });
            // Record that this profile now uses the tree model (the quick
            // option is written even when it is still the default), so a
            // later loss of the scope is reported as "re-enable", not as a
            // silent fallback to per-file access.
            try { await setDriveDefault(profileId, driveDefault); } catch { /* the card still works without it */ }
            router.replace(pathname);
            router.refresh();
            return;
          }
        } catch {
          // keep polling
        }
      }
      if (!cancelled) {
        posthog?.capture('drive_scope_enable_incomplete');
        setVerify('failed');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on the return leg
  }, [returned]);

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
