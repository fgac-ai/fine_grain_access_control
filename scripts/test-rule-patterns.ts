/**
 * Unit tests for access-rule match patterns (src/lib/rulePatterns.ts).
 * Run: npx tsx scripts/test-rule-patterns.ts  (part of `npm run mcp:lint`)
 *
 * Regression guard for the 2026-04-10 → 2026-08-25 rule-save outage. Commit
 * `38e5c84` added a `safe-regex` ReDoS guard in two places at once:
 *
 *   enforcement  safeRegex(pattern.replace(/\*​/g, '.*'))   ← the expanded string
 *   dashboard    safeRegex(pattern)                        ← the RAW glob
 *
 * Patterns are globs, so `*` and `*@competitor.com` do not compile as regexes
 * and `safe-regex` returns false for them. The result: the dashboard rejected
 * exactly the syntax its own placeholder advertised, and the syntax the app
 * itself wrote for "Send to Anyone" — a 500 on every create and every edit —
 * while enforcement kept matching those same rules correctly.
 *
 * The load-bearing test here is INVARIANT (bottom): the string validated on
 * write must be byte-identical to the string compiled on read.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  globToRegex,
  validateRulePattern,
  compileRulePattern,
  assertStorablePattern,
  patternKind,
} from '../src/lib/rulePatterns';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

/** Every pattern the product itself writes, or tells the user to write. */
const MUST_ACCEPT = [
  '*',                      // grantSendToAnyone, and "match everything"
  '*@competitor.com',       // the create-form placeholder
  '*@yourcompany.com',      // the user guide's send-whitelist example
  '*2FA*',                  // wildcard on both sides
  '2FA Code',               // applyRecommendedSecurityRules seeds
  'Password Reset',
  'Sign In',
  'Verification Code',
  '.*@example\\.com',       // a real regex still works
  'Label_12345',            // label ids
];

const MUST_REJECT_INVALID = ['[', '+', '?', '(unclosed', 'a{2,1}'];
// Two library behaviours pinned here, neither changed by this fix:
//   1. safe-regex@2 detects star height > 1 (nested quantifiers) ONLY — it does
//      not catch alternation ReDoS such as `(a|a)+$`.
//   2. Because `*` is expanded to `.*` FIRST, a `*` in a stored pattern can
//      never form a nested quantifier: `([a-z]+)*$` becomes `([a-z]+).*$`,
//      which is safe. The ReDoS surface a glob can still reach is `+`-based.
const MUST_REJECT_UNSAFE = ['(a+)+$', '(\\d+)+$', '((ab)+)+$', '(.*a){20}'];
// Unsafe as a regex, but harmless once `*` is read as a wildcard:
const SAFE_AFTER_EXPANSION = ['([a-zA-Z]+)*$'];

function main() {
  console.log('accepts every pattern the product produces or documents:');
  for (const p of MUST_ACCEPT) {
    const r = validateRulePattern(p);
    check(`accepts ${JSON.stringify(p)}`, r.ok);
  }

  console.log('\nthe exact production failures:');
  check("'*' is accepted (was: 500 on Send-to-Anyone edit)", validateRulePattern('*').ok);
  check("'*@competitor.com' is accepted (was: 500 on create)",
    validateRulePattern('*@competitor.com').ok);

  console.log('\nrejects uncompilable patterns as `invalid`:');
  for (const p of MUST_REJECT_INVALID) {
    const r = validateRulePattern(p);
    check(`rejects ${JSON.stringify(p)} as invalid`, !r.ok && r.reason === 'invalid');
  }

  console.log('\nrejects ReDoS patterns as `unsafe` (the CASA Tier 2 guard still holds):');
  for (const p of MUST_REJECT_UNSAFE) {
    const r = validateRulePattern(p);
    check(`rejects ${JSON.stringify(p)} as unsafe`, !r.ok && r.reason === 'unsafe');
  }

  console.log('\nwildcard expansion defuses star-height before the ReDoS check:');
  for (const p of SAFE_AFTER_EXPANSION) {
    const r = validateRulePattern(p);
    check(`${JSON.stringify(p)} is safe once * is expanded to .*`, r.ok);
  }

  console.log('\nglob expansion:');
  check("'*' expands to '.*'", globToRegex('*') === '.*');
  check("'*@x.com' expands to '.*@x.com'", globToRegex('*@x.com') === '.*@x.com');
  check('a pattern with no wildcard is unchanged', globToRegex('2FA Code') === '2FA Code');

  console.log('\nmatching behaviour is unchanged for real rules:');
  check("'*' matches any recipient", !!compileRulePattern('*')!.test('anyone@anywhere.dev'));
  check("'*@acme.com' matches inside the domain",
    !!compileRulePattern('*@acme.com')!.test('bob@acme.com'));
  check("'*@acme.com' does not match another domain",
    !compileRulePattern('*@acme.com')!.test('bob@evil.com'));
  check("'2FA Code' matches case-insensitively",
    !!compileRulePattern('2FA Code')!.test('your 2fa code is 123'));
  check('an unusable pattern compiles to null', compileRulePattern('[') === null);

  console.log('\ninternal writers cannot store a pattern the form would reject:');
  let threw = false;
  try { assertStorablePattern('[', 'test'); } catch { threw = true; }
  check('assertStorablePattern throws on an unstorable pattern', threw);
  let threwOnStar = false;
  try { assertStorablePattern('*', 'test'); } catch { threwOnStar = true; }
  check("assertStorablePattern accepts '*' (grantSendToAnyone)", !threwOnStar);

  console.log('\ntelemetry shape carries no pattern content:');
  check("'*@x.com' is a glob", patternKind('*@x.com') === 'glob');
  check("'2FA Code' is a literal", patternKind('2FA Code') === 'literal');
  check("'(a|b)+' is a regex", patternKind('(a|b)+') === 'regex');

  // ─── THE INVARIANT ────────────────────────────────────────────────────────
  // Write-time validation and read-time compilation must agree on the exact
  // string. This is the assertion that makes the April 10 drift impossible to
  // reintroduce: if someone edits one side's expansion, this fails.
  console.log('\nINVARIANT — write-side and read-side compile the same string:');
  for (const p of MUST_ACCEPT) {
    const validated = validateRulePattern(p);
    if (!validated.ok) { check(`invariant for ${JSON.stringify(p)}`, false); continue; }
    const compiled = compileRulePattern(p)!;
    check(
      `${JSON.stringify(p)}: validated ${JSON.stringify(validated.regex)} === compiled source`,
      compiled.source === new RegExp(validated.regex, 'i').source,
    );
  }
  // And that string is what the glob expansion produces — no third variant.
  for (const p of MUST_ACCEPT) {
    const validated = validateRulePattern(p);
    check(
      `${JSON.stringify(p)}: validated string is exactly globToRegex(pattern)`,
      validated.ok && validated.regex === globToRegex(p),
    );
  }

  // ─── "Block Sign In Alerts" template ──────────────────────────────────────
  // Migration 0022 moves stored legacy rows onto whatever the template seeds
  // today. If the seed changes again, the repair must follow it — otherwise
  // old and new holders of the same-named rule match different mail.
  console.log('\n"Block Sign In Alerts": legacy pattern vs the template seed:');
  const root = join(__dirname, '..');
  const actionsSrc = readFileSync(join(root, 'src/app/dashboard/actions.ts'), 'utf8');
  const seed = actionsSrc.match(/ruleName: "Block Sign In Alerts",[\s\S]*?regexPattern: "([^"]+)"/)?.[1];
  const migration = readFileSync(
    join(root, 'src/db/migrations/0023_tighten_legacy_sign_in_template_rule.sql'), 'utf8');
  check('template seed is found in actions.ts', !!seed);
  check(`migration 0022 rewrites to the template seed (${JSON.stringify(seed)})`,
    !!seed && migration.includes(`SET "regex_pattern" = '${seed}'`));
  check('migration 0022 only touches the exact legacy pattern',
    migration.includes(`"regex_pattern" = 'Sign In'`));

  const legacy = compileRulePattern('Sign In')!;
  const tightened = compileRulePattern(seed ?? 'sign-in')!;
  const ALERTS = [
    'Security alert: New sign-in to your account',
    'Unusual sign-in activity',
    'New sign-in on Mac',
  ];
  const BUSINESS = [
    'Please sign in to the portal to submit your timesheet',
    'Sign in to view your invoice',
  ];
  for (const s of ALERTS) check(`seed blocks alert: ${JSON.stringify(s)}`, tightened.test(s));
  for (const s of BUSINESS) {
    check(`legacy pattern over-blocks: ${JSON.stringify(s)}`, legacy.test(s));
    check(`seed lets through: ${JSON.stringify(s)}`, !tightened.test(s));
  }

  if (failures > 0) {
    console.error(`\n${failures} rule-pattern test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll rule-pattern tests passed.');
}
main();
