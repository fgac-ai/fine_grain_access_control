/**
 * Pins the database-free half of the bounce suppression feature
 * (src/lib/emailBounceParse.ts, src/lib/googleTokenFailure.ts undeliverableGuidance,
 * src/lib/approvalNotifyCopy.ts X-FGAC-Notice):
 *   - a DSN in the shape Google's MTA returned on 2026-09-23 (5.1.3 "does not
 *     exist") parses to its Final-Recipient, Status, Action, Diagnostic-Code,
 *     and the echoed notice header, through header folding
 *   - the class map: 5.1.x / 5.2.1 = mailbox_gone, other 5.x = rejected,
 *     4.x / non-failed = transient, non-DSN mail = null
 *   - every outgoing notice carries `X-FGAC-Notice: <kind>` so its bounce can
 *     be attributed without guessing from the subject
 *   - the agent text for a gone mailbox has NO reconnect link and says stop /
 *     remove the account; for a rejecting mailbox the link stays and the agent
 *     is told the owner was NOT reached
 * The sweep and the claims import the proxy route and the database and are
 * exercised by capability 18 A14 / A15, not here.
 * Run: npx tsx scripts/test-email-bounces.ts (part of `npm run mcp:lint`).
 */
import { classifyBounce, normalizeBounceAddress, parseDsn, SUPPRESSING_CLASSES } from '../src/lib/emailBounceParse';
import { undeliverableGuidance } from '../src/lib/googleTokenFailure';
import { approvalEmailRaw, NOTICE_HEADER } from '../src/lib/approvalNotifyCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

// Addresses assembled from parts so the public-repo email guard stays quiet
// and nothing here resembles a real recipient.
const gone = ['deleted-user', 'example.com'].join('@');
const support = ['support', 'example.com'].join('@');
const keyOwner = ['delegate', 'example.com'].join('@');
const daemon = ['mailer-daemon', 'googlemail.com'].join('@');
const reconnect = `https://fgac.ai/dashboard/accounts?reconnect=1&for=${encodeURIComponent(gone)}`;
const bouncedAt = new Date('2026-09-23T22:10:40Z');

// The 09-23 shape: multipart/report from Google's MTA, delivery-status part
// with folded Diagnostic-Code, original headers echoed (with our tag).
const googleDsn = [
  'Delivered-To: ' + support,
  'From: Mail Delivery Subsystem <' + daemon + '>',
  'To: ' + support,
  'Subject: Delivery Status Notification (Failure)',
  'Content-Type: multipart/report; boundary="b1"; report-type=delivery-status',
  '',
  '--b1',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'Address not found. Your message wasn\'t delivered.',
  '--b1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; googlemail.com',
  'Received-From-MTA: dns; ' + support,
  'Arrival-Date: Tue, 23 Sep 2026 15:10:38 -0700 (PDT)',
  '',
  'Final-Recipient: rfc822; ' + gone.toUpperCase(),
  'Action: failed',
  'Status: 5.1.3',
  'Diagnostic-Code: smtp; 550-5.1.3 The email account that you tried to reach does',
  ' not exist. Please try double-checking the recipient\'s email address for',
  ' typos or unnecessary spaces.',
  'Last-Attempt-Date: Tue, 23 Sep 2026 15:10:40 -0700 (PDT)',
  '--b1',
  'Content-Type: message/rfc822',
  '',
  'From: FGAC <' + support + '>',
  'Reply-To: ' + support,
  'To: ' + gone,
  'Subject: Google access is disconnected',
  `${NOTICE_HEADER}: dead_grant`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'body',
  '--b1--',
].join('\r\n');

console.log('parseDsn — the 09-23 shape');
const parsed = parseDsn(googleDsn);
check('parses', parsed !== null);
if (parsed) {
  check('Final-Recipient lower-cased', parsed.recipient === gone);
  check('Action failed', parsed.action === 'failed');
  check('Status 5.1.3', parsed.status === '5.1.3');
  check('Diagnostic unfolded onto one line, ≤ 200 chars',
    parsed.diagnostic !== null && parsed.diagnostic.includes('does not exist') && !parsed.diagnostic.includes('\n') && parsed.diagnostic.length <= 200);
  check('Reporting-MTA is Google', parsed.reportingMta === 'dns; googlemail.com');
  check('echoed notice header attributed to dead_grant', parsed.noticeKind === 'dead_grant');
  check('original From is the support address, not the daemon', parsed.originalFrom === support);
}

console.log('parseDsn — not a DSN');
check('a plain reply from a postmaster is null', parseDsn('From: postmaster@example.com\r\nSubject: hi\r\n\r\nhello') === null);
check('an unknown notice header value is dropped, not trusted',
  parseDsn(googleDsn.replace(`${NOTICE_HEADER}: dead_grant`, `${NOTICE_HEADER}: something_else`))?.noticeKind === null);
check('a text/rfc822-headers echo (no header block for the original) still parses',
  parseDsn(googleDsn.replace('Content-Type: message/rfc822', 'Content-Type: text/rfc822-headers'))?.recipient === gone);

console.log('classifyBounce');
check('5.1.3 failed → mailbox_gone', classifyBounce('failed', '5.1.3') === 'mailbox_gone');
check('5.1.1 failed → mailbox_gone', classifyBounce('failed', '5.1.1') === 'mailbox_gone');
check('5.2.1 (disabled) failed → mailbox_gone', classifyBounce('failed', '5.2.1') === 'mailbox_gone');
check('5.7.1 (policy) failed → rejected', classifyBounce('failed', '5.7.1') === 'rejected');
check('5.2.2 (over quota) failed → rejected', classifyBounce('failed', '5.2.2') === 'rejected');
check('4.4.1 delayed → transient', classifyBounce('delayed', '4.4.1') === 'transient');
check('5.x.x but Action delayed → transient (not a final failure)', classifyBounce('delayed', '5.1.1') === 'transient');
check('2.0.0 relayed → transient (never suppresses)', classifyBounce('relayed', '2.0.0') === 'transient');
check('garbage status → null', classifyBounce('failed', 'nope') === null);
check('only mailbox_gone and rejected suppress', SUPPRESSING_CLASSES.length === 2 && SUPPRESSING_CLASSES.includes('mailbox_gone') && SUPPRESSING_CLASSES.includes('rejected'));
check('address normalisation trims, lowercases, caps at 254', normalizeBounceAddress('  ' + gone.toUpperCase() + '  ') === gone && normalizeBounceAddress('a'.repeat(300)).length === 254);

console.log('X-FGAC-Notice on outgoing notices');
const raw = approvalEmailRaw({ from: support, to: gone, subject: 's', body: 'b', notice: 'dead_grant' });
check('header emitted before the body', raw.includes(`\r\n${NOTICE_HEADER}: dead_grant\r\n`) && raw.indexOf(NOTICE_HEADER) < raw.indexOf('\r\n\r\n'));
check('absent when no kind is given', !approvalEmailRaw({ from: support, to: gone, subject: 's', body: 'b' }).includes(NOTICE_HEADER));
check('the sweep can read its own header back', parseDsn(googleDsn)?.noticeKind === 'dead_grant');

console.log('undeliverableGuidance — mailbox_gone');
const goneOwn = undeliverableGuidance({
  targetEmail: gone, keyOwnerEmail: gone, reason: 'grant_revoked', bounceClass: 'mailbox_gone',
  dsnStatus: '5.1.3', bouncedAt, reconnectUrl: reconnect, dashboardUrl: 'https://fgac.ai/',
});
check('is a 🚫 refusal with the same denial code', goneOwn.text.startsWith('🚫') && goneOwn.denialCode === 'google_token_unavailable');
check('names the mailbox and says it no longer exists', goneOwn.text.includes(`'${gone}' no longer exists`));
check('quotes the DSN code and date', goneOwn.text.includes('(5.1.3)') && goneOwn.text.includes('2026-09-23'));
check('says STOP and that retrying will not help', /STOP/.test(goneOwn.text) && /retrying will NOT help/.test(goneOwn.text));
check('carries NO reconnect link', !goneOwn.text.includes('reconnect=1') && !goneOwn.text.includes(reconnect));
check('tells the agent not to hand out a link', /do not give the user a reconnect link/i.test(goneOwn.text));
check('own mailbox: remove from task and from the key\'s accounts, new address = new sign-in',
  /from this key's accounts/.test(goneOwn.text) && /sign in to FGAC with that address/.test(goneOwn.text) && goneOwn.text.includes('https://fgac.ai/dashboard/accounts'));
const goneDelegated = undeliverableGuidance({
  targetEmail: gone, keyOwnerEmail: keyOwner, reason: 'grant_revoked', bounceClass: 'mailbox_gone',
  dsnStatus: '', bouncedAt, reconnectUrl: reconnect, dashboardUrl: 'https://fgac.ai',
});
check('delegated: names the delegate and the delegation, no link', goneDelegated.text.includes(`'${keyOwner}'`) && /delegation/.test(goneDelegated.text) && !goneDelegated.text.includes('reconnect=1'));
check('an unknown DSN code adds no empty parentheses', !goneDelegated.text.includes('()'));

console.log('undeliverableGuidance — rejected');
const rej = undeliverableGuidance({
  targetEmail: gone, keyOwnerEmail: gone, reason: 'grant_revoked', bounceClass: 'rejected',
  dsnStatus: '5.7.1', bouncedAt, reconnectUrl: reconnect, dashboardUrl: 'https://fgac.ai',
});
check('still a 🚫 refusal', rej.text.startsWith('🚫') && rej.denialCode === 'google_token_unavailable');
check('keeps the reconnect link', rej.text.includes(reconnect));
check('says the owner was NOT told and to relay the link', /has NOT been told/.test(rej.text) && /relay the fix yourself/.test(rej.text));
check('says FGAC will not email that address again', /will not email that address again/.test(rej.text));
check('quotes the DSN code', rej.text.includes('(5.7.1)'));
const rejDelegated = undeliverableGuidance({
  targetEmail: gone, keyOwnerEmail: keyOwner, reason: 'refresh_failed', bounceClass: 'rejected',
  dsnStatus: '5.7.1', bouncedAt, reconnectUrl: reconnect, dashboardUrl: 'https://fgac.ai',
});
check('delegated rejected: forward to the owner, link kept', /forward this one-click link to the owner/.test(rejDelegated.text) && rejDelegated.text.includes(reconnect));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
