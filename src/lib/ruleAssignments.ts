/**
 * Key↔rule assignment loading, scoped to one owner.
 *
 * A rule with no assignment rows is "global" (applies to every key the owner
 * has); a rule with rows applies only to the keys named. Every enforcement path
 * needs that distinction, and for a long time each one answered it by reading
 * the WHOLE `key_rule_assignments` table — every owner's rows — on every
 * request, then looking up only the caller's own rule ids in the result.
 *
 * That was correct but paid for the entire table in database egress per
 * request: by November 2026 roughly 200–300 KB per REST proxy call and rising
 * with table size (Neon transfer went 7 GB → 69 GB → 80 GB in half a month as
 * temporary-key traffic grew). Callers only ever look up rule ids that belong
 * to the owner, so restricting the read to the owner's rules returns exactly
 * the rows they used.
 *
 * `scripts/test-rule-assignment-reads.ts` fails the lint when an unfiltered
 * `from(keyRuleAssignments)` read reappears anywhere in `src/`.
 */
import { db } from '@/db';
import { accessRules, keyRuleAssignments } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';

/** Every assignment row for rules owned by `userId` (all of that owner's keys). */
export function loadRuleAssignmentsForUser(userId: string) {
  return db
    .select()
    .from(keyRuleAssignments)
    .where(inArray(
      keyRuleAssignments.accessRuleId,
      db.select({ id: accessRules.id }).from(accessRules).where(eq(accessRules.userId, userId)),
    ));
}
