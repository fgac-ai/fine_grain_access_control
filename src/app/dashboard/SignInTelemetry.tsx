"use client";

import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import type { GoogleAccessLike } from "@/lib/googleScopeCopy";
import { classifyApproveClient } from "@/lib/approveClientClass";
import { APPROVAL_WALL_COOKIE, decodeApprovalWallCookie, readCookie } from "@/lib/approvalWall";

/**
 * Emits one `sign_in_completed` per Clerk sign-in, stamped with the Google
 * scope state the dashboard measured on that first load.
 *
 * PostHog had no sign-in signal at all (Clerk's OAuth hop is invisible to
 * `$pageview`), which is why the 2026-09-04 finding — a plain Google sign-in
 * rewrites Clerk's grant without drive.file — could only be sized from a
 * Clerk sweep. `drive_file_narrowed` is the per-sign-in version of that
 * sweep: true when the user depends on drive.file and just arrived without it.
 *
 * Dedupe: Clerk's `lastSignInAt` changes on every sign-in and is stable
 * between, so it keys a localStorage marker (localStorage, not
 * sessionStorage — /dashboard redirects to the profile slug route and both
 * loads mount this component, and a second tab must not double-count).
 * Only fires within a window of the sign-in so a stale marker-less browser
 * does not report a days-old sign-in as new.
 *
 * Since 2026-09-16 the event also carries `client` (browser / claude_desktop,
 * from the same UA classifier the approve page uses) and, when the
 * approval-wall cookie set by middleware is present, `after_approval_wall`
 * plus the wall's action / target hash / age. This component mounts on the
 * dashboard pages ONLY — never on /dashboard/approve — so a sign-in that
 * fires here with the marker present is, by construction, a person who hit
 * the approval sign-in wall and did NOT land back on the approve page: the
 * lost-context path. The marker is retired after one read.
 */

const SIGN_IN_REPORT_WINDOW_MS = 10 * 60_000;

export function SignInTelemetry({
  lastSignInAt,
  access,
  needsDriveFile,
}: {
  lastSignInAt: number | null;
  access: GoogleAccessLike;
  needsDriveFile: boolean;
}) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!lastSignInAt || Date.now() - lastSignInAt > SIGN_IN_REPORT_WINDOW_MS) return;
    const key = `fgac_sign_in_reported_${lastSignInAt}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      return;
    }
    let wall: ReturnType<typeof decodeApprovalWallCookie> = null;
    try {
      wall = decodeApprovalWallCookie(readCookie(document.cookie, APPROVAL_WALL_COOKIE));
      if (wall) document.cookie = `${APPROVAL_WALL_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    } catch {
      wall = null;
    }
    posthog?.capture("sign_in_completed", {
      gmail_scope: access.gmail,
      drive_file_scope: access.driveFile,
      needs_drive_file: needsDriveFile,
      drive_file_narrowed: needsDriveFile && !access.driveFile,
      client: classifyApproveClient(navigator.userAgent).client,
      landing_path: window.location.pathname,
      after_approval_wall: wall !== null,
      ...(wall ?? {}),
    });
  }, [lastSignInAt, access.gmail, access.driveFile, needsDriveFile, posthog]);

  return null;
}
