"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DRIVE_FILE_KINDS, type DriveFileKind } from "@/lib/driveFileKinds";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 15_000;

type SettleState = "settling" | "verified" | "unconfirmed";

/**
 * Post-approval settling check for per-file (sheets/docs) grants
 * (grant-race fix, 2026-08).
 *
 * Approval-time verification passes with the owner's token, but Google's
 * per-file drive.file grant is eventually consistent: the agent's very next
 * call could still 403 for ~10-60 s ("approved → one error → success" was the
 * launch cohort's most common post-fix failure). Instead of telling the user
 * "the agent can retry now" the instant the rule is written, this card keeps
 * them on the page while re-verifying the grant, and only claims success once
 * a live test read against Google passes. If Google still hasn't settled
 * after 15 s, it says so honestly and routes to the recovery page.
 */
export function ApprovedSettling({ kind, fileId, message }: { kind: DriveFileKind; fileId: string; message: string }) {
  const [state, setState] = useState<SettleState>("settling");
  const startedAt = useRef(Date.now());
  const d = DRIVE_FILE_KINDS[kind];
  const short = d.shortNoun;
  const verifyPath = d.verifyPath;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const r = await fetch(
          `${verifyPath}?${d.setupIdParam}=${encodeURIComponent(fileId)}&context=post_approval`,
        );
        const data = await r.json();
        if (cancelled) return;
        if (data.state === "ok") {
          setState("verified");
          return;
        }
      } catch { /* transient — keep polling until the timeout */ }
      if (cancelled) return;
      if (Date.now() - startedAt.current >= POLL_TIMEOUT_MS) {
        setState("unconfirmed");
        return;
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [fileId, verifyPath, d.setupIdParam]);

  if (state === "settling") {
    return (
      <div data-testid="approved-settling">
        <h1 className="mb-2 text-xl font-bold text-foreground">✓ Approved</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-foreground" aria-hidden="true" />
          Confirming Google has finished sharing the {short}…
        </p>
      </div>
    );
  }

  if (state === "verified") {
    return (
      <div data-testid="approved-verified">
        <h1 className="mb-2 text-xl font-bold text-success-foreground">✓ Approved &amp; verified with Google</h1>
        <p className="text-sm text-muted-foreground">
          {message}{" "}The agent can retry its request now. You can review or
          remove this grant any time from your dashboard rules.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="approved-unconfirmed">
      <h1 className="mb-2 text-xl font-bold text-foreground">✓ Approved — one more step may be needed</h1>
      <p className="text-sm text-muted-foreground">
        {message}{" "}However, Google hasn&apos;t confirmed the {short} is shared with
        FGAC yet. This usually settles within a minute — if the agent still
        gets an error, finish the share on the{" "}
        <Link
          href={`${d.setupPath}?${d.setupIdParam}=${encodeURIComponent(fileId)}&from=approval`}
          className="underline hover:text-foreground"
        >
          {short}s setup page
        </Link>.
      </p>
    </div>
  );
}
