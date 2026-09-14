/**
 * Out-of-band approval-link delivery: on the FIRST mint of a request, email
 * the link to the account owner's own inbox, sent through the owner's own
 * Gmail grant (the same token every FGAC send already uses). The denial text
 * still carries the link; this is the channel that survives an agent
 * surface that hides or paraphrases the tool result.
 *
 * Invariants:
 *   - ONE email per request id, ever. `claimApprovalNotification` flips
 *     `approval_requests.notified_at` atomically before anything is sent,
 *     so a concurrent mint or a scheduled job re-minting the same request
 *     hourly (observed 2026-09-05 → 09-11) cannot produce a second email.
 *     A send that does not happen releases the claim.
 *   - Owner only. `to` is the key owner's own address and the token is the
 *     owner's own; nothing here can address anyone else, whatever the
 *     denial was about.
 *   - Bounded. Per-owner cap of NOTIFY_MAX_PER_HOUR (a batch of N recipients
 *     in one turn is N requests), and the whole attempt is capped at
 *     NOTIFY_BUDGET_MS so a slow Clerk or Gmail round-trip cannot stall the
 *     denial the agent is waiting on.
 *   - Best-effort. Every failure degrades to "link only", exactly the
 *     response the agent got before this existed. Nothing here throws.
 */
import {
  approvalEmailBody, approvalEmailRaw, approvalEmailSubject, NOTIFY_MAX_PER_HOUR,
  type NotifyLink, type NotifyStatus,
} from './approvalNotifyCopy';
import {
  claimApprovalNotification, countRecentApprovalNotifications, releaseApprovalNotification,
} from './approvalRequests';
import { captureServerEvent } from './posthogServer';
import { withTimeout } from './upstreamTimeouts';

export type { NotifyLink, NotifyStatus } from './approvalNotifyCopy';

/** Whole-attempt ceiling: token fetch + Gmail send. */
const NOTIFY_BUDGET_MS = 6_000;
const GMAIL_SEND_TIMEOUT_MS = 4_000;

/** Flip to disable delivery without a deploy (empty/unset = enabled). */
export function approvalEmailEnabled(): boolean {
  return process.env.APPROVAL_LINK_EMAIL !== 'off';
}

export interface OwnerToken {
  token: string;
  /** `false` when the grant is known to lack the Gmail scope; `undefined` = unknown (try). */
  hasGmailScope?: boolean;
}

export interface NotifyOwnerOpts {
  owner: { id: string; email: string; clerkUserId: string };
  /** Connection nickname or client name, for the email's first line. */
  agentLabel: string;
  /** First entry is the request the claim is made on; the rest ride along. */
  links: NotifyLink[];
  dashboardUrl: string;
  /** The owner's own Google token, or null when it cannot be fetched. */
  fetchOwnerToken: () => Promise<OwnerToken | null>;
  /** Test seam; defaults to the Gmail API. */
  send?: (token: string, raw: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface NotifyOwnerResult {
  status: NotifyStatus;
  /** Set for `sent` and `already_sent`. */
  notifiedAt: Date | null;
  subject: string;
}

async function gmailSendSelf(token: string, raw: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await withTimeout(fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    }), GMAIL_SEND_TIMEOUT_MS);
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
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
    return await withTimeout(attempt(opts, primary, subject), NOTIFY_BUDGET_MS);
  } catch (err) {
    // Budget exceeded (or an unexpected throw): the claim may be held with no
    // email behind it — release it so the next mint can try again.
    console.error('[approvalNotify] attempt aborted:', err instanceof Error ? err.message : err);
    await releaseApprovalNotification(primary.requestId);
    return { status: 'failed', notifiedAt: null, subject };
  }
}

async function attempt(opts: NotifyOwnerOpts, primary: NotifyLink, subject: string): Promise<NotifyOwnerResult> {
  const claim = await claimApprovalNotification(primary.requestId);
  if (!claim.claimed) return { status: 'already_sent', notifiedAt: claim.notifiedAt, subject };

  const release = async (status: NotifyStatus): Promise<NotifyOwnerResult> => {
    await releaseApprovalNotification(primary.requestId);
    return { status, notifiedAt: null, subject };
  };

  // The claim counts toward the cap the moment it is stamped, so ">" not ">=".
  const recent = await countRecentApprovalNotifications(opts.owner.id);
  if (recent > NOTIFY_MAX_PER_HOUR) return release('skipped_rate_capped');

  const grant = await opts.fetchOwnerToken();
  if (!grant) return release('skipped_token_unavailable');
  if (grant.hasGmailScope === false) return release('skipped_no_gmail_scope');

  const body = approvalEmailBody({ agentLabel: opts.agentLabel, links: opts.links, dashboardUrl: opts.dashboardUrl });
  const raw = Buffer.from(approvalEmailRaw({ to: opts.owner.email, subject, body })).toString('base64url');
  const sent = await (opts.send ?? gmailSendSelf)(grant.token, raw);
  if (!sent.ok) {
    console.error('[approvalNotify] Gmail send failed:', sent.error);
    return release('failed');
  }

  captureServerEvent(opts.owner.clerkUserId, 'approval_link_notified', {
    channel: 'email',
    action: primary.action,
    request_id: primary.requestId,
    link_count: opts.links.length,
  });
  return { status: 'sent', notifiedAt: claim.notifiedAt ?? new Date(), subject };
}
