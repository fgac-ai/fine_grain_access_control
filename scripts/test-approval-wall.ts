/**
 * Unit tests for the approval sign-in wall instrumentation
 * (src/lib/approvalWall.ts).
 * Run: npx tsx scripts/test-approval-wall.ts  (part of `npm run mcp:lint`)
 *
 * What must hold: a signed-out approve-link visit is described with the same
 * action / target_hash the mint event carries (so the wall joins the funnel),
 * the client class tells Claude desktop's in-app browser from a real browser
 * and from agents, only document navigations count as the redirect case, and
 * the marker cookie round-trips into the sign_in_completed properties.
 */
process.env.CLERK_SECRET_KEY ??= 'sk_test_unit_only';

import {
  decodeApprovalWallCookie,
  describeApprovalWallHit,
  encodeApprovalWallCookie,
  isApprovalWallCandidate,
  isDocumentNavigation,
  readCookie,
} from '../src/lib/approvalWall';
import { approvalTargetHash } from '../src/lib/approvalLinks';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const CLAUDE_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.49585.0 Chrome/152.0.7977.76 Safari/537.36';
const CLAUDE_FETCHER = 'Mozilla/5.0 (compatible; Claude-User/1.0; +https://www.anthropic.com)';

const KEY = '11111111-2222-3333-4444-555555555555';
const link = new URL(`https://fgac.ai/dashboard/approve?a=sheets_expose&k=${KEY}&r=1AbCdEfGhIjKlMnOpQrStUvWxYz&s=abcdefabcdefabcdefabcdefabcdefab`);

async function main() {
  console.log('candidate detection:');
  check('approve link with a + s is a wall candidate', isApprovalWallCandidate(link));
  check('result page (?result=ok) is not', !isApprovalWallCandidate(new URL('https://fgac.ai/dashboard/approve?result=ok')));
  check('bare /dashboard/approve is not', !isApprovalWallCandidate(new URL('https://fgac.ai/dashboard/approve')));
  check('other dashboard routes are not', !isApprovalWallCandidate(new URL(`https://fgac.ai/dashboard/agents/default?a=send_all&s=x`)));

  console.log('document navigation (Clerk redirect vs 404):');
  check('sec-fetch-dest: document', isDocumentNavigation(new Headers({ 'sec-fetch-dest': 'document' })));
  check('Accept: text/html without sec-fetch-dest', isDocumentNavigation(new Headers({ accept: 'text/html,application/xhtml+xml' })));
  check('JSON fetch is not', !isDocumentNavigation(new Headers({ accept: 'application/json', 'sec-fetch-dest': 'empty' })));
  check('no headers at all is not', !isDocumentNavigation(new Headers()));

  console.log('hit description:');
  const desktop = await describeApprovalWallHit(link, new Headers({ 'user-agent': CLAUDE_DESKTOP, 'sec-fetch-dest': 'document' }));
  check('action validated from the enum', desktop.action === 'sheets_expose');
  check('proxy key id carried', desktop.proxy_key_id === KEY);
  check('target_hash equals the mint-side hash', desktop.target_hash === await approvalTargetHash('1AbCdEfGhIjKlMnOpQrStUvWxYz'));
  check('raw target never appears in the props', !JSON.stringify(desktop).includes('1AbCdEfGhIjKlMnOpQrStUvWxYz'));
  check('Claude desktop pane classified as claude_desktop, a person', desktop.client === 'claude_desktop' && desktop.agent_driven === false);
  check('navigation true for a document request', desktop.navigation === true);

  const browser = await describeApprovalWallHit(link, new Headers({ 'user-agent': CHROME, accept: 'text/html' }));
  check('real Chrome classified as browser', browser.client === 'browser');

  const agent = await describeApprovalWallHit(link, new Headers({ 'user-agent': CLAUDE_FETCHER, accept: '*/*' }));
  check('Anthropic fetcher classified as agent', agent.client === 'agent' && agent.agent_driven === true);
  check('agent fetch is not a navigation', agent.navigation === false);

  const bogus = await describeApprovalWallHit(new URL('https://fgac.ai/dashboard/approve?a=drop_tables&s=x'), new Headers());
  check('unknown action reported as unknown, not echoed', bogus.action === 'unknown');
  check('send_all-style empty target has no hash', (await describeApprovalWallHit(new URL('https://fgac.ai/dashboard/approve?a=send_all&s=x'), new Headers())).target_hash === undefined);
  check('user agent truncated to 160 chars', (await describeApprovalWallHit(link, new Headers({ 'user-agent': 'x'.repeat(500) }))).user_agent.length === 160);

  console.log('marker cookie:');
  const t0 = 1_760_000_000_000;
  const cookie = encodeApprovalWallCookie(desktop, t0);
  check('cookie omits the key id', !cookie.includes(KEY));
  const marker = decodeApprovalWallCookie(cookie, t0 + 90_000);
  check('round-trips action', marker?.approval_wall_action === 'sheets_expose');
  check('round-trips target hash', marker?.approval_wall_target_hash === desktop.target_hash);
  check('age measured in seconds since the hit', marker?.approval_wall_age_s === 90);
  const noTarget = decodeApprovalWallCookie(encodeApprovalWallCookie({ action: 'send_all' }, t0), t0);
  check('no target → no hash property', noTarget !== null && !('approval_wall_target_hash' in noTarget));
  check('garbage decodes to null', decodeApprovalWallCookie('a=&t=nope') === null);
  check('missing cookie decodes to null', decodeApprovalWallCookie(undefined) === null);
  check('readCookie finds the marker among others', readCookie(`foo=bar; fgac_approval_wall=${encodeURIComponent(cookie)}; baz=1`, 'fgac_approval_wall') === cookie);
  check('readCookie misses absent names', readCookie('foo=bar', 'fgac_approval_wall') === undefined);

  if (failures) { console.error(`\n${failures} approval-wall check(s) failed`); process.exit(1); }
  console.log('\nall approval-wall checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
