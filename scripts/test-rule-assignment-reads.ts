/**
 * Lint: no unfiltered read of `key_rule_assignments` anywhere in `src/`.
 * Run: npx tsx scripts/test-rule-assignment-reads.ts  (part of `npm run mcp:lint`)
 *
 * Regression guard for the 2026-11 Neon egress growth. Eight call sites —
 * `loadApplicableRules`, the REST proxy's file gates, the MCP file gates,
 * `get_my_permissions`, the rules API and the dashboard loader — each ran
 *
 *   db.select().from(keyRuleAssignments)        ← every owner's rows
 *
 * on every request and then looked up only the caller's own rule ids. The
 * answer was right; the cost was the whole table shipped out of the database
 * per call (~200–300 KB per REST proxy request by mid-November, growing with
 * the table). Reads must be scoped: by key, by rule id(s), or through
 * `loadRuleAssignmentsForUser` (src/lib/ruleAssignments.ts).
 *
 * The check is textual on purpose — the failure mode is one line that looks
 * harmless in review, and a grep catches it before any database does.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** A `.from(keyRuleAssignments)` whose next token is not a filter or a join. */
const UNSCOPED = /\.from\(\s*keyRuleAssignments\s*\)(?!\s*\.(where|innerJoin|leftJoin)\b)/g;

export function unscopedReads(source: string): number[] {
  const lines: number[] = [];
  for (const m of source.matchAll(UNSCOPED)) {
    lines.push(source.slice(0, m.index).split('\n').length);
  }
  return lines;
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('rule-assignment reads');

// The detector itself.
check('flags a bare read', unscopedReads('await db.select().from(keyRuleAssignments);').length === 1);
check('flags a bare read inside Promise.all', unscopedReads('[\n  db.select().from(keyRuleAssignments),\n]').length === 1);
check('accepts a filtered read', unscopedReads('db.select().from(keyRuleAssignments).where(eq(a, b))').length === 0);
check('accepts a filter on the next line', unscopedReads('db.select()\n  .from(keyRuleAssignments)\n  .where(eq(a, b))').length === 0);
check('accepts a joined read', unscopedReads('db.select().from(keyRuleAssignments).innerJoin(x, y)').length === 0);

// The codebase.
const offenders: string[] = [];
for (const file of walk(SRC)) {
  for (const line of unscopedReads(readFileSync(file, 'utf8'))) {
    offenders.push(`${relative(join(SRC, '..'), file)}:${line}`);
  }
}
check('no unscoped read in src/', offenders.length === 0, offenders.join(', '));

const helper = readFileSync(join(SRC, 'lib', 'ruleAssignments.ts'), 'utf8');
check('the shared helper filters by the owner\'s rules', /inArray\(\s*keyRuleAssignments\.accessRuleId/.test(helper) && /eq\(accessRules\.userId, userId\)/.test(helper));

if (failures > 0) {
  console.error(`\n${failures} failure(s). Scope the read by key or rule, or use loadRuleAssignmentsForUser().`);
  process.exit(1);
}
console.log('\nall rule-assignment read checks passed');
