/**
 * Bounce ledger — the pure half: DSN parsing, the bounce class map, and the
 * address normalisation. No database, no Clerk, no PostHog, so
 * `scripts/test-email-bounces.ts` pins it without an environment and
 * `npm run build` (which runs `mcp:lint`) never touches a connection string.
 * The ledger itself and the SQL helpers live in src/lib/emailBounces.ts; the
 * reader in src/lib/emailBounceSweep.ts. The why is in emailBounces.ts.
 */
import { NOTICE_HEADER, type NoticeKind } from './approvalNotifyCopy';

/** How the sweep filed a DSN. Only the first two suppress anything. */
export type BounceClass =
  /** No such mailbox, or disabled (5.1.1 / 5.1.2 / 5.1.3 / 5.1.6 / 5.1.10 /
   * 5.2.1): nobody can reconnect it; the notice system must never write to
   * it again and the agent gets a stop, not a reconnect link. */
  | 'mailbox_gone'
  /** Any other permanent failure: the mailbox exists but refused FGAC's mail
   * (policy, spam, size). Suppressed too — a wall we hit once is a wall — but
   * the reconnect link stays valid; the agent is told the owner was NOT
   * reached. */
  | 'rejected'
  /** 4.x.x delayed / still trying: not a bounce. Stored so the sweep never
   * re-reads it; suppresses nothing. */
  | 'transient'
  /** A permanent failure that is not ours (no notice header, recipient in no
   * ledger — the operator's own correspondence bouncing). Stored id-only so
   * the sweep never re-reads it; suppresses nothing, keeps no address. */
  | 'unmatched';

/** The classes that make an address undeliverable for every notice. */
export const SUPPRESSING_CLASSES: readonly BounceClass[] = ['mailbox_gone', 'rejected'];

/** Enhanced status codes whose meaning is "there is no such mailbox to reach":
 * RFC 3463 5.1.1 (bad destination mailbox), 5.1.2 (bad destination system),
 * 5.1.3 (bad destination mailbox syntax — what Google's MTA sends for a
 * deleted Workspace account: "The email account that you tried to reach does
 * not exist"), 5.1.6 (mailbox has moved, no forwarding), 5.1.10 (recipient
 * address has null MX), 5.2.1 (mailbox disabled — Google: "the account is
 * disabled"). Everything else permanent is `rejected`. */
const MAILBOX_GONE_STATUSES = new Set(['5.1.1', '5.1.2', '5.1.3', '5.1.6', '5.1.10', '5.2.1']);

export function classifyBounce(action: string, status: string): BounceClass | null {
  const code = status.trim();
  if (!/^[245]\.\d{1,3}\.\d{1,3}$/.test(code)) return null;
  if (!code.startsWith('5')) return 'transient';
  if (!/^failed$/i.test(action.trim())) return 'transient';
  return MAILBOX_GONE_STATUSES.has(code) ? 'mailbox_gone' : 'rejected';
}

export interface ParsedDsn {
  /** Final-Recipient, lower-cased. */
  recipient: string;
  action: string;
  status: string;
  /** Diagnostic-Code, unfolded, one line, ≤ 200 chars. */
  diagnostic: string | null;
  /** Reporting-MTA, when present (e.g. `dns; googlemail.com`). */
  reportingMta: string | null;
  /** The echoed original's X-FGAC-Notice header, when present. */
  noticeKind: NoticeKind | null;
  /** The echoed original's From address, when present. */
  originalFrom: string | null;
}

const NOTICE_KINDS: readonly NoticeKind[] = ['approval_link', 'account_refusal', 'dead_grant'];

function unfold(text: string): string {
  return text.replace(/\r?\n[ \t]+/g, ' ');
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Parse a raw RFC 5322 DSN (`format=raw`, already base64url-decoded). Tolerant
 * of header folding and of either `message/rfc822` or `text/rfc822-headers`
 * for the echoed original. Returns null when the message carries no
 * `Final-Recipient` / `Status` pair — i.e. it is not a delivery-status
 * report at all (a human reply from a postmaster, say).
 */
export function parseDsn(raw: string): ParsedDsn | null {
  const text = unfold(raw);
  const rawRecipient = firstMatch(text, /^Final-Recipient:\s*(?:rfc822|[a-z0-9-]+)\s*;\s*<?([^\s>]+)>?/im);
  const status = firstMatch(text, /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im);
  if (!rawRecipient || !status) return null;
  const action = firstMatch(text, /^Action:\s*([a-z]+)/im) ?? '';
  const diagnosticRaw = firstMatch(text, /^Diagnostic-Code:\s*(.+)$/im);
  const noticeRaw = firstMatch(text, new RegExp(`^${NOTICE_HEADER}:\\s*([a-z_]+)`, 'im'));
  const noticeKind = noticeRaw && (NOTICE_KINDS as readonly string[]).includes(noticeRaw)
    ? (noticeRaw as NoticeKind) : null;
  // The DSN's own From is the mailer-daemon; the echoed original's From is
  // ours ("FGAC <support@…>"). Take the first From that is not a daemon.
  const froms = [...text.matchAll(/^From:\s*(.+)$/gim)].map(m => m[1].trim());
  const originalFromLine = froms.find(f => !/mailer-daemon|postmaster/i.test(f)) ?? null;
  const originalFrom = originalFromLine
    ? (originalFromLine.match(/<([^>]+)>/)?.[1] ?? originalFromLine).trim().toLowerCase()
    : null;
  return {
    recipient: rawRecipient.toLowerCase(),
    action,
    status,
    diagnostic: diagnosticRaw ? diagnosticRaw.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) : null,
    reportingMta: firstMatch(text, /^Reporting-MTA:\s*(.+)$/im),
    noticeKind,
    originalFrom,
  };
}

export function normalizeBounceAddress(value: string): string {
  return value.trim().toLowerCase().slice(0, 254);
}
