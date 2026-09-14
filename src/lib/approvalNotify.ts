/**
 * Out-of-band approval-link delivery: on the FIRST mint of a request, email
 * the link to the account owner's own inbox, sent through the owner's own
 * Gmail grant (the same token every FGAC send already uses). The denial text
 * still carries the link; this is the channel that survives an agent
 * surface that hides or paraphrases the tool result.
 *
 * Invariants:
 *   - AT MOST one email per request id. `claimApprovalNotification` flips
 *     `approval_requests.notified_at` atomically — together with the
 *     per-owner hourly cap, in one statement — before anything is sent, so a
 *     concurrent mint or a scheduled job re-minting the same request hourly
 *     (observed 2026-09-05 → 09-11) cannot produce a second email. The claim
 *     is released only on a DEFINITE non-send (Gmail answered with an
 *     error). An ambiguous outcome — timeout, network error — keeps the
 *     claim: a lost email costs a channel the chat link still covers, a
 *     duplicate costs trust.
 *   - Owner only. The message is addressed to the mailbox the token belongs
 *     to (Gmail's own profile, falling back to the ledger address) and the
 *     token is the owner's own; nothing here can address anyone else,
 *     whatever the denial was about.
 *   - Bounded. Per-owner cap of NOTIFY_MAX_PER_HOUR (a batch of N recipients
 *     in one turn is N requests); each upstream call carries its own short
 *     timeout so a slow Clerk or Gmail round-trip cannot stall the denial
 *     the agent is waiting on. Repeat mints cost one SELECT.
 *   - Best-effort. Every failure degrades to "link only", exactly the
 *     response the agent got before this existed. Nothing here throws.
 */
import {
  approvalEmailBody, approvalEmailRaw, approvalEmailSubject, NOTIFY_MAX_PER_HOUR,
  type NotifyLink, type NotifyStatus,
} from './approvalNotifyCopy';
import {
  claimApprovalNotification, getApprovalNotificationState, releaseApprovalNotification,
} from './approvalRequests';
import { captureServerEvent } from './posthogServer';
import { withTimeout } from './upstreamTimeouts';

export type { NotifyLink, NotifyStatus } from './approvalNotifyCopy';

const TOKEN_TIMEOUT_MS = 4_000;
const GMAIL_TIMEOUT_MS = 4_000;

/** Flip to disable delivery without a deploy (empty/unset = enabled). */
export function approvalEmailEnabled(): boolean {
  return process.env.APPROVAL_LINK_EMAIL !== 'off';
}

export interface OwnerToken {
  token: string;
  /** `false` when the grant is known to lack the Gmail scope; `undefined` = unknown (try). */
  hasGmailScope?: boolean;
}

export type SendResult =
  | { ok: true }
  /** `definite`: Gmail answered and refused — nothing went out, safe to release the claim. */
  | { ok: false; definite: boolean; error: string };

export interface NotifyOwnerOpts {
  owner: { id: string; email: string; clerkUserId: string };
  /** Connection nickname or client name, for the email's first line. */
  agentLabel: string;
  /** First entry is the request the claim is made on; the rest ride along. */
  links: NotifyLink[];
  dashboardUrl: string;
  /**
   * The owner's own Google grant when the denied call already resolved it
   * (the target mailbox was the owner's) — saves the Clerk round-trip.
   * `null` = resolution already failed; `undefined` = not known, fetch it.
   */
  ownerGrant?: OwnerToken | null;
  /** Fetches the owner's own Google token; null when it cannot be had. */
  fetchOwnerToken: () => Promise<OwnerToken | null>;
  /** Test seams; default to the Gmail API. */
  send?: (token: string, raw: string) => Promise<SendResult>;
  resolveMailbox?: (token: string) => Promise<string | null>;
}

export interface NotifyOwnerResult {
  status: NotifyStatus;
  /** Set for `sent` and `already_sent`. */
  notifiedAt: Date | null;
  subject: string;
}

async function gmailSendSelf(token: string, raw: string): Promise<SendResult> {
  try {
    const res = await withTimeout(fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    }), GMAIL_TIMEOUT_MS);
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    // A 5xx may have been accepted upstream before the error surfaced; only a
    // 4xx is a refusal we can be sure sent nothing.
    return { ok: false, definite: res.status >= 400 && res.status < 500, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
  } catch (err) {
    return { ok: false, definite: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/**
 * The address the token actually belongs to. `users.email` can lag the
 * Clerk primary (the identity-drift population, self-healing since PR #107),
 * and an approval link must not land in a mailbox the person left behind.
 * Falls back to the ledger address when Gmail does not answer in time.
 */
async function gmailProfileAddress(token: string): Promise<string | null> {
  try {
    const res = await withTimeout(fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` },
    }), GMAIL_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json() as { emailAddress?: string };
    return typeof data.emailAddress === 'string' && data.emailAddress.includes('@') ? data.emailAddress : null;
  } catch {
    return null;
  }
}

/**
 * Email the owner about `links[0]` (plus any alternatives). Returns what
 * happened so the denial text can say so; never throws.
 */
export async function notifyOwnerOfApprovalLinks(opts: NotifyOwnerOpts): Promise<NotifyOwnerResult> {
  const primary = opts.links[0];
  if (!primary) return { status: 'skipped_no_links', notifiedAt: null, subject: '' };
  const subject = approvalEmailSubject(primary);
  if (!approvalEmailEnabled()) return { status: 'disabled', notifiedAt: null, subject };
  try {
    return await attempt(opts, primary, subject);
  } catch (err) {
    console.error('[approvalNotify] attempt failed:', err instanceof Error ? err.message : err);
    return { status: 'failed', notifiedAt: null, subject };
  }
}

async function attempt(opts: NotifyOwnerOpts, primary: NotifyLink, subject: string): Promise<NotifyOwnerResult> {
  // Cheap first: a repeat mint answers from one SELECT, no Clerk, no claim.
  const state = await getApprovalNotificationState(primary.requestId);
  if (state.kind === 'error' || state.kind === 'missing') return { status: 'failed', notifiedAt: null, subject };
  if (state.notifiedAt) return { status: 'already_sent', notifiedAt: state.notifiedAt, subject };

  // Grant before claim: a scope-less owner costs no claim/release churn.
  const grant = opts.ownerGrant !== undefined
    ? opts.ownerGrant
    : await withTimeout(opts.fetchOwnerToken(), TOKEN_TIMEOUT_MS).catch(() => null);
  if (!grant) return { status: 'skipped_token_unavailable', notifiedAt: null, subject };
  if (grant.hasGmailScope === false) return { status: 'skipped_no_gmail_scope', notifiedAt: null, subject };

  // Claim + cap in one statement, before the send.
  const claim = await claimApprovalNotification(primary.requestId, opts.owner.id, NOTIFY_MAX_PER_HOUR);
  if (!claim.claimed) {
    if (claim.reason === 'already') return { status: 'already_sent', notifiedAt: claim.notifiedAt, subject };
    if (claim.reason === 'capped') return { status: 'skipped_rate_capped', notifiedAt: null, subject };
    return { status: 'failed', notifiedAt: null, subject };
  }

  const to = (await (opts.resolveMailbox ?? gmailProfileAddress)(grant.token)) ?? opts.owner.email;
  const body = approvalEmailBody({ agentLabel: opts.agentLabel, links: opts.links, dashboardUrl: opts.dashboardUrl });
  const raw = Buffer.from(approvalEmailRaw({ to, subject, body })).toString('base64url');
  const sent = await (opts.send ?? gmailSendSelf)(grant.token, raw);
  if (!sent.ok) {
    console.error(`[approvalNotify] Gmail send ${sent.definite ? 'refused' : 'unconfirmed'}:`, sent.error);
    if (sent.definite) await releaseApprovalNotification(primary.requestId);
    return { status: 'failed', notifiedAt: null, subject };
  }

  captureServerEvent(opts.owner.clerkUserId, 'approval_link_notified', {
    channel: 'email',
    action: primary.action,
    request_id: primary.requestId,
    link_count: opts.links.length,
  });
  return { status: 'sent', notifiedAt: claim.notifiedAt ?? new Date(), subject };
}
