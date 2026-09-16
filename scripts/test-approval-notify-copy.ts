/**
 * Pins the approval-link reminder email (src/lib/approvalNotifyCopy.ts) and
 * the decision logic of src/lib/approvalNotify.ts that does not need a
 * database:
 *   - agent-controlled strings cannot inject mail headers or run past the cap
 *   - the emailed URL carries `src=email` after the signed params, untouched
 *   - the denial line exists only for `sent` / `already_sent`
 *   - the sender is FGAC's own mailbox from the environment; no sender = off
 * The repeat/cap/claim logic needs the ledger table and is exercised
 * end-to-end by capability 14 A16.
 * Run: npx tsx scripts/test-approval-notify-copy.ts (part of `npm run mcp:lint`).
 */
import {
  approvalEmailBody, approvalEmailSubject, emailLinkUrl, notifyDenialLine, sanitizeLine, shortGrant,
  NOTIFY_MAX_PER_DAY, NOTIFY_MIN_GAP_MS, type NotifyLink,
} from '../src/lib/approvalNotifyCopy';
import { senderConfig } from '../src/lib/approvalNotify';

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

console.log('sender config');
check('no credentials → off', senderConfig({}) === null);
check('kill switch wins', senderConfig({ APPROVAL_LINK_EMAIL: 'off', SUPPORT_SMTP_USER: 'support@fgac.ai', SUPPORT_SMTP_APP_PASSWORD: 'x' }) === null);
check('address without @ → off', senderConfig({ SUPPORT_SMTP_USER: 'support', SUPPORT_SMTP_APP_PASSWORD: 'x' }) === null);
const cfg = senderConfig({ SUPPORT_SMTP_USER: ' support@fgac.ai ', SUPPORT_SMTP_APP_PASSWORD: ' abcd efgh ' });
check('both present → sender, trimmed', cfg?.address === 'support@fgac.ai' && cfg?.appPassword === 'abcd efgh');

if (failures) { console.error(`\n${failures} approval-notify copy check(s) failed`); process.exit(1); }
console.log('\nAll approval-notify copy checks passed');
