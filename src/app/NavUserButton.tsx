'use client';

import { UserButton, useUser } from '@clerk/nextjs';
import { useEffect, useState } from 'react';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * The nav's Clerk UserButton. Its "Connect account" scopes are the Gmail
 * scope for everyone and, ONLY for users on the Drive tree feature flag, the
 * full `drive` scope as well — the flag lives in server env, so a signed-in
 * client asks /api/drive/flag once and widens the list when it says yes.
 * Kept client-side so the root layout stays static (reading the flag in the
 * layout itself would need currentUser() on every page render).
 */
export function NavUserButton() {
  const { isSignedIn } = useUser();
  const [driveTree, setDriveTree] = useState(false);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetch('/api/drive/flag')
      .then(res => (res.ok ? res.json() : { flagOn: false }))
      .then(data => { if (!cancelled && data?.flagOn === true) setDriveTree(true); })
      .catch(() => { /* stays off */ });
    return () => { cancelled = true; };
  }, [isSignedIn]);

  return (
    <UserButton
      userProfileProps={{
        additionalOAuthScopes: {
          google: driveTree ? [GMAIL_MODIFY_SCOPE, DRIVE_FULL_SCOPE] : [GMAIL_MODIFY_SCOPE],
        },
      }}
    />
  );
}
