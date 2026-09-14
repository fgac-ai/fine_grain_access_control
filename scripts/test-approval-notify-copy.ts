/**
 * Pins the approval-link notification email (src/lib/approvalNotifyCopy.ts):
 *   - agent-controlled strings cannot inject mail headers or run past the cap
 *   - the emailed URL carries `src=email` after the signed params, untouched
 *   - the denial line exists only for `sent` / `already_sent`
 * The claim/skip logic (one email per request, hourly cap, scope-less grant)
 * lives in src/lib/approvalNotify.ts and is exercised end-to-end by
 * capability 14 A16 — it needs the ledger table, so it is not pinned here.
 * Run: npx tsx scripts/test-approval-notify-copy.ts (part of `npm run mcp:lint`).
 */
import {
  approvalEmailBody, approvalEmailRaw, approvalEmailSubject, emailLinkUrl, encodeHeaderWord, notifyDenialLine, sanitizeLine,
  NOTIFY_MAX_PER_HOUR, type NotifyLink,
} from '../src/lib/approvalNotifyCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const url = 'https://fgac.ai/dashboard/approve?a=send_whitelist&k=abc&r=bob%40example.com&s=deadbeef';
const link: NotifyLink = { requestId: 'req1', action: 'send_whitelist', url, description: 'Allow this agent to send email to bob@example.com' };
const anyLink: NotifyLink = { requestId: 'req2', action: 'send_all', url: 'https://fgac.ai/dashboard/approve?a=send_all&k=abc&s=cafe', description: 'Allow this agent to send email to ANY recipient, from every mailbox on its profile' };

console.log('sanitizeLine');
check('strips CR/LF (header injection)', sanitizeLine('x\r\nBcc: victim@example.com') === 'x Bcc: victim@example.com');
check('drops other control chars', sanitizeLine('a\x01b\x7fc') === 'abc');
check('caps length with an ellipsis', sanitizeLine('a'.repeat(200), 50).length === 50 && sanitizeLine('a'.repeat(200), 50).endsWith('…'));

console.log('emailLinkUrl');
check('appends src=email after the signed params', emailLinkUrl(url) === `${url}&src=email`);
check('uses ? when there is no query', emailLinkUrl('https://fgac.ai/x') === 'https://fgac.ai/x?src=email');

console.log('subject');
const subject = approvalEmailSubject(link);
check('names FGAC and the grant', subject.startsWith('FGAC: approve your agent') && subject.includes('bob@example.com'));
check('is a single line', !/[\r\n]/.test(subject));
const evil: NotifyLink = { ...link, description: 'Sheet\r\nBcc: victim@example.com' };
check('agent-supplied description cannot add a header', !/[\r\n]/.test(approvalEmailSubject(evil)));

console.log('body');
const body = approvalEmailBody({ agentLabel: 'Claude Desktop', links: [link, anyLink], dashboardUrl: 'https://fgac.ai/' });
check('names the agent', body.startsWith('Claude Desktop just tried'));
check('carries the primary link with src=email', body.includes(`${url}&src=email`));
check('carries the alternative link', body.includes(`${anyLink.url}&src=email`) && body.includes('Or instead:'));
check('says doing nothing keeps the agent blocked', body.includes('do nothing'));
check('links to the dashboard without a double slash', body.includes('https://fgac.ai/dashboard') && !body.includes('fgac.ai//dashboard'));
check('is plain text (no markup)', !/<[a-z]+>/i.test(body));
check('empty agent label falls back', approvalEmailBody({ agentLabel: '', links: [link], dashboardUrl: 'https://fgac.ai' }).startsWith('Your AI agent'));

console.log('raw message');
const raw = approvalEmailRaw({ to: 'owner@example.com', subject, body });
check('To/Subject/MIME headers then a blank line', /^To: owner@example\.com\r\nSubject: [^\r\n]+\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n/.test(raw));
check('non-ASCII subject is an RFC 2047 encoded word', /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/.test(raw));
check('the encoded word decodes back to the subject', Buffer.from(raw.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)![1], 'base64').toString('utf8') === subject);
check('pure-ASCII headers are left readable', encodeHeaderWord('FGAC: plain') === 'FGAC: plain');
check('a CRLF in the recipient cannot add a header', !approvalEmailRaw({ to: 'a@b.c\r\nBcc: x@y.z', subject: 's', body: '' }).includes('\r\nBcc'));

console.log('denial line');
check('sent → line naming the subject', notifyDenialLine('sent', { subject }).startsWith('📧') && notifyDenialLine('sent', { subject }).includes(subject));
const at = new Date('2026-09-14T13:05:00Z');
check('already_sent → names the time in UTC', notifyDenialLine('already_sent', { subject, notifiedAt: at }).includes('2026-09-14 13:05 UTC'));
check('already_sent without a stamp still reads', notifyDenialLine('already_sent', { subject }).includes('earlier'));
for (const s of ['skipped_no_gmail_scope', 'skipped_token_unavailable', 'skipped_rate_capped', 'failed', 'disabled', 'skipped_no_links'] as const) {
  check(`${s} → no line`, notifyDenialLine(s, { subject }) === '');
}
check('cap is a small positive integer', Number.isInteger(NOTIFY_MAX_PER_HOUR) && NOTIFY_MAX_PER_HOUR >= 1 && NOTIFY_MAX_PER_HOUR <= 20);

if (failures) { console.error(`\n${failures} approval-notify copy check(s) failed`); process.exit(1); }
console.log('\nAll approval-notify copy checks passed');
