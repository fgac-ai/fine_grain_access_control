/**
 * Unit tests for agent-facing denial copy (src/lib/denialCopy.ts).
 * Run: npx tsx scripts/test-denial-copy.ts  (part of `npm run mcp:lint`)
 *
 * The invariants:
 *   - every builder keeps its outcome prefix (🚫 / ❌) as the FIRST characters,
 *     because classifyToolOutcome in route.ts sniffs it — appended guidance
 *     that moved or replaced the prefix would silently reclassify the call;
 *   - every refusal tells the agent NOT to retry, and says who can change it;
 *   - link-carrying denials say the link does not change on retry;
 *   - the account refusal lists the usable accounts, states both fixes (omit
 *     or pass a listed address), and addresses the scheduled-task case —
 *     the one caller that measured as immune to guidance (2026-09-09 → 11);
 *   - an upstream 404 names the account it ran against, and the
 *     cross-mailbox hint appears ONLY when the key reaches other mailboxes,
 *     names them, and states the fix as `account: '<address>'` (the
 *     wrong-mailbox retry loop, 2026-09-12 → 13).
 */
import {
  AGENT_APPROVAL_PROTOCOL, NO_LINK_STOP, LINK_UNAVAILABLE_STOP, SEND_DISABLED_MESSAGE,
  withNoLinkStop, withLinkUnavailableStop, recipientNotWhitelistedMessage,
  accountNotPermittedByCaller, accountNotPermittedByDefault,
  googleNotFoundMessage, crossMailboxHint,
} from '../src/lib/denialCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

/** Mirrors classifyToolOutcome's prefix sniff (route.ts). */
function outcomeOf(text: string): string {
  if (text.startsWith('⏳')) return 'pending_approval';
  if (text.startsWith('🚫')) return 'denied_by_policy';
  if (text.startsWith('⚠️')) return 'size_capped';
  if (text.startsWith('❌')) return 'failed';
  return 'success';
}
const saysDoNotRetry = (t: string) => /do not retry|Do NOT retry/i.test(t);

console.log('AGENT_APPROVAL_PROTOCOL:');
check('says to show the link verbatim', /VERBATIM/.test(AGENT_APPROVAL_PROTOCOL));
check('says not to retry until the user approved', /Do NOT retry the denied call until the user says they approved/.test(AGENT_APPROVAL_PROTOCOL));
check('says the link does not change on retry', /SAME link/.test(AGENT_APPROVAL_PROTOCOL) && /does not change/.test(AGENT_APPROVAL_PROTOCOL));
check('says the link does not expire', /does not expire/.test(AGENT_APPROVAL_PROTOCOL));
check('still carries the file-name instruction (4)', /request_access with resourceName/.test(AGENT_APPROVAL_PROTOCOL));
check('carries no emoji prefix of its own (it is appended, never first)', outcomeOf(AGENT_APPROVAL_PROTOCOL) === 'success');

console.log('SEND_DISABLED_MESSAGE:');
check('classifies as denied_by_policy', outcomeOf(SEND_DISABLED_MESSAGE) === 'denied_by_policy');
check('keeps the original refusal sentence first', SEND_DISABLED_MESSAGE.startsWith('🚫 Sending is disabled on this profile (no send whitelist configured). This is the safe default.'));
check('says the refusal covers every recipient', /ANY recipient/.test(SEND_DISABLED_MESSAGE));
check('says not to retry this message', saysDoNotRetry(SEND_DISABLED_MESSAGE));
check('tells the agent to hold the rest of a batch', /hold any other messages/.test(SEND_DISABLED_MESSAGE));
check('points at the links that follow', /links below/.test(SEND_DISABLED_MESSAGE));

console.log('recipientNotWhitelistedMessage:');
const rnw = recipientNotWhitelistedMessage('someone@example.com');
check('classifies as denied_by_policy', outcomeOf(rnw) === 'denied_by_policy');
check('names the recipient', rnw.includes("'someone@example.com'"));
check('keeps the original refusal sentence first', rnw.startsWith("🚫 Unauthorized recipient. 'someone@example.com' is not in the send whitelist."));
check('says not to retry', saysDoNotRetry(rnw));
check('points at the links that follow', /links below/.test(rnw));

console.log('withNoLinkStop (explicit blocks):');
const blocked = withNoLinkStop("🚫 Access Denied: Access to sheet 'abc' is explicitly blocked.");
check('classifies as denied_by_policy', outcomeOf(blocked) === 'denied_by_policy');
check('keeps the refusal sentence first', blocked.startsWith("🚫 Access Denied: Access to sheet 'abc' is explicitly blocked. "));
check('says STOP and not to retry', /STOP/.test(blocked) && saysDoNotRetry(blocked));
check('says there is no approval link', /no approval link/.test(NO_LINK_STOP));
check('says only the user can change it, and where', /Only the user can change this/.test(NO_LINK_STOP) && /FGAC dashboard/.test(NO_LINK_STOP));
check('appends exactly once', blocked.split(NO_LINK_STOP).length === 2);

console.log('withLinkUnavailableStop (mint failure):');
const noLink = withLinkUnavailableStop(SEND_DISABLED_MESSAGE);
check('classifies as denied_by_policy', outcomeOf(noLink) === 'denied_by_policy');
check('keeps the refusal first', noLink.startsWith(SEND_DISABLED_MESSAGE));
check('forbids a retry loop', /Do not retry the denied call in a loop/.test(LINK_UNAVAILABLE_STOP));
check('offers request_access once and the dashboard', /request_access ONCE/.test(LINK_UNAVAILABLE_STOP) && /FGAC dashboard/.test(LINK_UNAVAILABLE_STOP));
check('standalone constant has no prefix (it is pushed as its own line)', outcomeOf(LINK_UNAVAILABLE_STOP) === 'success');

console.log('accountNotPermittedByCaller (explicit account → 🚫):');
const byCaller = accountNotPermittedByCaller('wrong@example.com', 'a@example.com, b@example.com');
check('classifies as denied_by_policy', outcomeOf(byCaller) === 'denied_by_policy');
check('names the refused account', byCaller.includes("'wrong@example.com'"));
check('lists the usable accounts', byCaller.includes('Accounts it can use: a@example.com, b@example.com.'));
check('states both fixes: omit the parameter, or pass a listed address', /Omit the "account" parameter/.test(byCaller) && /pass one of the listed addresses/.test(byCaller));
check('says not to retry with the same value', /Do not retry with 'wrong@example.com'/.test(byCaller));
check('says no approval link exists and who can add an account', /no approval link exists/.test(byCaller) && /only the user can add an account/.test(byCaller));
check('addresses the scheduled-task caller', /scheduled or automated task/.test(byCaller) && /correct the task itself/.test(byCaller));

console.log('accountNotPermittedByDefault (no account given → ❌):');
const byDefault = accountNotPermittedByDefault('owner@example.com', 'a@example.com');
check('classifies as failed (unchanged class)', outcomeOf(byDefault) === 'failed');
check('keeps the original sentence first', byDefault.startsWith("❌ This proxy key does not have access to 'owner@example.com'. Accessible: a@example.com."));
check('says to pass an accessible address', /Pass one of the accessible addresses as "account"/.test(byDefault));
check('says the user can add the owner address in the dashboard', /add 'owner@example.com' to this key's accounts/.test(byDefault));
check('says retrying unchanged fails', /Retrying unchanged fails/.test(byDefault));

console.log('googleNotFoundMessage (upstream 404 names the account):');
const nf = googleNotFoundMessage('Requested entity was not found', 'owner@example.com');
check('classifies as failed (unchanged class)', outcomeOf(nf) === 'failed');
check('keeps the original sentence first, detail attached', nf.startsWith('❌ Google resource not found (404): Requested entity was not found. '));
check('names the account the call ran against', nf.includes("not visible to 'owner@example.com' — the account this call ran against"));
check('says to verify against a fresh listing on that account', /fresh listing on that account/.test(nf));
check('says the same id unchanged will 404 again', /same id unchanged will 404 again/.test(nf));
const nfBare = googleNotFoundMessage('', '');
check('no detail → no dangling colon', nfBare.startsWith('❌ Google resource not found (404). '));
check('no account known → falls back to "this account"', /not visible to this account/.test(nfBare));

console.log('crossMailboxHint (only when other mailboxes exist):');
check('single-mailbox key → empty string (message unchanged)', crossMailboxHint([]) === '');
const one = crossMailboxHint(['shared@example.com']);
check('carries no outcome prefix (it is appended, never first)', outcomeOf(one) === 'success');
check('counts and names the other mailbox', one.startsWith("This connection can also reach 1 other mailbox: shared@example.com (see list_accounts). "));
check('says ids are mailbox-specific', /ids are mailbox-specific/.test(one));
check('states the exact fix with the address', one.includes("retry ONCE with the same id and pass account: 'shared@example.com'"));
check('bounds the retry and says when to stop', /retry ONCE/.test(one) && /if it did not, stop/.test(one));
const two = crossMailboxHint(['a@example.com', 'b@example.com']);
check('pluralises and lists every other mailbox', two.startsWith('This connection can also reach 2 other mailboxes: a@example.com, b@example.com (see list_accounts). '));
check('with several candidates the fix is a placeholder, not a guess', two.includes("pass account: '<that address>'") && !two.includes("account: 'a@example.com'"));
const hinted = `${nf} ${one}`;
check('404 + hint still classifies as failed', outcomeOf(hinted) === 'failed');

console.log('cross-cutting:');
const all = [SEND_DISABLED_MESSAGE, rnw, blocked, noLink, byCaller, byDefault, nf, hinted];
check('no builder emits a second outcome emoji after the first character', all.every(t => !/[🚫❌⏳]/u.test(t.slice(2))));
check('every refusal carries a retry instruction', all.every(t => /retry/i.test(t)));

if (failures) { console.error(`\n${failures} denial-copy check(s) failed`); process.exit(1); }
console.log('\nAll denial-copy checks passed.');
