"use client";

import { useState } from "react";
import { usePostHog } from "posthog-js/react";
import { useClerk } from "@clerk/nextjs";
import { buttonPrimary } from "@/components/ui";
import { PREV_ACCOUNT_COOKIE, delegateLinkPath } from "@/lib/secondAccount";

/**
 * The dashboard prompt's other direction. SecondAccountBanner shows
 * DelegateToPanel when the CURRENT account is the newer one (attach this
 * mailbox to the account you were just in). When the current account is the
 * OLDER one — the person came back to their primary after creating a second
 * account and getting nowhere — delegating the primary away is the wrong
 * direction; what they want is the newer mailbox on this account. That has
 * to be granted as the newer account, so this panel signs out and returns
 * to this account's delegate link, where the newer account confirms in one
 * click (accounts/page.tsx, DelegateToPanel surface accounts_link).
 */
export function SwitchAndAttachPanel({
  targetMasked,
  currentEmail,
  currentUserId,
}: {
  targetMasked: string;
  currentEmail: string;
  currentUserId: string;
}) {
  const posthog = usePostHog();
  const { signOut } = useClerk();
  const [hidden, setHidden] = useState(false);
  const [switching, setSwitching] = useState(false);
  if (hidden) return null;

  const clearPrev = () => {
    try { document.cookie = `${PREV_ACCOUNT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`; } catch { /* ages out */ }
  };
  const dismiss = () => {
    clearPrev();
    posthog?.capture("delegation_prompt_dismissed", { surface: "dashboard_banner", direction: "switch" });
    setHidden(true);
  };
  const go = async () => {
    posthog?.capture("delegation_link_switch_clicked", { surface: "dashboard_banner" });
    clearPrev();
    setSwitching(true);
    try { await signOut({ redirectUrl: delegateLinkPath(currentUserId) }); } finally { setSwitching(false); }
  };

  return (
    <div className="rounded-md border border-primary bg-primary-muted px-4 py-3 text-sm" data-testid="switch-and-attach-panel">
      <p className="font-semibold text-foreground">
        You were signed in as {targetMasked} a moment ago — is that also you?
      </p>
      <p className="mt-1 text-muted-foreground">
        You don&apos;t need two FGAC accounts. Keep this one (<strong>{currentEmail}</strong>) and add{" "}
        <strong>{targetMasked}</strong>&apos;s mailbox to it: switch to that account and confirm — one
        click there, and its mail is available to the agents connected here.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={go} disabled={switching} className={buttonPrimary} data-testid="switch-and-attach-go">
          {switching ? "Signing out…" : `Switch to ${targetMasked} and attach it here`}
        </button>
        <button onClick={dismiss} className="text-[13px] font-semibold text-muted-foreground hover:text-foreground" data-testid="switch-and-attach-dismiss">
          No, that&apos;s someone else
        </button>
      </div>
    </div>
  );
}
