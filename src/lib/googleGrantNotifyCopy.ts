/**
 * Dead-grant owner notice — the pure half. `src/lib/approvalNotify.ts`
 * (`notifyOwnerOfDeadGrant`) decides when to send and sends; this module only
 * builds strings and holds the policy constants, so
 * `scripts/test-google-grant-notify-copy.ts` pins them without a database.
 *
 * The problem (measured in production, 30 d to 2026-09-19): when Clerk can no
 * longer hand FGAC a Google token for a mailbox (`grant_revoked`,
 * `refresh_failed`, `no_token` — src/lib/googleTokenFailure.ts), the ONLY
 * party told is the agent, which gets a 🚫 refusal with a reconnect link bound
 * to the mailbox owner. That works when the owner is the person driving the
 * agent interactively (three owners reconnected within 9 h – 4 d, every one
 * after visiting the dashboard). It does nothing when the owner is not
 * reading the agent's output:
 *   - a scheduled job read a DELEGATED mailbox once a day for 30 days and was
 *     refused every time (zero successes on that mailbox), while the same job's
 *     other mailboxes worked; the mailbox owner — a different person, who is
 *     the only one who can reconnect — was never told;
 *   - two own-mailbox owners each got exactly ONE refusal (the agent stopped),
 *     never opened the dashboard afterwards, and were still dead 48 h later.
 * A "second failure" rule would have emailed neither of those two, so the
 * first non-retryable failure triggers the notice.
 *
 * Third member of the owner-notice family (approval-link reminder, account
 * refusal): same sender (FGAC's support mailbox through FGAC's own proxy API,
 * never a user's grant — 2026-09-15), same transport, same 3-per-owner daily
 * cap across all three ledgers. Every agent-controlled string goes through
 * `sanitizeLine`. Plain text, no HTML.
 */
import { sanitizeLine } from './approvalNotifyCopy';
import type { GoogleTokenFailureReason } from './googleTokenFailure';

/** Reasons the notice covers: the deterministic failures a reconnect repairs
 * (the same set `list_accounts` mints a reconnect link for). */
export type DeadGrantReason = Extract<GoogleTokenFailureReason, 'no_token' | 'refresh_failed' | 'grant_revoked'>;

/** A repeat notice goes out only when the failure is STILL happening this
 * long after the previous notice. The 30-day delegated case argues for
 * weekly: daily denials, owner unreachable through the agent, the delegate
 * paying the refusal every day. */
export const GRANT_DEAD_REPEAT_AFTER_MS = 7 * 24 * 60 * 60_000;

/** Notices per episode (first + repeats). A mailbox nobody reconnects after
 * three weekly emails is a mailbox nobody wants reconnected — the owner has
 * been told, and the daily denial already carries the link for the agent. */
export const GRANT_DEAD_MAX_NOTICES = 3;

/** A failure arriving this long after the previous one on the same mailbox
 * starts a new episode: the grant was repaired in between (or the agent went
 * quiet), so a fresh death gets a fresh first notice. Longer than the repeat
 * interval so a still-failing daily job never resets itself. */
export const GRANT_DEAD_EPISODE_GAP_MS = 14 * 24 * 60 * 60_000;

/** Normalise the mailbox the way access rows compare it (the ledger key). */
export function normalizeAccountEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, 254);
}

/**
 * Pure decision: is a notice due for this ledger row right now? The first
 * notice of an episode is always due; a repeat is due only when the previous
 * notice is at least GRANT_DEAD_REPEAT_AFTER_MS old and the episode is under
 * GRANT_DEAD_MAX_NOTICES. The atomic claim in googleGrantFailures.ts re-checks
 * the same conditions in SQL; this exists so the common "not due" case costs
 * no UPDATE and so the rule is unit-testable without a database.
 */
export function grantNoticeDue(row: { notifiedCount: number; notifiedAt: Date | null }, now: Date): boolean {
  if (row.notifiedCount >= GRANT_DEAD_MAX_NOTICES) return false;
  if (!row.notifiedAt) return true;
  return now.getTime() - row.notifiedAt.getTime() >= GRANT_DEAD_REPEAT_AFTER_MS;
}

export interface DeadGrantNotice {
  /** The mailbox whose grant died — also the owner's FGAC sign-in address. */
  accountEmail: string;
  reason: DeadGrantReason;
  /** True when the refused agent belongs to someone else (a delegate). */
  delegated: boolean;
  /** The key owner whose agent was refused — CC'd on a delegated notice. */
  keyOwnerEmail: string;
  /** Connection nickname or client name (agent-controlled: sanitized). */
  agentLabel: string;
  /** The owner-bound one-click link (`?reconnect=1&for=<owner>`), as minted. */
  reconnectUrl: string;
  /** Refusals in this episode, and when it began. */
  failureCount: number;
  firstFailedAt: Date;
  /** 1 for the first notice of an episode, 2–3 for repeats. */
  noticeNumber: number;
  dashboardUrl: string;
  supportAddress: string;
}

function whenUtc(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Whole days since the episode began, floored; 0 on the first day. */
export function daysDead(firstFailedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - firstFailedAt.getTime()) / 86_400_000));
}

/** What went wrong, in the owner's voice — mirrors the agent-facing text in
 * googleTokenFailure.ts so the two never disagree about the cause. */
export function deadGrantCause(reason: DeadGrantReason): string {
  switch (reason) {
    case 'grant_revoked':
      return 'Google has expired or revoked FGAC\'s access to this account — this happens when FGAC is removed under the Google account\'s third-party access, when the Google password changes, or when a grant ages out.';
    case 'refresh_failed':
      return 'FGAC\'s auth provider can no longer refresh the Google access for this account (the stored grant has no usable refresh token — Google revoked it, or the account was connected without offline access).';
    case 'no_token':
      return 'FGAC holds no Google grant for this account — the Google connection was removed, or it was never completed.';
  }
}

export function deadGrantEmailSubject(notice: Pick<DeadGrantNotice, 'accountEmail' | 'noticeNumber' | 'delegated'>): string {
  const account = sanitizeLine(notice.accountEmail, 80);
  const still = notice.noticeNumber > 1 ? 'still ' : '';
  return sanitizeLine(
    notice.delegated
      ? `Google access to ${account} is ${still}disconnected — an agent you delegated to is being refused`
      : `Google access to ${account} is ${still}disconnected — your agent is being refused`,
    160,
  );
}

/**
 * Plain-text body, addressed to the OWNER. On a delegated notice the key
 * owner is CC'd (they are paying the daily refusal and cannot fix it), so the
 * body also tells them, in one line, what they can and cannot do.
 */
export function deadGrantEmailBody(opts: DeadGrantNotice & { now: Date }): string {
  const agent = sanitizeLine(opts.agentLabel, 80) || 'An AI agent';
  const account = sanitizeLine(opts.accountEmail, 254);
  const keyOwner = sanitizeLine(opts.keyOwnerEmail, 254);
  const base = opts.dashboardUrl.trim().replace(/\/+$/, '');
  const days = daysDead(opts.firstFailedAt, opts.now);
  const times = opts.failureCount === 1 ? 'once' : `${opts.failureCount} times`;
  const since = days === 0
    ? `today (first at ${whenUtc(opts.firstFailedAt)})`
    : `${times} since ${whenUtc(opts.firstFailedAt)} — ${days} day${days === 1 ? '' : 's'} so far`;

  const lines: string[] = [];
  if (opts.delegated) {
    lines.push(
      `${agent}, run by ${keyOwner} under the mailbox access you delegated, has been refused ${since} because FGAC can no longer reach Google on behalf of:`,
    );
  } else {
    lines.push(`${agent} has been refused ${since} because FGAC can no longer reach Google on behalf of:`);
  }
  lines.push('', `    ${account}`, '', deadGrantCause(opts.reason), '');
  lines.push(
    'Every call on this account fails until it is reconnected, and the agent has been told to stop retrying. Only you can repair it — reconnecting takes one click and shows Google\'s consent screen again:',
    opts.reconnectUrl,
    '',
    `Open the link while signed in to FGAC as ${account}; it will not run for any other account.`,
  );
  if (opts.delegated) {
    lines.push(
      '',
      `${keyOwner} (copied on this email): this is the mailbox owner's grant, not yours — nothing on your own Accounts page fixes it. Until ${account} reconnects, every run that touches that mailbox will be refused; your other mailboxes are unaffected.`,
    );
  }
  const remaining = GRANT_DEAD_MAX_NOTICES - opts.noticeNumber;
  lines.push(
    '',
    opts.noticeNumber >= GRANT_DEAD_MAX_NOTICES
      ? 'This is the last email FGAC will send about this account. If you intentionally disconnected it, do nothing — the agent stays refused.'
      : `If you intentionally disconnected it, do nothing — the agent stays refused. FGAC will email you again only if it is still failing in a week (at most ${remaining} more time${remaining === 1 ? '' : 's'}); reply to this email if you would rather we did not.`,
    '',
    `Connected accounts: ${base}/dashboard/accounts`,
    `— FGAC (${opts.supportAddress})`,
  );
  return lines.join('\n');
}

/**
 * The sentence appended to the agent's 🚫 refusal after the notice. Only the
 * two states a human can act on get a line; every other outcome adds nothing
 * (the refusal and its link are exactly what they were before).
 */
export function deadGrantDenialLine(
  status: string,
  opts: { notifiedAt?: Date | null; delegated: boolean; ccDelegate?: boolean },
): string {
  const who = opts.delegated
    ? `the owner of the mailbox${opts.ccDelegate ? ' (and copied this user)' : ''}`
    : 'the user';
  if (status === 'sent') {
    return `📧 FGAC has also emailed ${who} just now with this reconnect link — do not re-ask; if the link here cannot be clicked, tell the user to check their email.`;
  }
  if (status === 'already_sent') {
    const when = opts.notifiedAt ? ` at ${whenUtc(opts.notifiedAt)}` : ' earlier';
    return `📧 FGAC emailed ${who} this reconnect link${when}; no further email is sent while it keeps failing — do not re-ask, tell the user to check their inbox.`;
  }
  return '';
}
