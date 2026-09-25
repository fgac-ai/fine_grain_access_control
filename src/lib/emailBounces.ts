/**
 * Undeliverable-address ledger for the owner notices — the pure half and the
 * SQL helpers. `src/lib/emailBounceSweep.ts` reads the support mailbox and
 * calls `recordBounce`; this module parses DSNs, classifies them, and answers
 * "is this address undeliverable?" for the three notice claims.
 *
 * Why (2026-09-23): the dead-grant owner notice (PR #156) went to an
 * own-mailbox account on a Google Workspace domain two seconds after its first
 * `grant_revoked` refusal, and two seconds after that Google's own MTA
 * returned it — `Action: failed`, `Status: 5.1.3`, "The email account that
 * you tried to reach does not exist". On a Workspace domain that is a deleted
 * mailbox: `grant_revoked` there is not repairable, the reconnect link the
 * agent was told to relay on every refusal was dead, and no owner email could
 * ever land — yet the agent was refused three more times on 09-23 and again
 * on 09-24 with the same dead link, and nothing recorded the bounce. Google's
 * token endpoint answers `invalid_grant` for a revoked grant and a deleted
 * account alike, so the DSN is the only signal that tells them apart.
 *
 * Gmail has no bounce webhook and no suppression list: the DSN the receiving
 * MTA mails back to the envelope sender is the whole signal. FGAC sends from
 * the support address, a send-as alias on the operator mailbox, through its
 * own proxy API with the support profile's key — so the same key reads the
 * DSN back through the same route (FGAC's own consent for FGAC's own mailbox,
 * behind the same policy layer a customer gets; never a user's grant).
 *
 * Suppression is keyed by ADDRESS, not by ledger row: one DSN must silence all
 * three triggers for that person, including approval-link rows that do not
 * exist yet. This is a suppression feature — it adds no outbound email.
 */
import { db } from '@/db';
import { emailBounces, googleGrantFailures, users } from '@/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { normalizeBounceAddress, SUPPRESSING_CLASSES, type BounceClass, type ParsedDsn } from './emailBounceParse';

export {
  classifyBounce, normalizeBounceAddress, parseDsn, SUPPRESSING_CLASSES, type BounceClass, type ParsedDsn,
} from './emailBounceParse';

// ─── SQL helpers used by the notice claims ──────────────────────────────────

/** `EXISTS (…)` — true when a permanent bounce is on file for the address.
 * Embedded in every claim's UPDATE so a bounce recorded between the ledger
 * read and the claim still wins. */
export function recipientUndeliverableSql(address: string) {
  return sql`EXISTS (SELECT 1 FROM ${emailBounces} AS eb
             WHERE eb.address = ${normalizeBounceAddress(address)}
               AND eb.bounce_class IN ('mailbox_gone', 'rejected'))`;
}

export interface UndeliverableMark {
  bounceClass: Extract<BounceClass, 'mailbox_gone' | 'rejected'>;
  dsnStatus: string;
  bouncedAt: Date;
}

/**
 * Batched lookup for list_accounts: which of these addresses carry a
 * permanent bounce, and the most severe / most recent mark for each
 * (`mailbox_gone` outranks `rejected`). Never throws — an empty map means
 * "nothing known", which is the pre-feature behaviour.
 */
export async function lookupUndeliverable(addresses: string[]): Promise<Map<string, UndeliverableMark>> {
  const out = new Map<string, UndeliverableMark>();
  const wanted = [...new Set(addresses.map(normalizeBounceAddress).filter(Boolean))];
  if (wanted.length === 0) return out;
  try {
    const rows = await db.select({
      address: emailBounces.address,
      bounceClass: emailBounces.bounceClass,
      dsnStatus: emailBounces.dsnStatus,
      bouncedAt: emailBounces.bouncedAt,
    })
      .from(emailBounces)
      .where(inArray(emailBounces.address, wanted));
    for (const row of rows) {
      if (row.bounceClass !== 'mailbox_gone' && row.bounceClass !== 'rejected') continue;
      const prev = out.get(row.address);
      const better = !prev
        || (row.bounceClass === 'mailbox_gone' && prev.bounceClass !== 'mailbox_gone')
        || (row.bounceClass === prev.bounceClass && row.bouncedAt > prev.bouncedAt);
      if (better) out.set(row.address, { bounceClass: row.bounceClass, dsnStatus: row.dsnStatus, bouncedAt: row.bouncedAt });
    }
  } catch (err) {
    console.error('[emailBounces] undeliverable lookup failed:', err);
  }
  return out;
}

// ─── Recording (called by the sweep) ────────────────────────────────────────

export interface RecordBounceInput {
  gmailMessageId: string;
  bouncedAt: Date;
  parsed: ParsedDsn;
  bounceClass: BounceClass;
  /** Whether the bounced message was one of FGAC's notices (the sweep
   * decides: echoed notice header, or a recipient a ledger knows). Only an
   * "ours" row keeps its address — whatever the class — so the operator's
   * own correspondence never lands in FGAC's database, not even as a
   * delayed 4.x.x. */
  ours: boolean;
}

export interface RecordBounceResult {
  /** False when the row already existed (idempotent re-sweep). */
  inserted: boolean;
  /** The FGAC user the address resolved to, for the analytics capture. */
  owner: { id: string; clerkUserId: string } | null;
  /** google_grant_failures rows newly marked undeliverable. */
  grantRowsMarked: number;
  /** For `hours_after_send`: the dead-grant notice stamp on the marked row. */
  notifiedAt: Date | null;
}

/**
 * Whose bounce is this? Ours when the echoed original carries the notice
 * header, or when the recipient is an address a notice ledger knows (a
 * `users.email`, or a `google_grant_failures.account_email` — notices sent
 * before the header existed). Returns the owner when one resolves.
 */
export async function resolveNoticeRecipient(address: string): Promise<
  { ours: true; owner: { id: string; clerkUserId: string } | null } | { ours: false }
> {
  const normalized = normalizeBounceAddress(address);
  const [user] = await db.select({ id: users.id, clerkUserId: users.clerkUserId })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);
  if (user) return { ours: true, owner: user };
  const [grant] = await db.select({ id: users.id, clerkUserId: users.clerkUserId })
    .from(googleGrantFailures)
    .innerJoin(users, eq(users.id, googleGrantFailures.userId))
    .where(eq(googleGrantFailures.accountEmail, normalized))
    .limit(1);
  if (grant) return { ours: true, owner: grant };
  return { ours: false };
}

/**
 * Store one DSN — address only when it is ours — and, for a suppressing
 * class, mark every grant-failure row for that mailbox. One row per Gmail message id — a second sweep over the
 * same DSN inserts nothing and marks nothing. Throws on a DB error; the
 * sweep counts it and moves on.
 */
export async function recordBounce(input: RecordBounceInput): Promise<RecordBounceResult> {
  const suppressing = (SUPPRESSING_CLASSES as readonly string[]).includes(input.bounceClass) && input.ours;
  const address = input.ours ? normalizeBounceAddress(input.parsed.recipient) : '';
  const resolved = input.ours ? await resolveNoticeRecipient(address) : { ours: false as const };
  const owner = resolved.ours ? resolved.owner : null;

  const inserted = await db.insert(emailBounces)
    .values({
      address,
      bounceClass: input.bounceClass,
      dsnStatus: input.parsed.status,
      dsnDiagnostic: input.parsed.diagnostic,
      noticeKind: input.parsed.noticeKind ?? 'unknown',
      userId: owner?.id ?? null,
      gmailMessageId: input.gmailMessageId,
      bouncedAt: input.bouncedAt,
    })
    .onConflictDoNothing({ target: emailBounces.gmailMessageId })
    .returning({ id: emailBounces.id });
  if (inserted.length === 0) return { inserted: false, owner, grantRowsMarked: 0, notifiedAt: null };

  let grantRowsMarked = 0;
  let notifiedAt: Date | null = null;
  if (suppressing && address) {
    const marked = await db.update(googleGrantFailures)
      .set({ undeliverableAt: input.bouncedAt, undeliverableClass: input.bounceClass })
      .where(sql`${googleGrantFailures.accountEmail} = ${address} AND ${googleGrantFailures.undeliverableAt} IS NULL`)
      .returning({ notifiedAt: googleGrantFailures.notifiedAt });
    grantRowsMarked = marked.length;
    notifiedAt = marked.find(m => m.notifiedAt)?.notifiedAt ?? null;
  }
  return { inserted: true, owner, grantRowsMarked, notifiedAt };
}
