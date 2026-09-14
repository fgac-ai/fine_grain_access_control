/**
 * Approval-link email copy — the pure half of out-of-band link delivery.
 * `src/lib/approvalNotify.ts` does the claiming and sending; this module
 * only builds strings, so `scripts/test-approval-notify-copy.ts` can pin
 * them without a database or a Google token.
 *
 * Why an email exists at all (measured 2026-09-14, production, 14 d): about
 * half of minted approval requests are never opened, and the people who
 * never open cluster on agent surfaces that hide the tool result — Claude
 * Code collapses it by default, so the person reads the assistant's
 * paraphrase and the URL sits in the collapsed block. Two of the three
 * zero-open people in the window were on Claude Code; one of them had 570
 * successful Gmail calls in the same window. When a link IS opened, 67% of
 * opens happen within ten minutes of the mint (the chat path works when the
 * URL survives it), so the email is a second channel, not a replacement.
 *
 * Every agent-controlled string that reaches a mail header or the body goes
 * through `sanitizeLine`: CR/LF stripped (header injection), control
 * characters dropped, length capped. The email is plain text — no HTML, so
 * nothing agent-supplied can render as markup.
 */

export type NotifyStatus =
  | 'sent'
  | 'already_sent'
  | 'skipped_no_gmail_scope'
  | 'skipped_token_unavailable'
  | 'skipped_rate_capped'
  | 'skipped_no_links'
  | 'failed'
  | 'disabled';

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
 * tell an email open from a chat open. The approve page ignores unknown
 * params for verification (only a/k/r/s are signed). */
export const EMAIL_LINK_SOURCE_PARAM = 'src';
export const EMAIL_LINK_SOURCE_VALUE = 'email';

/** Rolling per-owner ceiling: a batch of N distinct recipients in one turn is
 * N requests, and this is what keeps that from being N emails. */
export const NOTIFY_MAX_PER_HOUR = 5;

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

export function approvalEmailSubject(primary: NotifyLink): string {
  return sanitizeLine(`FGAC: approve your agent's request — ${primary.description}`, 160);
}

/**
 * Plain-text body. `agentLabel` is the connection's nickname or client name
 * (agent-controlled at connect time, so it is sanitized like everything
 * else). `links` is one entry for a file/recipient grant, two for a send
 * denial (the recipient-only grant first, then send-to-anyone).
 */
export function approvalEmailBody(opts: { agentLabel: string; links: NotifyLink[]; dashboardUrl: string }): string {
  const agent = sanitizeLine(opts.agentLabel, 80) || 'Your AI agent';
  const [primary, ...rest] = opts.links;
  const lines: string[] = [
    `${agent} just tried to do something FGAC has not been told it may do:`,
    '',
    `    ${sanitizeLine(primary.description, 200)}`,
    '',
    'Nothing has happened yet — the agent is blocked until you approve it.',
    '',
    'Approve it in one click (you can revoke it any time from your FGAC dashboard):',
    emailLinkUrl(primary.url),
  ];
  for (const alt of rest) {
    lines.push('', `Or instead: ${sanitizeLine(alt.description, 200)}`, emailLinkUrl(alt.url));
  }
  lines.push(
    '',
    'If you did not expect this, do nothing: the agent cannot proceed without your approval.',
    '',
    `FGAC sent this from your own Gmail account, to you, because your agent is connected through it. Rules and connected agents: ${opts.dashboardUrl.trim().replace(/\/+$/, '')}/dashboard`,
  );
  return lines.join('\n');
}

/** The RFC 2822 message the Gmail API sends, base64url-encoded by the caller. */
export function approvalEmailRaw(opts: { to: string; subject: string; body: string }): string {
  return `To: ${sanitizeLine(opts.to, 254)}\r\nSubject: ${sanitizeLine(opts.subject, 200)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.body}`;
}

function whenUtc(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/**
 * The sentence appended to the denial text after the link line. Only the
 * two states a human can act on get a line; a skipped or failed email adds
 * nothing (the link alone is what it was before). Never names the owner's
 * address: the agent already knows the account, and the text is quoted.
 */
export function notifyDenialLine(status: NotifyStatus, opts: { subject: string; notifiedAt?: Date | null }): string {
  if (status === 'sent') {
    return `📧 FGAC also emailed this link to the user's own inbox just now (subject "${opts.subject}") — if they cannot click the link here, tell them to check their email.`;
  }
  if (status === 'already_sent') {
    const when = opts.notifiedAt ? ` at ${whenUtc(opts.notifiedAt)}` : ' earlier';
    return `📧 FGAC emailed this link to the user's own inbox${when} (subject "${opts.subject}"); no new email is sent for repeats — tell them to check their inbox.`;
  }
  return '';
}
