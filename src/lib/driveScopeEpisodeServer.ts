import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { users, proxyKeys } from '@/db/schema';
import { captureServerEvent, captureServerError } from '@/lib/posthogServer';
import { observeDriveFullScope, type DriveScopeObservation, type DriveScopeStore } from '@/lib/driveScopeEpisode';

const store: DriveScopeStore = {
  async markHeld(userId) {
    const won = await db.update(users)
      .set({ driveFullScopeSince: new Date() })
      .where(and(eq(users.id, userId), isNull(users.driveFullScopeSince)))
      .returning({ id: users.id });
    if (won.length === 0) return null;
    // A profile with a saved Drive default used the tree model in an earlier
    // episode — this grant is a RE-enable. Then record every active profile
    // as on the tree model (the value 'read' is what NULL already means), so
    // a later loss of the scope is reported as "re-enable", not as a silent
    // fallback to per-file access. This is the write the browser used to make
    // on the return leg, which never ran for the same reason the event didn't.
    const configured = await db.select({ id: proxyKeys.id }).from(proxyKeys)
      .where(and(eq(proxyKeys.userId, userId), isNull(proxyKeys.revokedAt), isNotNull(proxyKeys.driveDefault)))
      .limit(1);
    await db.update(proxyKeys)
      .set({ driveDefault: 'read' })
      .where(and(eq(proxyKeys.userId, userId), isNull(proxyKeys.revokedAt), isNull(proxyKeys.driveDefault)));
    return { reenable: configured.length > 0 };
  },
  async markLost(userId) {
    const ended = await db.update(users)
      .set({ driveFullScopeSince: null })
      .where(and(eq(users.id, userId), isNotNull(users.driveFullScopeSince)))
      .returning({ id: users.id });
    return ended.length > 0;
  },
};

/**
 * Server entry point (dashboard render, MCP tool path). Never throws: the
 * analytics marker must not break the page or the tool call it rides on.
 */
export async function recordDriveScopeObservation(obs: DriveScopeObservation): Promise<void> {
  try {
    await observeDriveFullScope(obs, store, captureServerEvent);
  } catch (err) {
    captureServerError(obs.clerkUserId, 'drive_scope_episode', err);
  }
}
