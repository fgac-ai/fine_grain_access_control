'use client';

import { useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import { buttonPrimary, buttonSecondary } from '@/components/ui';

/**
 * Sign-out control for the wrong-account approval card. Signs out and lands
 * back on the SAME approve URL: the dashboard route group is Clerk-protected,
 * so the next visitor is asked to sign in first and then returns to the live
 * link — no copy/paste, no dead end.
 *
 * `secondary` renders it as the quieter control: since 2026-09-21 the card
 * can lead with "attach this mailbox to the owner's account instead" when
 * the browser held the owner's session moments ago (DelegateToPanel), and
 * the switch becomes the follow-up step rather than the only exit.
 */
export function SignOutAndReturn({ returnTo, secondary = false }: { returnTo: string; secondary?: boolean }) {
  const { signOut } = useClerk();
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          await signOut({ redirectUrl: returnTo });
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      className={`${secondary ? buttonSecondary : buttonPrimary} mt-4 px-5 py-2.5 text-sm`}
      data-testid="wrong-account-sign-out"
    >
      {busy ? 'Signing out…' : 'Sign out to switch accounts'}
    </button>
  );
}
