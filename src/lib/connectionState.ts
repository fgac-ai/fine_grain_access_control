/**
 * Effective state of an agent connection, derived from its row AND the
 * liveness of the profile (proxy key) it is bound to.
 *
 * `agent_connections.status` alone is not the truth: revoking a profile sets
 * `proxy_keys.revoked_at` and leaves every connection bound to it `approved`.
 * The MCP route already refused those connections (key-liveness check), but
 * the dashboard listed approved connections only under their own profile tab
 * — and a revoked profile has no tab — so the connection vanished from every
 * page with no way to re-attach it (2026-10-09 hosted-MCP regression, key
 * lifecycle / connection lifecycle). Deriving `profile_revoked` here, rather
 * than rewriting rows on revoke, also covers every connection orphaned
 * before this fix without a backfill.
 *
 * Pure — shared by GET /api/connections, the MCP route and the dashboard.
 */

export type ConnectionState = 'pending' | 'approved' | 'blocked' | 'profile_revoked';

export interface KeyLiveness {
  revokedAt: Date | string | null;
  expiresAt?: Date | string | null;
}

const asTime = (d: Date | string | null | undefined) =>
  d == null ? null : new Date(d).getTime();

/** A profile key is live when it is neither revoked nor past its expiry. */
export function isKeyLive(key: KeyLiveness | null | undefined, now: Date = new Date()): boolean {
  if (!key) return false;
  if (key.revokedAt != null) return false;
  const exp = asTime(key.expiresAt);
  return exp == null || exp >= now.getTime();
}

/**
 * `profile_revoked` = the row says approved but the bound profile is revoked,
 * expired, or gone (`proxy_key_id` is ON DELETE SET NULL). Such a connection
 * is refused by MCP exactly like a blocked one, and the dashboard shows it on
 * every profile tab with a re-attach action.
 */
export function connectionState(
  conn: { status: string; proxyKeyId: string | null },
  keysById: ReadonlyMap<string, KeyLiveness>,
  now: Date = new Date(),
): ConnectionState {
  if (conn.status === 'pending') return 'pending';
  if (conn.status === 'blocked') return 'blocked';
  if (!conn.proxyKeyId) return 'profile_revoked';
  return isKeyLive(keysById.get(conn.proxyKeyId), now) ? 'approved' : 'profile_revoked';
}

/**
 * Where the "new connection" banner should send the user to review recent
 * connections. The banner used to say "Review or block it below" on every
 * tab, but the Connected Agents card below only lists the ACTIVE profile's
 * connections — so on any other tab "below" was empty. Returns 'below' only
 * when every recent connection is on the active tab, else the profile id to
 * link to (the first recent connection's).
 */
export function reviewTarget(
  recent: ReadonlyArray<{ proxyKeyId: string | null }>,
  activeProfileId: string | null,
): 'below' | { profileId: string } | null {
  if (recent.length === 0) return null;
  if (activeProfileId && recent.every(c => c.proxyKeyId === activeProfileId)) return 'below';
  const elsewhere = recent.find(c => c.proxyKeyId && c.proxyKeyId !== activeProfileId);
  return elsewhere?.proxyKeyId ? { profileId: elsewhere.proxyKeyId } : null;
}
