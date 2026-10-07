/**
 * Guard: every Google authorization URL FGAC's reconnect leg hands the browser
 * carries `include_granted_scopes=true` (incremental authorization), and nothing
 * else about Clerk's URL is touched.
 * Run: npx tsx scripts/test-google-reconnect-url.ts  (part of `npm run mcp:lint`)
 *
 * Why: a reconnect that requests drive.file for a user who holds the full
 * `drive` scope otherwise narrows Google's token and Clerk's record to the
 * request (measured 2026-10-04, docs/implementation_plans/claude_wizardly-shamir-8304cf_v1.md).
 */
import { startGoogleReconnect, withGrantedScopes, type ClerkUserLike } from '../src/app/dashboard/googleReconnect';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

const CLERK_URL = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123-abc.apps.googleusercontent.com'
  + '&prompt=select_account&redirect_uri=https%3A%2F%2Fclerk.example.com%2Fv1%2Foauth_callback&response_type=code'
  + '&scope=openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file'
  + '&state=opaque-state-value';

console.log('withGrantedScopes');
{
  const out = new URL(withGrantedScopes(CLERK_URL));
  const inp = new URL(CLERK_URL);
  check('adds include_granted_scopes=true', out.searchParams.get('include_granted_scopes') === 'true');
  check('keeps host and path', out.origin + out.pathname === inp.origin + inp.pathname);
  for (const [k, v] of inp.searchParams) {
    check(`keeps ${k} unchanged`, out.searchParams.get(k) === v, `${out.searchParams.get(k)} !== ${v}`);
  }
  check('adds exactly one parameter', [...out.searchParams.keys()].length === [...inp.searchParams.keys()].length + 1);
  check('is idempotent', withGrantedScopes(withGrantedScopes(CLERK_URL)) === withGrantedScopes(CLERK_URL));
  check('overrides an explicit false', new URL(withGrantedScopes(`${CLERK_URL}&include_granted_scopes=false`)).searchParams.getAll('include_granted_scopes').join() === 'true');
  check('returns an unparseable value unchanged', withGrantedScopes('not a url') === 'not a url');
}

console.log('startGoogleReconnect applies it on both branches');
function fakeUser(status: string): { user: ClerkUserLike; calls: string[] } {
  const calls: string[] = [];
  const user: ClerkUserLike = {
    externalAccounts: [{
      provider: 'google',
      verification: { status },
      reauthorize: async () => { calls.push('reauthorize'); return { verification: { externalVerificationRedirectURL: { href: CLERK_URL } } }; },
      destroy: async () => { calls.push('destroy'); },
    }],
    createExternalAccount: async () => { calls.push('create'); return { verification: { externalVerificationRedirectURL: { href: CLERK_URL } } }; },
  };
  return { user, calls };
}
(async () => {
  const verified = fakeUser('verified');
  const a = await startGoogleReconnect(verified.user, 'https://app.example.com/back');
  check('verified account: reauthorize branch', verified.calls.join() === 'reauthorize');
  check('verified account: URL carries the parameter', new URL(a).searchParams.get('include_granted_scopes') === 'true');

  const broken = fakeUser('unverified');
  const b = await startGoogleReconnect(broken.user, 'https://app.example.com/back');
  check('unverified account: destroy + recreate branch', broken.calls.join() === 'destroy,create');
  check('unverified account: URL carries the parameter', new URL(b).searchParams.get('include_granted_scopes') === 'true');

  if (failures > 0) {
    console.error(`\n${failures} reconnect URL check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll reconnect URL checks passed');
})();
