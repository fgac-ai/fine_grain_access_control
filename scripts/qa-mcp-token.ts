/**
 * QA MCP bearer for the DEVELOPMENT Clerk instance — consent once, refresh forever.
 *
 * Why: every authenticated MCP QA check (temporary keys, approvals, reconnect, the
 * list_accounts smoke) needs a bearer, and the only way to get one used to be a
 * fresh DCR client + a click on Clerk's consent "Allow" per run. Agents doing that
 * click are routinely stopped by the auto-mode classifier (2026-10-05, 10-07,
 * 10-08), which turned every train's QA into a hand-back. A refresh token removes
 * the consent screen from the loop: one attended mint, then plain HTTPS.
 *
 * One token serves localhost AND every Vercel preview: dev-instance access tokens
 * carry no `aud` (see src/lib/mcpAudience.ts), and every preview uses dev Clerk.
 * Production is refused outright — this script never touches the prod instance.
 *
 *   start  [--user A|B] [--base URL]   register (or reuse) the DCR client, print the
 *                                      authorize URL to open in the QA browser
 *   finish <redirected URL | code> [--user A|B]
 *                                      exchange the code, store the refresh token
 *   token  [--user A|B] [--out PATH]   write a valid access token to a 0600 file and
 *                                      print ONLY the path (refreshes when needed)
 *   check  --base URL [--user A|B]     token + MCP initialize + list_accounts; prints
 *                                      status and which QA user the token resolves to
 *
 * Usage in a runner:  TOKEN_FILE=$(npx tsx scripts/qa-mcp-token.ts token --user A)
 *                     curl -H "Authorization: Bearer $(cat "$TOKEN_FILE")" ...
 * Never echo the token itself; never paste it into results files.
 *
 * Store: <main clone>/.secrets/qa-mcp/<user>.json (gitignored, 0600), shared by
 * every worktree so a mint in one checkout serves them all.
 * Exit codes: 0 ok, 2 usage, 3 needs the one-time consent (start/finish), 1 other.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const DEV_ISSUER_DEFAULT = 'https://pumped-quetzal-63.clerk.accounts.dev';
const DEV_ISSUER_RE = /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/;
// The redirect lands on Clerk's own domain (a 404 page whose URL is readable in
// the browser pane) — a dead localhost listener's chrome-error page is not.
const REDIRECT_PATH = '/qa-cb';
const SCOPES = 'openid profile email offline_access';
const USER_AGENT = 'fgac-qa-mcp-token/1 (+https://github.com/fgac-ai/fine_grain_access_control)';
const REFRESH_MARGIN_MS = 5 * 60_000;

type Store = {
  issuer: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
  pending?: { verifier: string; state: string; created_at: number };
  minted_at?: string;
  refreshed_at?: string;
};

function fail(code: number, msg: string): never {
  console.error(msg);
  process.exit(code);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** Allow only FGAC's own non-production hosts. */
function checkBase(base: string): string {
  const u = new URL(base);
  const host = u.hostname;
  const ok = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')
    || (host.endsWith('.vercel.app') && host.startsWith('fine-grain-access-control'));
  if (!ok) fail(2, `refusing base ${u.origin}: only localhost and fine-grain-access-control *.vercel.app previews (never production)`);
  return u.origin;
}

function checkIssuer(issuer: string): string {
  if (!DEV_ISSUER_RE.test(issuer)) fail(2, `refusing issuer ${issuer}: only the development Clerk instance (*.clerk.accounts.dev)`);
  return issuer;
}

function storeDir(): string {
  const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { encoding: 'utf8' }).trim();
  const dir = path.join(path.dirname(common), '.secrets', 'qa-mcp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function userLabel(): 'A' | 'B' {
  const u = (arg('user') ?? 'A').toUpperCase();
  if (u !== 'A' && u !== 'B') fail(2, '--user must be A or B');
  return u;
}

const storePath = (u: string) => path.join(storeDir(), `user_${u}.json`);

function load(u: string): Store | undefined {
  try { return JSON.parse(fs.readFileSync(storePath(u), 'utf8')); } catch { return undefined; }
}

function save(u: string, s: Store) {
  fs.writeFileSync(storePath(u), JSON.stringify(s, null, 2), { mode: 0o600 });
}

async function issuerFor(base?: string): Promise<string> {
  if (!base) return DEV_ISSUER_DEFAULT;
  const res = await fetch(`${checkBase(base)}/.well-known/oauth-protected-resource/mcp`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) fail(1, `protected-resource metadata returned ${res.status}`);
  const meta = await res.json() as { authorization_servers?: string[] };
  return checkIssuer((meta.authorization_servers?.[0] ?? '').replace(/\/$/, ''));
}

async function tokenRequest(s: Store, body: Record<string, string>) {
  const form = new URLSearchParams({ ...body, client_id: s.client_id, ...(s.client_secret ? { client_secret: s.client_secret } : {}) });
  const res = await fetch(`${s.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: form,
  });
  const json = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  return { status: res.status, json };
}

async function start() {
  const u = userLabel();
  const issuer = await issuerFor(arg('base'));
  let s = load(u);
  if (!s || s.issuer !== issuer) {
    const redirect_uri = `${issuer}${REDIRECT_PATH}`;
    const res = await fetch(`${issuer}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        client_name: `FGAC QA token (USER_${u})`,
        redirect_uris: [redirect_uri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: SCOPES,
      }),
    });
    if (!res.ok) fail(1, `DCR register failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const reg = await res.json() as { client_id: string; client_secret?: string };
    s = { issuer, client_id: reg.client_id, client_secret: reg.client_secret, redirect_uri };
  }
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(12).toString('base64url');
  s.pending = { verifier, state, created_at: Date.now() };
  save(u, s);
  const url = new URL(`${issuer}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: s.client_id, redirect_uri: s.redirect_uri, scope: SCOPES,
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent',
  }).toString();
  console.log(`Open this in the browser signed in to Clerk as USER_${u}, click Allow, then run`);
  console.log(`  npx tsx scripts/qa-mcp-token.ts finish '<the URL the browser lands on>' --user ${u}`);
  console.log(url.toString());
}

async function finish() {
  const u = userLabel();
  const input = process.argv[3];
  if (!input || input.startsWith('--')) fail(2, 'usage: finish <redirected URL | code> [--user A|B]');
  const s = load(u);
  if (!s?.pending) fail(3, `no pending consent for USER_${u} — run start first`);
  let code = input;
  if (input.startsWith('http')) {
    const q = new URL(input).searchParams;
    if (q.get('error')) fail(1, `authorization failed: ${q.get('error')} ${q.get('error_description') ?? ''}`);
    if (q.get('state') !== s.pending.state) fail(1, 'state mismatch — this URL is not from the latest start; run start again');
    code = q.get('code') ?? fail(1, 'no code in URL');
  }
  const { status, json } = await tokenRequest(s, { grant_type: 'authorization_code', code, redirect_uri: s.redirect_uri, code_verifier: s.pending.verifier });
  if (status !== 200 || !json.access_token) fail(1, `code exchange failed: ${status} ${json.error ?? ''} ${json.error_description ?? ''}`);
  if (!json.refresh_token) console.warn('⚠️  no refresh_token returned — offline_access was not granted; this token will need a new consent when it expires');
  delete s.pending;
  Object.assign(s, {
    access_token: json.access_token, refresh_token: json.refresh_token ?? s.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000, minted_at: new Date().toISOString(),
  });
  save(u, s);
  console.log(`stored USER_${u} token (expires ${new Date(s.expires_at!).toISOString()}, refresh token: ${s.refresh_token ? 'yes' : 'NO'})`);
}

/** A valid access token for USER_<u>, refreshing (and persisting a rotated refresh token) when near expiry. */
async function accessToken(u: string): Promise<string> {
  const s = load(u);
  if (!s?.access_token && !s?.refresh_token) fail(3, `no QA token for USER_${u}. One-time consent needed: npx tsx scripts/qa-mcp-token.ts start --user ${u}`);
  if (s.access_token && (s.expires_at ?? 0) - Date.now() > REFRESH_MARGIN_MS) return s.access_token;
  if (!s.refresh_token) fail(3, `USER_${u} token expired and there is no refresh token. Re-run start/finish once.`);
  const { status, json } = await tokenRequest(s, { grant_type: 'refresh_token', refresh_token: s.refresh_token });
  if (status !== 200 || !json.access_token) {
    fail(3, `refresh failed for USER_${u} (${status} ${json.error ?? ''}) — the grant was revoked or expired. Re-run start/finish once.`);
  }
  Object.assign(s, {
    access_token: json.access_token, refresh_token: json.refresh_token ?? s.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000, refreshed_at: new Date().toISOString(),
  });
  save(u, s);
  return s.access_token!;
}

async function token() {
  const u = userLabel();
  const t = await accessToken(u);
  const out = arg('out') ?? path.join(os.tmpdir(), `fgac-qa-mcp-user_${u}.token`);
  fs.writeFileSync(out, t, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log(out);
}

/** Parse a JSON-RPC response that may arrive as plain JSON or as an SSE stream. */
async function rpcResult(res: Response): Promise<{ result?: unknown; error?: { message?: string } }> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
    return data ? JSON.parse(data) : {};
  }
  return text ? JSON.parse(text) : {};
}

async function check() {
  const u = userLabel();
  const base = checkBase(arg('base') ?? fail(2, 'check needs --base URL'));
  const t = await accessToken(u);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${t}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'User-Agent': USER_AGENT,
  };
  const init = await fetch(`${base}/api/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fgac-qa-mcp-token', version: '1' } } }),
  });
  if (init.status !== 200) fail(1, `initialize: HTTP ${init.status}`);
  await rpcResult(init);
  const sid = init.headers.get('mcp-session-id');
  if (sid) headers['Mcp-Session-Id'] = sid;
  const call = await fetch(`${base}/api/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } }),
  });
  const r = await rpcResult(call) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
  const text = r.result?.content?.map(c => c.text ?? '').join('\n') ?? '';
  // Which QA user is this? Compare against the machine-level QA address file without printing it.
  let who = 'unknown';
  try {
    const qa = JSON.parse(fs.readFileSync(path.join(path.dirname(storeDir()), '..', '.qa_test_emails.json'), 'utf8')) as Record<string, string>;
    const hit = Object.entries(qa).filter(([, v]) => typeof v === 'string' && text.includes(v)).map(([k]) => k);
    if (hit.length) who = hit.join('+');
  } catch { /* address file absent: identity stays unknown */ }
  const ok = call.status === 200 && !r.error && !r.result?.isError;
  console.log(`initialize 200; list_accounts HTTP ${call.status} ${ok ? 'OK' : `ERROR ${r.error?.message ?? text.slice(0, 120)}`}; accounts visible include: ${who}`);
  if (!ok) process.exit(1);
}

const cmd = process.argv[2];
const run = { start, finish, token, check }[cmd as 'start'];
if (!run) fail(2, 'usage: qa-mcp-token.ts start|finish|token|check [--user A|B] [--base URL] [--out PATH]');
run().catch(e => fail(1, `qa-mcp-token: ${e instanceof Error ? e.message : e}`));
