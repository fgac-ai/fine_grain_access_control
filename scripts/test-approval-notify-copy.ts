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
  approvalEmailBody, approvalEmailRaw, approvalEmailSubject, capitalize, emailLinkUrl, encodeHeaderWord, notifyBaseUrl, notifyDenialLine,
  sanitizeLine, shortGrant, signatureLine,
  ACCOUNT_REFUSAL_EPISODE_GAP_MS, ACCOUNT_REFUSAL_NOTIFY_AFTER, DELEGATION_HOWTO_PATH, NOTIFY_MAX_PER_DAY, NOTIFY_MIN_GAP_MS,
  PRODUCTION_SITE_URL, SUPPORT_CONTACT_ADDRESS, type NotifyLink,
} from '../src/lib/approvalNotifyCopy';
import { normalizeRequestedEmail } from '../src/lib/accountRefusals';
import { agentLabel, looksLikeId } from '../src/lib/agentLabel';

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
check('signs as FGAC support with the fixed support contact', body.trimEnd().endsWith('— FGAC support (support@fgac.ai)') && signatureLine() === `— FGAC support (${SUPPORT_CONTACT_ADDRESS})`);
check('is plain text (no markup)', !/<[a-z]+>/i.test(body));
check('empty agent label falls back', approvalEmailBody({ agentLabel: '', links: [link], times: 2, firstAskedAt: first, dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai' }).includes('your AI agent asking 2 times'));
check('never mentions the user\'s own account as the sender', !/your own gmail/i.test(body));
// A dev or preview build stands a QA account in for the support mailbox
// (Reply-To); the body must never render that address as who is writing.
const devSent = approvalEmailBody({ agentLabel: 'Claude', links: [link], times: 2, firstAskedAt: first, dashboardUrl: 'https://fgac.ai', supportAddress: 'qa-owner@example.com' });
check('a QA sender address never appears in the body', !devSent.includes('qa-owner@example.com') && devSent.includes('— FGAC support (support@fgac.ai)'));
check('a production-base body never links localhost', !/localhost|127\.0\.0\.1/.test(body));

console.log('notifyBaseUrl (what the emailed links are built on)');
check('trims the trailing slash', notifyBaseUrl('https://fgac.ai/', { VERCEL_ENV: 'production' }) === 'https://fgac.ai');
check('a preview host passes through', notifyBaseUrl('https://fgac-git-x.vercel.app', { VERCEL_ENV: 'preview' }) === 'https://fgac-git-x.vercel.app');
check('localhost in production becomes the canonical site', notifyBaseUrl('http://localhost:3000', { VERCEL_ENV: 'production' }) === PRODUCTION_SITE_URL);
check('loopback IP in production becomes the canonical site', notifyBaseUrl('http://127.0.0.1:3000/', { VERCEL_ENV: 'production' }) === PRODUCTION_SITE_URL);
check('empty base in production becomes the canonical site', notifyBaseUrl('', { VERCEL_ENV: 'production' }) === PRODUCTION_SITE_URL);
check('localhost on a dev build is left alone (QA reads it)', notifyBaseUrl('http://localhost:3000', {}) === 'http://localhost:3000');
check('a real host in production is never rewritten', notifyBaseUrl('https://fgac.ai', { VERCEL_ENV: 'production' }) === 'https://fgac.ai');

console.log('agentLabel (what the emails call the agent)');
check('an opaque client id is an id', looksLikeId('JkGUAFOdt9Ib0Q7J') && looksLikeId('72T5NfMmQXkq') && looksLikeId('cl_9aB8cD7eF6gH5iJ4'));
check('product names are not ids', !looksLikeId('claude-desktop') && !looksLikeId('Claude Code') && !looksLikeId('cursor') && !looksLikeId('Nightly digest'));
check('nickname wins and carries the profile', agentLabel({ nickname: 'Nightly digest', clientName: 'Claude', clientId: 'abc', profileLabel: 'Default Profile' }) === 'Nightly digest on the Default Profile');
check('client name becomes "your <client> agent"', agentLabel({ nickname: null, clientName: 'Claude', clientId: 'abc', profileLabel: 'Default Profile' }) === 'your Claude agent on the Default Profile');
check('a client name that is still the client id is never rendered', agentLabel({ nickname: null, clientName: 'JkGUAFOdt9Ib0Q7J', clientId: 'JkGUAFOdt9Ib0Q7J', profileLabel: 'Default Profile' }) === 'your AI agent on the Default Profile');
check('an id-shaped client name is caught even when the id is unknown', agentLabel({ nickname: null, clientName: 'JkGUAFOdt9Ib0Q7J', profileLabel: null }) === 'your AI agent');
check('an id-shaped nickname falls through to the client', agentLabel({ nickname: '72T5NfMmQXkq', clientName: 'Claude Desktop', clientId: 'x', profileLabel: null }) === 'your Claude Desktop agent');
check('a profile label without "Profile" gets the word', agentLabel({ nickname: null, clientName: 'Claude', clientId: 'x', profileLabel: 'Work inbox' }) === 'your Claude agent on the Work inbox profile');
check('nothing known → generic', agentLabel({ nickname: null, clientName: null, clientId: 'x', profileLabel: null }) === 'your AI agent');
check('capitalize for a sentence start', capitalize('your Claude agent') === 'Your Claude agent' && capitalize('') === '');
const labelled = approvalEmailBody({ agentLabel: agentLabel({ nickname: null, clientName: 'Claude', clientId: 'x', profileLabel: 'Default Profile' }), links: [link], times: 2, firstAskedAt: first, dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai' });
check('the reminder reads as a sentence with the label', labelled.startsWith('FGAC has detected your Claude agent on the Default Profile asking 2 times, without approval, to:'));

console.log('denial line');
check('sent → repeat-request line', notifyDenialLine('sent', {}).startsWith('📧') && notifyDenialLine('sent', {}).includes('repeat request'));
check('already_sent → names the time in UTC', notifyDenialLine('already_sent', { notifiedAt: first }).includes('2026-09-14 13:05 UTC'));
check('already_sent without a stamp still reads', notifyDenialLine('already_sent', {}).includes('earlier'));
for (const s of ['not_due', 'skipped_opened', 'skipped_rate_capped', 'skipped_burst', 'failed', 'disabled', 'skipped_no_links'] as const) {
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
check('body links the delegation walkthrough video next to the delegation fix', refusalBody.includes(`How delegation works, in two minutes (video): https://fgac.ai${DELEGATION_HOWTO_PATH}`) && refusalBody.indexOf(DELEGATION_HOWTO_PATH) > refusalBody.indexOf('2. The task really should use'));
check('the video path is the multiple-accounts use case page', DELEGATION_HOWTO_PATH === '/use-cases/multiple-gmail-accounts');
check('body promises no repeat email for this account', refusalBody.includes('will not email you about this account again'));
check('body signs off as FGAC support with the fixed contact', refusalBody.trimEnd().endsWith('— FGAC support (support@fgac.ai)'));
check('body never links localhost with a production base', !/localhost/.test(refusalBody));
const humanRefusal = accountRefusalEmailBody({
  agentLabel: agentLabel({ nickname: null, clientName: 'JkGUAFOdt9Ib0Q7J', clientId: 'JkGUAFOdt9Ib0Q7J', profileLabel: 'Default Profile' }),
  requestedAccount: 'ops@example.com', usableAccounts: ['me@example.com'], ownerEmail: 'me@example.com',
  tool: 'sheets_read_range', times: 3, firstRefusedAt: new Date('2026-09-23T02:03:00Z'), dashboardUrl: 'https://fgac.ai', supportAddress: 'qa-owner@example.com',
});
check('the 2026-09-23 email now names the agent by profile, not by id', humanRefusal.startsWith('FGAC has refused your AI agent on the Default Profile 3 times since 2026-09-23 02:03 UTC') && !humanRefusal.includes('JkGUAFOdt9Ib0Q7J'));
check('the 2026-09-23 email never shows the QA sender as the signature', !humanRefusal.includes('qa-owner@example.com') && humanRefusal.includes('— FGAC support (support@fgac.ai)'));
const pluralBody = accountRefusalEmailBody({
  agentLabel: 'x'.repeat(200), requestedAccount: 'ops@example.com', usableAccounts: ['a@example.com', 'b@example.com'], ownerEmail: 'a@example.com',
  times: 5, firstRefusedAt: new Date('2026-09-09T00:37:00Z'), dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai',
});
check('body pluralises and omits the tool clause when unknown', pluralBody.includes('The accounts it can use: a@example.com, b@example.com.') && !pluralBody.includes('(its '));
check('agent label is capped', !pluralBody.includes('x'.repeat(100)));
check('refusal denial line: sent', accountRefusalDenialLine('sent', {}).startsWith('📧') && accountRefusalDenialLine('sent', {}).includes('emailed the user just now'));
check('refusal denial line: already_sent names the time', accountRefusalDenialLine('already_sent', { notifiedAt: new Date('2026-09-09T03:37:00Z') }).includes('at 2026-09-09 03:37 UTC'));
check('refusal denial line: nothing for not_due / disabled / failed / capped', ['not_due', 'disabled', 'failed', 'skipped_rate_capped'].every(s => accountRefusalDenialLine(s as never, {}) === ''));
check('refusal denial line: nothing for skipped_episode (the refusal text already names the value)', accountRefusalDenialLine('skipped_episode', {}) === '');
check('one refusal email per owner per 14-day episode', ACCOUNT_REFUSAL_EPISODE_GAP_MS === 14 * 24 * 60 * 60_000);

if (failures) { console.error(`\n${failures} approval-notify copy check(s) failed`); process.exit(1); }
console.log('\nAll approval-notify copy checks passed');
