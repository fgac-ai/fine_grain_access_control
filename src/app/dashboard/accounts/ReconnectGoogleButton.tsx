"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import {
  startGoogleReconnect, DRIVE_FILE_SCOPE, GMAIL_MODIFY_SCOPE, type ClerkUserLike,
} from "../googleReconnect";

/**
 * The control every "reconnect Google from the Accounts page" message points
 * at. Runs the shared reconnect leg (reauthorize, or destroy+recreate for a
 * broken grant) and sends the user through Google's consent, returning here
 * with ?reconnected=1. Failures render inline — never a button that silently
 * does nothing.
 *
 * Gmail is requested explicitly (not just drive.file): the missing-scope
 * lockout this button remediates is a grant whose Gmail checkbox was left
 * unchecked, and only listing the scope guarantees Google re-presents it.
 *
 * `?reconnect=1` (minted into MCP tool errors) auto-fires the flow on load so
 * the agent's link is one click from Google's consent screen — but ONLY on
 * the safe reauthorize branch: a non-verified account takes the
 * destroy+recreate leg, which must stay behind an explicit click. The page
 * additionally passes `blockAutoReconnect` when the link's `for=` account is
 * not the signed-in user — auto-firing there would repair the wrong account
 * while reporting success (2026-08-30 incident).
 *
 * On return (?reconnected=1) success is VERIFIED, not assumed: the token
 * bridge does a real tokeninfo call, and Google's granular consent means a
 * completed flow can still be missing a checkbox — and a permission the
 * account declined before comes back UNCHECKED on the next screen, so the
 * failure copy has to say "tick the box", not just "approve" (one owner ran
 * the flow twice inside a minute on 2026-09-24 and returned without either
 * scope both times). Clerk propagates fresh
 * scopes with a lag, so we poll the same way useGooglePicker does before
 * declaring failure.
 */

type VerifyState =
  | { phase: "checking" }
  | { phase: "verified" }
  | { phase: "failed"; missing: string[] };

const SCOPE_POLL_ATTEMPTS = 4;
const SCOPE_POLL_INTERVAL_MS = 1500;

function missingScopes(scopes: string[]): string[] {
  const missing: string[] = [];
  if (!scopes.includes(GMAIL_MODIFY_SCOPE) && !scopes.includes("https://mail.google.com/")) {
    missing.push("gmail.modify");
  }
  if (!scopes.includes(DRIVE_FILE_SCOPE) && !scopes.includes("https://www.googleapis.com/auth/drive")) {
    missing.push("drive.file");
  }
  return missing;
}

export function ReconnectGoogleButton({
  prominent = false,
  blockAutoReconnect = false,
}: {
  prominent?: boolean;
  blockAutoReconnect?: boolean;
}) {
  const { user, isLoaded } = useUser();
  const posthog = usePostHog();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const autoFired = useRef(false);
  const verifyStarted = useRef(false);
  const mismatchCaptured = useRef(false);
  const justReconnected = params.get("reconnected") === "1";
  const autoRequested = params.get("reconnect") === "1";

  // Make the wrong-account card countable: suppressing the auto-fire also
  // removes the google_reconnect_started signature these opens used to leave
  // in analytics, so without this event the mismatch population would be
  // invisible (docs/monitoring.md §7.7).
  useEffect(() => {
    if (!autoRequested || !blockAutoReconnect || !isLoaded || mismatchCaptured.current) return;
    mismatchCaptured.current = true;
    posthog?.capture("google_reconnect_wrong_account", {
      intended_for: params.get("for"),
    });
  }, [autoRequested, blockAutoReconnect, isLoaded, posthog, params]);

  const start = async (source: string) => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    posthog?.capture("google_reconnect_started", { source });
    try {
      const url = await startGoogleReconnect(
        user as unknown as ClerkUserLike,
        `${window.location.origin}/dashboard/accounts?reconnected=1`,
        [GMAIL_MODIFY_SCOPE, DRIVE_FILE_SCOPE],
      );
      window.location.href = url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[accounts] Google reconnect failed:", err);
      posthog?.capture("picker_flow_error", { stage: "accounts_reconnect", message });
      setError(
        `Could not start Google authorization (${message}). Retry in a moment; if it keeps failing, sign out and back in, then try again.`,
      );
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!autoRequested || autoFired.current || !isLoaded || !user || justReconnected) return;
    if (blockAutoReconnect) return;
    const google = user.externalAccounts.find(
      acc => acc.provider === "google" || (acc.provider as string) === "oauth_google",
    );
    if (google?.verification?.status !== "verified") return;
    autoFired.current = true;
    void start("agent_link");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once when the session hydrates
  }, [autoRequested, isLoaded, user, justReconnected, blockAutoReconnect]);

  // Post-reconnect verification: poll the token bridge (real tokeninfo call)
  // until both scopes show up or the attempts run out.
  useEffect(() => {
    if (!justReconnected || verifyStarted.current) return;
    verifyStarted.current = true;
    let cancelled = false;

    // Closes the reconnect funnel: started → returned → verified|incomplete.
    // Without this event a google_reconnect_started with no terminal event is
    // ambiguous between abandoned consent, a session dropped during the OAuth
    // round-trip (observed 2026-09-03: consent succeeded, user landed on the
    // sign-in page and reasonably assumed failure), and plain success — the
    // return leg rendered its result but captured nothing.
    posthog?.capture("google_reconnect_returned");

    const run = async () => {
      setVerify({ phase: "checking" });
      let missing = ["gmail.modify", "drive.file"];
      for (let attempt = 0; attempt <= SCOPE_POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, SCOPE_POLL_INTERVAL_MS));
        if (cancelled) return;
        try {
          const res = await fetch("/api/auth/google-picker-token");
          const data = await res.json();
          if (res.ok && Array.isArray(data.scopes)) {
            missing = missingScopes(data.scopes);
            if (missing.length === 0) break;
          }
        } catch {
          // Keep polling; the final state reports whatever is still missing.
        }
      }
      if (cancelled) return;
      if (missing.length === 0) {
        posthog?.capture("google_reconnect_verified");
        setVerify({ phase: "verified" });
      } else {
        posthog?.capture("google_reconnect_incomplete", { missing_scopes: missing });
        setVerify({ phase: "failed", missing });
      }
    };
    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on the return leg
  }, [justReconnected]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={() => start("accounts_page")}
        disabled={busy}
        className={
          prominent
            ? "rounded-sm bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
            : "rounded-sm border border-border px-4 py-2 text-[13px] font-semibold text-foreground hover:bg-card disabled:opacity-60"
        }
      >
        {busy ? "Opening Google…" : "Reconnect Google"}
      </button>
      {justReconnected && !error && verify?.phase === "checking" && (
        <p className="text-[11px] text-muted-foreground">Confirming Google permissions…</p>
      )}
      {justReconnected && !error && verify?.phase === "verified" && (
        <p className="text-[11px] text-success-foreground">✓ Google reconnected — gmail.modify and drive.file confirmed.</p>
      )}
      {justReconnected && !error && verify?.phase === "failed" && (
        <p className="max-w-xs text-right text-[11px] text-destructive [overflow-wrap:anywhere]">
          Google finished the flow WITHOUT granting {verify.missing.join(" and ")}.
          Google leaves a permission that was declined before UNCHECKED on the
          consent screen, so continuing without ticking it changes nothing. Click
          Reconnect Google again and tick every box before you continue.
        </p>
      )}
      {error && (
        <p className="max-w-xs text-right text-[11px] text-destructive [overflow-wrap:anywhere]">{error}</p>
      )}
    </div>
  );
}
