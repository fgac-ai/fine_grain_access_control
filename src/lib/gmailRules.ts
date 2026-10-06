/**
 * Gmail rule loading + read-time enforcement, shared by the MCP server, the
 * REST proxy paths that need it, and the push-notification filter. Extracted
 * from src/app/api/mcp/route.ts so notification filtering can never drift from
 * read-time filtering — a message a key cannot read must also never be
 * announced to a partner webhook.
 */
import { compileRulePattern } from '@/lib/rulePatterns';
import { db } from '@/db';
import { accessRules, keyRuleAssignments } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { collectLabelIds } from '@/app/api/mcp/googleApiPolicy';
import { SEND_DISABLED_MESSAGE, recipientNotWhitelistedMessage } from '@/lib/denialCopy';

export async function loadApplicableRules(userId: string, proxyKeyId: string, targetEmail: string) {
  const allUserRules = await db.select().from(accessRules)
    .where(eq(accessRules.userId, userId));

  const keyAssignments = await db.select().from(keyRuleAssignments)
    .where(eq(keyRuleAssignments.proxyKeyId, proxyKeyId));

  const assignedRuleIds = new Set(keyAssignments.map(a => a.accessRuleId));
  const allAssignments = await db.select().from(keyRuleAssignments);
  const rulesWithAssignments = new Set(allAssignments.map(a => a.accessRuleId));

  return allUserRules.filter(rule => {
    const isGlobal = !rulesWithAssignments.has(rule.id);
    const isAssignedToThisKey = assignedRuleIds.has(rule.id);
    const emailMatches = !rule.targetEmail ||
      rule.targetEmail.toLowerCase() === targetEmail.toLowerCase();
    return (isGlobal || isAssignedToThisKey) && emailMatches;
  });
}

export type ApplicableRules = Awaited<ReturnType<typeof loadApplicableRules>>;

/**
 * Send-whitelist enforcement shared by gmail_send, google_api_modify, and the
 * REST proxy (src/app/api/proxy/[...path]/route.ts).
 * Every recipient must match a whitelist pattern; unknown recipients deny.
 * Returns a denial ({ message, deniedRecipient? }) or null if sending is
 * allowed. deniedRecipient feeds the magic approval link — absent when we
 * could not even parse who the mail was for (no link in that case).
 */
export type SendDenial = { message: string; deniedRecipient?: string; code: string };

export function checkSendWhitelist(rules: ApplicableRules, recipients: string[] | null): SendDenial | null {
  const sendRules = rules.filter(r => r.service === 'gmail' && r.actionType === 'send_whitelist');

  if (!recipients || recipients.length === 0) {
    return { message: '🚫 Could not determine the message recipients, so sending was denied. Provide a standard RFC 2822 message whose To/Cc/Bcc headers hold only plain addresses (name@example.com — no quoted local parts, IP-literal domains, or non-ASCII addresses).', code: 'recipients_undetermined' };
  }

  if (sendRules.length === 0) {
    return {
      message: SEND_DISABLED_MESSAGE,
      deniedRecipient: recipients[0],
      code: 'send_disabled',
    };
  }

  for (const recipient of recipients) {
    let isWhitelisted = false;
    for (const rule of sendRules) {
      if (!rule.regexPattern) continue;
      const regex = compileRulePattern(rule.regexPattern);
      if (!regex) continue;
      if (regex.test(recipient)) { isWhitelisted = true; break; }
    }
    if (!isWhitelisted) {
      return {
        message: recipientNotWhitelistedMessage(recipient),
        deniedRecipient: recipient,
        code: 'recipient_not_whitelisted',
      };
    }
  }

  return null;
}

// ─── Message content extraction (shared with parseGmailMessage) ──────────────

export function decodeB64Url(s: string): string {
  try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; }
}

/** Reduce an HTML body to its visible text, the way parseGmailMessage renders it. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_CONTENT_WALK_DEPTH = 10;

/**
 * Collect the human-readable content of every Gmail message nested in a
 * response (single message, thread, or listing): header lines, snippets,
 * attachment filenames, and DECODED text bodies (text/plain, plus text/html
 * reduced to visible text).
 *
 * This exists because Gmail's `format=full` JSON carries body text
 * base64url-ENCODED — a content rule tested against the raw serialization can
 * never see the body (the one place users expect a content rule to look), and
 * matches only the plaintext fields (snippet/headers/filenames), which made
 * enforcement look format- and size-dependent (support case, 2026-09-03).
 *
 * Returns null when the value carries no recognizable message fields, so the
 * caller can fall back to the raw serialization instead of silently
 * un-enforcing on shapes this walker does not understand.
 */
export function collectMessageContent(value: unknown): string | null {
  const chunks: string[] = [];

  const walk = (v: unknown, depth: number) => {
    if (depth > MAX_CONTENT_WALK_DEPTH || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const obj = v as Record<string, unknown>;
    if (typeof obj.snippet === 'string' && obj.snippet) chunks.push(obj.snippet);
    if (typeof obj.filename === 'string' && obj.filename) chunks.push(obj.filename);
    if (Array.isArray(obj.headers)) {
      for (const h of obj.headers) {
        const header = h as { name?: unknown; value?: unknown };
        if (typeof header?.name === 'string' && typeof header?.value === 'string') {
          chunks.push(`${header.name}: ${header.value}`);
        }
      }
    }
    const body = obj.body as { data?: unknown } | undefined;
    if (typeof obj.mimeType === 'string' && typeof body?.data === 'string' && body.data) {
      if (obj.mimeType.startsWith('text/html')) {
        chunks.push(stripHtmlToText(decodeB64Url(body.data)));
      } else if (obj.mimeType.startsWith('text/')) {
        chunks.push(decodeB64Url(body.data));
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === 'headers') continue;
      walk(obj[key], depth + 1);
    }
  };

  walk(value, 0);
  return chunks.length > 0 ? chunks.join('\n') : null;
}

// ─── Read-time enforcement ───────────────────────────────────────────────────

const RULES_DASHBOARD_URL = 'https://fgac.ai/dashboard';

/**
 * Every denial names the governing rule, says FGAC made the decision, and
 * links the dashboard. The self-identification is load-bearing: a hosted
 * agent's own failure messages (client-side tool approval, dropped results)
 * otherwise get attributed to FGAC rules — that mis-attribution is exactly
 * what the 2026-09-03 support case reported.
 */
function denial(ruleName: string, detail: string): string {
  return `🚫 FGAC read rule '${ruleName}' blocked this message: ${detail} ` +
    `This decision was made by FGAC.ai policy (not by your agent or client). ` +
    `The FGAC account owner can review or adjust rules at ${RULES_DASHBOARD_URL}.`;
}

/**
 * Read-time enforcement, shared by every path that returns message content.
 * Policy: messages may APPEAR in listings, but reading content must respect
 * label blacklists (checked first — precedence), label whitelists, and content
 * read-blacklists — identically on MCP and the raw API proxy.
 *
 * Label rules consider every labelIds array in the response (thread and list
 * responses nest messages). Whitelists only apply when the response carries
 * labels at all — ID-only listings stay visible, matching the policy above.
 * Content rules are tested against the DECODED message content (headers,
 * snippet, filenames, decoded text bodies) — see collectMessageContent — with
 * the raw serialization as a fallback for unrecognized response shapes.
 * Returns a user-facing restriction message, or null if the read is allowed.
 */
export function checkReadRestrictions(
  rules: ApplicableRules,
  message: unknown,
): string | null {
  const gmailRules = rules.filter(r => r.service === 'gmail');
  const labelIds = collectLabelIds(message);

  for (const rule of gmailRules.filter(r => r.actionType === 'label_blacklist')) {
    if (rule.regexPattern && labelIds.includes(rule.regexPattern)) {
      return denial(rule.ruleName, `it carries the blacklisted label '${rule.regexPattern}'.`);
    }
  }

  const whitelists = gmailRules.filter(r => r.actionType === 'label_whitelist' && !!r.regexPattern);
  if (whitelists.length > 0 && labelIds.length > 0 && !whitelists.some(r => labelIds.includes(r.regexPattern!))) {
    const names = whitelists.map(r => `'${r.ruleName}'`).join(', ');
    return denial(whitelists[0].ruleName, `it lacks a label required by the label whitelist (${names}).`);
  }

  const contentRules = gmailRules.filter(r => r.actionType === 'read_blacklist');
  if (contentRules.length > 0) {
    const corpus = collectMessageContent(message) ?? JSON.stringify(message);
    for (const rule of contentRules) {
      if (!rule.regexPattern) continue;
      const regex = compileRulePattern(rule.regexPattern);
      if (!regex) continue;
      if (regex.test(corpus)) {
        return denial(rule.ruleName, `its content matches the rule's blocked pattern.`);
      }
    }
  }

  return null;
}
