"use client";

import { useState, useTransition } from "react";
import { usePostHog } from "posthog-js/react";
import { useClerk } from "@clerk/nextjs";
import { buttonPrimary, buttonSecondary } from "@/components/ui";
import { PREV_ACCOUNT_COOKIE, type DelegationSurface } from "@/lib/secondAccount";
import type { ApprovalSearchParams } from "@/lib/approvalLinks";
import { delegateToApprovalOwner, delegateToUser } from "./actions";

/**
 * The one-click "attach this mailbox to that account" panel — the repair for
 * a person who ended up with two FGAC accounts (src/lib/secondAccount.ts).
 * Shared by three surfaces:
 *
 *   approve_wall     the wrong-account card: the visitor is signed in as a
 *                    different account than the link's owner;
 *   dashboard_banner the fresh account whose browser held another FGAC
 *                    session minutes ago;
 *   accounts_link    whoever opened /dashboard/accounts?delegate_to=<id>.
 *
 * Two clicks by design. Delegation is read access to the visitor's whole
 * mailbox for the recipient's agents, and a link-holder with an FGAC
 * account can put this card in front of anyone — so the first click opens
 * a confirm step that names the recipient (masked: the right person
 * recognises their own address, nobody else learns it), the mailbox being
 * granted, and where to undo it. `prominent` orders the surrounding
 * controls; the copy inside is the same either way.
 */
export type DelegateTarget =
  | { kind: "approval"; link: ApprovalSearchParams; priorSessionMatches: boolean }
  | { kind: "user"; userId: string; priorGapS?: number };

export function DelegateToPanel({
  targetMasked,
  signedInEmail,
  surface,
  target,
  prominent,
  onDone,
  returnTo,
  dismissible = false,
  initialDone = false,
}: {
  targetMasked: string;
  signedInEmail: string;
  surface: Exclude<DelegationSurface, "add_account_dialog">;
  target: DelegateTarget;
  /** The surface's evidence says this is the same person: lead with the offer. */
  prominent: boolean;
  /** Shown after success where the caller has nothing else to render. */
  onDone?: (maskedEmail: string) => void;
  /** approve_wall: the approve URL to come back to after switching accounts. */
  returnTo?: string;
  dismissible?: boolean;
  /** The server already knows the delegation is active: render the done
   *  view straight away. Same component, same tree position as the offer,
   *  so a client that just confirmed keeps its state through the RSC
   *  re-render a server action can trigger. */
  initialDone?: boolean;
}) {
  const posthog = usePostHog();
  const { signOut } = useClerk();
  const [step, setStep] = useState<"offer" | "confirm" | "done" | "hidden">(initialDone ? "done" : "offer");
  // Whether THIS client did the confirming. The approve page re-renders
  // after the action regardless of revalidation (measured 2026-09-21: the
  // server-side `initialDone` prop flips to true ~1.1 s after the click), so
  // the done view keys its wording and test attributes on client state,
  // which survives the re-render — never on the prop.
  const [confirmedHere, setConfirmedHere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [switching, setSwitching] = useState(false);

  if (step === "hidden") return null;

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = target.kind === "approval"
          ? await delegateToApprovalOwner(target.link, { prior_session_matches: target.priorSessionMatches })
          : await delegateToUser(target.userId, surface === "approve_wall" ? "accounts_link" : surface, { prior_gap_s: target.priorGapS });
        if (!result.ok) { setError(result.error); return; }
        clearPrevMarker();
        setConfirmedHere(true);
        setStep("done");
        onDone?.(result.maskedEmail ?? targetMasked);
      } catch {
        setError("Something went wrong attaching the mailbox. Please try again.");
      }
    });
  };

  const dismiss = () => {
    clearPrevMarker();
    posthog?.capture("delegation_prompt_dismissed", { surface });
    setStep("hidden");
  };

  const switchAccount = async () => {
    if (!returnTo) return;
    setSwitching(true);
    try { await signOut({ redirectUrl: returnTo }); } finally { setSwitching(false); }
  };

  if (step === "done") {
    return (
      <div className="rounded-md border border-success-foreground/30 bg-success px-4 py-3 text-sm text-success-foreground" data-testid="delegate-panel-done" data-surface={surface} data-initial={confirmedHere ? "false" : "true"}>
        <p className="font-semibold">✓ {signedInEmail} is {confirmedHere ? "now" : "already"} attached to {targetMasked}</p>
        <p className="mt-1">
          {surface === "approve_wall"
            ? "That account's agents can read this mailbox from now on. The approval link itself still belongs to "
            : "That account's agents can read this mailbox from now on — it appears under its Accessible Gmail Accounts automatically. "}
          {surface === "approve_wall" && (
            <>
              <strong>{targetMasked}</strong>: switch to it to approve, and this link brings you straight back.
            </>
          )}
          {surface !== "approve_wall" && "You can revoke this any time from Accounts → Delegations You've Granted."}
        </p>
        {surface === "approve_wall" && returnTo && (
          <button onClick={switchAccount} disabled={switching} className={`${buttonPrimary} mt-3`} data-testid="delegate-panel-switch">
            {switching ? "Signing out…" : `Switch to ${targetMasked}`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`rounded-md border px-4 py-3 text-sm ${prominent ? "border-primary bg-primary-muted" : "border-border bg-card"}`}
      data-testid="delegate-panel"
      data-surface={surface}
      data-prominent={prominent ? "true" : "false"}
    >
      {step === "offer" ? (
        <>
          <p className="font-semibold text-foreground">
            {surface === "approve_wall"
              ? `Is ${targetMasked} also your account?`
              : surface === "dashboard_banner"
                ? `You were signed in as ${targetMasked} a moment ago — is that also you?`
                : `Attach ${signedInEmail} to ${targetMasked}?`}
          </p>
          <p className="mt-1 text-muted-foreground">
            {surface === "accounts_link"
              ? <>This link was made by <strong>{targetMasked}</strong> to add another Gmail account. One click gives that account&apos;s agents access to <strong>{signedInEmail}</strong> — no second dashboard to manage.</>
              : <>You don&apos;t need two FGAC accounts. One click attaches <strong>{signedInEmail}</strong> to <strong>{targetMasked}</strong>, so its agents can use this mailbox too — and you keep managing everything from that one account.</>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => setStep("confirm")} className={prominent ? buttonPrimary : buttonSecondary} data-testid="delegate-panel-offer">
              Yes, attach {signedInEmail} to that account
            </button>
            {dismissible && (
              <button onClick={dismiss} className="text-[13px] font-semibold text-muted-foreground hover:text-foreground" data-testid="delegate-panel-dismiss">
                {surface === "dashboard_banner" ? "No, that's someone else" : "Dismiss"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="font-semibold text-foreground">Confirm: give {targetMasked} access to {signedInEmail}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Agents connected to <strong>{targetMasked}</strong> will be able to read <strong>{signedInEmail}</strong>&apos;s mail, under that account&apos;s rules (read-only until it adds rules).</li>
            <li>Only do this if <strong>{targetMasked}</strong> is your own account or someone you trust with this mailbox.</li>
            <li>Undo any time: sign in as <strong>{signedInEmail}</strong> → Accounts → Delegations You&apos;ve Granted → Revoke.</li>
          </ul>
          {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={confirm} disabled={isPending} className={buttonPrimary} data-testid="delegate-panel-confirm">
              {isPending ? "Attaching…" : "Attach this mailbox"}
            </button>
            <button onClick={() => { setStep("offer"); setError(null); }} disabled={isPending} className="text-[13px] font-semibold text-muted-foreground hover:text-foreground">
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The dashboard prompt is keyed on the previous-account marker; a decision
 *  either way retires it, so the prompt does not return on the next page. */
function clearPrevMarker() {
  try {
    document.cookie = `${PREV_ACCOUNT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  } catch { /* cookies unavailable: the marker ages out on its own */ }
}
