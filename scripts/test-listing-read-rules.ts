/**
 * Read rules on Gmail LISTING responses (src/lib/gmailRules.ts redactListing).
 * Run: npx tsx scripts/test-listing-read-rules.ts  (part of `npm run mcp:lint`)
 *
 * Production 2026-10-09: a `$mcp_tool_call` on GET gmail/v1/users/me/threads
 * came back denied_by_policy — one thread's snippet matched a content rule
 * ('Block Sign In Alerts'), and the whole-response check refused the entire
 * listing. The stated policy is "messages may APPEAR in listings, but reading
 * content must respect the rules". Pins:
 *   - listing paths are told apart from single-resource reads;
 *   - a matching entry stays listed, its snippet withheld; others untouched;
 *   - the input is not mutated (rules ran on Google's real payload);
 *   - label rules withhold per entry too, never refuse the listing;
 *   - single-message reads still refuse outright (no regression).
 * Plan: docs/implementation_plans/claude/distracted-kapitsa-19a2d7_v1.md
 */
process.env.neon__POSTGRES_URL = ['postgres://fixture', 'ep-test-fixture.invalid/db'].join(':fixture' + String.fromCharCode(64));

import type { ApplicableRules } from '../src/lib/gmailRules';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const rule = (actionType: string, regexPattern: string, ruleName: string) =>
  ({ service: 'gmail', actionType, regexPattern, ruleName });

async function main() {
  // Dynamic: gmailRules pulls in the db module, which reads the env fixture above.
  const { isGmailListingPath, redactListing, checkReadRestrictions, withheldSnippet } = await import('../src/lib/gmailRules');

  console.log('listing paths vs single-resource reads:');
  for (const p of [
    'gmail/v1/users/me/threads', 'gmail/v1/users/me/threads?q=is:unread&maxResults=5',
    '/gmail/v1/users/me/messages', 'gmail/v1/users/me/drafts/', 'gmail/v1/users/someone%40example.com/history?startHistoryId=1',
  ]) check(`listing: ${p}`, isGmailListingPath(p));
  for (const p of [
    'gmail/v1/users/me/threads/18f0a', 'gmail/v1/users/me/messages/18f0a?format=full',
    'gmail/v1/users/me/drafts/r123', 'gmail/v1/users/me/labels', 'gmail/v1/users/me/profile',
    'gmail/v1/users/me/messages/18f0a/attachments/ANGj', 'drive/v3/files',
  ]) check(`not a listing: ${p}`, !isGmailListingPath(p));

  console.log('\nthreads.list with one matching snippet (the 2026-10-09 production case):');
  const rules = [rule('read_blacklist', 'Sign In', 'Block Sign In Alerts')] as unknown as ApplicableRules;
  const threads = {
    threads: [
      { id: 't1', snippet: 'Lunch on Friday? Let me know', historyId: '1' },
      { id: 't2', snippet: 'New Sign In to your account. Your code is 482913', historyId: '2' },
      { id: 't3', snippet: 'Quarterly numbers attached', historyId: '3' },
    ],
    nextPageToken: 'abc', resultSizeEstimate: 3,
  };
  const before = JSON.stringify(threads);
  check('the whole-response check WOULD refuse this listing (the bug, for reference)', checkReadRestrictions(rules, threads) !== null);
  const r = redactListing(rules, threads);
  const out = r.body as typeof threads;
  check('listing is not refused — all three entries remain', out.threads.length === 3);
  check('ids and paging survive', out.threads.map(t => t.id).join() === 't1,t2,t3' && out.nextPageToken === 'abc');
  check('matching snippet withheld, naming the rule', out.threads[1].snippet === withheldSnippet('Block Sign In Alerts'));
  check('the code from the matching snippet is gone', !JSON.stringify(out).includes('482913'));
  check('non-matching snippets untouched', out.threads[0].snippet === threads.threads[0].snippet && out.threads[2].snippet === threads.threads[2].snippet);
  check('withheld count + rule names reported', r.withheld === 1 && r.ruleNames.join() === 'Block Sign In Alerts');
  check('input not mutated', JSON.stringify(threads) === before);

  console.log('\nno matches → identical listing:');
  const clean = redactListing(rules, { threads: [threads.threads[0]] });
  check('withheld 0', clean.withheld === 0);
  check('body equal to input', JSON.stringify(clean.body) === JSON.stringify({ threads: [threads.threads[0]] }));

  console.log('\nID-only listings (messages.list, drafts.list) never trip a content rule on ids:');
  const ids = { messages: [{ id: '18f0a', threadId: '18f0a' }], resultSizeEstimate: 1 };
  const idOnly = redactListing([rule('read_blacklist', '*', 'Block everything')] as unknown as ApplicableRules, ids);
  check('entries kept', (idOnly.body as typeof ids).messages[0].id === '18f0a');
  check('nothing withheld, nothing counted', idOnly.withheld === 0);
  check('nothing to withhold leaves ids intact', JSON.stringify((idOnly.body as typeof ids).messages[0]) === JSON.stringify(ids.messages[0]));

  console.log('\nlabel rules withhold per entry instead of refusing the listing (history.list):');
  const history = {
    history: [
      { id: '9', messagesAdded: [{ message: { id: 'm1', threadId: 'm1', labelIds: ['INBOX', 'Label_HR'] } }] },
      { id: '10', messagesAdded: [{ message: { id: 'm2', threadId: 'm2', labelIds: ['INBOX'] } }] },
    ],
    historyId: '10',
  };
  const labelRules = [rule('label_blacklist', 'Label_HR', 'No HR')] as unknown as ApplicableRules;
  const h = redactListing(labelRules, history);
  check('both history records remain', (h.body as typeof history).history.length === 2);
  check('history entries carry no content → nothing withheld or counted', h.withheld === 0);

  console.log('\nsingle-message reads still refuse outright (unchanged):');
  const message = { id: 'm', snippet: 'New Sign In detected', payload: { headers: [{ name: 'Subject', value: 'Security alert' }] } };
  const d = checkReadRestrictions(rules, message);
  check('gmail_read-shaped message refused', !!d && d.includes("'Block Sign In Alerts'"));

  console.log('\nnon-object bodies pass through:');
  check('null', redactListing(rules, null).body === null);
  check('string', redactListing(rules, 'x').body === 'x');

  if (failures > 0) { console.error(`\n${failures} listing read-rule test(s) failed.`); process.exit(1); }
  console.log('\nAll listing read-rule tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
