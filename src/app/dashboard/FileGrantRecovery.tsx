"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useGooglePicker, PickedFile } from "./useGooglePicker";
import { TrackedVideoEmbed } from "@/components/TrackedVideoEmbed";
import { DRIVE_FILE_KINDS, type DriveFileKind } from "@/lib/driveFileKinds";

const SHEETS_DEMO_EMBED = "https://share.descript.com/embed/Fv9pwXugLUa";

type GrantStatus = "checking" | "needs_grant" | "verified" | "verified_other";

/**
 * Recovery UI for the "FGAC approved, Google grant missing" state — shared
 * by /dashboard/sheets-setup and /dashboard/docs-setup.
 *
 * Approving a file in FGAC only creates our rule; Google shares the file
 * with FGAC exclusively through a Google Picker pick (per-file drive.file
 * grant). Production showed users approving and then retrying into 404s
 * with no way out — this page IS the way out: one button that opens the
 * Picker, the demo video for anyone unsure (sheets has one today), and a
 * live verification check so we never again say "done" without Google
 * agreeing.
 */
export function FileGrantRecovery({
  kind,
  fileId,
  resourceName,
  fromApproval,
}: {
  kind: DriveFileKind;
  fileId: string | null;
  resourceName: string | null;
  fromApproval: boolean;
}) {
  const [status, setStatus] = useState<GrantStatus>(fileId ? "checking" : "needs_grant");
  const [busy, setBusy] = useState(false);
  // Access level applied to the pick. Read-only default; the user chooses
  // before picking (they had no way to choose at all before 2026-08-20 —
  // the page silently granted read-only).
  const [level, setLevel] = useState<"read" | "read_write">("read");
  const [grantedLevel, setGrantedLevel] = useState<"read" | "read_write">("read");
  const d = DRIVE_FILE_KINDS[kind];
  const short = d.shortNoun;
  const verifyPath = d.verifyPath;
  const grantPath = d.grantPath;
  const rulesKey = d.rulesKey;

  const verify = useCallback(async (recovery: boolean): Promise<boolean> => {
    if (!fileId) return false;
    try {
      const res = await fetch(
        `${verifyPath}?${d.setupIdParam}=${encodeURIComponent(fileId)}${recovery ? "&context=recovery" : ""}`,
      );
      const data = await res.json();
      return data.state === "ok";
    } catch {
      return false;
    }
  }, [fileId, verifyPath, d.setupIdParam]);

  useEffect(() => {
    let cancelled = false;
    if (!fileId) return;
    verify(false).then(ok => {
      if (!cancelled) setStatus(ok ? "verified" : "needs_grant");
    });
    return () => { cancelled = true; };
  }, [fileId, verify]);

  const handleFilesPicked = async (picked: PickedFile[]) => {
    setBusy(true);
    try {
      // Read-only picks upsert only files that have no rule yet — re-POSTing
      // an existing rule would silently downgrade a Read & Write choice. An
      // explicit Read & Write selection applies to every picked file
      // (upgrading an existing read-only rule is exactly what the user asked
      // for by selecting it).
      const chosenActionType = level === "read_write" ? d.actionTypes.readWrite : d.actionTypes.read;
      const existing = await fetch(grantPath)
        .then(r => r.json())
        .then(dta => new Set((dta[rulesKey] ?? []).map((r: { targetResourceId: string }) => r.targetResourceId)))
        .catch(() => new Set());
      for (const file of picked) {
        if (level === "read" && existing.has(file.id)) continue;
        await fetch(grantPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetResourceId: file.id,
            resourceName: file.name,
            actionType: chosenActionType,
          }),
        });
      }
      setGrantedLevel(level);

      if (!fileId) {
        // No specific file to verify — a pick is all setup requires.
        setStatus(picked.length > 0 ? "verified" : "needs_grant");
        return;
      }
      const ok = await verify(true);
      if (ok) {
        setStatus("verified");
      } else {
        // The user's pick is authoritative (product decision 2026-08-20):
        // whatever they picked is now shared and usable — render SUCCESS,
        // never a warning. Most likely the agent simply had the wrong id;
        // verified_other adds one informational line about that, nothing
        // blocking. Only an empty pick returns to needs_grant.
        setStatus(picked.length > 0 ? "verified_other" : "needs_grant");
      }
    } finally {
      setBusy(false);
    }
  };

  const { triggerAddSheets, isLoading: pickerLoading } = useGooglePicker(handleFilesPicked, kind);

  const fileLabel = resourceName || fileId || `your ${d.noun}`;
  const shortCap = short.charAt(0).toUpperCase() + short.slice(1);

  return (
    <div className="mx-auto mt-12 max-w-2xl px-6 pb-16">
      <div className="rounded-lg border border-border bg-card p-8">
        {status === "verified" || status === "verified_other" ? (
          <>
            <h1 className="mb-2 text-xl font-bold text-success-foreground">
              {status === "verified" ? `✓ ${shortCap} access verified` : `✓ ${shortCap} access granted`}
            </h1>
            <p className="text-sm text-muted-foreground">
              {status === "verified"
                ? <>{"Google now shares "}{resourceName ? <strong>{fileLabel}</strong> : `the selected ${short}`}{" with FGAC and your access rule is active. The agent can retry its request now."}</>
                : `Google now shares the ${short}(s) you picked with FGAC and their ${grantedLevel === "read_write" ? "Read & Write" : "Read Only"} access rules are active. The agent can use them now — it will find them in its permissions. You can change the access level any time from the dashboard.`}
            </p>
            {status === "verified_other" && fileId && (
              <p className="mt-3 text-xs text-subtle [overflow-wrap:anywhere]">
                {`Heads up: the specific ${d.noun} ID the agent originally asked for (`}<code className="font-mono">{fileId}</code>{`) wasn't among your picks — most likely the agent guessed a wrong ID. Nothing to fix on your end; if the agent really needs that exact ${short}, it can request access again.`}
              </p>
            )}
          </>
        ) : (
          <>
            <h1 className="mb-2 text-xl font-bold text-foreground">
              {fromApproval ? "Approved — one more step" : `Finish setting up ${short} access`}
            </h1>
            <p className="mb-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {fromApproval
                ? <>{"Your FGAC rule for "}<strong>{fileLabel}</strong>{` is saved, but Google hasn't shared the ${short} itself with FGAC yet.`}</>
                : <>{"FGAC has a rule for "}<strong>{fileLabel}</strong>{`, but Google hasn't shared the ${short} itself with FGAC yet.`}</>}
            </p>
            <p className="mb-5 text-sm text-muted-foreground">
              {`Google only shares a ${short} when you pick it in Google's own file picker — that's the per-file permission FGAC runs on (nothing else in your Drive is shared). Pick the ${short} below and you're done.`}
            </p>

            
            <fieldset className="mb-4 flex flex-col gap-2 text-sm text-foreground">
              <label className="flex items-center gap-2">
                <input type="radio" name="recovery-permission" value="read" checked={level === "read"} onChange={() => setLevel("read")} />
                Read only
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="recovery-permission" value="read_write" checked={level === "read_write"} onChange={() => setLevel("read_write")} />
                Read &amp; write
              </label>
            </fieldset>

            <button
              onClick={() => triggerAddSheets(fileId ?? undefined)}
              disabled={pickerLoading || busy || status === "checking"}
              className="w-full rounded-sm bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {status === "checking"
                ? "Checking current access…"
                : busy
                  ? "Saving…"
                  : pickerLoading
                    ? "Opening Google Picker…"
                    : `Pick the ${short} in Google Picker`}
            </button>
            <p className="mt-2 text-xs text-subtle">
              First time? Google will ask you to allow FGAC&apos;s file picker
              (drive.file) and then bring you straight back here.
            </p>
          </>
        )}
      </div>

      {status !== "verified" && status !== "verified_other" && d.hasSetupVideo && (
        <div className="mt-6 rounded-lg border border-border bg-card p-2.5">
          <div className="px-1.5 pb-2 pt-1 text-sm font-semibold text-foreground">
            Watch how it works (2 min)
          </div>
          <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-surface-inverse">
            <TrackedVideoEmbed src={SHEETS_DEMO_EMBED} title="FGAC Google Sheets demo" />
          </div>
        </div>
      )}

      <p className="mt-4 text-center text-xs text-subtle">
        <Link href="/dashboard" className="underline hover:text-foreground">
          Back to dashboard
        </Link>
      </p>
    </div>
  );
}
