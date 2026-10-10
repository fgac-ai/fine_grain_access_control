'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { usePostHog } from 'posthog-js/react';
import { DRIVE_FULL_SCOPE } from './googleReconnect';

const SCOPE_POLL_ATTEMPTS = 6;
const SCOPE_POLL_INTERVAL_MS = 1500;

export type DriveScopeVerify = 'checking' | 'failed' | null;

/**
 * The Enable Drive access card's OAuth return leg (?drive_scope=1). Mounted
 * by AgentProfilesView for every flagged user — NOT inside the card — because
 * on a successful consent the server render already sees the scope and draws
 * the Drive tree card in its place; an effect inside the card never ran on
 * exactly the path that succeeded (0 `drive_scope_enabled` rows to
 * 2026-10-09).
 *
 * The success itself is recorded server-side (`drive_scope_enabled`,
 * src/lib/driveScopeEpisode.ts) by the render that first sees the scope;
 * this hook records that the user came back, polls only while the server
 * has not seen the scope yet, and strips the query so a reload is not a
 * second return.
 */
export function useDriveScopeReturnLeg(driveTree: { flagOn: boolean; hasFullScope: boolean } | undefined): DriveScopeVerify {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const posthog = usePostHog();
  const [verify, setVerify] = useState<DriveScopeVerify>(null);
  const started = useRef(false);
  // An unmount guard rather than per-effect cancellation: with the run-once
  // ref, a Strict Mode re-run would otherwise cancel the only poll.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const returned = params.get('drive_scope') === '1' && driveTree?.flagOn === true;
  const seenByServer = driveTree?.hasFullScope === true;

  useEffect(() => {
    if (!returned || started.current) return;
    started.current = true;
    posthog?.capture('drive_scope_enable_returned', { scope_seen_by_server: seenByServer });
    if (seenByServer) {
      router.replace(pathname);
      return;
    }
    (async () => {
      setVerify('checking');
      for (let attempt = 0; attempt <= SCOPE_POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, SCOPE_POLL_INTERVAL_MS));
        if (!alive.current) return;
        try {
          const res = await fetch('/api/auth/google-picker-token');
          const data = await res.json();
          if (res.ok && Array.isArray(data.scopes) && data.scopes.includes(DRIVE_FULL_SCOPE)) {
            // The re-render sees the scope, records `drive_scope_enabled`
            // and swaps in the Drive tree card.
            setVerify(null);
            router.replace(pathname);
            router.refresh();
            return;
          }
        } catch {
          // keep polling
        }
      }
      if (alive.current) {
        posthog?.capture('drive_scope_enable_incomplete');
        setVerify('failed');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on the return leg
  }, [returned]);

  return verify;
}
