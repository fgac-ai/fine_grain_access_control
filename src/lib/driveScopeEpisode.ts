/**
 * Records the full-`drive`-scope consent outcome for Drive tree (feature-
 * flagged) users from the SERVER, where the scope is actually observed.
 *
 * Why not the browser: `drive_scope_enabled` used to be captured by
 * EnableDriveAccessCard's return-leg effect, but that card only renders while
 * the server sees NO full scope. On a successful consent the return leg's
 * server render already sees the scope and draws the Drive tree card instead,
 * so the effect never mounted and the event never fired — 0 rows in PostHog
 * through 2026-10-09 while flagged users made hundreds of `drive_tree` calls.
 * Users who granted through the nav UserButton's "Connect account" scopes
 * never had an event at all.
 *
 * Model: `users.drive_full_scope_since` is set while the scope is held and
 * cleared when it is observed gone. The NULL → set transition is the enable;
 * it happens in one conditional UPDATE, so concurrent observers (two tabs, a
 * dashboard render racing an MCP call) record it exactly once per episode.
 *
 * This file is DB-free so the decision logic is unit-testable
 * (scripts/test-drive-scope-episode.ts); the Drizzle store lives in
 * driveScopeEpisodeServer.ts.
 */

export type DriveScopeSurface = 'dashboard' | 'mcp';

export type DriveScopeObservation = {
  /** users.id (row the episode marker lives on). */
  userId: string;
  /** Clerk id — the PostHog distinct id. */
  clerkUserId: string;
  /** Drive tree flag for this user; observations without it are ignored. */
  flagOn: boolean;
  /** The user's OWN live token carries the full `drive` scope. */
  hasDriveFullScope: boolean;
  /**
   * The absence of the scope is known from the token itself (tokeninfo
   * answered). A transient lookup failure or a scope record that may be
   * stale must never end an episode — that would fake a later re-enable.
   */
  lossCertain: boolean;
  surface: DriveScopeSurface;
  /** Dashboard render of the card's OAuth return leg (?drive_scope=1). */
  returnLeg?: boolean;
};

export type DriveScopeStore = {
  /**
   * Atomically set the marker if it is NULL. Returns null when it was already
   * set (nothing to record); otherwise whether the user had configured the
   * tree model before (a prior episode) — i.e. this is a RE-enable.
   */
  markHeld(userId: string): Promise<{ reenable: boolean } | null>;
  /** Atomically clear the marker; true when it was set. */
  markLost(userId: string): Promise<boolean>;
};

export type Capture = (distinctId: string, event: string, props: Record<string, unknown>) => void;

export type DriveScopeTransition = 'enabled' | 'lost' | null;

// Last state this instance wrote or confirmed per user, so the MCP hot path
// costs one UPDATE per user per function instance, not one per tool call. A
// stale `true` here can only DELAY an enable to the next dashboard render or
// another instance's first call — the UPDATE, not the cache, decides "once".
const known = new Map<string, boolean>();

export function _resetDriveScopeCache(): void { known.clear(); }

export async function observeDriveFullScope(
  obs: DriveScopeObservation,
  store: DriveScopeStore,
  capture: Capture,
): Promise<DriveScopeTransition> {
  if (!obs.flagOn) return null;
  const held = obs.hasDriveFullScope;
  if (!held && !obs.lossCertain) return null;
  // Only the MCP hot path trusts the cache; a dashboard render always asks
  // the database, so an episode another instance ended is never masked here.
  if (obs.surface === 'mcp' && known.get(obs.userId) === held) return null;

  if (held) {
    const result = await store.markHeld(obs.userId);
    known.set(obs.userId, true);
    if (!result) return null;
    capture(obs.clerkUserId, 'drive_scope_enabled', {
      reenable: result.reenable,
      surface: obs.surface,
      return_leg: obs.returnLeg === true,
    });
    return 'enabled';
  }

  const ended = await store.markLost(obs.userId);
  known.set(obs.userId, false);
  if (!ended) return null;
  capture(obs.clerkUserId, 'drive_scope_lost', { surface: obs.surface });
  return 'lost';
}
