/**
 * The scopes a Google access token ACTUALLY carries, from Google's tokeninfo
 * endpoint — as opposed to Clerk's `scopes` metadata, which is a record of
 * the last OAuth request that completed for the account.
 *
 * The two disagree in practice, in both directions (measured 2026-09-04):
 * a plain sign-in on an instance whose scope list lacks drive.file rewrites
 * the record narrower than a later-refreshed token; a sign-in that bounces
 * without consent over a narrow refresh token writes the record WIDER than
 * every token minted after the first refresh. The dashboard (googleAccess.ts)
 * and the Picker token bridge already treat tokeninfo as the truth; the MCP
 * pre-flight does the same here, so the three readers never disagree.
 *
 * Cached per token (in-memory, per function instance) so the check costs
 * about one Google round-trip per account per token lifetime, not one per
 * call. The cache holds only the scope list, never anything it could leak —
 * but the key is the token, so it must never be logged or exposed.
 */

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];
export const DRIVE_FILE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'];
/** The full Drive scope — the gate for the folder-inherited access model
 * (src/lib/driveTreeAccess.ts). Requested only for feature-flagged users. */
export const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

export type ScopeVerdict = {
  /** undefined = no scope information at all; never enforce on it. */
  hasGmailScope?: boolean;
  hasDriveFileScope?: boolean;
  /** The token carries the full `drive` scope (implies hasDriveFileScope). */
  hasDriveFullScope?: boolean;
  /** Clerk's record said a scope was missing that the token actually carries. */
  recordStale: boolean;
  /**
   * Clerk's record claims a scope the token does NOT carry — the sign-in
   * bounced without consent and Clerk kept an older, narrower refresh token,
   * so after the first refresh every token is narrower than the record
   * (measured 2026-09-04, USER_B). Only a consent pass repairs this.
   */
  recordOverstates: boolean;
  /** Which source decided: the token (tokeninfo) or, when unavailable, Clerk's record. */
  source: 'token' | 'record' | 'none';
};

/**
 * Pure decision behind the MCP pre-flight: the token's live scopes
 * (tokeninfo) are the truth whenever available — Clerk's record disagrees
 * with the token in BOTH directions (narrower after a plain sign-in, wider
 * after a no-consent sign-in over a narrow refresh token). `live` null means
 * tokeninfo was unavailable, so the record stands: an outage must never
 * widen or narrow access on its own.
 */
export function reconcileScopes(recorded: string[] | undefined, live: string[] | null | undefined): ScopeVerdict {
  const has = (scopes: string[], wanted: string[]) => scopes.some(s => wanted.includes(s));
  const recGmail = recorded ? has(recorded, GMAIL_SCOPES) : undefined;
  const recDrive = recorded ? has(recorded, DRIVE_FILE_SCOPES) : undefined;
  const recDriveFull = recorded ? recorded.includes(DRIVE_FULL_SCOPE) : undefined;
  if (!live) {
    return {
      hasGmailScope: recGmail, hasDriveFileScope: recDrive, hasDriveFullScope: recDriveFull,
      recordStale: false, recordOverstates: false, source: recorded ? 'record' : 'none',
    };
  }
  const liveGmail = has(live, GMAIL_SCOPES);
  const liveDrive = has(live, DRIVE_FILE_SCOPES);
  return {
    hasGmailScope: liveGmail,
    hasDriveFileScope: liveDrive,
    hasDriveFullScope: live.includes(DRIVE_FULL_SCOPE),
    recordStale: (liveGmail && recGmail === false) || (liveDrive && recDrive === false),
    recordOverstates: (!liveGmail && recGmail === true) || (!liveDrive && recDrive === true),
    source: 'token',
  };
}

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
// Google access tokens live an hour; a refreshed token is a new cache key, so
// a long TTL costs nothing in staleness and keeps this to ~1 lookup per
// account per hour per function instance.
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 3_000;

const cache = new Map<string, { scopes: string[]; at: number }>();

/**
 * Returns the token's scope list, or null when tokeninfo could not be
 * consulted (timeout, network, non-2xx) — callers fall back to whatever they
 * already knew; a tokeninfo outage must never widen or narrow access on its
 * own.
 */
export async function liveTokenScopes(
  token: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string[] | null> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scopes;

  try {
    const res = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const info = await res.json();
    const scopes = typeof info?.scope === 'string' ? info.scope.split(' ').filter(Boolean) : [];
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(token, { scopes, at: Date.now() });
    return scopes;
  } catch {
    return null;
  }
}
