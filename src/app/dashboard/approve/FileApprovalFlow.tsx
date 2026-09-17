"use client";

import { useCallback, useEffect, useState } from "react";
import { useGooglePicker, PickedFile, type PickerCancelInfo } from "../useGooglePicker";
import { pickerRecoveryCopy, pickByNameHint, pickerAccountHint } from "@/lib/pickerRecoveryCopy";
import { TrackedVideoEmbed } from "@/components/TrackedVideoEmbed";
import { DRIVE_FILE_KINDS, type DriveFileKind } from "@/lib/driveFileKinds";
import type { ApprovalSearchParams } from "@/lib/approvalLinks";
import { ApproveSubmitButton } from "./ApproveSubmitButton";

const SHEETS_DEMO_EMBED = "https://share.descript.com/embed/Fv9pwXugLUa";

type FlowState =
  | { step: "checking" }
  // Grant verified (or verification inconclusive) — straight to confirm.
  | { step: "confirm"; picked: PickedFile[] | null; title: string | null }
  // No Google grant: the pick comes FIRST. The pick registers the grant and
  // confirms the file's identity; only then does approving mean anything.
  // `cancelled` = the user closed the Picker without a pick; the panel then
  // explains what to look for and offers the Picker again in place.
  | { step: "need_pick"; pickFailed: boolean; cancelled: { attempt: number } | null }
  // User picked file(s) that don't include the id the agent asked for.
  | { step: "substitute"; picked: PickedFile[] };

/**
 * Picker-first approval flow for per-file (sheets/docs) magic links.
 *
 * Sequence: verify the Google-side grant on load. If Google can already
 * reach the file, approving is one click (title shown, since we can now
 * resolve it). If not, the user picks the file in Google's Picker BEFORE
 * any FGAC rule exists — approving blind on a raw id is how the connector
 * launch cohort ended up with rules for sheets Google couldn't serve. A
 * different-file pick becomes an explicit substitution: the grant follows
 * what the user actually picked, never the unverifiable id.
 */
export function FileApprovalFlow({
  link,
  kind,
  fileId,
  resourceName,
  connectedGoogleEmail,
  level,
  approveAction,
}: {
  link: ApprovalSearchParams;
  kind: DriveFileKind;
  fileId: string;
  resourceName: string | null;
  /** Google account whose Drive the Picker lists (Clerk's Google external account); null when unknown. */
  connectedGoogleEmail: string | null;
  /** 'expose' = read grant with an upgrade choice; 'write' = read & write. */
  level: "expose" | "write";
  approveAction: (formData: FormData) => Promise<void>;
}) {
  const [state, setState] = useState<FlowState>({ step: "checking" });
  const d = DRIVE_FILE_KINDS[kind];
  const short = d.shortNoun;
  const testPrefix = d.service;
  const verifyPath = d.verifyPath;

  useEffect(() => {
    let cancelled = false;
    fetch(`${verifyPath}?${d.setupIdParam}=${encodeURIComponent(fileId)}&context=link_open`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.state === "ok") {
          setState({ step: "confirm", picked: null, title: data.title ?? null });
        } else if (data.state === "missing") {
          setState({ step: "need_pick", pickFailed: false, cancelled: null });
        } else {
          // Verification inconclusive (Google hiccup) — don't block the
          // approval; the server falls back to the recovery page if needed.
          setState({ step: "confirm", picked: null, title: null });
        }
      })
      .catch(() => { if (!cancelled) setState({ step: "confirm", picked: null, title: null }); });
    return () => { cancelled = true; };
  }, [fileId, verifyPath, d.setupIdParam]);

  const handleFilesPicked = (picked: PickedFile[]) => {
    if (picked.length === 0) {
      setState({ step: "need_pick", pickFailed: true, cancelled: null });
      return;
    }
    if (picked.some(s => s.id === fileId)) {
      setState({ step: "confirm", picked, title: picked.find(s => s.id === fileId)?.name ?? null });
    } else {
      setState({ step: "substitute", picked });
    }
  };

  // A cancel used to leave this panel exactly as it was — no message, no name,
  // no visible way back in. Measured 2026-09-03 → 09-07, 39% of Picker opens
  // ended in a cancel, and the two users who cancelled on this page never
  // approved. Only the pick-first state changes; a cancel from "Pick again"
  // keeps the pick the user already has.
  const handleCancelled = useCallback((info: PickerCancelInfo) => {
    setState(prev => prev.step === "need_pick"
      ? { step: "need_pick", pickFailed: false, cancelled: { attempt: info.attempt } }
      : prev);
  }, []);

  const { triggerAddSheets, isLoading: pickerLoading, pickerError } = useGooglePicker(handleFilesPicked, kind, { onCancelled: handleCancelled });

  // A failed Google flow must be visible with a way forward — the silent
  // do-nothing button sent a real user away (2026-08-19).
  const pickerErrorBox = pickerError ? (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground [overflow-wrap:anywhere]" data-testid="picker-error">
      <span className="font-semibold">Google flow failed: </span>{pickerError}{" "}
      <a href="/dashboard/accounts" className="underline hover:opacity-80">Open the Accounts page</a>
    </div>
  ) : null;

  const fileLabel = resourceName || fileId;
  const levelChoice = level === "expose";

  if (state.step === "checking") {
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${testPrefix}-flow-checking`}>
        Checking whether Google already shares this {short} with FGAC…
      </p>
    );
  }

  if (state.step === "need_pick") {
    // Denial-minted links carry no name and Drive cannot resolve a file it
    // does not share with FGAC, so `resourceName` is usually null here — the
    // copy then says "the sheet with Google id …" and, because Google's Picker
    // lists files by NAME, tells the user to look for it by title.
    const recovery = state.cancelled ? pickerRecoveryCopy({ short, title: resourceName, fileId }) : null;
    return (
      <div className="flex flex-col gap-4" data-testid={`${testPrefix}-flow-pick-first`}>
        {recovery ? (
          <div className="rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground [overflow-wrap:anywhere]" data-testid={`${testPrefix}-flow-pick-cancelled`}>
            <p className="font-semibold">{recovery.heading}</p>
            <p className="mt-2">{"The agent asked for "}<strong>{recovery.target}</strong>{". "}{recovery.hint}</p>
            <p className="mt-2">{pickerAccountHint({ short, googleEmail: connectedGoogleEmail })}</p>
            <p className="mt-2">{recovery.reassurance}</p>
          </div>
        ) : (
          <div className="rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground [overflow-wrap:anywhere]">
            {"Google hasn't shared "}
            <strong>{resourceName ? `"${resourceName}"` : `the ${short} the agent asked for`}</strong>
            {resourceName ? null : <>{" (Google id "}<code className="font-mono text-xs">{fileId}</code>{")"}</>}
            {` with FGAC yet, so there's nothing to approve until you pick it. Google only shares a ${short} when you choose it in Google's own file picker — that per-file permission is all FGAC runs on (nothing else in your Drive is shared).`}
          </div>
        )}
        {pickerErrorBox}
        {state.pickFailed && (
          <p className="text-sm text-muted-foreground">
            {`No ${short} was selected. Open the picker and choose the ${short} the agent should reach.`}
          </p>
        )}
        <button
          onClick={() => triggerAddSheets(fileId)}
          disabled={pickerLoading}
          data-testid={`${testPrefix}-flow-pick-button`}
          className="rounded-sm bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {pickerLoading ? "Opening Google Picker…" : recovery ? recovery.retryLabel : `Step 1 — Pick the ${short} in Google Picker`}
        </button>
        <p className="text-xs text-subtle" data-testid={`${testPrefix}-flow-pick-hint`}>
          {pickByNameHint({ short, title: resourceName })}
        </p>
        <p className="text-xs text-subtle [overflow-wrap:anywhere]" data-testid={`${testPrefix}-flow-account-hint`}>
          {pickerAccountHint({ short, googleEmail: connectedGoogleEmail })}
        </p>
        <p className="text-xs text-subtle">
          First time? Google will ask you to allow FGAC&apos;s file picker
          (drive.file) and then bring you straight back here.
        </p>
        {d.hasSetupVideo && (
          <div className="rounded-lg border border-border bg-card p-2">
            <div className="px-1.5 pb-1.5 pt-0.5 text-sm font-semibold text-foreground">
              Watch how it works (2 min)
            </div>
            <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-surface-inverse">
              <TrackedVideoEmbed src={SHEETS_DEMO_EMBED} title="FGAC Google Sheets demo" />
            </div>
          </div>
        )}
      </div>
    );
  }

  const picked = state.picked;
  const substituting = state.step === "substitute";
  const grantTargets = state.step === "substitute"
    ? state.picked.map(s => s.name || s.id).join(", ")
    : (state.title || fileLabel);

  return (
    <form action={approveAction} className="flex flex-col gap-4" data-testid={`${testPrefix}-flow-confirm`}>
      <input type="hidden" name="a" value={link.a ?? ""} />
      <input type="hidden" name="k" value={link.k ?? ""} />
      <input type="hidden" name="r" value={link.r ?? ""} />
      <input type="hidden" name="s" value={link.s ?? ""} />
      {picked && <input type="hidden" name="picked" value={JSON.stringify(picked)} />}

      {substituting && (
        <div className="rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground [overflow-wrap:anywhere]" data-testid={`${testPrefix}-flow-substitution`}>
          {"You picked "}<strong>{grantTargets}</strong>{`, but the agent asked for a different ${short} ID (`}<code className="font-mono text-xs">{fileId}</code>{") that Google says you don't have. Most likely the agent had the wrong ID. Approving grants access to "}<strong>what you picked</strong>{` — and nothing for the ID the agent sent; the agent will find the right ${short} in its permissions.`}
        </div>
      )}
      {!substituting && (
        <div className="rounded-md border border-border bg-secondary/30 px-4 py-3 text-sm text-foreground [overflow-wrap:anywhere]">
          {"Granting access to "}<strong>{grantTargets}</strong>
          {state.title && resourceName === null ? " (verified with Google)" : ""}.
        </div>
      )}

      {levelChoice && (
        <fieldset className="flex flex-col gap-2 text-sm text-foreground">
          <label className="flex items-center gap-2">
            <input type="radio" name="permission" value="read_only" defaultChecked />
            Read only
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="permission" value="read_write" />
            Read &amp; write
          </label>
        </fieldset>
      )}

      {/* Guarded submit (disables + "Approving…" while the action runs). The
          plain button this replaced let every extra click queue another
          server action — the 2026-09 duplicate-approval / duplicate-rule
          source. */}
      <ApproveSubmitButton label={substituting ? "Grant access to what I picked" : "Approve this grant"} />
      {picked && !substituting && (
        <button
          type="button"
          onClick={() => triggerAddSheets(fileId)}
          className="text-xs text-subtle underline hover:text-foreground self-start"
        >
          Pick again
        </button>
      )}
      {substituting && (
        <button
          type="button"
          onClick={() => triggerAddSheets(fileId)}
          disabled={pickerLoading}
          className="text-xs text-subtle underline hover:text-foreground self-start disabled:opacity-50"
        >
          That&apos;s not right — pick a different {short}
        </button>
      )}
      {pickerErrorBox}
    </form>
  );
}
