/* eslint-disable */
/**
 * `npx tsx scripts/qa-coverage-check.ts` — is every QA assertion accounted for?
 *
 * Parses the assertion inventory from docs/QA_Acceptance_Test/capabilities/NN_*.md
 * (headings of the form `### A<n>: ...`) and diffs it against
 * docs/QA_Acceptance_Test/qa-results.json.
 *
 * Coverage is arithmetic, not judgment — this script does the arithmetic so a
 * model only ever argues about evidence quality. Exits non-zero when anything
 * is unaccounted for, listing exactly what. Run manually, from the Stop hook,
 * or at the end of any /qa-* workflow.
 *
 * qa-results.json schema (documented in docs/QA_Acceptance_Test/README.md):
 * {
 *   "run_id": "2026-07-26T14:00:00Z-cc-mcp",
 *   "environment": "02_claude_code_mcp",
 *   "scope": ["10"],            // optional — scoped re-test (see below)
 *   "results": [
 *     { "cap": "01", "assertion": "A1", "status": "pass",
 *       "evidence": "HTTP 403 with whitelist error text" }
 *   ]
 * }
 * status: "pass" | "fail" | "skip". A "skip" requires a "reason". A "pass" or
 * "fail" requires "evidence". Evidence strings must be masked per CLAUDE.md →
 * "This Repository Is Public" (USER_A/USER_B, never real addresses/ids/keys).
 *
 * "scope": optional list of capability ids. When present, this is a targeted
 * re-test (CLAUDE.md → "QA Subagent Architecture") and complete coverage is
 * required for the scoped capabilities only; assertions of excluded
 * capabilities are not demanded (rows for them are still validated if
 * present). When absent, the full suite is expected — unchanged behavior.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CAPS_DIR = 'docs/QA_Acceptance_Test/capabilities';
const RESULTS_FILE = 'docs/QA_Acceptance_Test/qa-results.json';

type ResultRow = {
  cap?: string;
  assertion?: string;
  status?: string;
  evidence?: string;
  reason?: string;
};

// ── Inventory: capability id → assertion ids ────────────────────────────────
const inventory = new Map<string, Set<string>>();
// Duplicate-id guard (ADR-002, Landing step 2): two features landing on one train
// can each take the same next `A<n>`. A Set would silently collapse them into one
// slot and one assertion would never be counted — fail loudly instead.
const duplicateIds: string[] = [];

for (const file of readdirSync(CAPS_DIR).sort()) {
  const m = file.match(/^(\d{2})_.*\.md$/);
  if (!m) continue; // README.md etc.
  const cap = m[1];
  const assertions = new Set<string>();
  const lines = readFileSync(join(CAPS_DIR, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const a = line.match(/^###\s+(A\d+)\s*:/);
    if (!a) return;
    if (assertions.has(a[1])) {
      duplicateIds.push(`${join(CAPS_DIR, file)}:${i + 1}: duplicate assertion id ${a[1]} (already defined earlier in this file)`);
      return;
    }
    assertions.add(a[1]);
  });
  if (assertions.size > 0) inventory.set(cap, assertions);
}

if (duplicateIds.length > 0) {
  console.error(
    `Duplicate assertion ids in ${CAPS_DIR} — the coverage check cannot count them separately.\n` +
    `Renumber the later heading to the next free A<n> and update its cross-references (docs/adr/002_integration_trains.md, Landing step 2):\n` +
    duplicateIds.map((d) => `  - ${d}`).join('\n'),
  );
  process.exit(2);
}

const totalAssertions = [...inventory.values()].reduce((n, s) => n + s.size, 0);

if (totalAssertions === 0) {
  console.error(`No assertions found under ${CAPS_DIR} — the parser or the docs moved.`);
  process.exit(2);
}

// ── Results ─────────────────────────────────────────────────────────────────
if (!existsSync(RESULTS_FILE)) {
  console.error(`${RESULTS_FILE} not found. Runners must write it (schema in docs/QA_Acceptance_Test/README.md).`);
  process.exit(2);
}

let results: ResultRow[];
let runId = '?', environment = '?';
let scopeRaw: unknown;
try {
  const parsed = JSON.parse(readFileSync(RESULTS_FILE, 'utf8'));
  results = parsed.results ?? [];
  runId = parsed.run_id ?? '?';
  environment = parsed.environment ?? '?';
  scopeRaw = parsed.scope;
} catch (e) {
  console.error(`${RESULTS_FILE} is not valid JSON: ${(e as Error).message}`);
  process.exit(2);
}

const problems: string[] = [];

// ── Scope (optional): targeted re-test covering a subset of capabilities ────
let scope: Set<string> | null = null; // null = full-suite expectation
if (scopeRaw !== undefined) {
  if (!Array.isArray(scopeRaw) || scopeRaw.length === 0) {
    console.error(`"scope" must be a non-empty array of capability ids (e.g. ["10"]), got: ${JSON.stringify(scopeRaw)}`);
    process.exit(2);
  }
  scope = new Set<string>();
  for (const s of scopeRaw) {
    const cap = String(s).padStart(2, '0'); // tolerate "10", "04", 4
    if (!inventory.has(cap)) {
      problems.push(`scope entry "${s}": no capability "${cap}" in ${CAPS_DIR}`);
      continue;
    }
    scope.add(cap);
  }
}
const seen = new Map<string, string>(); // "cap/assertion" → status

for (const [i, row] of results.entries()) {
  const key = `${row.cap}/${row.assertion}`;
  if (!row.cap || !row.assertion || !row.status) {
    problems.push(`results[${i}] is missing cap/assertion/status: ${JSON.stringify(row)}`);
    continue;
  }
  if (!inventory.get(row.cap)?.has(row.assertion)) {
    problems.push(`${key}: not in the capability docs (typo, or docs changed?)`);
    continue;
  }
  if (seen.has(key)) {
    problems.push(`${key}: reported twice (${seen.get(key)} then ${row.status})`);
    continue;
  }
  seen.set(key, row.status);

  if (!['pass', 'fail', 'skip', 'blocked'].includes(row.status)) {
    problems.push(`${key}: unknown status "${row.status}" (pass|fail|skip|blocked)`);
  } else if ((row.status === 'skip' || row.status === 'blocked') && !row.reason?.trim()) {
    problems.push(`${key}: ${row.status} without a reason — every ${row.status} needs one`);
  } else if (row.status === 'blocked' && !/USER ACTION|upstream/i.test(row.reason ?? '')) {
    problems.push(`${key}: blocked reason must name what unblocks it — a "USER ACTION" (e.g. re-auth) or an "upstream" dependency`);
  } else if (row.status !== 'skip' && row.status !== 'blocked' && !row.evidence?.trim()) {
    problems.push(`${key}: ${row.status} with no evidence — cite the observed output`);
  }
}

// Missing assertions. With a scope, only the scoped capabilities are required.
const missing: string[] = [];
for (const [cap, assertions] of inventory) {
  if (scope && !scope.has(cap)) continue;
  for (const a of assertions) {
    if (!seen.has(`${cap}/${a}`)) missing.push(`${cap}/${a}`);
  }
}
if (missing.length > 0) {
  problems.push(`Unaccounted-for assertions (${missing.length}): ${missing.join(', ')}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
const counts = { pass: 0, fail: 0, skip: 0, blocked: 0 };
for (const status of seen.values()) if (status in counts) counts[status as keyof typeof counts]++;

console.log(`QA coverage — run ${runId} (${environment})`);
if (scope) {
  const inScope = [...scope].sort();
  const excluded = [...inventory.keys()].filter((c) => !scope!.has(c)).sort();
  const scopedAssertions = inScope.reduce((n, c) => n + (inventory.get(c)?.size ?? 0), 0);
  console.log(`  SCOPED RUN — capabilities ${inScope.join(', ')} (${scopedAssertions} assertions required)`);
  console.log(`  excluded from coverage: ${excluded.length > 0 ? excluded.join(', ') : '(none)'}`);
}
console.log(`  inventory: ${totalAssertions} assertions across ${inventory.size} capabilities`);
console.log(`  reported:  ${seen.size}  (pass ${counts.pass} / fail ${counts.fail} / skip ${counts.skip} / blocked ${counts.blocked})`);

// Blocked assertions are never buried in a count: each one is listed with the
// action that unblocks it, so the user is explicitly flagged (e.g. to re-auth
// a QA account) instead of reading "skipped" and moving on.
if (counts.blocked > 0) {
  console.log(`\n⛔ BLOCKED (${counts.blocked}) — these should have run and could not; action required:`);
  for (const row of results) {
    if (row.status === 'blocked' && seen.get(`${row.cap}/${row.assertion}`) === 'blocked') {
      console.log(`  - ${row.cap}/${row.assertion}: ${row.reason}`);
    }
  }
}

if (problems.length > 0) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

if (counts.fail > 0) {
  console.log('\nCoverage is complete, but there are failures to address.');
  process.exit(0); // coverage is this script's job; failures are the orchestrator's
}

console.log(scope ? '\nAll in-scope assertions accounted for (scoped run).' : '\nAll assertions accounted for.');
