/**
 * Per-owner serialization for the owner-notice claims (approval-link
 * reminder, account-refusal notice, dead-grant notice — src/lib/approvalNotify.ts).
 *
 * Each claim is one UPDATE that flips a ledger row's `notified_at` and, in the
 * same WHERE, checks predicates over OTHER rows of the same owner: the shared
 * 3-per-day cap (`recentNotificationCountSql`, three ledgers), the 14-day
 * refusal episode (`ownerEpisodeNotifiedSql`), the same-turn link burst, and
 * the dead-grant global hourly breaker. The per-row flip is atomic, but under
 * READ COMMITTED a statement evaluates those subqueries against its own
 * snapshot, taken when it starts — so two claims on two different rows of one
 * owner, started within the same few milliseconds, each see the other's row
 * un-stamped, both pass, and both send. Production (2026-09-17 and 09-21): two
 * owners each got two emails 108 ms / 271 ms apart, from two rows minted or
 * refused in one agent turn. The cap itself never broke (audit of every stamp
 * ever: no rolling-24 h window above 3), because both claims had headroom;
 * the cross-row rules that decide "one email per event" are what raced.
 *
 * The fix: every claim runs inside one transaction that FIRST takes a
 * transaction-scoped advisory lock keyed on the owner, THEN runs the UPDATE.
 * The lock serializes the owner's claims; because each statement in a READ
 * COMMITTED transaction takes a fresh snapshot, the UPDATE that waited sees
 * the row the earlier claim stamped and committed. The dead-grant claim also
 * takes a global lock (always AFTER the owner lock, so lock order is fixed and
 * no two claims can deadlock) for its breaker across all owners.
 *
 * The neon-http driver has no interactive transactions, but its batch form
 * (`db.batch`, one HTTP round trip) runs the statements in order inside one
 * transaction — verified on a Neon branch 2026-09-24: two concurrent batches
 * taking the same lock finished 1 s apart with a 1 s `pg_sleep` inside, and
 * `txid_current()` matched across a batch's statements.
 *
 * Cost: one extra statement per claim, and claims are rare (a claim is
 * attempted only once a notice is due — a few a day in production). Lock
 * keys: (`NOTIFY_LOCK_NAMESPACE`, `hashtext(user_id)`) — a hash collision
 * between two owners only serializes them needlessly, never lets one through.
 */
import { db } from '@/db';
import { sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';

/** int4 key-space for the owner-notice locks — arbitrary, but fixed so every
 * claim path agrees on it. Owners hash into the second key; the global
 * breaker lock uses 0 there, which no owner can (hashtext of a uuid string
 * is never reserved — a collision with 0 merely serializes that owner with
 * the breaker). */
export const NOTIFY_LOCK_NAMESPACE = 7311;

export function ownerNoticeLockSql(userId: string) {
  return sql`SELECT pg_advisory_xact_lock(${NOTIFY_LOCK_NAMESPACE}, hashtext(${userId}))`;
}

export function globalNoticeLockSql() {
  return sql`SELECT pg_advisory_xact_lock(${NOTIFY_LOCK_NAMESPACE}, 0)`;
}

/**
 * Run `claim` (an UPDATE … RETURNING built with the query builder) inside one
 * transaction, after taking the owner's advisory lock — and the global lock
 * too when `global` is set (owner first, then global: fixed order). Resolves
 * to the claim's own result (its returned rows). Throws what the driver
 * throws; callers already treat any error as `reason: 'error'`.
 */
export async function claimSerialized<T extends BatchItem<'pg'>>(
  userId: string,
  claim: T,
  opts: { global?: boolean } = {},
): Promise<Awaited<T>> {
  const locks: BatchItem<'pg'>[] = [db.execute(ownerNoticeLockSql(userId))];
  if (opts.global) locks.push(db.execute(globalNoticeLockSql()));
  const results = await db.batch([locks[0], ...locks.slice(1), claim] as unknown as readonly [BatchItem<'pg'>, ...BatchItem<'pg'>[]]);
  return results[results.length - 1] as Awaited<T>;
}
