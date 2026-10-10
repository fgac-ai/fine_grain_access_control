/**
 * Outbound links name the serving deployment (src/lib/linkOrigin.ts).
 * Run: npx tsx scripts/test-link-origin.ts  (part of `npm run mcp:lint`)
 *
 * Hosted-MCP QA regression 2026-10-09: on a preview, approval links in
 * denials, list_accounts' delegation links and dashboard pointers named
 * fgac.ai — production — for requests that exist only in the preview's
 * database. Pins:
 *   - production output is byte-identical to the configured URL, whatever
 *     host the request arrived on (www, a vercel.app alias, gmail.);
 *   - a preview or local build names the request's host, else its own
 *     deployment origin — never fgac.ai;
 *   - the per-request origin survives awaits and does not leak between
 *     concurrent requests;
 *   - approval links and read-rule denials built on it follow the same rule.
 * Plan: docs/implementation_plans/claude/preview-origin-links_v1.md
 */
process.env.neon__POSTGRES_URL = ['postgres://fixture', 'ep-test-fixture.invalid/db'].join(':fixture' + String.fromCharCode(64));
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_unit_only_signing_seed';

import { linkBase, runWithLinkOrigin } from '../src/lib/linkOrigin';
import type { ApplicableRules } from '../src/lib/gmailRules';

let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed++;
}

const PROD = { VERCEL_ENV: 'production', VERCEL_URL: 'fine-grain-access-control-xyz.vercel.app' };
const PREVIEW = { VERCEL_ENV: 'preview', VERCEL_URL: 'fine-grain-access-control-abc.vercel.app' };
const PREVIEW_ORIGIN = 'https://fine-grain-access-control-git-feature-x.vercel.app';

async function main() {
  // Dynamic: static imports are hoisted above the env fixture, and gmailRules pulls in the db module.
  const { mintApprovalLink } = await import('../src/lib/approvalLinks');
  const { checkReadRestrictions } = await import('../src/lib/gmailRules');

  // ── production: configured URL, byte for byte ─────────────────────────────
  for (const configured of ['https://fgac.ai', 'https://fgac.ai\n', 'http://localhost:3000']) {
    for (const origin of [undefined, 'https://www.fgac.ai', 'https://gmail.fgac.ai', `https://${PROD.VERCEL_URL}`]) {
      check(`production: ${JSON.stringify(configured)} unchanged (request on ${origin ?? 'no request'})`,
        linkBase(configured, PROD, origin) === configured);
    }
  }
  check('production: unchanged inside a request scope too',
    runWithLinkOrigin('https://www.fgac.ai', () => linkBase('https://fgac.ai', PROD)) === 'https://fgac.ai');

  // ── preview / local: the serving host ────────────────────────────────────
  check('preview: names the request host', linkBase('https://fgac.ai', PREVIEW, PREVIEW_ORIGIN) === PREVIEW_ORIGIN);
  check('preview: no request → its own deployment URL', linkBase('https://fgac.ai', PREVIEW, undefined) === `https://${PREVIEW.VERCEL_URL}`);
  check('preview: trailing slash trimmed', linkBase('https://fgac.ai', PREVIEW, `${PREVIEW_ORIGIN}/`) === PREVIEW_ORIGIN);
  check('local: names the dev server port it was reached on', linkBase('http://localhost:3000', {}, 'http://localhost:52330') === 'http://localhost:52330');
  check('local: no request → localhost:PORT', linkBase('http://localhost:3000', { PORT: '4100' }, undefined) === 'http://localhost:4100');

  // ── request scoping ──────────────────────────────────────────────────────
  const scoped = await runWithLinkOrigin(PREVIEW_ORIGIN, async () => {
    await new Promise(r => setTimeout(r, 5));
    return linkBase('https://fgac.ai', PREVIEW);
  });
  check('request origin survives an await', scoped === PREVIEW_ORIGIN);
  const [a, b] = await Promise.all([
    runWithLinkOrigin('https://a.vercel.app', async () => { await new Promise(r => setTimeout(r, 10)); return linkBase('x', PREVIEW); }),
    runWithLinkOrigin('https://b.vercel.app', async () => { await new Promise(r => setTimeout(r, 1)); return linkBase('x', PREVIEW); }),
  ]);
  check('concurrent requests keep their own origin', a === 'https://a.vercel.app' && b === 'https://b.vercel.app');
  check('outside a request → deployment origin', linkBase('https://fgac.ai', PREVIEW) === `https://${PREVIEW.VERCEL_URL}`);

  // ── approval links built on it ───────────────────────────────────────────
  const action = { action: 'send_whitelist' as const, recipient: 'someone@example.com' };
  const prodLink = await mintApprovalLink(linkBase('https://fgac.ai', PROD, PREVIEW_ORIGIN), 'user-1', 'key-1', action);
  const baseline = await mintApprovalLink('https://fgac.ai', 'user-1', 'key-1', action);
  check('production approval link identical to the pre-change link', prodLink.url === baseline.url);
  const previewLink = await mintApprovalLink(linkBase('https://fgac.ai', PREVIEW, PREVIEW_ORIGIN), 'user-1', 'key-1', action);
  check('preview approval link points at the preview', previewLink.url.startsWith(`${PREVIEW_ORIGIN}/dashboard/approve?`));
  check('preview approval link carries the same signed query', previewLink.query === baseline.query);

  // ── read-rule denials (gmailRules) ───────────────────────────────────────
  const rules = [{ service: 'gmail', actionType: 'label_blacklist', regexPattern: 'Label_9', ruleName: 'No HR' }] as unknown as ApplicableRules;
  const message = { labelIds: ['Label_9'] };
  const savedEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  const prodDenial = checkReadRestrictions(rules, message);
  check('production read denial links https://fgac.ai/dashboard', !!prodDenial?.endsWith('adjust rules at https://fgac.ai/dashboard.'));
  process.env.VERCEL_ENV = 'preview';
  const previewDenial = runWithLinkOrigin(PREVIEW_ORIGIN, () => checkReadRestrictions(rules, message));
  check('preview read denial links the preview dashboard', !!previewDenial?.endsWith(`adjust rules at ${PREVIEW_ORIGIN}/dashboard.`));
  check('preview read denial never names fgac.ai', !/fgac\.ai/.test(previewDenial ?? ''));
  if (savedEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedEnv;

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall link-origin checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
