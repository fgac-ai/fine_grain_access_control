/* eslint-disable */
import { config } from 'dotenv'
import { execSync } from 'child_process'
import { sanitize } from './lib/neon-branch-classifier'
import { neonctl } from './lib/neonctl'

config({ path: '.env.local' })

/**
 * Decide whether branch CREATION needs changing — the counterpart to the
 * pruner, which only decides deletion. REPORT ONLY; changes nothing.
 *
 * The question it answers: how many database branches get provisioned that
 * nobody ever queries? `cpu_used_sec === 0` is the evidence — the branch was
 * created, an endpoint was attached, and no compute ever ran on it. That branch
 * did nothing but cost money once the project passed the 10 included.
 *
 * It splits the answer by who created the branch, because the two have
 * different levers and conflating them produces advice that cannot be acted on:
 *
 *   preview/<git-branch>  — the Vercel-Neon integration, automatically, on
 *                           every preview deploy. Not opt-in. The lever is the
 *                           integration setting, not our code.
 *   <sanitized-branch>    — `npm run db:branch`, run by a person or an agent
 *                           during worktree bootstrap. The lever is the
 *                           bootstrap habit: docs-only work needs no database.
 *
 * A docs-only PR is the clearest case of a branch that cannot possibly be
 * needed, so PRs are classified too.
 *
 * TWO CAVEATS, both of which make this an UNDER-count and are printed with the
 * output so nobody over-reads it:
 *   - Deleted branches are invisible. The pruner is aggressive now, so this
 *     sees only what survived the last run — run it before a prune for a fuller
 *     picture, or over several days.
 *   - `cpu_used_sec` is reported per consumption period and can lag a freshly
 *     created branch by a few minutes. A branch minutes old reading 0 may
 *     simply be too new; the report marks those rather than counting them.
 *
 * Run: npx tsx scripts/report-branch-creation.ts   (npm run branches:creation-report)
 */

/** Below this age, a 0 reading is treated as "too new to tell", not as unused. */
const TOO_NEW_HOURS = 1;

/** Share of decidable branches with zero compute that should prompt a change. */
const ACTION_THRESHOLD = 0.3;

/**
 * Below this many decidable branches, report the numbers but issue no verdict.
 * The pruner keeps the population small, so a single unused branch can swing
 * the share past the threshold — "50% of 4" is not evidence of anything.
 */
const MIN_SAMPLE = 6;

const DOCS_PREFIXES = ['docs/', '.claude/', '.github/'];
const DOCS_FILES = ['CLAUDE.md', 'README.md', 'LICENSE'];
const isDocsPath = (f: string) =>
  f.endsWith('.md') || DOCS_FILES.includes(f) || DOCS_PREFIXES.some(p => f.startsWith(p));

function runNeonCmd(cmd: string) {
  try {
    return JSON.parse(execSync(neonctl(`${cmd} -o json`), { encoding: 'utf-8' }));
  } catch (error: any) {
    console.error(`❌ Neon CLI error executing: ${cmd}`);
    console.error(error.message);
    process.exit(1);
  }
}

interface PrInfo { number: number; docsOnly: boolean; state: string }

/** headRefName -> PR info, newest PR per ref. Best-effort; no gh = no PR column. */
function prsByRef(): Map<string, PrInfo> {
  const out = new Map<string, PrInfo>();
  try {
    const prs = JSON.parse(
      execSync('gh pr list --state all --limit 100 --json number,headRefName,state,files', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024,
      })
    ) as { number: number; headRefName: string; state: string; files: { path: string }[] }[];
    for (const pr of prs) {
      if (out.has(pr.headRefName)) continue;
      const paths = pr.files.map(f => f.path);
      out.set(pr.headRefName, {
        number: pr.number,
        state: pr.state.toLowerCase(),
        docsOnly: paths.length > 0 && paths.every(isDocsPath),
      });
    }
  } catch {
    console.log('ℹ️  gh unavailable — PR/docs-only classification omitted.');
  }
  return out;
}

const refFor = (branchName: string, prs: Map<string, PrInfo>): PrInfo | null => {
  if (prs.size === 0) return null;
  if (branchName.startsWith('preview/')) return prs.get(branchName.slice('preview/'.length)) ?? null;
  for (const [ref, info] of prs) if (sanitize(ref) === branchName) return info;
  return null;
};

const pad = (v: string, w: number) => (v.length >= w ? v : v + ' '.repeat(w - v.length));
const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

function main() {
  const projectId = process.env.NEON_PROJECT_ID ?? runNeonCmd('projects list')[0].id;
  const branches = runNeonCmd(`branches list --project-id ${projectId}`) as any[];
  const prs = prsByRef();
  const now = Date.now();

  const rows = branches
    .filter(b => !(b.primary || b.default || b.name === 'main'))
    .map(b => {
      const ageHours = (now - Date.parse(b.created_at)) / 3_600_000;
      const cpu = b.cpu_used_sec ?? 0;
      const pr = refFor(b.name, prs);
      return {
        name: b.name as string,
        kind: b.name.startsWith('preview/') ? ('preview' as const) : ('local' as const),
        ageHours,
        cpu,
        tooNew: cpu === 0 && ageHours < TOO_NEW_HOURS,
        unused: cpu === 0 && ageHours >= TOO_NEW_HOURS,
        pr,
      };
    })
    .sort((a, b) => a.ageHours - b.ageHours);

  if (rows.length === 0) {
    console.log('No non-primary branches to assess.');
    return;
  }

  console.log(`🌱 Branch creation assessment — ${rows.length} non-primary branch(es) present.\n`);

  const cols: [string, (r: typeof rows[0]) => string][] = [
    ['BRANCH', r => r.name],
    ['MADE BY', r => (r.kind === 'preview' ? 'vercel-neon' : 'db:branch')],
    ['AGE', r => (r.ageHours < 48 ? `${r.ageHours.toFixed(1)}h` : `${Math.round(r.ageHours / 24)}d`)],
    ['COMPUTE', r => (r.cpu > 0 ? `${r.cpu}s` : r.tooNew ? '0 (too new)' : '0 — NEVER USED')],
    ['PR', r => (r.pr ? `#${r.pr.number} ${r.pr.state}${r.pr.docsOnly ? ' (docs-only)' : ''}` : '')],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map(r => get(r).length)));
  console.log('   ' + cols.map(([h], i) => pad(h, widths[i])).join('  ').trimEnd());
  console.log('   ' + widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log('   ' + cols.map(([, get], i) => pad(get(r), widths[i])).join('  ').trimEnd());
  }

  const decidable = rows.filter(r => !r.tooNew);
  const unused = decidable.filter(r => r.unused);
  const byKind = (k: 'preview' | 'local') => ({
    all: decidable.filter(r => r.kind === k),
    unused: unused.filter(r => r.kind === k),
  });
  const preview = byKind('preview');
  const local = byKind('local');
  const docsOnly = decidable.filter(r => r.pr?.docsOnly);

  console.log(`\n📊 Of ${decidable.length} decidable branch(es) (${rows.length - decidable.length} too new to judge):`);
  console.log(`   never queried at all: ${unused.length} (${pct(unused.length, decidable.length)})`);
  console.log(`   · vercel-neon previews: ${preview.unused.length}/${preview.all.length} unused — created automatically on every preview deploy`);
  console.log(`   · db:branch locals:    ${local.unused.length}/${local.all.length} unused — created by worktree bootstrap`);
  if (prs.size > 0) {
    console.log(`   backing a docs-only PR: ${docsOnly.length} (of which ${docsOnly.filter(r => r.unused).length} never queried)`);
  }

  console.log('\n🔎 Verdict:');
  const share = decidable.length === 0 ? 0 : unused.length / decidable.length;
  if (decidable.length < MIN_SAMPLE) {
    console.log(`   No verdict — ${decidable.length} decidable branch(es) is too small a sample (need ${MIN_SAMPLE}).`);
    console.log(`   Current reading is ${pct(unused.length, decidable.length)} unused; one branch either way moves that a lot.`);
    console.log('   Run this again just BEFORE a prune, when the population is at its largest.');
  } else if (share < ACTION_THRESHOLD) {
    console.log(`   No change indicated — ${pct(unused.length, decidable.length)} of branches went unused, under the ${Math.round(ACTION_THRESHOLD * 100)}% bar.`);
    console.log('   Creation is roughly matched to need; the pruner is the right lever for cost.');
  } else {
    console.log(`   Worth acting — ${pct(unused.length, decidable.length)} of branches were provisioned and never queried.`);
    if (preview.unused.length > local.unused.length) {
      console.log('   The waste is mostly VERCEL-NEON previews. Our code does not create these:');
      console.log('   the lever is the Vercel-Neon integration (limit which branches get a preview');
      console.log('   database, or detach docs-only branches from it), not scripts/branch-db.ts.');
    } else {
      console.log('   The waste is mostly DB:BRANCH locals. The lever is the bootstrap habit:');
      console.log('   docs-only work needs no database, so skip db:branch until the app must run.');
    }
  }

  console.log('\n   Caveats: deleted branches are invisible here, so this UNDER-counts — run it');
  console.log(`   before a prune, or over several days. Branches under ${TOO_NEW_HOURS}h old are excluded`);
  console.log('   because cpu_used_sec lags a freshly created branch.');
}

main();
