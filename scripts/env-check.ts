/* eslint-disable */
/**
 * `npm run env:check` — what is this working copy actually pointed at?
 *
 * Answers, in one place: which Neon branch, which Clerk instance, and whether
 * any production credential is sitting in .env.local where it could be picked
 * up by accident.
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true } as any);

import { execSync } from 'child_process';
import { hostOf, isProductionHost, resolveConnection } from '../src/db/connectionSafety';

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ok = (s: string) => `${GREEN}✔${RESET} ${s}`;
const bad = (s: string) => `${RED}✘${RESET} ${s}`;
const warn = (s: string) => `${YELLOW}!${RESET} ${s}`;

function gitBranch(): string {
  try { return execSync('git rev-parse --abbrev-ref HEAD').toString().trim(); }
  catch { return 'unknown'; }
}

function clerkMode(key: string | undefined): 'live' | 'test' | 'unset' {
  if (!key) return 'unset';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return 'unset';
}

console.log(`\n${DIM}git branch${RESET}  ${gitBranch()}\n`);

// ── Database ───────────────────────────────────────────────────────────────
const resolution = resolveConnection({
  isProductionRuntime: false,   // this script always reports the LOCAL view
  isBuildTime: false,
  env: process.env,
});

console.log('DATABASE');
if (resolution.fatal) {
  console.log(bad(`local runtime would FAIL: ${resolution.describe}`));
  console.log(DIM + resolution.fatal.split('\n').map(l => '    ' + l).join('\n') + RESET);
} else {
  console.log(ok(`local runtime → ${resolution.describe}`));
}

// Surface production URLs sitting in the environment, even unused.
const prodVars = ['POSTGRES_URL', 'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING']
  .filter(v => process.env[v] && isProductionHost(process.env[v]!));

if (prodVars.length) {
  console.log(warn(`production DB host present in: ${prodVars.join(', ')}`));
  console.log(`${DIM}    Harmless today — src/db only accepts neon__POSTGRES_URL outside production.`);
  console.log(`    Scripts that read these directly must opt in explicitly (e.g. --prod).${RESET}`);
}

// ── Clerk ──────────────────────────────────────────────────────────────────
const mode = clerkMode(process.env.CLERK_SECRET_KEY);
console.log('\nCLERK');
if (mode === 'unset') {
  console.log(bad('CLERK_SECRET_KEY not set — auth will not work locally'));
  // Distinguish "file lacks the line" from "line exists but did not parse".
  // Presence booleans only — never print values.
  try {
    const fs = require('fs') as typeof import('fs');
    const raw = fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8') : null;
    if (raw === null) {
      console.log(`${DIM}    .env.local does not exist. Bootstrap:`);
      console.log(`    npx vercel env pull .env.local --environment=development${RESET}`);
    } else if (raw.split('\n').some(l => l.trim().startsWith('CLERK_SECRET_KEY='))) {
      const parsed = (require('dotenv') as typeof import('dotenv')).parse(raw).CLERK_SECRET_KEY ?? '';
      if (/^["']/.test(parsed)) {
        console.log(`${DIM}    The value parses but BEGINS WITH A QUOTE character — the value stored in`);
        console.log(`    Vercel itself contains literal quotes (pasted with quotes when added).`);
        console.log(`    Fix it at the source, then re-pull:`);
        console.log(`      npx vercel env rm CLERK_SECRET_KEY development`);
        console.log(`      npx vercel env add CLERK_SECRET_KEY development   # paste WITHOUT quotes`);
        console.log(`      npx vercel env pull .env.local --environment=development${RESET}`);
      } else {
        console.log(`${DIM}    The line EXISTS in .env.local but the value has an unexpected format`);
        console.log(`    (expected an sk_test_/sk_live_ key). Check the value stored in Vercel.${RESET}`);
      }
    } else {
      console.log(`${DIM}    The line is ABSENT from .env.local. Re-pull (the dev value exists in Vercel):`);
      console.log(`    npx vercel env pull .env.local --environment=development`);
      console.log(`    Note: each git worktree has its OWN .env.local — a key fixed in another`);
      console.log(`    worktree or the main clone does not carry over.${RESET}`);
    }
  } catch { /* diagnostics are best-effort */ }
} else if (mode === 'live') {
  console.log(bad('CLERK_SECRET_KEY is sk_live_ — PRODUCTION instance'));
  console.log(`${DIM}    Local dev should use the development instance. Re-pull:`);
  console.log(`    npx vercel env pull .env.local --environment=development${RESET}`);
} else {
  console.log(ok('CLERK_SECRET_KEY is sk_test_ (development instance)'));
}

// ── Mismatch check ─────────────────────────────────────────────────────────
const dbIsProd = isProductionHost(process.env.neon__POSTGRES_URL || '');
console.log('');
if (dbIsProd && mode === 'test') {
  console.log(bad('MISMATCH: production database with a development Clerk instance.'));
  console.log(`${DIM}    User ids will not resolve — every Clerk lookup 404s and reads as "deleted".${RESET}`);
} else if (!dbIsProd && mode === 'live') {
  console.log(bad('MISMATCH: branch database with a production Clerk instance.'));
} else {
  console.log(ok('Database and Clerk instance are consistent.'));
}

// ── PostHog query access (analytics verification) ──────────────────────────
// Two consumers, two different env sources — a key in one place does not make
// the other work:
//   * The `posthog` MCP server (.mcp.json) expands ${POSTHOG_PERSONAL_API_KEY}
//     from the SHELL environment at `claude` launch. .env.local is invisible
//     to it. No key at launch → the server fails auth silently and its tools
//     never appear in the session.
//   * scripts/qa-posthog-events.ts reads .env.local via dotenv.
console.log('\nPOSTHOG (query access)');
// Approval-link reminder email (src/lib/approvalNotify.ts): off unless the
// support mailbox's FGAC proxy key and address are present. Informational —
// local and preview normally run with it off; production needs both set
// (Vercel env). The key must belong to a profile that allows sending.
if (process.env.SUPPORT_FGAC_PROXY_KEY && process.env.SUPPORT_SENDER_EMAIL) {
  console.log(`Approval reminder email: ON, from ${process.env.SUPPORT_SENDER_EMAIL} through FGAC's proxy API (key ${process.env.SUPPORT_FGAC_PROXY_KEY.slice(0, 12)}…)`);
} else {
  console.log('Approval reminder email: off (SUPPORT_FGAC_PROXY_KEY / SUPPORT_SENDER_EMAIL not set)');
}

const phKey = process.env.POSTHOG_PERSONAL_API_KEY;
if (!phKey) {
  console.log(warn('POSTHOG_PERSONAL_API_KEY not set — analytics verification is blind'));
  console.log(`${DIM}    Neither the posthog MCP server nor qa-posthog-events.ts can query events.`);
  console.log(`    Fix (user action — needs the PostHog UI): create a personal API key`);
  console.log(`    (phx_…, Query:Read scope, project 343912), then:`);
  console.log(`      export POSTHOG_PERSONAL_API_KEY=phx_…   # in ~/.zshrc, for the MCP server`);
  console.log(`      npx vercel env add POSTHOG_PERSONAL_API_KEY development  # for the script,`);
  console.log(`      npx vercel env pull .env.local --environment=development # then re-pull${RESET}`);
} else if (!phKey.startsWith('phx_')) {
  console.log(warn('POSTHOG_PERSONAL_API_KEY is set but does not look like a personal key (phx_…)'));
  console.log(`${DIM}    NEXT_PUBLIC_POSTHOG_KEY (phc_…) is the write-side ingestion key and cannot query.${RESET}`);
} else {
  console.log(ok('POSTHOG_PERSONAL_API_KEY present (phx_…)'));
  console.log(`${DIM}    Note: the posthog MCP server only sees it if it was exported in the shell`);
  console.log(`    that launched Claude Code — .env.local alone is enough only for scripts.${RESET}`);
}

// ── Stray production credential files ──────────────────────────────────────
import { existsSync } from 'fs';
const strays = ['.env.production.local', '.env.production'].filter(existsSync);
if (strays.length) {
  console.log('');
  console.log(bad(`Next.js auto-loads these in production mode: ${strays.join(', ')}`));
  console.log(`${DIM}    A local \`npm run build && npm start\` would pick them up.`);
  console.log(`    Keep production credentials in .secrets/ instead (see CLAUDE.md).${RESET}`);
}

// ── Whitespace inside env values ────────────────────────────────────────────
// Sibling of the quoted-value check above: a value pasted into Vercel with a
// trailing newline survives `vercel env pull` and dotenv parsing, then breaks
// whatever URL it gets concatenated into (approval links shipped as
// "https://fgac.ai\n/dashboard/approve..." this way). Detect it at the source.
const whitespaceOffenders = Object.entries(process.env)
  .filter(([k]) => /URL|HOST|DOMAIN/i.test(k))
  .filter(([, v]) => v !== undefined && v !== v.trim())
  .map(([k]) => k);
if (whitespaceOffenders.length) {
  console.log('');
  console.log(bad(`env values with leading/trailing whitespace or newlines: ${whitespaceOffenders.join(', ')}`));
  console.log(`${DIM}    URLs built from these break at the stray character. Fix at the source:`);
  console.log(`      npx vercel env rm <VAR> <environment>   # then re-add WITHOUT the newline`);
  console.log(`      npx vercel env pull .env.local --environment=development${RESET}`);
}

console.log('');
