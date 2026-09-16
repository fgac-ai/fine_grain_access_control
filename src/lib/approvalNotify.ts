/**
 * Out-of-band approval-link delivery: when an agent asks for the SAME
 * approval link again and the person has still not opened it, email the
 * link from FGAC's own support mailbox. The denial text still carries the
 * link; this is the channel that survives an agent surface that hides or
 * paraphrases the tool result.
 *
 * Invariants:
 *   - FGAC's own credentials only. The message is sent through the support
 *     mailbox's SMTP app password (`SUPPORT_SMTP_USER` /
 *     `SUPPORT_SMTP_APP_PASSWORD`). Nothing here touches a user's Google
 *     grant — that grant is for their agent acting at their direction, and
 *     an FGAC-initiated send through it was rejected on 2026-09-15.
 *   - Due only on a repeat: the request must have been minted before, the
 *     current mint must be at least NOTIFY_MIN_GAP_MS after the first, and
 *     the approve page must never have been opened for it.
 *   - AT MOST one email per request id, and at most NOTIFY_MAX_PER_DAY per
 *     person per rolling 24 h. `claimApprovalNotification` flips
 *     `approval_requests.notified_at` atomically — cap included in the same
 *     statement — before anything is sent, so a concurrent mint or a job
 *     re-minting hourly cannot produce a second email and parallel claims
 *     cannot each pass a separate count. The claim is released only on a
 *     DEFINITE non-send (the server refused the message); an ambiguous
 *     outcome — timeout, dropped connection — keeps it, because a lost
 *     email costs a channel the chat link still covers while a duplicate
 *     costs trust.
 *   - Best-effort. Every failure degrades to "link only", exactly the
 *     response the agent got before this existed. Nothing here throws, and
 *     a non-due mint costs one SELECT.
 */
import nodemailer from 'nodemailer';
import {
  approvalEmailBody, approvalEmailSubject, NOTIFY_MAX_PER_DAY, NOTIFY_MIN_GAP_MS,
  type NotifyLink, type NotifyStatus,
} from './approvalNotifyCopy';
import {
  claimApprovalNotification, getApprovalNotificationState, releaseApprovalNotification,
} from './approvalRequests';
import { captureServerEvent } from './posthogServer';
import { withTimeout } from './upstreamTimeouts';

export type { NotifyLink, NotifyStatus } from './approvalNotifyCopy';

const SMTP_TIMEOUT_MS = 8_000;

export interface SenderConfig {
  /** The mailbox the message is sent from and replies go to. */
  address: string;
  appPassword: string;
  /** SMTP relay; Gmail's by default. QA points this at a capture server. */
  host: string;
  port: number;
}

/**
 * Sender credentials from the environment; null = the feature is off (no
 * claim, no email, denial text unchanged). `APPROVAL_LINK_EMAIL=off` is the
 * explicit kill switch.
 */
export function senderConfig(env: Record<string, string | undefined> = process.env): SenderConfig | null {
  if (env.APPROVAL_LINK_EMAIL === 'off') return null;
  const address = env.SUPPORT_SMTP_USER?.trim();
  const appPassword = env.SUPPORT_SMTP_APP_PASSWORD?.trim();
  if (!address || !appPassword || !address.includes('@')) return null;
  const host = env.SUPPORT_SMTP_HOST?.trim() || 'smtp.gmail.com';
  const port = Number(env.SUPPORT_SMTP_PORT) || 465;
  return { address, appPassword, host, port };
}

export type SendResult =
  | { ok: true }
  /** `definite`: the server answered and refused — nothing went out, safe to release the claim. */
  | { ok: false; definite: boolean; error: string };

export interface NotifyOwnerOpts {
  owner: { id: string; email: string; clerkUserId: string };
  /** Connection nickname or client name, for the email's first line. */
  agentLabel: string;
  /** First entry is the request the claim is made on; the rest ride along. */
  links: NotifyLink[];
  dashboardUrl: string;
  /** Test seams. */
  sender?: SenderConfig | null;
  send?: (cfg: SenderConfig, msg: { to: string; subject: string; text: string }) => Promise<SendResult>;
  now?: () => Date;
}

export interface NotifyOwnerResult {
  status: NotifyStatus;
  /** Set for `sent` and `already_sent`. */
  notifiedAt: Date | null;
}

async function smtpSend(cfg: SenderConfig, msg: { to: string; subject: string; text: string }): Promise<SendResult> {
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.port === 465,
      auth: { user: cfg.address, pass: cfg.appPassword },
      connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS,
    });
    await withTimeout(transport.sendMail({
      from: { name: 'FGAC', address: cfg.address },
      replyTo: cfg.address,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    }), SMTP_TIMEOUT_MS + 2_000);
    return { ok: true };
  } catch (err) {
    // nodemailer surfaces an SMTP refusal with a responseCode; anything else
    // (timeout, socket drop, DNS) may or may not have gone out.
    const code = (err as { responseCode?: number })?.responseCode;
    const definite = typeof code === 'number' && code >= 400;
    return { ok: false, definite, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/**
 * Consider emailing the owner about `links[0]` (plus any alternatives) on
 * this mint. Returns what happened so the denial text can say so; never
 * throws.
 */
export async function notifyOwnerOfApprovalLinks(opts: NotifyOwnerOpts): Promise<NotifyOwnerResult> {
  const primary = opts.links[0];
  if (!primary) return { status: 'skipped_no_links', notifiedAt: null };
  const sender = opts.sender === undefined ? senderConfig() : opts.sender;
  if (!sender) return { status: 'disabled', notifiedAt: null };
  try {
    return await attempt(opts, primary, sender);
  } catch (err) {
    console.error('[approvalNotify] attempt failed:', err instanceof Error ? err.message : err);
    return { status: 'failed', notifiedAt: null };
  }
}

async function attempt(opts: NotifyOwnerOpts, primary: NotifyLink, sender: SenderConfig): Promise<NotifyOwnerResult> {
  const now = (opts.now ?? (() => new Date()))();
  const state = await getApprovalNotificationState(primary.requestId);
  if (state.kind !== 'row') return { status: 'failed', notifiedAt: null };
  if (state.notifiedAt) return { status: 'already_sent', notifiedAt: state.notifiedAt };
  if (state.openedAt) return { status: 'skipped_opened', notifiedAt: null };
  // Due = a repeat, and not the same agent turn as the first ask.
  if (state.mintCount < 2 || now.getTime() - state.firstMintedAt.getTime() < NOTIFY_MIN_GAP_MS) {
    return { status: 'not_due', notifiedAt: null };
  }

  const claim = await claimApprovalNotification(primary.requestId, opts.owner.id, NOTIFY_MAX_PER_DAY);
  if (!claim.claimed) {
    if (claim.reason === 'already') return { status: 'already_sent', notifiedAt: claim.notifiedAt };
    if (claim.reason === 'capped') return { status: 'skipped_rate_capped', notifiedAt: null };
    return { status: 'failed', notifiedAt: null };
  }

  const subject = approvalEmailSubject(primary, state.mintCount);
  const text = approvalEmailBody({
    agentLabel: opts.agentLabel, links: opts.links, times: state.mintCount, firstAskedAt: state.firstMintedAt,
    dashboardUrl: opts.dashboardUrl, supportAddress: sender.address,
  });
  const sent = await (opts.send ?? smtpSend)(sender, { to: opts.owner.email, subject, text });
  if (!sent.ok) {
    console.error(`[approvalNotify] send ${sent.definite ? 'refused' : 'unconfirmed'}:`, sent.error);
    if (sent.definite) await releaseApprovalNotification(primary.requestId);
    return { status: 'failed', notifiedAt: null };
  }

  captureServerEvent(opts.owner.clerkUserId, 'approval_link_notified', {
    channel: 'email',
    trigger: 'repeat_mint',
    action: primary.action,
    request_id: primary.requestId,
    link_count: opts.links.length,
    mint_count: state.mintCount,
    hours_since_first_mint: Math.round((now.getTime() - state.firstMintedAt.getTime()) / 36_000) / 100,
  });
  return { status: 'sent', notifiedAt: claim.notifiedAt ?? now };
}
