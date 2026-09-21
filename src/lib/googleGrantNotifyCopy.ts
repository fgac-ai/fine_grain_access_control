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
 * cap across all three ledgers, plus a global hourly circuit breaker of its
 * own. One email per episode. Every agent-controlled string goes through
 * `sanitizeLine`. Plain text, no HTML.
 */
import { sanitizeLine } from './approvalNotifyCopy';
import type { GoogleTokenFailureReason } from './googleTokenFailure';

/** Reasons the notice covers: the deterministic failures a reconnect repairs
 * (the same set `list_accounts` mints a reconnect link for). */
export type DeadGrantReason = Extract<GoogleTokenFailureReason, 'no_token' | 'refresh_failed' | 'grant_revoked'>;

/** ONE notice per episode (Ken, 2026-09-21: "I don't want to email someone 3
 * times for an event that occurred once"). The refusal itself recurs on every
 * agent call, but the owner is told once; the delegate is CC'd on a delegated
 * mailbox and can nudge the owner directly, and the dashboard card says
 * "Reconnect Google" for anyone who logs in. A repaired grant that dies again
 * after GRANT_DEAD_EPISODE_GAP_MS is a new episode and gets a new notice. */
export const GRANT_DEAD_NOTICES_PER_EPISODE = 1;

/** A failure arriving this long after the previous one on the same mailbox
 * starts a new episode: the grant was repaired in between (or the agent went
 * quiet), so a fresh death gets a fresh notice. A still-failing daily job
 * never resets itself. */
export const GRANT_DEAD_EPISODE_GAP_MS = 14 * 24 * 60 * 60_000;

/** Circuit breaker across ALL owners: notices per rolling hour, enforced
 * inside the claim. The dead-grant classes are deterministic by Clerk error
 * code, so an auth-provider or Google token-endpoint incident would classify
 * every account as revoked at once and, without this, send one email per user
 * in minutes. Ten an hour is far above the organic rate (30 d to 2026-09-19:
 * five own-mailbox owners and one delegated mailbox in total) and low enough
 * that an incident sends a handful, not hundreds; the skipped refusals stamp
 * `notify_status: 'skipped_global_capped'` so monitoring.md 7.29 sees it. */
export const GRANT_DEAD_GLOBAL_HOURLY_MAX = 10;

/** Normalise the mailbox the way access rows compare it (the ledger key). */
export function normalizeAccountEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, 254);
}

/**
 * Pure decision: is a notice due for this ledger row right now? Exactly one
 * per episode — due while the episode has not been notified. The atomic claim
 * in googleGrantFailures.ts re-checks this in SQL together with the caps; this
 * exists so the steady state of a still-dead mailbox (`already_sent` on every
 * later refusal) costs no UPDATE, and so the rule is unit-testable.
 */
export function grantNoticeDue(row: { notifiedCount: number; notifiedAt: Date | null }): boolean {
  return row.notifiedAt === null && row.notifiedCount < GRANT_DEAD_NOTICES_PER_EPISODE;
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

export function deadGrantEmailSubject(notice: Pick<DeadGrantNotice, 'accountEmail' | 'delegated'>): string {
  const account = sanitizeLine(notice.accountEmail, 80);
  return sanitizeLine(
    notice.delegated
      ? `Google access to ${account} is disconnected — an agent you delegated to is being refused`
      : `Google access to ${account} is disconnected — your agent is being refused`,
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
  lines.push(
    '',
    'This is the only email FGAC will send about this account unless it is repaired and disconnects again. If you intentionally disconnected it, do nothing — the agent stays refused. Reply to this email if you need a hand.',
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
