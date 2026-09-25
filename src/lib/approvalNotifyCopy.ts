/**
 * Approval-link reminder email — the pure half of out-of-band link delivery.
 * `src/lib/approvalNotify.ts` decides when to send and sends; this module
 * only builds strings, so `scripts/test-approval-notify-copy.ts` can pin
 * them without a database or a mail server.
 *
 * Sender: FGAC's own support mailbox, sending through FGAC's own proxy API
 * with its own key (never the user's Google grant — that grant exists for
 * the user's agent acting at the user's direction, and an FGAC-initiated
 * send through it is a use the user never consented to; decided
 * 2026-09-15). Reply-To is the same mailbox, so "let us know" is a reply.
 *
 * When (Ken, 2026-09-15): only after the agent has asked for the SAME link
 * more than once and the person has still not opened it — the first denial
 * relies on the agent relaying the link; the reminder exists for the case
 * where that visibly did not happen. Never more than a few per person per
 * day, in case an agent asks for many files at once.
 *
 * Every agent-controlled string that reaches a header or the body goes
 * through `sanitizeLine`: CR/LF stripped (header injection), control
 * characters dropped, length capped. Plain text, no HTML.
 */

export type NotifyStatus =
  | 'sent'
  | 'already_sent'
  | 'not_due'
  | 'skipped_opened'
  | 'skipped_rate_capped'
  /** Dead-grant notice only: the global hourly circuit breaker tripped. */
  | 'skipped_global_capped'
  /** Account-refusal notice only: the owner was already emailed about a
   * refused account inside the current episode (ACCOUNT_REFUSAL_EPISODE_GAP_MS). */
  | 'skipped_episode'
  /** Link reminder only: another request of this owner was emailed inside
   * the same-turn window (NOTIFY_MIN_GAP_MS) — one email per turn; this link
   * stays eligible for a later turn. */
  | 'skipped_burst'
  | 'skipped_no_links'
  | 'failed'
  | 'disabled';

/** What every owner notice signs as and tells people to write to. A fixed
 * address, never the configured sender: on a local or preview build the
 * sender is a QA account standing in for the support mailbox, and a
 * signature rendering it read as if the user's own address had sent the
 * email (Ken, 2026-09-23). Reply-To stays the real sender. */
export const SUPPORT_CONTACT_ADDRESS = 'support@fgac.ai';

/** The canonical site, used when a production build would otherwise email
 * a loopback URL. */
export const PRODUCTION_SITE_URL = 'https://fgac.ai';

/** The delegation walkthrough video (the "Multiple Gmail accounts" demo),
 * linked from the refusal email's "delegate that account" fix. The site page
 * rather than the raw embed: it is ours, and the `video_played` event fires. */
export const DELEGATION_HOWTO_PATH = '/use-cases/multiple-gmail-accounts';

/**
 * The base every emailed link is built on. `dashboardUrl` is the caller's
 * `DASHBOARD_URL` (NEXT_PUBLIC_APP_URL, else Vercel's production URL, else
 * localhost); in a production runtime a loopback base can only be a
 * mis-set environment, and an email is the one place it cannot be allowed
 * through — the QA copy of 2026-09-23 linked http://localhost:3000.
 */
export function notifyBaseUrl(dashboardUrl: string, env: Record<string, string | undefined> = process.env): string {
  const base = dashboardUrl.trim().replace(/\/+$/, '');
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(base) || base === '';
  return loopback && env.VERCEL_ENV === 'production' ? PRODUCTION_SITE_URL : base;
}

/** The signature line shared by every owner notice. */
export function signatureLine(): string {
  return `— FGAC support (${SUPPORT_CONTACT_ADDRESS})`;
}

/** First letter upper-cased, for a label at the start of a sentence
 * ("your Claude agent on the Default Profile" → "Your Claude agent …"). */
export function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export interface NotifyLink {
  /** Deterministic request id (the dedupe key). */
  requestId: string;
  action: string;
  /** The approval URL exactly as minted into the denial text. */
  url: string;
  /** Human-readable grant, e.g. "Allow this agent to send email to x@y". */
  description: string;
}

/** Query parameter appended to emailed links so `approval_link_opened` can
 * tell an email open from a chat open. Outside the signed params (a/k/r/s),
 * so it changes nothing about verification. */
export const EMAIL_LINK_SOURCE_PARAM = 'src';
export const EMAIL_LINK_SOURCE_VALUE = 'email';

/** Reminders per person per rolling 24 h. "No user should receive more than
 * 3 emails in a single day from this flow" (Ken, 2026-09-15). */
export const NOTIFY_MAX_PER_DAY = 3;

/** A repeat mint counts as "the agent asked again" only this long after the
 * request's first mint: inside it, re-mints are the same agent turn (a
 * batch, an immediate retry) and the person has not had a chance to click.
 * Simulated on 30 d of production mints (2026-09-15): 0 s → 70 reminders /
 * 42 people, one 4-a-day; 5 min → 42 / 29, max 2 a day; 10 min → 37 / 27. */
export const NOTIFY_MIN_GAP_MS = 5 * 60_000;

/** Header-safe, single-line, bounded. */
export function sanitizeLine(value: string, max = 120): string {
  const oneLine = value.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Append `src=email` to a minted URL without disturbing the signed params. */
export function emailLinkUrl(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${EMAIL_LINK_SOURCE_PARAM}=${EMAIL_LINK_SOURCE_VALUE}`;
}

/** "read-only access to spreadsheet X" / "send email to x@y" — the grant in the subject's voice. */
export function shortGrant(link: NotifyLink): string {
  const m = /^(?:Allow this agent to|Give this agent) (.*)$/.exec(link.description);
  return sanitizeLine(m ? m[1] : link.description, 140);
}

export function approvalEmailSubject(primary: NotifyLink, times: number): string {
  return sanitizeLine(`Your agent has asked ${times} times to ${shortGrant(primary)} — approve it?`, 160);
}

function whenUtc(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * Plain-text body. `agentLabel` is what src/lib/agentLabel.ts made of the
 * connection's nickname, client name and profile (nickname and client name
 * are agent-controlled at connect time, so it is sanitized like everything
 * else). `links` is one entry for a file/recipient grant, two for a send
 * denial (the recipient-only grant first, then send-to-anyone).
 * `supportAddress` is the Reply-To; the signature names the fixed support
 * contact, never it.
 */
export function approvalEmailBody(opts: {
  agentLabel: string; links: NotifyLink[]; times: number; firstAskedAt: Date; dashboardUrl: string; supportAddress: string;
}): string {
  const agent = sanitizeLine(opts.agentLabel, 80) || 'your AI agent';
  const [primary, ...rest] = opts.links;
  const lines: string[] = [
    `FGAC has detected ${agent} asking ${opts.times} times, without approval, to:`,
    '',
    `    ${sanitizeLine(primary.description, 200)}`,
    '',
    `The first request was at ${whenUtc(opts.firstAskedAt)}. Each time, FGAC refused it and handed the agent a link for you to approve — this email carries that link, in case it never reached you.`,
    '',
    'To give the agent this access, approve it here (one click; you can revoke it any time from your FGAC dashboard):',
    emailLinkUrl(primary.url),
  ];
  for (const alt of rest) {
    lines.push('', `Or instead: ${sanitizeLine(alt.description, 200)}`, emailLinkUrl(alt.url));
  }
  lines.push(
    '',
    'If you intentionally do not want the agent to have this access, do nothing — it stays blocked. Or reply to this email to let us know, and we will not remind you about this request again.',
    '',
    `Rules and connected agents: ${opts.dashboardUrl.trim().replace(/\/+$/, '')}/dashboard`,
    signatureLine(),
  );
  return lines.join('\n');
}

/** RFC 2047 encoded-word for a header that may carry non-ASCII (the subject's em dash). */
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * The RFC 2822 message FGAC's proxy API sends (base64url-encoded by the
 * caller). From and Reply-To are the support mailbox; the proxy sends as
 * the key's own account, so Gmail keeps the From consistent. `cc` is used by
 * the dead-grant notice on a delegated mailbox (the key owner rides along).
 */
export function approvalEmailRaw(opts: { from: string; to: string; cc?: string | null; subject: string; body: string }): string {
  const from = sanitizeLine(opts.from, 254);
  const cc = opts.cc ? sanitizeLine(opts.cc, 254) : '';
  return `From: FGAC <${from}>\r\n` +
    `Reply-To: ${from}\r\n` +
    `To: ${sanitizeLine(opts.to, 254)}\r\n` +
    (cc ? `Cc: ${cc}\r\n` : '') +
    `Subject: ${encodeHeaderWord(sanitizeLine(opts.subject, 200))}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n\r\n${opts.body}`;
}

/**
 * The sentence appended to the denial text after the link line. Only the
 * two states a human can act on get a line; every other outcome adds
 * nothing (the link alone is what it was before).
 */
export function notifyDenialLine(status: NotifyStatus, opts: { notifiedAt?: Date | null }): string {
  if (status === 'sent') {
    return '📧 Because this is a repeat request, FGAC has also emailed this link to the user just now — if they cannot click the link here, tell them to check their email.';
  }
  if (status === 'already_sent') {
    const when = opts.notifiedAt ? ` at ${whenUtc(opts.notifiedAt)}` : ' earlier';
    return `📧 FGAC emailed this link to the user${when}; no further email is sent for repeats — tell them to check their inbox.`;
  }
  return '';
}

// ─── Account-refusal notice (the refusal that mints no link) ────────────────
// A second trigger for the same sender and cap (plan v4, 2026-09-16): the
// caller-chosen `account_not_permitted` refusal — the agent passes an
// `account` the key cannot use — mints nothing, so the reminder above can
// never fire for it. Measured in production: a scheduled job refused 53
// times in 6 days at a 1–3 h cadence, owner last on the dashboard 11 days
// earlier, and the 🚫 text (PR #137) stopped its retries without changing
// the task. This email names the value the task passes (which the dashboard
// cannot show) and both fixes. Once ever per (key, requested account).

/** Refusals of the same value on one key inside a rolling 24 h before the
 * owner is emailed. 30 d of production refusals (2026-09-16): two callers
 * at 7–11 a day, six one-offs at 1–2 in the month — any threshold from 3 to
 * 7 separates them; 3 emails earliest. */
export const ACCOUNT_REFUSAL_NOTIFY_AFTER = 3;

/** One refusal email per OWNER per episode, whatever the refused value. The
 * once-per-(key, value) rule alone let an agent that guessed three wrong
 * addresses earn three emails in 16.7 h (production, 2026-09-20/21 — only
 * the daily cap stopped a fourth). The 🚫 refusal still names every value and
 * the fixes on every call; the owner is told once, and again only if refusals
 * recur after a fortnight with none in between (same gap as the dead-grant
 * episode). Ken, 2026-09-21: one email per event, no repeat cadence. */
export const ACCOUNT_REFUSAL_EPISODE_GAP_MS = 14 * 24 * 60 * 60_000;

export interface AccountRefusalNotice {
  agentLabel: string;
  /** The `account` value the caller passed (agent-controlled: sanitized). */
  requestedAccount: string;
  /** Every address the key can use. */
  usableAccounts: string[];
  /** The owner's sign-up address — the delegate in the "connect that account" fix. */
  ownerEmail: string;
  /** MCP tool of the latest refusal, if known. */
  tool?: string | null;
  times: number;
  firstRefusedAt: Date;
  dashboardUrl: string;
  supportAddress: string;
}

export function accountRefusalEmailSubject(requestedAccount: string): string {
  return sanitizeLine(`Your agent keeps asking for '${sanitizeLine(requestedAccount, 80)}', an account it cannot use — a change is needed`, 160);
}

export function accountRefusalEmailBody(opts: AccountRefusalNotice): string {
  const agent = sanitizeLine(opts.agentLabel, 80) || 'your AI agent';
  const requested = sanitizeLine(opts.requestedAccount, 254);
  const usable = opts.usableAccounts.map(a => sanitizeLine(a, 254)).filter(Boolean);
  const tool = opts.tool ? sanitizeLine(opts.tool, 60) : '';
  const base = opts.dashboardUrl.trim().replace(/\/+$/, '');
  const lines: string[] = [
    `FGAC has refused ${agent} ${opts.times} times since ${whenUtc(opts.firstRefusedAt)}${tool ? ` (its ${tool} calls)` : ''} because it asks for the Google account:`,
    '',
    `    ${requested}`,
    '',
    `That account is not on the agent's profile. The account${usable.length === 1 ? '' : 's'} it can use: ${usable.join(', ') || '(none)'}.`,
    '',
    'No approval link exists for this — adding an account to a profile is only ever done by you, so FGAC cannot offer one. Two ways to fix it:',
    '',
    `1. The task should use an account listed above: change the task (or tell the agent) to name that account, or to leave "account" unspecified so the profile's default is used.`,
    `2. The task really should use ${requested}: sign in to FGAC as that account and, under Delegation Management, delegate access to ${sanitizeLine(opts.ownerEmail, 254)}; the mailbox then appears on your Default Profile automatically. ${base}/dashboard/accounts`,
    `   How delegation works, in two minutes (video): ${base}${DELEGATION_HOWTO_PATH}`,
    '',
    'Until one of these happens, every run is refused the same way. FGAC will not email you about this account again; reply to this email if you need a hand.',
    '',
    `Rules and connected agents: ${base}/dashboard`,
    signatureLine(),
  ];
  return lines.join('\n');
}

/**
 * The sentence appended to the 🚫 refusal after the account-refusal email.
 * Same two states as `notifyDenialLine`; every other outcome adds nothing.
 */
export function accountRefusalDenialLine(status: NotifyStatus, opts: { notifiedAt?: Date | null }): string {
  if (status === 'sent') {
    return '📧 Because this account has now been refused repeatedly, FGAC has emailed the user just now naming the account this task passes and the accounts this connection can use — tell them to check their email.';
  }
  if (status === 'already_sent') {
    const when = opts.notifiedAt ? ` at ${whenUtc(opts.notifiedAt)}` : ' earlier';
    return `📧 FGAC emailed the user about this account${when}; no further email is sent for the same account — tell them to check their inbox.`;
  }
  return '';
}
