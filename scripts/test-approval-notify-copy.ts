/**
 * Pins the approval-link reminder email (src/lib/approvalNotifyCopy.ts) and
 * the decision logic of src/lib/approvalNotify.ts that does not need a
 * database:
 *   - agent-controlled strings cannot inject mail headers or run past the cap
 *   - the emailed URL carries `src=email` after the signed params, untouched
 *   - the denial line exists only for `sent` / `already_sent`
 *   - the raw message names FGAC's support mailbox as From and Reply-To,
 *     with an RFC 2047 subject and MIME headers
 * Sender configuration (SUPPORT_FGAC_PROXY_KEY / SUPPORT_SENDER_EMAIL) and
 * the repeat/cap/claim logic live in src/lib/approvalNotify.ts, which
 * imports the proxy route (database-backed) — exercised end-to-end by
 * capability 14 A16, not here.
 * Run: npx tsx scripts/test-approval-notify-copy.ts (part of `npm run mcp:lint`).
 */
import {
  accountRefusalDenialLine, accountRefusalEmailBody, accountRefusalEmailSubject,
  approvalEmailBody, approvalEmailRaw, approvalEmailSubject, emailLinkUrl, encodeHeaderWord, notifyDenialLine, sanitizeLine, shortGrant,
  ACCOUNT_REFUSAL_NOTIFY_AFTER, NOTIFY_MAX_PER_DAY, NOTIFY_MIN_GAP_MS, type NotifyLink,
} from '../src/lib/approvalNotifyCopy';
import { normalizeRequestedEmail } from '../src/lib/accountRefusals';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const url = 'https://fgac.ai/dashboard/approve?a=send_whitelist&k=abc&r=bob%40example.com&s=deadbeef';
const link: NotifyLink = { requestId: 'req1', action: 'send_whitelist', url, description: 'Allow this agent to send email to bob@example.com' };
const sheet: NotifyLink = { requestId: 'req3', action: 'sheets_expose', url: 'https://fgac.ai/dashboard/approve?a=sheets_expose&k=abc&r=1AbC&s=feed', description: 'Give this agent read-only access to spreadsheet Q3 budget' };
const anyLink: NotifyLink = { requestId: 'req2', action: 'send_all', url: 'https://fgac.ai/dashboard/approve?a=send_all&k=abc&s=cafe', description: 'Allow this agent to send email to ANY recipient, from every mailbox on its profile' };

console.log('sanitizeLine');
check('strips CR/LF (header injection)', sanitizeLine('x\r\nBcc: victim@example.com') === 'x Bcc: victim@example.com');
check('drops other control chars', sanitizeLine('a\x01b\x7fc') === 'abc');
check('caps length with an ellipsis', sanitizeLine('a'.repeat(200), 50).length === 50 && sanitizeLine('a'.repeat(200), 50).endsWith('…'));

console.log('emailLinkUrl');
check('appends src=email after the signed params', emailLinkUrl(url) === `${url}&src=email`);
check('uses ? when there is no query', emailLinkUrl('https://fgac.ai/x') === 'https://fgac.ai/x?src=email');

console.log('subject');
const subject = approvalEmailSubject(link, 3);
check('says how many times and what', subject === 'Your agent has asked 3 times to send email to bob@example.com — approve it?');
check('file grants read naturally', shortGrant(sheet) === 'read-only access to spreadsheet Q3 budget');
check('is a single line', !/[\r\n]/.test(subject));
const evil: NotifyLink = { ...link, description: 'Allow this agent to Sheet\r\nBcc: victim@example.com' };
check('agent-supplied description cannot add a header', !/[\r\n]/.test(approvalEmailSubject(evil, 2)));

console.log('body');
const first = new Date('2026-09-14T13:05:00Z');
const body = approvalEmailBody({ agentLabel: 'Claude Desktop', links: [link, anyLink], times: 3, firstAskedAt: first, dashboardUrl: 'https://fgac.ai/', supportAddress: 'support@fgac.ai' });
check('opens with the detection sentence', body.startsWith('FGAC has detected Claude Desktop asking 3 times, without approval, to:'));
check('names the first request time in UTC', body.includes('The first request was at 2026-09-14 13:05 UTC'));
check('carries the primary link with src=email', body.includes(`${url}&src=email`));
check('carries the alternative link', body.includes(`${anyLink.url}&src=email`) && body.includes('Or instead:'));
check('offers the do-nothing and reply paths', body.includes('do nothing') && body.includes('reply to this email'));
check('links to the dashboard without a double slash', body.includes('https://fgac.ai/dashboard') && !body.includes('fgac.ai//dashboard'));
check('signs as FGAC with the support address', body.trimEnd().endsWith('— FGAC (support@fgac.ai)'));
check('is plain text (no markup)', !/<[a-z]+>/i.test(body));
check('empty agent label falls back', approvalEmailBody({ agentLabel: '', links: [link], times: 2, firstAskedAt: first, dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai' }).includes('Your AI agent asking 2 times'));
check('never mentions the user\'s own account as the sender', !/your own gmail/i.test(body));

console.log('denial line');
check('sent → repeat-request line', notifyDenialLine('sent', {}).startsWith('📧') && notifyDenialLine('sent', {}).includes('repeat request'));
check('already_sent → names the time in UTC', notifyDenialLine('already_sent', { notifiedAt: first }).includes('2026-09-14 13:05 UTC'));
check('already_sent without a stamp still reads', notifyDenialLine('already_sent', {}).includes('earlier'));
for (const s of ['not_due', 'skipped_opened', 'skipped_rate_capped', 'failed', 'disabled', 'skipped_no_links'] as const) {
  check(`${s} → no line`, notifyDenialLine(s, {}) === '');
}

console.log('policy constants');
check('cap is three per day', NOTIFY_MAX_PER_DAY === 3);
check('repeat gap is minutes, not seconds', NOTIFY_MIN_GAP_MS >= 60_000 && NOTIFY_MIN_GAP_MS <= 30 * 60_000);

console.log('raw message');
const raw = approvalEmailRaw({ from: 'support@fgac.ai', to: 'owner@example.com', subject, body });
check('From is FGAC at the support mailbox, Reply-To the same', raw.startsWith('From: FGAC <support@fgac.ai>\r\nReply-To: support@fgac.ai\r\nTo: owner@example.com\r\n'));
check('Subject then MIME headers then a blank line', /\r\nSubject: [^\r\n]+\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n/.test(raw));
check('non-ASCII subject is an RFC 2047 encoded word', /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/.test(raw));
check('the encoded word decodes back to the subject', Buffer.from(raw.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/)![1], 'base64').toString('utf8') === subject);
check('pure-ASCII headers are left readable', encodeHeaderWord('FGAC: plain') === 'FGAC: plain');
check('a CRLF in the recipient cannot add a header', !approvalEmailRaw({ from: 'support@fgac.ai', to: 'a@b.c\r\nBcc: x@y.z', subject: 's', body: '' }).includes('\r\nBcc'));
check('a CRLF in the sender cannot add a header', !approvalEmailRaw({ from: 's@example.com\r\nBcc: x@y.z', to: 'a@b.c', subject: 's', body: '' }).includes('\r\nBcc'));

console.log('account-refusal notice (trigger 2)');
check('threshold is 3 refusals in 24 h (plan v4 simulation)', ACCOUNT_REFUSAL_NOTIFY_AFTER === 3);
check('requested value is normalised like the access check', normalizeRequestedEmail('  Ops.Team@Example.COM ') === 'ops.team@example.com');
check('requested value is capped at 254', normalizeRequestedEmail('a'.repeat(300)).length === 254);
const refusalSubject = accountRefusalEmailSubject('ops@example.com\r\nBcc: victim@example.com');
check('subject names the refused account and cannot carry a header', refusalSubject.includes("'ops@example.com Bcc: victim@example.com'") && !/[\r\n]/.test(refusalSubject) && refusalSubject.length <= 160);
const refusalBody = accountRefusalEmailBody({
  agentLabel: 'Toolbox', requestedAccount: 'ops@example.com', usableAccounts: ['me@example.com'], ownerEmail: 'me@example.com',
  tool: 'sheets_read_range', times: 3, firstRefusedAt: new Date('2026-09-09T00:37:00Z'), dashboardUrl: 'https://fgac.ai/', supportAddress: 'support@fgac.ai',
});
check('body opens with the count, the first time and the tool', refusalBody.startsWith('FGAC has refused Toolbox 3 times since 2026-09-09 00:37 UTC (its sheets_read_range calls) because it asks for the Google account:'));
check('body names the refused account on its own line', refusalBody.includes('\n    ops@example.com\n'));
check('body lists the usable account (singular)', refusalBody.includes('The account it can use: me@example.com.'));
check('body says no approval link exists', refusalBody.includes('No approval link exists for this'));
check('body offers the task fix and the delegation fix with the accounts URL', refusalBody.includes('1. The task should use an account listed above') && refusalBody.includes('delegate access to me@example.com') && refusalBody.includes('https://fgac.ai/dashboard/accounts'));
check('body promises no repeat email for this account', refusalBody.includes('will not email you about this account again'));
check('body signs off with the support address', refusalBody.trimEnd().endsWith('— FGAC (support@fgac.ai)'));
const pluralBody = accountRefusalEmailBody({
  agentLabel: 'x'.repeat(200), requestedAccount: 'ops@example.com', usableAccounts: ['a@example.com', 'b@example.com'], ownerEmail: 'a@example.com',
  times: 5, firstRefusedAt: new Date('2026-09-09T00:37:00Z'), dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai',
});
check('body pluralises and omits the tool clause when unknown', pluralBody.includes('The accounts it can use: a@example.com, b@example.com.') && !pluralBody.includes('(its '));
check('agent label is capped', !pluralBody.includes('x'.repeat(100)));
check('refusal denial line: sent', accountRefusalDenialLine('sent', {}).startsWith('📧') && accountRefusalDenialLine('sent', {}).includes('emailed the user just now'));
check('refusal denial line: already_sent names the time', accountRefusalDenialLine('already_sent', { notifiedAt: new Date('2026-09-09T03:37:00Z') }).includes('at 2026-09-09 03:37 UTC'));
check('refusal denial line: nothing for not_due / disabled / failed / capped', ['not_due', 'disabled', 'failed', 'skipped_rate_capped'].every(s => accountRefusalDenialLine(s as never, {}) === ''));

if (failures) { console.error(`\n${failures} approval-notify copy check(s) failed`); process.exit(1); }
console.log('\nAll approval-notify copy checks passed');
