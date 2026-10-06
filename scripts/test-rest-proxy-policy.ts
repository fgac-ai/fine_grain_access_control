/**
 * REST proxy (src/app/api/proxy/[...path]/route.ts) policy parity with the
 * MCP raw-call classifier (classifyGoogleApiCall in googleApiPolicy.ts).
 * Run: npx tsx scripts/test-rest-proxy-policy.ts  (part of `npm run mcp:lint`)
 *
 * Drives the real route handlers with a stubbed `db.select` (fixture rows per
 * table, no database) and a stubbed global `fetch` that answers Clerk's
 * OAuth-token endpoint and records every Google call. Each bypass case
 * asserts BOTH the refusal status and that nothing reached Google — a 403
 * after forwarding would still be a write.
 *
 * Pinned bypasses (found by code reading 2026-10-03):
 *   1. `upload/drive/v3/files/{id}` media update missed the anchored Drive
 *      per-file guard and fell into the Gmail branch → overwrite any file.
 *   2. `upload/gmail/v1/.../messages/send` with an RFC 822 body skipped the
 *      send whitelist (JSON parse failed → no recipient → no check), and the
 *      JSON `raw` form only checked the first To: (Cc/Bcc unchecked).
 *   3. `batch/...` multiplex endpoints were forwarded.
 *   4. Non-Gmail families (calendar, people, …) fell into the Gmail branch
 *      and were forwarded with the owner's token.
 * Plus the gaps the shared classifier closes on the way: DELETE (permanent
 * deletion is a product guarantee) and drafts/send (recipients live in the
 * stored draft).
 */
// Env BEFORE any app import: a dummy non-production branch URL keeps
// src/db quiet, a dummy Clerk key lets clerkClient() build, and PostHog stays
// unconfigured so captureServerEvent no-ops.
process.env.neon__POSTGRES_URL = ['postgres://fixture', 'ep-test-fixture.invalid/db'].join(':fixture' + String.fromCharCode(64));
process.env.CLERK_SECRET_KEY = 'sk_test_fixture';
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_Zml4dHVyZS5jbGVyay5hY2NvdW50cy5kZXYk';
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;

import { NextRequest } from 'next/server';

const OWNER_EMAIL = 'owner@example.com';
const ALLOWED = 'allowed@example.com';
const OUTSIDER = 'outsider@example.com';
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const KEY = 'sk_proxy_fixture';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); }
  else console.log(`  ✓ ${name}`);
}

type Row = Record<string, unknown>;
type Fixture = { rules: Row[] };
let fixture: Fixture = { rules: [] };
let googleCalls: Array<{ url: string; method: string }> = [];
let draftRaw = '';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (/clerk/.test(new URL(url).hostname)) {
      return new Response(JSON.stringify({ total_count: 1, data: [{
        object: 'oauth_access_token', external_account_id: 'eac_fixture', provider: 'oauth_google', token: 'google-fixture-token',
        public_metadata: {}, label: null,
        scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.file'],
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Google tokeninfo (scope checks): the fixture token holds drive.file, not the full drive scope.
    if (new URL(url).hostname === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive.file', expires_in: 3000 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    googleCalls.push({ url, method });
    // Drive metadata lookup (the no-rule mime gate): the fixture file is a Sheet.
    if (method === 'GET' && /\/drive\/v3\/files\/[^/?]+\?fields=mimeType/.test(url)) {
      return new Response(JSON.stringify({ mimeType: 'application/vnd.google-apps.spreadsheet' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET' && /\/drafts\/[^/?]+\?format=raw/.test(url)) {
      return new Response(JSON.stringify({ id: 'd1', message: { raw: draftRaw } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function main() {
  installFetch();
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const route = await import('../src/app/api/proxy/[...path]/route');

  const owner = { id: 'u_owner', clerkUserId: 'clerk_owner_fixture', email: OWNER_EMAIL };
  const rowsFor = (table: unknown): Row[] => {
    if (table === schema.proxyKeys) return [{ id: 'k1', userId: owner.id, key: KEY, revokedAt: null, expiresAt: null }];
    if (table === schema.users) return [owner];
    if (table === schema.keyEmailAccess) return [{ id: 'kea1', proxyKeyId: 'k1', targetEmail: OWNER_EMAIL, delegationId: null }];
    if (table === schema.accessRules) return fixture.rules;
    if (table === schema.keyRuleAssignments) return [];
    if (table === schema.emailDelegations) return [];
    throw new Error('unexpected table in REST proxy query');
  };
  // Chainable, thenable stand-in for drizzle's select builder; `where` and
  // `limit` filters are ignored (fixtures are already scoped to one key).
  (db as unknown as { select: () => unknown }).select = () => {
    let rows: Row[] = [];
    const q = {
      from(t: unknown) { rows = rowsFor(t); return q; },
      where() { return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(rows).then(res, rej); },
    };
    return q;
  };

  type Handler = (r: NextRequest, c: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  const handlers: Record<string, Handler> = {
    GET: route.GET, POST: route.POST, PUT: route.PUT, PATCH: route.PATCH, DELETE: route.DELETE,
  };
  async function call(method: string, path: string, opts: { body?: string; contentType?: string; rules?: Row[] } = {}) {
    fixture = { rules: opts.rules ?? [] };
    googleCalls = [];
    const [pathname] = path.split('?');
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
    if (opts.contentType) headers['content-type'] = opts.contentType;
    const req = new NextRequest(`http://localhost:3000/api/proxy/${path}`, { method, headers, body: opts.body });
    const res = await handlers[method](req, { params: Promise.resolve({ path: pathname.split('/').map(decodeURIComponent) }) });
    return { status: res.status, text: await res.text(), google: googleCalls };
  }
  // "Nothing reached Google" except the read-only metadata lookup the no-rule
  // Drive gate makes to learn the file's kind (never a write, never content).
  const refused = (r: { status: number; google: Array<{ url: string; method: string }> }) => r.status >= 400 && r.status < 500
    && r.google.every(g => g.method === 'GET' && /\?fields=mimeType/.test(g.url));

  const sendRule = { id: 'r_send', userId: owner.id, service: 'gmail', actionType: 'send_whitelist', regexPattern: ALLOWED, targetEmail: null, targetResourceId: null, ruleName: 'allowed' };
  const sheetRead = { id: 'r_sheet', userId: owner.id, service: 'sheets', actionType: 'sheet_read', targetResourceId: FILE_ID, regexPattern: null, targetEmail: null, ruleName: 'sheet' };

  console.log('rest-proxy-policy — bypasses:');
  let r = await call('PATCH', `upload/drive/v3/files/${FILE_ID}?uploadType=media`, { body: 'overwritten', contentType: 'text/plain' });
  check('1. PATCH upload/drive/v3/files/{id} with no rule is refused before Google', refused(r), r);
  r = await call('GET', `drive/v2/files/${FILE_ID}?alt=media`);
  check('1c. Drive v2 file read with no rule is refused (no discovery-passthrough loophole)', refused(r), r);
  r = await call('PATCH', `upload/drive/v3/files/${FILE_ID}?uploadType=media`, { body: 'x', contentType: 'text/plain', rules: [sheetRead] });
  check('1b. PATCH upload/drive/v3/files/{id} under a Read Only rule is refused', refused(r), r);

  const rfc822 = (hdrs: string) => `${hdrs}\r\nSubject: hi\r\n\r\nbody`;
  r = await call('POST', 'upload/gmail/v1/users/me/messages/send?uploadType=media', { body: rfc822(`To: ${OUTSIDER}`), contentType: 'message/rfc822' });
  check('2. upload/ send with RFC 822 body and no whitelist is refused', refused(r), r);
  r = await call('POST', 'upload/gmail/v1/users/me/messages/send?uploadType=media', { body: rfc822(`To: ${OUTSIDER}`), contentType: 'message/rfc822', rules: [sendRule] });
  check('2b. upload/ send to a non-whitelisted recipient is refused', refused(r), r);
  r = await call('POST', 'gmail/v1/users/me/messages/send', { body: JSON.stringify({ raw: b64url(rfc822(`To: ${ALLOWED}\r\nBcc: ${OUTSIDER}`)) }), contentType: 'application/json', rules: [sendRule] });
  check('2c. JSON raw send with a non-whitelisted Bcc is refused', refused(r), r);
  r = await call('POST', 'gmail/v1/users/me/messages/send', { body: JSON.stringify({ raw: b64url(rfc822(`To: ${ALLOWED}\r\nCc: ${OUTSIDER}`)) }), contentType: 'application/json', rules: [sendRule] });
  check('2d. JSON raw send with a non-whitelisted Cc is refused', refused(r), r);
  r = await call('POST', 'gmail/v1/users/me/messages/send', { body: JSON.stringify({ raw: b64url('Subject: no recipients\r\n\r\nbody') }), contentType: 'application/json', rules: [sendRule] });
  check('2e. send whose recipients cannot be determined is refused', refused(r), r);
  r = await call('POST', 'gmail/v1/users/me/messages/send', { body: 'not json', contentType: 'text/plain', rules: [sendRule] });
  check('2f. send with an unparseable body is refused', refused(r), r);

  r = await call('POST', 'batch/gmail/v1', { body: `--b\r\nContent-Type: application/http\r\n\r\nPOST /gmail/v1/users/me/messages/send\r\n\r\n--b--`, contentType: 'multipart/mixed; boundary=b' });
  check('3. batch/gmail/v1 is refused', refused(r), r);
  r = await call('POST', 'batch/drive/v3', { body: 'x', contentType: 'multipart/mixed; boundary=b' });
  check('3b. batch/drive/v3 is refused', refused(r), r);

  r = await call('GET', 'calendar/v3/users/me/calendarList');
  check('4. calendar family is refused', refused(r), r);
  r = await call('GET', 'people/v1/people/me/connections');
  check('4b. people family is refused', refused(r), r);
  r = await call('GET', 'oauth2/v2/userinfo');
  check('4c. unknown family is refused (deny-by-default on REST)', refused(r), r);

  r = await call('DELETE', 'gmail/v1/users/me/messages/abc123');
  check('5. DELETE on a Gmail message is refused (deletion guarantee)', refused(r), r);
  r = await call('DELETE', `drive/v3/files/${FILE_ID}`, { rules: [{ ...sheetRead, actionType: 'sheet_read_write' }] });
  check('5b. DELETE on a Drive file is refused even under Read & Write', refused(r), r);

  draftRaw = b64url(rfc822(`To: ${OUTSIDER}`));
  r = await call('POST', 'gmail/v1/users/me/drafts/send', { body: JSON.stringify({ id: 'd1' }), contentType: 'application/json', rules: [sendRule] });
  check('6. drafts/send of a draft addressed outside the whitelist is not sent',
    r.status === 403 && !r.google.some(g => g.method === 'POST'), r);

  console.log('rest-proxy-policy — allowed paths still work:');
  r = await call('GET', 'gmail/v1/users/me/messages?maxResults=5');
  check('gmail list forwards to www.googleapis.com', r.status === 200 && r.google.length === 1 && r.google[0].url.startsWith('https://www.googleapis.com/gmail/v1/users/me/messages'), r);
  r = await call('POST', 'gmail/v1/users/me/messages/abc/modify', { body: JSON.stringify({ removeLabelIds: ['UNREAD'] }), contentType: 'application/json' });
  check('gmail modify (mark read) forwards', r.status === 200 && r.google.length === 1, r);
  r = await call('POST', 'gmail/v1/users/me/messages/send', { body: JSON.stringify({ raw: b64url(rfc822(`To: ${ALLOWED}`)) }), contentType: 'application/json', rules: [sendRule] });
  check('whitelisted JSON send forwards', r.status === 200 && r.google.length === 1, r);
  r = await call('POST', 'upload/gmail/v1/users/me/messages/send?uploadType=media', { body: rfc822(`To: ${ALLOWED}`), contentType: 'message/rfc822', rules: [sendRule] });
  check('whitelisted upload/ RFC 822 send forwards to the upload host path', r.status === 200 && r.google.length === 1 && r.google[0].url.startsWith('https://www.googleapis.com/upload/gmail/v1/'), r);
  draftRaw = b64url(rfc822(`To: ${ALLOWED}`));
  r = await call('POST', 'gmail/v1/users/me/drafts/send', { body: JSON.stringify({ id: 'd1' }), contentType: 'application/json', rules: [sendRule] });
  check('drafts/send of a whitelisted draft forwards', r.status === 200 && r.google.some(g => g.method === 'POST' && /drafts\/send/.test(g.url)), r);
  r = await call('GET', 'drive/v3/files?q=trashed%3Dfalse');
  check('Drive listing (discovery) still passes through', r.status === 200 && r.google.length === 1, r);
  r = await call('GET', `drive/v3/files/${FILE_ID}`, { rules: [sheetRead] });
  check('Drive file GET under a Read Only rule forwards', r.status === 200 && r.google.length === 1, r);
  r = await call('GET', `drive/v3/files/${FILE_ID}`);
  check('Drive file GET with no rule is refused', refused(r), r);
  r = await call('PATCH', `upload/drive/v3/files/${FILE_ID}?uploadType=media`, { body: 'x', contentType: 'text/plain', rules: [{ ...sheetRead, actionType: 'sheet_read_write' }] });
  check('upload/ Drive media update under Read & Write forwards to the upload path', r.status === 200 && r.google.length === 1 && r.google[0].url.includes('/upload/drive/v3/files/'), r);
  r = await call('GET', `v4/spreadsheets/${FILE_ID}/values/A1:B2`, { rules: [sheetRead] });
  check('Sheets read under a Read Only rule forwards to sheets.googleapis.com', r.status === 200 && r.google[0]?.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/'), r);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall rest-proxy-policy checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
