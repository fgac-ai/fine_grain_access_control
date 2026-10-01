/**
 * Unit tests for the Clerk auth-redirect telemetry
 * (src/lib/clerkAuthRedirect.ts).
 * Run: npx tsx scripts/test-clerk-auth-redirect.ts  (part of `npm run mcp:lint`)
 *
 * What must hold: the two Clerk redirects middleware can return are told
 * apart from every other redirect (the dev handshake's same-origin return hop
 * counts nothing), `path` never carries an id, the bounce marker counts hops
 * inside one five-minute window and restarts outside it, and the event's
 * properties carry a keyed hash of the Clerk cookie — never the cookie.
 */
process.env.CLERK_SECRET_KEY ??= 'sk_test_unit_only';

import {
  CLERK_BOUNCE_WINDOW_S,
  advanceBounceMarker,
  classifyClerkRedirect,
  decodeBounceMarker,
  describeClerkAuthRedirect,
  encodeBounceMarker,
  stripPathIds,
} from '../src/lib/clerkAuthRedirect';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const ORIGIN = 'https://fgac.ai';
const HANDSHAKE = 'https://clerk.fgac.ai/v1/client/handshake?redirect_url=https%3A%2F%2Ffgac.ai%2Fdashboard&__clerk_api_version=2025-04-10&suffixed_cookies=false&__clerk_hs_reason=session-token-expired&format=nonce';
const DEV_HANDSHAKE = 'https://caring-bird-12.clerk.accounts.dev/v1/client/handshake?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fdashboard&__clerk_hs_reason=dev-browser-missing';
const SIGN_IN = 'https://accounts.fgac.ai/sign-in?redirect_url=https%3A%2F%2Ffgac.ai%2Fdashboard';
const DEV_SIGN_IN = 'https://caring-bird-12.accounts.dev/sign-in?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fdashboard&__clerk_db_jwt=dvb_abc';

console.log('classifyClerkRedirect:');
check('production handshake → handshake', classifyClerkRedirect(HANDSHAKE, ORIGIN) === 'handshake');
check('dev handshake → handshake', classifyClerkRedirect(DEV_HANDSHAKE, 'http://localhost:3000') === 'handshake');
check('hosted sign-in → sign_in', classifyClerkRedirect(SIGN_IN, ORIGIN) === 'sign_in');
check('dev hosted sign-in → sign_in', classifyClerkRedirect(DEV_SIGN_IN, 'http://localhost:3000') === 'sign_in');
check('sign-up page → sign_in', classifyClerkRedirect('https://accounts.fgac.ai/sign-up?redirect_url=x', ORIGIN) === 'sign_in');
check('same-origin /sign-in with redirect_url → sign_in', classifyClerkRedirect('/sign-in?redirect_url=%2Fdashboard', ORIGIN) === 'sign_in');
check('handshake return hop (same-origin clean URL) → null', classifyClerkRedirect('http://localhost:3000/dashboard', 'http://localhost:3000') === null);
check("the app's own profile redirect → null", classifyClerkRedirect('https://fgac.ai/dashboard/agents/default', ORIGIN) === null);
check('Google OAuth redirect → null', classifyClerkRedirect('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', ORIGIN) === null);
check('no Location → null', classifyClerkRedirect(null, ORIGIN) === null);
check('garbage Location → null', classifyClerkRedirect('::not a url::', ORIGIN) === null);

console.log('stripPathIds:');
check('plain path unchanged', stripPathIds('/dashboard') === '/dashboard');
check('uuid segment stripped', stripPathIds('/dashboard/keys/6f1c2a4e-9b1d-4c33-8e2a-0f9d7b6a5c41') === '/dashboard/keys/:id');
check('numeric segment stripped', stripPathIds('/dashboard/agents/12345') === '/dashboard/agents/:id');
check('long opaque token stripped', stripPathIds('/dashboard/approve/AbCdEfGhIjKlMnOpQrStUvWxYz012345') === '/dashboard/approve/:id');
check('short slug kept', stripPathIds('/dashboard/agents/default') === '/dashboard/agents/default');
check('root stays root', stripPathIds('/') === '/');

console.log('bounce marker:');
const t0 = 1_758_400_000_000;
const ids = ['a1b2c3d4e5f60718', 'ffffffffffffffff'];
let n = 0;
const nextId = () => ids[n++ % ids.length];
const first = advanceBounceMarker(undefined, t0, nextId);
check('first hop starts a series at count 1', first.count === 1 && first.id === ids[0] && first.first === Math.floor(t0 / 1000));
const enc = encodeBounceMarker(first);
check('marker round-trips', JSON.stringify(decodeBounceMarker(enc)) === JSON.stringify(first));
const second = advanceBounceMarker(enc, t0 + 4_000, nextId);
check('second hop 4 s later counts 2, same series', second.count === 2 && second.id === first.id && second.first === first.first);
const fifth = [3, 4, 5].reduce((m, k) => advanceBounceMarker(encodeBounceMarker(m), t0 + k * 4_000, nextId), second);
check('five hops in 20 s read bounce_count 5', fifth.count === 5 && fifth.id === first.id);
const late = advanceBounceMarker(encodeBounceMarker(fifth), t0 + (CLERK_BOUNCE_WINDOW_S + 1) * 1000, nextId);
check('a hop after the window starts a fresh series', late.count === 1 && late.id !== first.id);
check('marker from the future starts fresh', advanceBounceMarker(encodeBounceMarker(first), t0 - 60_000, nextId).count === 1);
check('malformed marker is ignored', decodeBounceMarker('nope') === null && decodeBounceMarker('a1b2c3d4e5f60718.x.1') === null && decodeBounceMarker('') === null);

console.log('describeClerkAuthRedirect:');
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const navHeaders = new Headers({ 'user-agent': CHROME, 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml' });
const resHeaders = new Headers({ location: SIGN_IN, 'x-clerk-auth-status': 'signed-out', 'x-clerk-auth-reason': 'session-token-and-uat-missing' });
const marker = { id: ids[0], first: Math.floor(t0 / 1000), count: 3 };

(async () => {
  const signedOut = await describeClerkAuthRedirect({
    kind: 'sign_in',
    url: new URL('https://fgac.ai/dashboard'),
    requestHeaders: navHeaders,
    cookies: { __client_uat: '0' },
    responseHeaders: resHeaders,
    marker,
    nowMs: t0 + 8_000,
  });
  check('kind / path / navigation carried', signedOut.kind === 'sign_in' && signedOut.path === '/dashboard' && signedOut.navigation === true);
  check('reason and status come from Clerk headers', signedOut.reason === 'session-token-and-uat-missing' && signedOut.auth_status === 'signed-out');
  check('__client_uat=0 is not a client cookie', signedOut.has_client_cookie === false && signedOut.has_session_cookie === false);
  check('cookie-less browser has no client_hash and keys on the bounce id', signedOut.client_hash === undefined && signedOut.browser_key === marker.id);
  check('bounce props from the marker', signedOut.bounce_id === marker.id && signedOut.bounce_count === 3 && signedOut.bounce_age_s === 8);
  check('clerk_redirect_count defaults to 0', signedOut.clerk_redirect_count === 0);
  check('client classified as browser', signedOut.client === 'browser' && signedOut.agent_driven === false);

  const SESSION = 'eyJhbGciOiJSUzI1NiJ9.eyJzaWQiOiJzZXNzXzEyMyJ9.sig';
  const loop = await describeClerkAuthRedirect({
    kind: 'handshake',
    url: new URL('https://fgac.ai/dashboard/keys/6f1c2a4e-9b1d-4c33-8e2a-0f9d7b6a5c41'),
    requestHeaders: navHeaders,
    cookies: { __session: SESSION, __client_uat: '1758400000', __clerk_redirect_count: '2' },
    responseHeaders: new Headers({ location: HANDSHAKE, 'x-clerk-auth-status': 'handshake', 'x-clerk-auth-reason': 'session-token-expired' }),
    marker,
    nowMs: t0,
  });
  check('session cookie hashed, 16 chars, never the raw value', typeof loop.client_hash === 'string' && loop.client_hash.length === 16 && !JSON.stringify(loop).includes(SESSION));
  check('browser_key is the client_hash when present', loop.browser_key === loop.client_hash);
  check('cookie flags true', loop.has_session_cookie === true && loop.has_client_cookie === true);
  check("Clerk's own hop counter is read", loop.clerk_redirect_count === 2);
  check('id stripped from path', loop.path === '/dashboard/keys/:id');
  check('handshake reason carried', loop.kind === 'handshake' && loop.reason === 'session-token-expired' && loop.auth_status === 'handshake');
  const again = await describeClerkAuthRedirect({ ...{
    kind: 'handshake' as const, url: new URL('https://fgac.ai/dashboard'), requestHeaders: navHeaders,
    cookies: { __session: SESSION }, responseHeaders: new Headers(), marker, nowMs: t0 } });
  check('same cookie → same hash (stable join key)', again.client_hash === loop.client_hash);
  check('no Clerk headers → no reason / status props', !('reason' in again) && !('auth_status' in again));

  const suffixed = await describeClerkAuthRedirect({
    kind: 'sign_in', url: new URL('https://fgac.ai/dashboard'), requestHeaders: navHeaders,
    cookies: { __session_Ab12: SESSION }, responseHeaders: new Headers(), marker, nowMs: t0 });
  check('suffixed __session_<suffix> counts as the session cookie', suffixed.has_session_cookie === true && suffixed.client_hash === loop.client_hash);

  // The 2026-09-24 specimen: two dev instances on one host — a stale bare
  // __session next to __client_uat=0, with the other instance's suffixed
  // __client_uat still live. Clerk answered session-token-but-no-client-uat
  // forever; the event must say "there IS a live client cookie, and two sets".
  const twoInstances = await describeClerkAuthRedirect({
    kind: 'handshake', url: new URL('http://localhost:3000/dashboard'), requestHeaders: navHeaders,
    cookies: { __session: SESSION, __client_uat: '0', __client_uat_envb8lhk: '1758400000', __clerk_db_jwt_envb8lhk: 'dvb_x' },
    responseHeaders: new Headers(), marker, nowMs: t0 });
  check('a live suffixed __client_uat counts even when the bare one is 0', twoInstances.has_client_cookie === true);
  check('client_uat_cookies counts every instance seen on the host', twoInstances.client_uat_cookies === 2);
  check('cookie-less browser has zero client_uat cookies', agentLike(await describeClerkAuthRedirect({
    kind: 'handshake', url: new URL('https://fgac.ai/dashboard'), requestHeaders: navHeaders,
    cookies: {}, responseHeaders: new Headers(), marker, nowMs: t0 })));
  function agentLike(h: Awaited<ReturnType<typeof describeClerkAuthRedirect>>) { return h.client_uat_cookies === 0 && h.has_client_cookie === false; }

  const fetchHeaders = new Headers({ 'user-agent': 'python-requests/2.32', accept: '*/*' });
  const agent = await describeClerkAuthRedirect({
    kind: 'handshake', url: new URL('https://fgac.ai/dashboard'), requestHeaders: fetchHeaders,
    cookies: {}, responseHeaders: new Headers(), marker, nowMs: t0 });
  check('non-document fetch from an agent: navigation false, client agent', agent.navigation === false && agent.client === 'agent');

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
})();
