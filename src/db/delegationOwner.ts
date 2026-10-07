import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { QueryBuilder } from 'drizzle-orm/pg-core';
import { db } from './index';
import { emailDelegations, users } from './schema';

/**
 * The owner of `targetEmail` who has an ACTIVE delegation to
 * `delegateUserId`, or undefined.
 *
 * Starts from the delegation, not from the address: an address can have
 * several live `users` rows (Clerk re-issues ids; every fresh db:branch holds
 * the prod-id rows next to the dev-id row), and picking one row by address
 * first — the old `eq(users.email, target)).limit(1)` — could land on a row
 * that is not the delegation's owner and read a live delegation as inactive
 * (2026-10-05). Tombstoned owners never count; the address match is
 * case-insensitive; if several owner rows delegated, the newest delegation wins.
 */
export async function findActiveDelegationOwner(
  targetEmail: string, delegateUserId: string,
): Promise<{ owner: typeof users.$inferSelect; delegation: typeof emailDelegations.$inferSelect } | undefined> {
  // db.select and QueryBuilder.select build the same query; only db's is
  // executable, so the shared builder is typed on the common shape.
  const query = activeDelegationOwnerQuery(db as unknown as Pick<QueryBuilder, 'select'>, targetEmail, delegateUserId);
  const [row] = await (query as unknown as Promise<Array<{
    owner: typeof users.$inferSelect; delegation: typeof emailDelegations.$inferSelect;
  }>>);
  return row;
}

/** The query behind findActiveDelegationOwner, over any select-capable
 * builder — the test renders it with drizzle's connection-free QueryBuilder. */
export function activeDelegationOwnerQuery(
  qb: Pick<QueryBuilder, 'select'>, targetEmail: string, delegateUserId: string,
) {
  return qb
    .select({ owner: users, delegation: emailDelegations })
    .from(emailDelegations)
    .innerJoin(users, eq(emailDelegations.ownerUserId, users.id))
    .where(and(
      eq(emailDelegations.delegateUserId, delegateUserId),
      eq(emailDelegations.status, 'active'),
      isNull(users.deletedAt),
      sql`lower(${users.email}) = ${targetEmail.toLowerCase()}`,
    ))
    .orderBy(desc(emailDelegations.createdAt))
    .limit(1);
}
