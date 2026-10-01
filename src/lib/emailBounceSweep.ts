/**
 * The bounce sweep: read the support mailbox's DSNs through FGAC's own proxy
 * API and file each one on the bounce ledger (src/lib/emailBounces.ts).
 * Run hourly by `src/app/api/cron/sweep-bounces/route.ts`.
 *
 * Credential: the support profile's proxy key — the SAME key every owner
 * notice is sent with (`senderConfig` / `proxyGet` in approvalNotify.ts).
 * The support address is a send-as alias on the operator mailbox, so the DSN
 * Gmail mails back to the envelope sender lands in exactly the mailbox that
 * key reads as `users/me`. This is FGAC reading FGAC's own mailbox, behind
 * the same policy layer a customer gets; no user's grant is involved. The
 * sweep reads ONLY delivery-status messages (`from:mailer-daemon` /
 * `from:postmaster`), keeps only the delivery-status fields and the echoed
 * notice header, and never logs a body or a recipient.
 *
 * Every DSN listed gets exactly one ledger row (idempotent on the Gmail
 * message id), including the ones that suppress nothing (`transient`,
 * `unmatched`) — so a DSN is fetched once, ever. Best-effort throughout: one
 * bad message is counted and skipped, never fatal.
 */
import { proxyGet, senderConfig, type SenderConfig } from './approvalNotify';
import {
  classifyBounce, parseDsn, recordBounce, resolveNoticeRecipient, type BounceClass,
} from './emailBounces';
import { db } from '@/db';
import { emailBounces } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { captureServerEvent } from './posthogServer';

const GMAIL_MESSAGES_PATH = ['gmail', 'v1', 'users', 'me', 'messages'];
/** Gmail search for delivery-status reports. `newer_than` bounds the backfill. */
export const BOUNCE_QUERY = '(from:mailer-daemon OR from:postmaster) newer_than:30d';
const MAX_PER_SWEEP = 50;

export interface SweepResult {
  status: 'ok' | 'disabled' | 'failed';
  /** DSNs the search returned. */
  listed: number;
  /** Of those, not yet on the ledger. */
  fresh: number;
  /** Fresh DSNs filed by class. */
  recorded: Record<BounceClass, number>;
  /** Fresh DSNs that could not be fetched or parsed as a DSN at all. */
  failed: number;
  error?: string;
}

export interface SweepOpts {
  sender?: SenderConfig | null;
  /** Test seam: the proxy reader. */
  get?: typeof proxyGet;
  now?: () => Date;
}

function emptyCounts(): Record<BounceClass, number> {
  return { mailbox_gone: 0, rejected: 0, transient: 0, unmatched: 0 };
}

function decodeRaw(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try { return Buffer.from(value, 'base64url').toString('utf8'); } catch { return null; }
}

export async function sweepBounces(opts: SweepOpts = {}): Promise<SweepResult> {
  const sender = opts.sender === undefined ? senderConfig() : opts.sender;
  const result: SweepResult = { status: 'ok', listed: 0, fresh: 0, recorded: emptyCounts(), failed: 0 };
  if (!sender) return { ...result, status: 'disabled' };
  const get = opts.get ?? proxyGet;
  const now = (opts.now ?? (() => new Date()))();

  const listed = await get(sender, GMAIL_MESSAGES_PATH, { q: BOUNCE_QUERY, maxResults: String(MAX_PER_SWEEP) });
  if (!listed.ok) {
    console.error('[emailBounceSweep] list failed:', listed.error);
    return { ...result, status: 'failed', error: listed.error };
  }
  const messages = (listed.json as { messages?: Array<{ id?: unknown }> } | null)?.messages ?? [];
  const ids = messages.map(m => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
  result.listed = ids.length;
  if (ids.length === 0) return result;

  let known = new Set<string>();
  try {
    const rows = await db.select({ id: emailBounces.gmailMessageId }).from(emailBounces).where(inArray(emailBounces.gmailMessageId, ids));
    known = new Set(rows.map(r => r.id));
  } catch (err) {
    console.error('[emailBounceSweep] ledger read failed:', err);
    return { ...result, status: 'failed', error: 'ledger read failed' };
  }
  const fresh = ids.filter(id => !known.has(id));
  result.fresh = fresh.length;

  for (const id of fresh) {
    try {
      const got = await get(sender, [...GMAIL_MESSAGES_PATH, id], { format: 'raw' });
      if (!got.ok) { result.failed++; console.error('[emailBounceSweep] fetch failed:', got.error); continue; }
      const msg = got.json as { raw?: unknown; internalDate?: unknown } | null;
      const raw = decodeRaw(msg?.raw);
      const parsed = raw ? parseDsn(raw) : null;
      if (!parsed) { result.failed++; continue; }
      const internal = typeof msg?.internalDate === 'string' ? Number(msg.internalDate) : NaN;
      const bouncedAt = Number.isFinite(internal) ? new Date(internal) : now;

      let bounceClass = classifyBounce(parsed.action, parsed.status) ?? 'transient';
      // Ours? The echoed notice header settles it; otherwise the recipient
      // must be an address a notice ledger knows. Anything else is the
      // operator's own correspondence: a permanent one is filed `unmatched`,
      // and NO class keeps its address (QA 2026-09-25 found 4.x.x rows of
      // the operator's own mail carrying the recipient).
      const ours = parsed.noticeKind !== null || (await resolveNoticeRecipient(parsed.recipient)).ours;
      if (!ours && (bounceClass === 'mailbox_gone' || bounceClass === 'rejected')) bounceClass = 'unmatched';
      const recorded = await recordBounce({ gmailMessageId: id, bouncedAt, parsed, bounceClass, ours });
      if (!recorded.inserted) continue;
      result.recorded[bounceClass]++;
      if ((bounceClass === 'mailbox_gone' || bounceClass === 'rejected') && recorded.owner) {
        const hoursAfterSend = recorded.notifiedAt
          ? Math.round((bouncedAt.getTime() - recorded.notifiedAt.getTime()) / 36_000) / 100
          : undefined;
        captureServerEvent(recorded.owner.clerkUserId, 'notice_bounce_recorded', {
          notice_kind: parsed.noticeKind ?? 'unknown',
          bounce_class: bounceClass,
          dsn_status: parsed.status,
          grant_rows_marked: recorded.grantRowsMarked,
          ...(hoursAfterSend !== undefined ? { hours_after_send: hoursAfterSend } : {}),
        });
      }
      console.log(`[emailBounceSweep] filed ${bounceClass} ${parsed.status} (${parsed.noticeKind ?? 'no header'}), grant rows marked: ${recorded.grantRowsMarked}`);
    } catch (err) {
      result.failed++;
      console.error('[emailBounceSweep] message failed:', err instanceof Error ? err.message : err);
    }
  }
  return result;
}
