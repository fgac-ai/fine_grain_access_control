'use client';

import { useEffect, useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import { usePostHog } from 'posthog-js/react';
import { buttonSecondary, buttonPrimary } from '@/components/ui';
import { delegateLinkPath } from '@/lib/secondAccount';

/**
 * "+ Add account": hands out the delegate link instead of an explanation.
 *
 * Until 2026-09-21 this dialog described the routine — "sign in to FGAC as
 * the other account and delegate from its Accounts page" — and closed on
 * "Got it". Measured 14 d to 09-21: 11 clicks by 6 people, 11 "Got it"s, and
 * one person who signed out, created a SECOND FGAC account and clicked the
 * same button there, because the explainer told them to be the other
 * account, which they now were. The link is the thing the other account can
 * act on: whoever opens it signed in gets a one-click "attach my mailbox to
 * <this account>" (accounts/page.tsx, DelegateToPanel). "Switch account now"
 * signs out and returns to the link, so the same browser can do it in one
 * pass; "Copy" is for another browser profile, device, or another person.
 *
 * Delegation is still granted by the mailbox owner, from their own account —
 * that has not changed. The link only tells them where to click.
 */
export function AddDelegatedAccountButton({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const [switching, setSwitching] = useState(false);
  const posthog = usePostHog();
  const { signOut } = useClerk();
  const path = delegateLinkPath(userId);
  const link = `${origin}${path}`;

  useEffect(() => { setOrigin(window.location.origin); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the field is selectable */ }
    posthog?.capture('delegation_link_copied', { surface: 'add_account_dialog' });
  };

  const switchAccount = async () => {
    posthog?.capture('delegation_link_switch_clicked', { surface: 'add_account_dialog' });
    setSwitching(true);
    try { await signOut({ redirectUrl: path }); } finally { setSwitching(false); }
  };

  return (
    <>
      <button className={buttonSecondary} onClick={() => setOpen(true)}>
        + Add account
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-account-title"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-popover shadow-lg"
            onClick={e => e.stopPropagation()}
            data-testid="add-account-dialog"
          >
            <div className="px-6 pt-5 pb-3">
              <h2 id="add-account-title" className="text-base font-bold text-popover-foreground">
                Add another Gmail account
              </h2>
            </div>

            <div className="px-6 pb-5 space-y-3 text-[13px] text-muted-foreground">
              <p>
                Open this link <strong className="text-foreground">signed in to FGAC as the account you want to add</strong>{' '}
                — your own second Gmail, or someone else&apos;s. One click there attaches that
                mailbox here. No second dashboard to set up.
              </p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={link}
                  onFocus={e => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-sm border border-input bg-card px-2.5 py-1.5 font-mono text-[12px] text-foreground"
                  data-testid="delegate-link"
                  aria-label="Delegate link"
                />
                <button type="button" onClick={copy} className={buttonSecondary} data-testid="delegate-link-copy">
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p>
                <strong className="text-foreground">Your own account?</strong> Switch to it now —
                you&apos;ll sign in as the other Gmail and land on the confirm step. Or paste the
                link into the browser profile where that account is signed in.
              </p>
              <p>
                <strong className="text-foreground">Someone else&apos;s?</strong> Send them the link.
                They sign up at fgac.ai with that Google account if they haven&apos;t, open it, and
                confirm. The mailbox appears in this list automatically.
              </p>
            </div>

            <div className="flex justify-end gap-2 rounded-b-lg border-t border-border bg-muted px-6 py-3.5">
              <button className={buttonSecondary} onClick={() => setOpen(false)}>
                Close
              </button>
              <button className={buttonPrimary} onClick={switchAccount} disabled={switching} data-testid="delegate-link-switch">
                {switching ? 'Signing out…' : 'Switch account now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
