/**
 * Contact-sales leads from /pricing.
 *
 * A submission does two things: the client captures it to PostHog (the
 * lead list), and this module emails it — one message to the submitter,
 * copied to the sales inbox, sent from FGAC's own support mailbox through
 * FGAC's own proxy exactly like the approval reminders (`approvalNotify.ts`):
 * same key, same send-allowlist enforcement, same `proxy_request` analytics.
 * The confirmation carries what the person told us, so the copy in the
 * sales inbox IS the lead.
 *
 * Off when the sender is unconfigured (local, preview): the form still
 * works and the lead still reaches PostHog; `sales_lead_emailed` records
 * `status: 'disabled'` so the gap is visible.
 */
import { senderConfig, proxySend, type SenderConfig, type SendResult } from './approvalNotify';
import { sanitizeLine, encodeHeaderWord } from './approvalNotifyCopy';
import { captureServerEvent } from './posthogServer';

export const SALES_INBOX = 'sales@fgac.ai';
export const TEAM_SIZES = ['2–10', '11–50', '51–250', '250+'] as const;
export const NEEDS = ['BAA', 'SOC 2 report', 'SSO / SAML', 'Self-hosted', 'DPA / security review', 'Invoicing'] as const;

export interface SalesLead {
  email: string;
  company: string | null;
  teamSize: (typeof TEAM_SIZES)[number] | null;
  needs: (typeof NEEDS)[number][];
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/** Validates a POST body. `spam` = the honeypot field was filled; answer 200 and drop. */
export function parseSalesLead(body: unknown): { ok: true; lead: SalesLead } | { ok: false; error: 'invalid' | 'spam' } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid' };
  const b = body as Record<string, unknown>;
  if (typeof b.website === 'string' && b.website.trim() !== '') return { ok: false, error: 'spam' };
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid' };
  const companyRaw = typeof b.company === 'string' ? b.company.trim() : '';
  const company = companyRaw ? sanitizeLine(companyRaw, 120) : null;
  const teamSize = (TEAM_SIZES as readonly string[]).includes(String(b.teamSize ?? ''))
    ? (b.teamSize as SalesLead['teamSize'])
    : null;
  const needs = Array.isArray(b.needs)
    ? (b.needs.filter((n): n is (typeof NEEDS)[number] => (NEEDS as readonly string[]).includes(String(n))))
    : [];
  return { ok: true, lead: { email, company, teamSize, needs: [...new Set(needs)] } };
}

export function salesLeadSubject(lead: SalesLead): string {
  return `FGAC.ai Enterprise — ${lead.company ?? lead.email}`;
}

export function salesLeadBody(lead: SalesLead): string {
  const lines = [
    'Thanks for getting in touch with FGAC.ai — we will reply within one business day.',
    '',
    'What you told us:',
    `  Email:      ${lead.email}`,
    `  Company:    ${lead.company ?? '—'}`,
    `  Team size:  ${lead.teamSize ?? '—'}`,
    `  Needs:      ${lead.needs.length ? lead.needs.join(', ') : '—'}`,
    '',
    'Reply to this email to add anything, or to book a time to talk.',
    '',
    '— FGAC.ai sales',
    SALES_INBOX,
  ];
  return lines.join('\r\n');
}

/**
 * RFC 5322 message: To the submitter, Cc the sales inbox, Reply-To sales.
 * `from` is the support mailbox unless SALES_SENDER_EMAIL names an address
 * that mailbox is allowed to send as (a Gmail "send mail as" alias); Google
 * rewrites or rejects a From it does not own, so the default is the safe one.
 */
export function salesLeadEmailRaw(opts: { from: string; to: string; cc: string; replyTo: string; subject: string; body: string }): string {
  return `From: FGAC.ai Sales <${sanitizeLine(opts.from, 254)}>\r\n` +
    `Reply-To: ${sanitizeLine(opts.replyTo, 254)}\r\n` +
    `To: ${sanitizeLine(opts.to, 254)}\r\n` +
    `Cc: ${sanitizeLine(opts.cc, 254)}\r\n` +
    `Subject: ${encodeHeaderWord(sanitizeLine(opts.subject, 200))}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n\r\n${opts.body}`;
}

export type SalesLeadEmailStatus = 'sent' | 'disabled' | 'failed';

export interface EmailSalesLeadOpts {
  /** Clerk user id when the submitter was signed in — merges the server event into their PostHog person. */
  clerkUserId?: string | null;
  source?: string;
  /** Test seams. */
  sender?: SenderConfig | null;
  send?: (cfg: SenderConfig, raw: string) => Promise<SendResult>;
  env?: Record<string, string | undefined>;
}

export async function emailSalesLead(lead: SalesLead, opts: EmailSalesLeadOpts = {}): Promise<{ status: SalesLeadEmailStatus; error?: string }> {
  const env = opts.env ?? process.env;
  const sender = opts.sender === undefined ? senderConfig(env) : opts.sender;
  const props = {
    source: opts.source ?? 'pricing',
    signed_in: Boolean(opts.clerkUserId),
    team_size: lead.teamSize ?? 'unspecified',
    needs: lead.needs,
    has_company: lead.company !== null,
  };
  const distinctId = opts.clerkUserId ?? 'anonymous-sales-lead';

  if (!sender) {
    captureServerEvent(distinctId, 'sales_lead_emailed', { ...props, status: 'disabled' });
    return { status: 'disabled' };
  }

  const from = env.SALES_SENDER_EMAIL?.trim() || sender.address;
  const raw = Buffer.from(
    salesLeadEmailRaw({
      from,
      to: lead.email,
      cc: SALES_INBOX,
      replyTo: SALES_INBOX,
      subject: salesLeadSubject(lead),
      body: salesLeadBody(lead),
    }),
  ).toString('base64url');

  const result = await (opts.send ?? proxySend)(sender, raw);
  if (result.ok) {
    captureServerEvent(distinctId, 'sales_lead_emailed', { ...props, status: 'sent' });
    return { status: 'sent' };
  }
  console.warn('[sales-lead] email failed:', result.error);
  captureServerEvent(distinctId, 'sales_lead_emailed', { ...props, status: 'failed', error: result.error.slice(0, 200) });
  return { status: 'failed', error: result.error };
}
