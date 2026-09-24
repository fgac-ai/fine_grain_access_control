/**
 * Unit tests for the placeholder-address detector (src/lib/placeholderEmail.ts)
 * and the two things it gates:
 *   - the caller-chosen account refusal gets placeholder-specific copy that
 *     says the value is fictional, says "do not guess", and tells the agent to
 *     ask the user — while keeping the 🚫 prefix classifyToolOutcome sniffs;
 *   - `skipped_placeholder` adds no 📧 line (nobody was emailed).
 * The ledger/email skip itself lives in notifyOwnerOfAccountRefusal, which
 * imports the database-backed proxy route; it is exercised by the
 * refusal-path checks in capability 14, not here.
 *
 * The detector is deliberately narrow (see the module header): every
 * "real-looking" case below MUST come back null — a false positive silences
 * the owner email for an address the agent genuinely meant.
 * Run: npx tsx scripts/test-placeholder-email.ts (part of `npm run mcp:lint`).
 */
import { classifyPlaceholderEmail, isPlaceholderEmail } from '../src/lib/placeholderEmail';
import { accountNotPermittedByCaller } from '../src/lib/denialCopy';
import { accountRefusalDenialLine } from '../src/lib/approvalNotifyCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}
function kindOf(value: string) { return classifyPlaceholderEmail(value); }
// Addresses off the example.com family are assembled from parts: this repo is
// public and its pre-commit guard rightly refuses any literal address that is
// not on an RFC 2606 placeholder domain — but a detector whose job is to tell
// gmail.com from example.com has to be tested against gmail.com. Every value
// below is fictional.
const at = (local: string, domain: string) => `${local}@${domain}`;

console.log('reserved domains (RFC 2606 / 6761)');
// The two production values, verbatim (2026-09-21 → 23).
check('ufficio@example.com', kindOf('ufficio@example.com') === 'reserved_domain');
check('direzione@example.com', kindOf('direzione@example.com') === 'reserved_domain');
check('example.net / .org / .edu', ['a@example.net', 'a@example.org', 'a@example.edu'].every(v => kindOf(v) === 'reserved_domain'));
check('subdomains of example.com', kindOf(at('mail', 'sales.example.com')) === 'reserved_domain');
check('.test TLD', kindOf(at('ops', 'corp.test')) === 'reserved_domain');
check('.invalid TLD', kindOf(at('nobody', 'nowhere.invalid')) === 'reserved_domain');
check('.example TLD', kindOf(at('a', 'b.example')) === 'reserved_domain');
check('.local TLD', kindOf(at('printer', 'office.local')) === 'reserved_domain');
check('user@localhost (no dot)', kindOf('user@localhost') === 'reserved_domain');
check('case and whitespace normalised', kindOf('  Ufficio@Example.COM ') === 'reserved_domain');

console.log('synthetic template values');
check(at('user', 'domain.com'), kindOf(at('user', 'domain.com')) === 'synthetic');
check('test@test.com', kindOf('test@test.com') === 'synthetic');
check(at('email', 'email.tld'), kindOf(at('email', 'email.tld')) === 'synthetic');
check(at('name', 'yourdomain.com'), kindOf(at('name', 'yourdomain.com')) === 'synthetic');
check('john.doe@ any domain', kindOf(at('john.doe', 'gmail.com')) === 'synthetic');
check('firstname.lastname@ any domain', kindOf(at('firstname.lastname', 'umich.edu')) === 'synthetic');
check('your-email@ any domain', kindOf(at('your-email', 'outlook.com')) === 'synthetic');
check('user1 at sample.com (numbered generic pair)', kindOf(at('user1', 'sample.com')) === 'synthetic');
check('admin@company.com', kindOf('admin@company.com') === 'synthetic');

console.log('malformed / template markers');
check('empty', kindOf('') === 'malformed');
check('no @', kindOf('direzione') === 'malformed');
check('angle-bracket template', kindOf('<email>') === 'malformed');
check('mustache template', kindOf('{{account}}') === 'malformed');
check('square-bracket template', kindOf('[your address]') === 'malformed');
check('spaces inside', kindOf(at('direzione amministrativa', 'gmail.com')) === 'malformed');
check('bare host, no dot, not reserved', kindOf('user@server') === 'malformed');
check('trailing dot / empty TLD', kindOf('user@gmail.') === 'malformed');

console.log('real-looking values must pass (null)');
const real = [
  at('direzione.amministrativa', 'gmail.com'),    // the shape of the real mailbox the placeholders stood in for
  at('qa.owner', 'gmail.com'), at('qa.owner', 'umich.edu'),
  at('test', 'gmail.com'),                        // generic local part, real provider
  at('info', 'ospedale-fittizio.it'), at('admin', 'brokerage-fictional.com'), // generic local parts on business domains
  at('user', 'mail.com'), at('someone.else', 'email.com'), // real providers that sound generic
  at('support', 'fgac.ai'), at('ops', 'example-corp.com'), at('a', 'examplecompany.com'),
  at('jane', 'testing.io'), at('demo', 'acme.io'), at('first.last.name', 'gmail.com'),
  'ops@localhost.example-corp.com', at('x', 'y.co.uk'),
];
for (const v of real) check(`${v} → null`, kindOf(v) === null);
check('isPlaceholderEmail mirrors the classifier', isPlaceholderEmail('a@example.com') && !isPlaceholderEmail(at('a', 'gmail.com')));

console.log('placeholder refusal copy');
const usable = `${at('owner', 'gmail.com')}, ${at('direzione.amministrativa', 'gmail.com')}`;
const text = accountNotPermittedByCaller('ufficio@example.com', usable, 'reserved_domain');
check('keeps the 🚫 prefix (denied_by_policy)', text.startsWith('🚫'));
check('names the refused value', text.includes("'ufficio@example.com'"));
check('says it is a placeholder, not a mailbox anyone has', /is a placeholder/.test(text) && /not a mailbox anyone has/.test(text));
check('says do not guess or invent', /Do not guess or invent addresses/.test(text));
check('lists the only usable accounts', text.includes(`The only accounts this connection can use: ${usable}.`));
check('tells the agent to ask the user instead of trying another value', /ask the user which account they mean/.test(text) && /instead of trying another value/.test(text));
check('says the user cannot add it either', /the user cannot add it either/.test(text));
check('still says not to retry with the value', /Do not retry with 'ufficio@example.com'/.test(text));
check('addresses the scheduled task: replace the placeholder in the task', /scheduled or automated task/.test(text) && /replace it in the task/.test(text));
check('never says "add an account" — the generic fix that does not apply', !/add an account/.test(text));

const malformed = accountNotPermittedByCaller('<email>', usable, 'malformed');
check('malformed: 🚫 and "not a mailbox address"', malformed.startsWith('🚫') && /is not a mailbox address/.test(malformed));
check('malformed: same do-not-guess guidance', /Do not guess or invent addresses/.test(malformed) && /ask the user which account they mean/.test(malformed));

const synthetic = accountNotPermittedByCaller(at('user', 'domain.com'), usable, 'synthetic');
check('synthetic reads as a template value', /an example or template value/.test(synthetic));

const generic = accountNotPermittedByCaller(at('wrong', 'gmail.com'), usable, null);
check('null placeholder keeps the generic text (only the user can add an account)', /only the user can add an account/.test(generic) && !/placeholder/.test(generic));
check('omitted placeholder keeps the generic text', accountNotPermittedByCaller(at('wrong', 'gmail.com'), usable) === generic);

console.log('skipped_placeholder adds no email line');
check('empty denial line', accountRefusalDenialLine('skipped_placeholder', {}) === '');

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall placeholder-email checks passed');
