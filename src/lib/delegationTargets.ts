/**
 * Server-side reads behind the second-account prompts (src/lib/secondAccount.ts
 * has the pure rules and the why). Every function here is best-effort and
 * read-only: a prompt that cannot be resolved renders nothing, never an error.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { users } from '@/db/schema';
import { findActiveDelegation } from '@/db/delegationQueries';
import { maskEmail } from '@/lib/maskEmail';

export interface DelegationTarget {
  /** users.id of the account that would RECEIVE the mailbox. */
  userId: string;
  clerkUserId: string;
  email: string;
  maskedEmail: string;
  createdAt: Date;
}

/** The live account behind a `delegate_to` target (users.id). */
export async function delegationTargetById(userId: string): Promise<DelegationTarget | null> {
  try {
    const row = await db.select({ id: users.id, clerkUserId: users.clerkUserId, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1).then(r => r[0]);
    return row ? toTarget(row) : null;
  } catch (err) {
    console.error('[delegationTargets] lookup by id failed:', err);
    return null;
  }
}

/** The live account behind a second-account marker (Clerk user id). Newest
 *  row wins when Clerk re-issued ids for one address (delegationQueries.ts). */
export async function delegationTargetByClerkId(clerkUserId: string): Promise<DelegationTarget | null> {
  try {
    const row = await db.select({ id: users.id, clerkUserId: users.clerkUserId, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.clerkUserId, clerkUserId), isNull(users.deletedAt)))
      .orderBy(desc(users.createdAt))
      .limit(1).then(r => r[0]);
    return row ? toTarget(row) : null;
  } catch (err) {
    console.error('[delegationTargets] lookup by clerk id failed:', err);
    return null;
  }
}

/** Whether `ownerEmail`'s mailbox is already delegated to `delegateEmail`. */
export async function delegationAlreadyActive(ownerEmail: string, delegateEmail: string): Promise<boolean> {
  try {
    return (await findActiveDelegation(ownerEmail, delegateEmail)) !== null;
  } catch (err) {
    console.error('[delegationTargets] active check failed:', err);
    return false;
  }
}

/** Whole seconds since an account was created — a prop on the prompt events
 *  (computed here so page renders stay free of clock reads). */
export function accountAgeSeconds(createdAt: Date, nowMs = Date.now()): number {
  return Math.max(0, Math.round((nowMs - createdAt.getTime()) / 1000));
}

function toTarget(row: { id: string; clerkUserId: string; email: string; createdAt: Date }): DelegationTarget {
  return { userId: row.id, clerkUserId: row.clerkUserId, email: row.email, maskedEmail: maskEmail(row.email), createdAt: row.createdAt };
}
