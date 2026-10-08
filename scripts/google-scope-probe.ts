/* eslint-disable */
/**
 * Google-scope probe for the two QA accounts on the DEV Clerk instance.
 *
 * For each account it prints, side by side, what Clerk's record says and
 * what the served access token actually carries:
 *   - Clerk external account: verification status, `approved_scopes`
 *     (Clerk's record of the last OAuth request that completed), updated_at
 *   - Clerk's token endpoint: the `scopes` array returned with the token
 *   - Google tokeninfo on that token: live scope list, expires_in, and the
 *     OAuth client's project number (so a probe against the wrong Google
 *     client is obvious)
 *
 * Fetching the token makes Clerk refresh an expired one — exactly what every
 * tool call does, so "the first token after expiry" is simply the first probe
 * after `expires_in` has run out.
 *
 * READ-ONLY. Prints USER_A / USER_B labels and scope lists only — never an
 * email, a Clerk id, or the token value. Refuses a live Clerk secret: this is
 * a dev-instance measurement tool (the production counterpart is the
 * counts-only `scripts/google-scope-sweep.ts`).
 *
 *   npx tsx scripts/google-scope-probe.ts              # both accounts
 *   npx tsx scripts/google-scope-probe.ts USER_A       # one account
 *   npx tsx scripts/google-scope-probe.ts --note "after card grant"
 *
 * Reads the QA addresses from .qa_test_emails.json in the checkout, falling
 * back to the same file in an enclosing checkout (a worktree's main clone).
 */
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

config({ path: '.env.local' });

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

type Label = 'USER_A' | 'USER_B';

function loadQaEmails(): Record<Label, string> {
  const name = '.qa_test_emails.json';
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const p = join(dir, name);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      return { USER_A: raw.USER_A_EMAIL, USER_B: raw.USER_B_EMAIL };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${name} not found in this checkout or any enclosing one`);
}

function short(scopes: string[]): string {
  return scopes
    .map(s => (s.startsWith(SCOPE_PREFIX) ? s.slice(SCOPE_PREFIX.length) : s))
    .sort()
    .join(' ');
}

async function clerk(path: string, secret: string) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, { headers: { Authorization: `Bearer ${secret}` } });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function probe(label: Label, email: string, secret: string) {
  const at = new Date().toISOString();
  const list = await clerk(`/users?email_address=${encodeURIComponent(email)}`, secret);
  if (!list.ok || !Array.isArray(list.body) || list.body.length === 0) {
    console.log(`${label}  ${at}  no Clerk user on this instance (HTTP ${list.status})`);
    return;
  }
  const user = list.body[0];
  const google = (user.external_accounts ?? []).find((a: any) => a.provider === 'oauth_google' || a.provider === 'google');
  console.log(`${label}  ${at}`);
  console.log(`  last_sign_in_at           ${user.last_sign_in_at ? new Date(user.last_sign_in_at).toISOString() : '—'}`);
  if (!google) { console.log('  Google external account   none'); return; }
  console.log(`  verification.status       ${google.verification?.status ?? '—'}`);
  console.log(`  record updated_at         ${new Date(google.updated_at).toISOString()}`);
  console.log(`  record approved_scopes    ${short(String(google.approved_scopes ?? '').split(/\s+/).filter(Boolean))}`);

  const tok = await clerk(`/users/${user.id}/oauth_access_tokens/oauth_google`, secret);
  if (!tok.ok || !Array.isArray(tok.body) || !tok.body[0]?.token) {
    const err = tok.body?.errors?.[0];
    console.log(`  token                     unavailable (HTTP ${tok.status}${err ? ` ${err.code}: ${err.long_message ?? err.message}` : ''})`);
    return;
  }
  const entry = tok.body[0];
  console.log(`  token endpoint scopes     ${short(entry.scopes ?? [])}`);
  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(entry.token)}`, { cache: 'no-store' });
  if (!info.ok) { console.log(`  tokeninfo                 HTTP ${info.status} (token rejected by Google)`); return; }
  const data = await info.json();
  const live = String(data.scope ?? '').split(' ').filter(Boolean);
  const project = String(data.aud ?? data.azp ?? '').split('-')[0];
  console.log(`  tokeninfo scopes          ${short(live)}`);
  console.log(`  tokeninfo expires_in      ${data.expires_in}s  (client project ${project || '?'})`);
  const rec = new Set(String(google.approved_scopes ?? '').split(/\s+/).filter(Boolean));
  const onlyLive = live.filter(s => !rec.has(s));
  const onlyRec = [...rec].filter(s => !live.includes(s));
  if (onlyLive.length || onlyRec.length) {
    console.log(`  DISAGREE                  token-only: [${short(onlyLive)}]  record-only: [${short(onlyRec)}]`);
  } else {
    console.log('  record and token agree');
  }
}

async function main() {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) { console.error('CLERK_SECRET_KEY missing (pull the development env first)'); process.exit(1); }
  if (!secret.startsWith('sk_test_')) { console.error('REFUSING: this probe runs against the dev Clerk instance only.'); process.exit(1); }

  const args = process.argv.slice(2);
  const noteIdx = args.indexOf('--note');
  const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined;
  const wanted = args.filter((a, i) => (a === 'USER_A' || a === 'USER_B') && i !== noteIdx + 1) as Label[];
  const emails = loadQaEmails();
  const labels: Label[] = wanted.length ? wanted : ['USER_A', 'USER_B'];

  if (note) console.log(`# ${note}`);
  for (const label of labels) {
    await probe(label, emails[label], secret);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
