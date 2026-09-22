import { clerkClient } from '@clerk/nextjs/server';
import { DRIVE_FILE_KINDS, type DriveFileKind } from '@/lib/driveFileKinds';

/**
 * Per-file access has two halves: the FGAC rule (our database) and the
 * Google-side grant. The app never requests a Sheets/Docs OAuth scope — API
 * access rides on per-file `drive.file` grants, which Google registers ONLY
 * when the user picks the file in the Google Picker with our appId. An FGAC
 * rule whose file was never picked passes policy but 403/404s at Google,
 * which is exactly the trap the 2026-08 connector-launch cohort fell into
 * (approve → retry → generic error → churn). This module is the single
 * source of truth for "does Google actually let us reach this file right
 * now?" — for every drive-file kind (sheets, docs, slides later).
 */
export type FileGrantState =
  | { state: 'ok'; title: string | null }
  // 403/404 from Google: no drive.file grant for this file (or the id is
  // wrong — indistinguishable from outside, and the Picker fixes both).
  | { state: 'missing' }
  // Network error / 5xx / 429: verification could not run. Callers must
  // degrade to "no warning", never alarm the user on Google's bad day.
  | { state: 'unknown'; status?: number };

/** Back-compat alias (pre-docs name). */
export type SheetsGrantState = FileGrantState;

export async function verifyFileGrant(
  kind: DriveFileKind,
  token: string,
  fileId: string,
): Promise<FileGrantState> {
  let res: Response;
  try {
    res = await fetch(DRIVE_FILE_KINDS[kind].verifyUrl(fileId), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { state: 'unknown' };
  }

  if (res.ok) {
    const data = await res.json().catch(() => null) as
      | { properties?: { title?: string }; title?: string }
      | null;
    // Sheets nests the title under properties; Docs/Slides return it top-level.
    return { state: 'ok', title: data?.properties?.title ?? data?.title ?? null };
  }
  if (res.status === 403) {
    // A disabled product API (SERVICE_DISABLED) is a project configuration
    // gap, not a missing per-file grant: reporting it as `missing` would send
    // the user into a Picker loop that can never verify. Treat it as
    // `unknown` so no chip or recovery page claims a pick will fix it.
    const body = await res.json().catch(() => null) as
      { error?: { details?: Array<{ reason?: unknown }>; errors?: Array<{ reason?: unknown }> } } | null;
    const reasons = [
      ...(body?.error?.details ?? []).map(d => d?.reason),
      ...(body?.error?.errors ?? []).map(e => e?.reason),
    ];
    if (reasons.includes('SERVICE_DISABLED')) return { state: 'unknown', status: 403 };
    return { state: 'missing' };
  }
  if (res.status === 404) return { state: 'missing' };
  return { state: 'unknown', status: res.status };
}

export async function verifySheetsGrant(token: string, spreadsheetId: string): Promise<FileGrantState> {
  return verifyFileGrant('sheet', token, spreadsheetId);
}

export async function verifyDocsGrant(token: string, documentId: string): Promise<FileGrantState> {
  return verifyFileGrant('doc', token, documentId);
}

/**
 * The signed-in owner's Google access token (same token the MCP path uses for
 * the owner's own mailbox). Null when Google is not connected — for grant
 * verification purposes that reads as `missing`, since the Picker flow is
 * also the fix for a not-yet-connected account (it triggers consent first).
 */
export async function getOwnerGoogleToken(clerkUserId: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    // Un-prefixed provider id — the `oauth_` form is deprecated (see
    // googleAccess.ts).
    const tokens = await client.users.getUserOauthAccessToken(clerkUserId, 'google');
    return tokens.data?.[0]?.token || null;
  } catch (err) {
    // Same observability as the MCP path: a Clerk "cannot refresh" here means
    // grant verification will read as `missing` for a user whose real problem
    // is a dead token, not a missing pick. Make that measurable.
    const { captureServerEvent } = await import('@/lib/posthogServer');
    const { classifyClerkTokenError } = await import('@/lib/googleTokenFailure');
    // Same classifier as the MCP path (since 2026-09-09): a revoked grant
    // reads as `grant_revoked`, not `clerk_error`.
    const cls = classifyClerkTokenError(err);
    captureServerEvent(clerkUserId, 'google_token_fetch_failed', {
      reason: cls.reason,
      via: 'grant_check',
      ...(cls.clerkStatus !== undefined ? { clerk_status: cls.clerkStatus } : {}),
      ...(cls.clerkCode ? { clerk_code: cls.clerkCode } : {}),
    });
    return null;
  }
}
