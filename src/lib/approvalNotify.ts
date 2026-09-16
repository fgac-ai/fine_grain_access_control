/**
 * Out-of-band approval-link delivery: when an agent asks for the SAME
 * approval link again and the person has still not opened it, email the
 * link from FGAC's own support mailbox — through FGAC itself. The denial
 * text still carries the link; this is the channel that survives an agent
 * surface that hides or paraphrases the tool result.
 *
 * Invariants:
 *   - FGAC's own account, through FGAC's own product. The support mailbox
 *     is a normal FGAC user with a proxy key on a profile that allows
 *     sending; the reminder is a `gmail/v1/users/me/messages/send` call to
 *     FGAC's proxy API with that key (`SUPPORT_FGAC_PROXY_KEY`), invoked
 *     in-process — same auth, same send-whitelist enforcement, same
 *     `proxy_request` analytics as any customer call. Nothing here touches
 *     a USER's Google grant: that grant is for their agent acting at their
 *     direction, and an FGAC-initiated send through it was rejected on
 *     2026-09-15.
 *   - Due only on a repeat: the request must have been minted before, the
 *     current mint must be at least NOTIFY_MIN_GAP_MS after the first, and
 *     the approve page must never have been opened for it.
 *   - AT MOST one email per request id, and at most NOTIFY_MAX_PER_DAY per
 *     person per rolling 24 h. `claimApprovalNotification` flips
 *     `approval_requests.notified_at` atomically — cap included in the same
 *     statement — before anything is sent, so a concurrent mint or a job
 *     re-minting hourly cannot produce a second email and parallel claims
 *     cannot each pass a separate count. The claim is released only on a
 *     DEFINITE non-send (FGAC or Google refused the message with a 4xx); an
 *     ambiguous outcome — timeout, 5xx — keeps it, because a lost email
 *     costs a channel the chat link still covers while a duplicate costs
 *     trust.
 *   - Best-effort. Every failure degrades to "link only", exactly the
 *     response the agent got before this existed. Nothing here throws, and
 *     a non-due mint costs one SELECT.
 *
 * Second trigger (plan v4, 2026-09-16) — `notifyOwnerOfAccountRefusal`: the
 * caller-chosen `account_not_permitted` refusal mints no link, so the
 * repeat-mint rule above can never fire for it; a scheduled job was refused
 * 53 times in 6 days that way with its owner off the dashboard. The
 * ACCOUNT_REFUSAL_NOTIFY_AFTER-th refusal of the same value on one key in
 * 24 h emails the owner once (ever, per key + value) from the same sender,
 * under the same per-person daily cap (both ledgers count), naming the value
 * the task passes and the accounts that would work.
 */
import { NextRequest } from 'next/server';
import { POST as proxyPost } from '@/app/api/proxy/[...path]/route';
import {
  accountRefusalEmailBody, accountRefusalEmailSubject, ACCOUNT_REFUSAL_NOTIFY_AFTER,
  approvalEmailBody, approvalEmailRaw, approvalEmailSubject, NOTIFY_MAX_PER_DAY, NOTIFY_MIN_GAP_MS,
  type NotifyLink, type NotifyStatus,
} from './approvalNotifyCopy';
import {
  claimAccountRefusalNotification, recordAccountRefusal, releaseAccountRefusalNotification,
} from './accountRefusals';
import {
  claimApprovalNotification, getApprovalNotificationState, releaseApprovalNotification,
} from './approvalRequests';
import { captureServerEvent } from './posthogServer';
import { withTimeout } from './upstreamTimeouts';

export type { NotifyLink, NotifyStatus } from './approvalNotifyCopy';

const SEND_TIMEOUT_MS = 10_000;
const GMAIL_SEND_PATH = ['gmail', 'v1', 'users', 'me', 'messages', 'send'];

export interface SenderConfig {
  /** The FGAC proxy key (`sk_proxy_…`) of the support mailbox's profile. */
  proxyKey: string;
  /** The mailbox that key sends from; also the Reply-To. */
  address: string;
}

/**
 * Sender from the environment; null = the feature is off (no claim, no
 * email, denial text unchanged). `APPROVAL_LINK_EMAIL=off` is the explicit
 * kill switch.
 */
export function senderConfig(env: Record<string, string | undefined> = process.env): SenderConfig | null {
  if (env.APPROVAL_LINK_EMAIL === 'off') return null;
  const proxyKey = env.SUPPORT_FGAC_PROXY_KEY?.trim();
  const address = env.SUPPORT_SENDER_EMAIL?.trim();
  if (!proxyKey || !address || !address.includes('@')) return null;
  return { proxyKey, address };
}

export type SendResult =
  | { ok: true }
  /** `definite`: FGAC or Google refused with a 4xx — nothing went out, safe to release the claim. */
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
  send?: (cfg: SenderConfig, raw: string) => Promise<SendResult>;
  now?: () => Date;
}

export interface NotifyOwnerResult {
  status: NotifyStatus;
  /** Set for `sent` and `already_sent`. */
  notifiedAt: Date | null;
}

/**
 * The send, as a customer would make it: a proxy-API request with the
 * support profile's key, handled by the proxy route in-process (it reads
 * only the request and its path params, so no network hop and no dependence
 * on the deployment's public URL — which on previews points at production).
 */
async function proxySend(cfg: SenderConfig, raw: string): Promise<SendResult> {
  try {
    const req = new NextRequest(`http://fgac.internal/api/proxy/${GMAIL_SEND_PATH.join('/')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.proxyKey}`, 'Content-Type': 'application/json', 'User-Agent': 'fgac-approval-reminder' },
      body: JSON.stringify({ raw }),
    });
    const res = await withTimeout(proxyPost(req, { params: Promise.resolve({ path: GMAIL_SEND_PATH }) }), SEND_TIMEOUT_MS);
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, definite: res.status >= 400 && res.status < 500, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
  } catch (err) {
    return { ok: false, definite: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
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
  const body = approvalEmailBody({
    agentLabel: opts.agentLabel, links: opts.links, times: state.mintCount, firstAskedAt: state.firstMintedAt,
    dashboardUrl: opts.dashboardUrl, supportAddress: sender.address,
  });
  const raw = Buffer.from(approvalEmailRaw({ from: sender.address, to: opts.owner.email, subject, body })).toString('base64url');
  const sent = await (opts.send ?? proxySend)(sender, raw);
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

// ─── Trigger 2: the refusal that mints no link ──────────────────────────────

export interface NotifyAccountRefusalOpts {
  owner: { id: string; email: string; clerkUserId: string };
  proxyKeyId: string;
  agentLabel: string;
  /** The `account` value the caller passed and the key refused. */
  requestedAccount: string;
  /** Every address the key can use. */
  usableAccounts: string[];
  /** MCP tool of this refusal, if known. */
  tool?: string | null;
  dashboardUrl: string;
  /** Test seams. */
  sender?: SenderConfig | null;
  send?: (cfg: SenderConfig, raw: string) => Promise<SendResult>;
  now?: () => Date;
}

export interface NotifyAccountRefusalResult {
  status: NotifyStatus;
  notifiedAt: Date | null;
  /** Refusals of this value on this key inside the current 24 h window (null = ledger write failed). */
  refusalCount: number | null;
}

/**
 * Record a caller-chosen `account_not_permitted` refusal and, on the
 * ACCOUNT_REFUSAL_NOTIFY_AFTER-th one for the same value on the same key
 * within 24 h, email the owner ONCE (ever, per key + value) from the support
 * mailbox under the shared daily cap. The ledger row is written whether or
 * not the sender is configured — the refused value is the diagnosis
 * analytics never carried. Never throws.
 */
export async function notifyOwnerOfAccountRefusal(opts: NotifyAccountRefusalOpts): Promise<NotifyAccountRefusalResult> {
  const row = await recordAccountRefusal({
    proxyKeyId: opts.proxyKeyId, userId: opts.owner.id, requestedEmail: opts.requestedAccount, tool: opts.tool,
  });
  if (!row) return { status: 'failed', notifiedAt: null, refusalCount: null };
  const sender = opts.sender === undefined ? senderConfig() : opts.sender;
  if (!sender) return { status: 'disabled', notifiedAt: null, refusalCount: row.windowCount };
  if (row.notifiedAt) return { status: 'already_sent', notifiedAt: row.notifiedAt, refusalCount: row.windowCount };
  if (row.windowCount < ACCOUNT_REFUSAL_NOTIFY_AFTER) return { status: 'not_due', notifiedAt: null, refusalCount: row.windowCount };
  try {
    return await attemptRefusalNotice(opts, row, sender);
  } catch (err) {
    console.error('[approvalNotify] account-refusal attempt failed:', err instanceof Error ? err.message : err);
    return { status: 'failed', notifiedAt: null, refusalCount: row.windowCount };
  }
}

async function attemptRefusalNotice(
  opts: NotifyAccountRefusalOpts,
  row: { id: string; windowCount: number; refusalCount: number; windowStartedAt: Date; firstRefusedAt: Date },
  sender: SenderConfig,
): Promise<NotifyAccountRefusalResult> {
  const now = (opts.now ?? (() => new Date()))();
  const claim = await claimAccountRefusalNotification(row.id, opts.owner.id, NOTIFY_MAX_PER_DAY);
  if (!claim.claimed) {
    if (claim.reason === 'already') return { status: 'already_sent', notifiedAt: claim.notifiedAt, refusalCount: row.windowCount };
    if (claim.reason === 'capped') return { status: 'skipped_rate_capped', notifiedAt: null, refusalCount: row.windowCount };
    return { status: 'failed', notifiedAt: null, refusalCount: row.windowCount };
  }

  const subject = accountRefusalEmailSubject(opts.requestedAccount);
  const body = accountRefusalEmailBody({
    agentLabel: opts.agentLabel, requestedAccount: opts.requestedAccount, usableAccounts: opts.usableAccounts,
    ownerEmail: opts.owner.email, tool: opts.tool, times: row.windowCount, firstRefusedAt: row.windowStartedAt,
    dashboardUrl: opts.dashboardUrl, supportAddress: sender.address,
  });
  const raw = Buffer.from(approvalEmailRaw({ from: sender.address, to: opts.owner.email, subject, body })).toString('base64url');
  const sent = await (opts.send ?? proxySend)(sender, raw);
  if (!sent.ok) {
    console.error(`[approvalNotify] account-refusal send ${sent.definite ? 'refused' : 'unconfirmed'}:`, sent.error);
    if (sent.definite) await releaseAccountRefusalNotification(row.id);
    return { status: 'failed', notifiedAt: null, refusalCount: row.windowCount };
  }

  captureServerEvent(opts.owner.clerkUserId, 'account_refusal_notified', {
    channel: 'email',
    trigger: 'account_not_permitted',
    tool: opts.tool || undefined,
    refusal_count: row.windowCount,
    refusal_count_ever: row.refusalCount,
    usable_account_count: opts.usableAccounts.length,
    hours_since_first_refusal: Math.round((now.getTime() - row.windowStartedAt.getTime()) / 36_000) / 100,
  });
  return { status: 'sent', notifiedAt: claim.notifiedAt ?? now, refusalCount: row.windowCount };
}
