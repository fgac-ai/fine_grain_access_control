/**
 * Pins the dead-grant owner notice (src/lib/googleGrantNotifyCopy.ts) and the
 * database-free half of its trigger (`grantNoticeDue`):
 *   - the FIRST failure of an episode is due (the two owners who never
 *     recovered in production each got exactly one refusal — a second-failure
 *     rule would have emailed neither) and nothing after it is: one notice
 *     per episode (Ken, 2026-09-21)
 *   - the global hourly circuit breaker is a sane constant
 *   - the subject and body name the mailbox, the cause, the owner-bound
 *     reconnect link and who may open it; a delegated notice addresses the
 *     CC'd key owner and says nothing on their own page fixes it
 *   - agent-controlled strings cannot inject headers; the raw message carries
 *     a Cc only when asked
 *   - the agent-facing 📧 line exists only for `sent` / `already_sent`
 * The claim/cap/send path imports the proxy route (database-backed) and is
 * exercised end-to-end by capability 18 A13, not here.
 * Run: npx tsx scripts/test-google-grant-notify-copy.ts (part of `npm run mcp:lint`).
 */
import {
  daysDead, deadGrantCause, deadGrantDenialLine, deadGrantEmailBody, deadGrantEmailSubject, grantNoticeDue, normalizeAccountEmail,
  GRANT_DEAD_EPISODE_GAP_MS, GRANT_DEAD_GLOBAL_HOURLY_MAX, GRANT_DEAD_NOTICES_PER_EPISODE,
} from '../src/lib/googleGrantNotifyCopy';
import { approvalEmailRaw, NOTIFY_MAX_PER_DAY } from '../src/lib/approvalNotifyCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const DAY = 86_400_000;
const now = new Date('2026-09-20T13:25:00Z');
const reconnect = 'https://fgac.ai/dashboard/accounts?reconnect=1&for=owner%40example.com';

console.log('policy constants');
check('exactly one notice per episode', GRANT_DEAD_NOTICES_PER_EPISODE === 1);
check('episode gap is two weeks (a daily job never resets itself)', GRANT_DEAD_EPISODE_GAP_MS === 14 * DAY);
check('global circuit breaker is 10 notices per hour across all owners', GRANT_DEAD_GLOBAL_HOURLY_MAX === 10);
check('daily cap shared with the other notices is 3', NOTIFY_MAX_PER_DAY === 3);

console.log('grantNoticeDue');
check('first failure of an episode is due', grantNoticeDue({ notifiedCount: 0, notifiedAt: null }));
check('same-day repeat is not due', !grantNoticeDue({ notifiedCount: 1, notifiedAt: new Date(now.getTime() - DAY) }));
check('a week later is still not due (one per episode)', !grantNoticeDue({ notifiedCount: 1, notifiedAt: new Date(now.getTime() - 7 * DAY) }));
check('ninety days later, same episode, still not due', !grantNoticeDue({ notifiedCount: 1, notifiedAt: new Date(now.getTime() - 90 * DAY) }));
check('a reset episode (count 0, stamp cleared) is due again', grantNoticeDue({ notifiedCount: 0, notifiedAt: null }));

console.log('daysDead / normalize');
check('same day is 0', daysDead(new Date(now.getTime() - 3600_000), now) === 0);
check('30 days is 30', daysDead(new Date(now.getTime() - 30 * DAY - 1000), now) === 30);
check('never negative', daysDead(new Date(now.getTime() + DAY), now) === 0);
check('account email lower-cased and trimmed', normalizeAccountEmail('  Owner@Example.COM ') === 'owner@example.com');

console.log('subject');
const ownSubject = deadGrantEmailSubject({ accountEmail: 'owner@example.com', delegated: false });
check('own-mailbox subject names the account and the agent being refused', /owner@example\.com/.test(ownSubject) && /your agent is being refused/.test(ownSubject));
const delSubject = deadGrantEmailSubject({ accountEmail: 'owner@example.com', delegated: true });
check('delegated subject says "an agent you delegated to"', /is disconnected — an agent you delegated to is being refused/.test(delSubject));
check('subject strips CR/LF from the account', !/[\r\n]/.test(deadGrantEmailSubject({ accountEmail: 'x\r\nBcc: victim@example.com', delegated: false })));

console.log('cause copy mirrors the agent-facing taxonomy');
check('grant_revoked names Google revoking / password change', /revoked/.test(deadGrantCause('grant_revoked')) && /password/.test(deadGrantCause('grant_revoked')));
check('refresh_failed names the refresh token', /refresh token/.test(deadGrantCause('refresh_failed')));
check('no_token names a removed or never-completed connection', /removed|never completed/.test(deadGrantCause('no_token')));

console.log('body — own mailbox, first day');
const own = deadGrantEmailBody({
  accountEmail: 'owner@example.com', reason: 'grant_revoked', delegated: false, keyOwnerEmail: 'owner@example.com',
  agentLabel: 'Claude', reconnectUrl: reconnect, failureCount: 1, firstFailedAt: new Date('2026-09-20T13:20:00Z'),
  dashboardUrl: 'https://fgac.ai/', supportAddress: 'support@fgac.ai', now,
});
check('opens with the agent and "refused today"', own.startsWith('Claude has been refused today (first at 2026-09-20 13:20 UTC) because FGAC can no longer reach Google on behalf of:'));
check('names the mailbox on its own line', own.includes('\n    owner@example.com\n'));
check('carries the reconnect link exactly as minted', own.includes(`\n${reconnect}\n`));
check('says who may open it', own.includes('Open the link while signed in to FGAC as owner@example.com; it will not run for any other account.'));
check('says the agent was told to stop retrying', /told to stop retrying/.test(own));
check('tells a fast self-recoverer to ignore it', /If you have already reconnected, no action is needed/.test(own));
check('no delegate paragraph on an own-mailbox notice', !/copied on this email/.test(own));
check('says it is the only email unless the grant is repaired and dies again', /This is the only email FGAC will send about this account unless it is repaired and disconnects again/.test(own));
check('never promises a repeat', !/again only if|at most|in a week/.test(own));
check('offers "do nothing" as the decline path', /do nothing — the agent stays refused/.test(own));
check('links the Accounts page with the trailing slash trimmed', own.includes('Connected accounts: https://fgac.ai/dashboard/accounts'));
check('signs off as FGAC support with the fixed contact', own.endsWith('— FGAC support (support@fgac.ai)'));
const labelled = deadGrantEmailBody({
  accountEmail: 'owner@example.com', reason: 'grant_revoked', delegated: false, keyOwnerEmail: 'owner@example.com',
  agentLabel: 'your Claude agent on the Default Profile', reconnectUrl: reconnect, failureCount: 1, firstFailedAt: new Date('2026-09-20T13:20:00Z'),
  dashboardUrl: 'https://fgac.ai/', supportAddress: 'qa-owner@example.com', now,
});
check('a lower-case label is capitalised at the sentence start', labelled.startsWith('Your Claude agent on the Default Profile has been refused today'));
check('a QA sender address never appears in the body', !labelled.includes('qa-owner@example.com'));
check('never links localhost with a production base', !/localhost/.test(labelled));

console.log('body — delegated mailbox, day 15');
const del = deadGrantEmailBody({
  accountEmail: 'owner@example.com', reason: 'refresh_failed', delegated: true, keyOwnerEmail: 'delegate@example.org',
  agentLabel: 'Nightly digest', reconnectUrl: reconnect, failureCount: 15, firstFailedAt: new Date(now.getTime() - 15 * DAY),
  dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai', now,
});
check('names the delegate and the delegation in the first line', del.startsWith('Nightly digest, run by delegate@example.org under the mailbox access you delegated, has been refused 15 times since 2026-09-05 13:25 UTC — 15 days so far because'));
check('addresses the CC\'d delegate: not their grant, nothing on their page fixes it', /delegate@example\.org \(copied on this email\): this is the mailbox owner's grant, not yours — nothing on your own Accounts page fixes it/.test(del));
check('tells the delegate which runs are affected', /every run that touches that mailbox will be refused; your other mailboxes are unaffected/.test(del));
check('delegated body also says it is the only email', /This is the only email FGAC will send about this account/.test(del));
check('refresh_failed cause is stated', /no usable refresh token/.test(del));

console.log('body — header-safe agent label, one-week wording');
const second = deadGrantEmailBody({
  accountEmail: 'owner@example.com', reason: 'no_token', delegated: false, keyOwnerEmail: 'owner@example.com',
  agentLabel: 'x\r\nBcc: victim@example.com', reconnectUrl: reconnect, failureCount: 8, firstFailedAt: new Date(now.getTime() - 7 * DAY - 1000),
  dashboardUrl: 'https://fgac.ai', supportAddress: 'support@fgac.ai', now,
});
check('agent label is header-safe in the body', !/\r|\nBcc/.test(second) && /X Bcc: victim@example.com has been refused/.test(second));
check('one-week wording: "8 times since … — 7 days so far"', /8 times since .* — 7 days so far/.test(second));

console.log('raw message');
const rawCc = approvalEmailRaw({ from: 'support@fgac.ai', to: 'owner@example.com', cc: 'delegate@example.org', subject: 'S', body: 'B' });
check('Cc header present when given, after To', /\r\nTo: owner@example\.com\r\nCc: delegate@example\.org\r\nSubject: S\r\n/.test(rawCc));
const rawNoCc = approvalEmailRaw({ from: 'support@fgac.ai', to: 'owner@example.com', cc: null, subject: 'S', body: 'B' });
check('no Cc header when null', !/Cc:/.test(rawNoCc));
check('Cc cannot inject a header', !/\r\nBcc/.test(approvalEmailRaw({ from: 'support@example.com', to: 'owner@example.com', cc: 'delegate@example.org\r\nBcc: victim@example.com', subject: 'S', body: 'B' })));

console.log('denial line');
check('sent, own mailbox → emailed the user, do not re-ask', /📧 FGAC has also emailed the user just now/.test(deadGrantDenialLine('sent', { delegated: false })) && /do not re-ask/.test(deadGrantDenialLine('sent', { delegated: false })));
check('sent, delegated with CC → names the owner and the copy', /emailed the owner of the mailbox \(and copied this user\) just now/.test(deadGrantDenialLine('sent', { delegated: true, ccDelegate: true })));
check('already_sent carries the stamp', deadGrantDenialLine('already_sent', { notifiedAt: new Date('2026-09-13T13:25:00Z'), delegated: false }).includes('at 2026-09-13 13:25 UTC'));
check('already_sent says no further email while it keeps failing', /no further email is sent while it keeps failing/.test(deadGrantDenialLine('already_sent', { notifiedAt: null, delegated: false })));
for (const st of ['not_due', 'skipped_rate_capped', 'skipped_global_capped', 'failed', 'disabled']) {
  check(`${st} adds nothing`, deadGrantDenialLine(st, { delegated: false }) === '');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll google-grant-notify-copy checks passed.');
