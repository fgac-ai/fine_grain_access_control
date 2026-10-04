/**
 * Temporary API keys + large-transfer relay in the REST proxy
 * (src/lib/temporaryApiKeys.ts, src/app/api/proxy/[...path]/route.ts).
 * Run: npx tsx scripts/test-temporary-api-keys.ts  (part of `npm run mcp:lint`)
 *
 * Same harness as test-rest-proxy-policy.ts: the real route handlers with a
 * stubbed drizzle (fixture rows per table, recorded inserts/updates) and a
 * stubbed global fetch standing in for Clerk and Google. Pins:
 *   - a temporary key resolves to its parent profile (same refusals), and
 *     expired / revoked / parent-revoked keys are refused before Google;
 *   - FGAC refuses bodies over its cap with guidance (Vercel would 413 blind);
 *   - resumable sessions: Google's session URL never reaches the caller, the
 *     FGAC session id is bound to the opening profile, chunks are relayed to
 *     Google's URL, and a Gmail send's recipients are checked on the byte-0
 *     chunk with the verdict enforced on every later chunk;
 *   - attachments are read-rule checked on the parent message, then piped;
 *     Drive media is piped byte-for-byte.
 * Plan: docs/implementation_plans/large-api-payload-options_v5.md
 */
process.env.neon__POSTGRES_URL = ['postgres://fixture', 'ep-test-fixture.invalid/db'].join(':fixture' + String.fromCharCode(64));
process.env.CLERK_SECRET_KEY = 'sk_test_fixture';
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_Zml4dHVyZS5jbGVyay5hY2NvdW50cy5kZXYk';
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.NEXT_PUBLIC_POSTHOG_HOST;

import { NextRequest } from 'next/server';
import {
  clampTtlMinutes, expectedBytesBucket, generateTemporaryKey, hashTemporaryKey, isTemporaryKey,
  temporaryKeyRecipe, hashUploadId, TEMP_KEY_PREFIX, PROXY_MAX_REQUEST_BYTES,
} from '../src/lib/temporaryApiKeys';

const OWNER_EMAIL = 'owner@example.com';
const ALLOWED = 'allowed@example.com';
const OUTSIDER = 'outsider@example.com';
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const GOOGLE_UPLOAD_ID = 'GOOGLE-SESSION-SECRET-abc123';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got).slice(0, 400)}`}`); }
  else console.log(`  ✓ ${name}`);
}

type Row = Record<string, unknown>;
const TEMP = generateTemporaryKey();
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
let tempKeyRow: Row = {};
let parentKeyRow: Row = {};
let rules: Row[] = [];
let sessions: Row[] = [];
let mailboxRows: Row[] = [];
let googleCalls: Array<{ url: string; method: string; headers: Headers; bodyBytes: number }> = [];
const MEDIA = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256)); // binary, not UTF-8 safe

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/clerk/.test(new URL(url).hostname)) {
      return new Response(JSON.stringify({ total_count: 1, data: [{
        object: 'oauth_access_token', external_account_id: 'eac_fixture', provider: 'oauth_google', token: 'google-fixture-token',
        public_metadata: {}, label: null,
        scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.file'],
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = init?.body as ArrayBuffer | undefined;
    googleCalls.push({ url, method, headers: new Headers(init?.headers), bodyBytes: body ? body.byteLength : 0 });
    const u = new URL(url);
    if (u.searchParams.get('uploadType') === 'resumable' && !u.searchParams.get('upload_id')) {
      if (u.searchParams.get('fixture') === 'nolocation') return new Response(null, { status: 200, headers: { 'x-guploader-uploadid': GOOGLE_UPLOAD_ID } });
      const loc = `https://www.googleapis.com${u.pathname}?uploadType=resumable&upload_id=${GOOGLE_UPLOAD_ID}`;
      return new Response(null, { status: 200, headers: { location: loc, 'x-guploader-uploadid': GOOGLE_UPLOAD_ID } });
    }
    if (u.searchParams.get('upload_id')) {
      const range = new Headers(init?.headers).get('content-range') ?? '';
      const m = range.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (m && Number(m[2]) + 1 < Number(m[3])) return new Response(null, { status: 308, headers: { range: `bytes=0-${m[2]}`, 'x-guploader-uploadid': GOOGLE_UPLOAD_ID } });
      return new Response(JSON.stringify({ id: 'new-file-id' }), { status: 200, headers: { 'content-type': 'application/json', 'x-guploader-uploadid': GOOGLE_UPLOAD_ID } });
    }
    if (/\/messages\/m1\?format=full/.test(url)) {
      return new Response(JSON.stringify({ id: 'm1', labelIds: ['INBOX', 'SECRET'], payload: { headers: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/messages\/m2\?format=full/.test(url)) {
      return new Response(JSON.stringify({ id: 'm2', labelIds: ['INBOX'], payload: { headers: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/attachments\//.test(url)) {
      return new Response(JSON.stringify({ size: 3, data: 'YWJj' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.searchParams.get('alt') === 'media') {
      return new Response(MEDIA, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(MEDIA.length) } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function main() {
  console.log('temporary-api-keys — pure helpers:');
  check('default lifetime is 15 min', clampTtlMinutes(undefined).granted === 15);
  check('60 min is granted as asked', clampTtlMinutes(60).granted === 60 && !clampTtlMinutes(60).capped);
  check('120 min is capped to 60 and reported as capped', clampTtlMinutes(120).granted === 60 && clampTtlMinutes(120).capped);
  check('sub-minute rounds up to 1', clampTtlMinutes(0.4).granted === 1);
  check('generated keys carry the temporary prefix', TEMP.key.startsWith(TEMP_KEY_PREFIX) && isTemporaryKey(TEMP.key));
  check('standing keys are not temporary', !isTemporaryKey('sk_proxy_abcdef'));
  check('hash is deterministic and not the key', hashTemporaryKey(TEMP.key) === TEMP.hash && TEMP.hash !== TEMP.key);
  check('size buckets', expectedBytesBucket(500_000) === '<1M' && expectedBytesBucket(3_000_000) === '1-4.5M'
    && expectedBytesBucket(10_000_000) === '4.5-35M' && expectedBytesBucket(50_000_000) === '35M+' && expectedBytesBucket(undefined) === undefined);
  const recipe = temporaryKeyRecipe({ key: TEMP.key, baseUrl: 'https://preview.example.com', purpose: 'upload', ttlGranted: 60, ttlRequested: 120, capped: true, expiresAt: minutesFromNow(60) });
  check('recipe names the base URL on the serving host', recipe.includes('https://preview.example.com/api/proxy'));
  check('recipe states the cap it applied', recipe.includes('granted 60 of the 120 requested'));
  check('recipe states the 4 MB chunk rule and resume step', recipe.includes('4 MB') && recipe.includes('bytes */TOTAL'));

  installFetch();
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const route = await import('../src/app/api/proxy/[...path]/route');

  const owner = { id: 'u_owner', clerkUserId: 'clerk_owner_fixture', email: OWNER_EMAIL };
  const rowsFor = (table: unknown): Row[] => {
    // The stub ignores `where`, so "no such key" is modelled as an empty fixture.
    if (table === schema.temporaryApiKeys) return Object.keys(tempKeyRow).length ? [tempKeyRow] : [];
    if (table === schema.proxyKeys) return [parentKeyRow];
    if (table === schema.users) return [owner];
    if (table === schema.keyEmailAccess) return mailboxRows;
    if (table === schema.accessRules) return rules;
    if (table === schema.keyRuleAssignments) return [];
    if (table === schema.emailDelegations) return [];
    if (table === schema.resumableUploads) return sessions;
    throw new Error('unexpected table in proxy query');
  };
  const dbStub = db as unknown as Record<string, unknown>;
  dbStub.select = () => {
    let rows: Row[] = [];
    const q = {
      from(t: unknown) { rows = rowsFor(t); return q; },
      where() { return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(rows).then(res, rej); },
    };
    return q;
  };
  dbStub.insert = (table: unknown) => ({
    values(v: Row) {
      if (table === schema.resumableUploads) sessions.push({ id: `s${sessions.length + 1}`, recipientVerdict: null, ...v });
      const done = { onConflictDoNothing: () => Promise.resolve(), then: (res: (x: unknown) => unknown) => Promise.resolve().then(res) };
      return done;
    },
  });
  dbStub.update = (table: unknown) => ({
    set(v: Row) {
      return { where: () => { if (table === schema.resumableUploads) sessions.forEach(s => Object.assign(s, v)); return Promise.resolve(); } };
    },
  });

  type Handler = (r: NextRequest, c: { params: Promise<{ path: string[] }> }) => Promise<Response>;
  const handlers: Record<string, Handler> = { GET: route.GET, POST: route.POST, PUT: route.PUT, PATCH: route.PATCH, DELETE: route.DELETE };
  async function call(method: string, pathOrUrl: string, opts: { body?: BodyInit; contentType?: string; headers?: Record<string, string>; key?: string } = {}) {
    googleCalls = [];
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `http://localhost:3000/api/proxy/${pathOrUrl}`;
    const pathname = new URL(url).pathname.replace(/^\/api\/proxy\//, '');
    const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? TEMP.key}`, ...(opts.headers ?? {}) };
    if (opts.contentType) headers['content-type'] = opts.contentType;
    const req = new NextRequest(url, { method, headers, body: opts.body });
    const res = await handlers[method](req, { params: Promise.resolve({ path: pathname.split('/').map(decodeURIComponent) }) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), google: googleCalls };
  }
  const refusedBeforeGoogle = (r: { status: number; google: unknown[] }) => r.status >= 400 && r.status < 500 && r.google.length === 0;
  const reset = () => {
    tempKeyRow = { id: 't1', keyHash: TEMP.hash, parentKeyId: 'k1', expiresAt: minutesFromNow(15), revokedAt: null };
    parentKeyRow = { id: 'k1', userId: owner.id, key: 'sk_proxy_parent', revokedAt: null, expiresAt: null, driveDefault: null };
    rules = [];
    mailboxRows = [{ id: 'kea1', proxyKeyId: 'k1', targetEmail: OWNER_EMAIL, delegationId: null }];
  };

  console.log('temporary-api-keys — authentication:');
  reset();
  let r = await call('GET', 'gmail/v1/users/me/messages?maxResults=1');
  check('a live temporary key reaches what its profile reaches', r.status === 200 && r.google.length === 1, r);
  r = await call('PATCH', `upload/drive/v3/files/${FILE_ID}?uploadType=media`, { body: 'x', contentType: 'text/plain' });
  check('a temporary key gets the profile\'s refusals (unexposed Drive file)', refusedBeforeGoogle(r), r);
  tempKeyRow.expiresAt = minutesFromNow(-1);
  r = await call('GET', 'gmail/v1/users/me/messages');
  check('an expired temporary key is refused with re-mint + resume guidance', r.status === 401 && r.google.length === 0
    && r.text.includes('create_temporary_api_key') && r.text.includes('bytes */TOTAL'), r);
  reset(); tempKeyRow.revokedAt = new Date();
  r = await call('GET', 'gmail/v1/users/me/messages');
  check('a revoked temporary key is refused', r.status === 401 && r.google.length === 0 && /revoked/.test(r.text), r);
  reset(); parentKeyRow.revokedAt = new Date();
  r = await call('GET', 'gmail/v1/users/me/messages');
  check('revoking the parent profile kills its temporary keys', r.status === 401 && r.google.length === 0 && /profile/.test(r.text), r);
  reset(); tempKeyRow = {} as Row;
  r = await call('GET', 'gmail/v1/users/me/messages');
  check('an unknown temporary key is refused', r.status === 401 && r.google.length === 0, r);

  console.log('temporary-api-keys — size guard:');
  reset();
  // Real clients send Content-Length; NextRequest does not derive it from a buffer body.
  r = await call('POST', 'upload/drive/v3/files?uploadType=media', { body: Buffer.alloc(PROXY_MAX_REQUEST_BYTES + 1), contentType: 'application/octet-stream', headers: { 'content-length': String(PROXY_MAX_REQUEST_BYTES + 1) } });
  check('a body over the FGAC cap is refused with resumable guidance, before Google', r.status === 413 && r.google.length === 0 && r.text.includes('uploadType=resumable'), r);

  console.log('temporary-api-keys — Drive resumable relay:');
  reset(); sessions = [];
  r = await call('POST', 'upload/drive/v3/files?uploadType=resumable', { body: JSON.stringify({ name: 'big.bin' }), contentType: 'application/json', headers: { 'x-upload-content-length': '600000' } });
  const loc = r.headers.get('location') ?? '';
  check('initiation returns a session URL on FGAC\'s host', r.status === 200 && loc.startsWith('http://localhost:3000/api/proxy/upload/drive/v3/files?'), loc);
  const leaks = (res: { headers: Headers; text: string }) => [...res.headers.entries()].some(([, v]) => v.includes(GOOGLE_UPLOAD_ID)) || res.text.includes(GOOGLE_UPLOAD_ID);
  check('Google\'s upload id never reaches the caller (Location, X-GUploader-UploadID, body)', !leaks(r), [...r.headers.entries()]);
  check('the session is bound to the opening profile and Google\'s URL kept server-side',
    sessions.length === 1 && sessions[0].parentKeyId === 'k1' && String(sessions[0].googleSessionUrl).includes(GOOGLE_UPLOAD_ID)
    && sessions[0].uploadIdHash === hashUploadId(new URL(loc).searchParams.get('upload_id') ?? ''), sessions);
  const viaGmailHost = await call('POST', 'https://gmail.fgac.ai/api/proxy/upload/drive/v3/files?uploadType=resumable', { body: '{}', contentType: 'application/json' });
  const gmailHostLoc = viaGmailHost.headers.get('location') ?? '';
  check('on the gmail.fgac.ai proxy host the session URL has no /api/proxy prefix (the middleware adds it)',
    gmailHostLoc.startsWith('https://gmail.fgac.ai/upload/drive/v3/files?'), gmailHostLoc);
  sessions = sessions.slice(0, 1);
  r = await call('PUT', loc, { body: Buffer.alloc(262_144), headers: { 'content-range': 'bytes 0-262143/600000' } });
  check('chunk responses carry no Google upload id either', !leaks(r), [...r.headers.entries()]);
  check('a chunk is relayed to Google\'s session URL with its Content-Range (308 = continue)',
    r.status === 308 && r.google.length === 1 && r.google[0].url.includes(GOOGLE_UPLOAD_ID)
    && r.google[0].headers.get('content-range') === 'bytes 0-262143/600000' && r.google[0].bodyBytes === 262_144, r);
  r = await call('PUT', loc, { body: Buffer.alloc(600_000 - 262_144), headers: { 'content-range': 'bytes 262144-599999/600000' } });
  check('the final chunk completes the upload', r.status === 200 && r.text.includes('new-file-id'), r);
  r = await call('PUT', loc, { headers: { 'content-range': 'bytes */600000' } });
  check('a status query is relayed', r.status === 200 && r.google.length === 1, r);
  const opened = sessions;
  sessions = []; // the stub ignores `where`: an unknown upload_id is an empty lookup
  r = await call('PUT', 'upload/drive/v3/files?uploadType=resumable&upload_id=not-an-fgac-session', { body: Buffer.alloc(10) });
  check('a chunk for a session FGAC never opened is refused before Google', refusedBeforeGoogle(r), r);
  sessions = opened;
  sessions[0].parentKeyId = 'k_other';
  r = await call('PUT', loc, { body: Buffer.alloc(10), headers: { 'content-range': 'bytes 0-9/600000' } });
  check('a chunk from a different profile is refused before Google', refusedBeforeGoogle(r), r);
  r = await call('PATCH', `upload/drive/v3/files/${FILE_ID}?uploadType=resumable`, { body: '{}', contentType: 'application/json' });
  check('resumable update of an unexposed file is refused at initiation', refusedBeforeGoogle(r), r);
  r = await call('POST', 'upload/drive/v3/files?uploadType=resumable&fixture=nolocation', { body: '{}', contentType: 'application/json' });
  check('an initiation Google answers without a usable session URL fails closed (502, no Google id)', r.status === 502 && !leaks(r), r);

  const rwRule = { id: 'r_rw', userId: owner.id, service: 'sheets', actionType: 'sheet_read_write', targetResourceId: FILE_ID, regexPattern: null, targetEmail: null, ruleName: 'rw' };
  reset(); sessions = []; rules = [rwRule];
  r = await call('PATCH', `upload/drive/v3/files/${FILE_ID}?uploadType=resumable`, { body: '{}', contentType: 'application/json' });
  const updLoc = r.headers.get('location') ?? '';
  check('resumable update of a Read & Write file opens a session bound to the file', r.status === 200 && sessions[0]?.fileId === FILE_ID, sessions);
  r = await call('PUT', updLoc, { body: Buffer.alloc(262_144), headers: { 'content-range': 'bytes 0-262143/600000' } });
  check('its chunks are relayed while the rule allows writes', r.status === 308, r);
  rules = [{ ...rwRule, actionType: 'sheet_read' }];
  r = await call('PUT', updLoc, { body: Buffer.alloc(262_144), headers: { 'content-range': 'bytes 262144-524287/600000' } });
  check('a file switched to Read Only mid-upload stops receiving chunks', refusedBeforeGoogle(r), r);

  console.log('temporary-api-keys — Gmail resumable send:');
  const sendRule = { id: 'r_send', userId: owner.id, service: 'gmail', actionType: 'send_whitelist', regexPattern: ALLOWED, targetEmail: null, targetResourceId: null, ruleName: 'allowed' };
  const message = (hdrs: string) => Buffer.from(`${hdrs}\r\nSubject: big\r\nContent-Type: text/plain\r\n\r\n${'x'.repeat(300_000)}`, 'latin1');
  const openGmailSession = async () => {
    sessions = [];
    const init = await call('POST', 'upload/gmail/v1/users/me/messages/send?uploadType=resumable', { body: '{}', contentType: 'application/json' });
    return { init, loc: init.headers.get('location') ?? '' };
  };
  reset(); rules = [sendRule];
  let g = await openGmailSession();
  check('initiation passes without a message and opens an FGAC session', g.init.status === 200 && g.loc.includes('/api/proxy/upload/gmail/') && sessions[0]?.kind === 'gmail_send', g.init);
  let msg = message(`To: ${ALLOWED}\r\nCc: ${OUTSIDER}`);
  r = await call('PUT', g.loc, { body: msg.subarray(0, 262_144), headers: { 'content-range': `bytes 0-262143/${msg.length}` } });
  check('a first chunk with a non-whitelisted Cc is refused before Google', refusedBeforeGoogle(r) && sessions[0].recipientVerdict === 'denied', r);
  r = await call('PUT', g.loc, { body: msg.subarray(262_144), headers: { 'content-range': `bytes 262144-${msg.length - 1}/${msg.length}` } });
  check('later chunks of a refused send are refused too', refusedBeforeGoogle(r), r);

  g = await openGmailSession();
  msg = message(`To: ${ALLOWED}\r\nBcc: ${OUTSIDER}`);
  r = await call('PUT', g.loc, { body: msg.subarray(0, 262_144), headers: { 'content-range': `bytes 0-262143/${msg.length}` } });
  check('a non-whitelisted Bcc is refused too', refusedBeforeGoogle(r), r);

  g = await openGmailSession();
  msg = message(`To: ${ALLOWED}`);
  r = await call('PUT', g.loc, { body: msg.subarray(262_144), headers: { 'content-range': `bytes 262144-${msg.length - 1}/${msg.length}` } });
  check('a chunk past byte 0 before the headers were checked is refused', refusedBeforeGoogle(r), r);
  r = await call('PUT', g.loc, { body: msg.subarray(0, 20), headers: { 'content-range': `bytes 0-19/${msg.length}` } });
  check('a first chunk that ends inside the header block is refused', refusedBeforeGoogle(r) && /header block/.test(r.text), r);
  r = await call('PUT', g.loc, { body: msg.subarray(0, 262_144), headers: { 'content-range': `bytes 0-262143/${msg.length}` } });
  check('a whitelisted first chunk is relayed to Google', r.status === 308 && r.google.length === 1 && r.google[0].url.includes(GOOGLE_UPLOAD_ID) && sessions[0].recipientVerdict === 'allowed', r);
  r = await call('PUT', g.loc, { body: msg.subarray(262_144), headers: { 'content-range': `bytes 262144-${msg.length - 1}/${msg.length}` } });
  check('the rest of an allowed send is relayed and completes', r.status === 200 && r.google.length === 1, r);

  g = await openGmailSession();
  r = await call('PUT', g.loc, { headers: { 'content-range': `bytes */${msg.length}` } });
  check('a status query before the recipients were checked is refused', refusedBeforeGoogle(r), r);
  r = await call('PUT', g.loc, { body: msg.subarray(0, 262_144), headers: { 'content-range': 'bytes zero-262143/x' } });
  check('an unparseable Content-Range on a send is refused', refusedBeforeGoogle(r), r);
  r = await call('PUT', g.loc, { body: msg.subarray(0, 262_144), headers: { 'content-range': `bytes 0-262143/${msg.length}` } });
  check('(allowed byte-0 chunk)', r.status === 308, r);
  r = await call('PUT', g.loc, { body: msg.subarray(100_000, 362_144), headers: { 'content-range': `bytes 100000-362143/${msg.length}` } });
  check('after the check, a chunk at an offset below 256 KB is refused (header region is byte-0 only)', refusedBeforeGoogle(r), r);
  r = await call('PUT', g.loc, { headers: { 'content-range': `bytes */${msg.length}` } });
  check('after the check, a status query is relayed', r.google.length === 1, r);
  mailboxRows = [];
  r = await call('PUT', g.loc, { body: msg.subarray(262_144), headers: { 'content-range': `bytes 262144-${msg.length - 1}/${msg.length}` } });
  check('a mailbox unticked for the profile mid-upload stops the send', refusedBeforeGoogle(r), r);
  reset(); rules = [sendRule];

  g = await openGmailSession();
  const padded = Buffer.from(`To: ${ALLOWED}\r\nX-Pad: ${'p'.repeat(270_000)}\r\nSubject: s\r\n\r\nbody`, 'latin1');
  r = await call('PUT', g.loc, { body: padded, headers: { 'content-range': `bytes 0-${padded.length - 1}/${padded.length}` } });
  check('a header block that runs past the first 256 KB is refused', refusedBeforeGoogle(r), r);

  sessions = [];
  r = await call('POST', 'upload/gmail/v1/users/me/messages/send?uploadType=resumable', { body: JSON.stringify({ raw: 'eA' }), contentType: 'application/json' });
  check('a resumable send initiation carrying "raw" metadata is refused', refusedBeforeGoogle(r), r);
  r = await call('POST', 'upload/gmail/v1/users/me/drafts/send?uploadType=resumable', { body: JSON.stringify({ id: 'd1' }), contentType: 'application/json' });
  check('resumable drafts/send is refused (chunk bytes would replace the checked draft)', refusedBeforeGoogle(r) && /resumable/i.test(r.text), r);
  r = await call('POST', 'upload/gmail/v1/users/me/messages?uploadType=resumable', { body: '{}', contentType: 'application/json' });
  check('resumable Gmail insert is refused (not a relayed kind)', refusedBeforeGoogle(r), r);

  console.log('temporary-api-keys — streamed downloads:');
  reset(); rules = [{ id: 'r_lbl', userId: owner.id, service: 'gmail', actionType: 'label_blacklist', regexPattern: 'SECRET', targetEmail: null, targetResourceId: null, ruleName: 'secret label' }];
  r = await call('GET', 'gmail/v1/users/me/messages/m1/attachments/a1');
  check('an attachment of a read-blocked message is refused; the attachment is never fetched',
    r.status === 403 && r.google.length === 1 && /format=full/.test(r.google[0].url), r);
  r = await call('GET', 'gmail/v1/users/me/messages/m2/attachments/a1');
  check('an attachment of a readable message is returned', r.status === 200 && r.text.includes('YWJj') && r.google.length === 2, r);
  reset(); rules = [{ id: 'r_sheet', userId: owner.id, service: 'sheets', actionType: 'sheet_read', targetResourceId: FILE_ID, regexPattern: null, targetEmail: null, ruleName: 'sheet' }];
  r = await call('GET', `drive/v3/files/${FILE_ID}?alt=media`);
  check('Drive media is piped byte-for-byte (binary-safe)', r.status === 200 && Buffer.compare(r.buf, MEDIA) === 0, { status: r.status, len: r.buf.length });

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall temporary-api-keys checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
