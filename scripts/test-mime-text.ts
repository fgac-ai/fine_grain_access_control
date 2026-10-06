/**
 * Unit tests for src/lib/mimeText.ts — the plain-text RFC 5322 builder behind
 * gmail_send, the owner notices and the sales-lead mail.
 *
 * The regression this pins (2026-10-05): a text/plain body sent without a
 * Content-Transfer-Encoding is hard-wrapped by Gmail's relay at ~72 columns
 * on delivery. Quoted-printable keeps every encoded line within 76 columns
 * so the relay has nothing to fold, and the recipient's client removes the
 * soft breaks, so the decoded body must equal the input byte for byte.
 * Run: npx tsx scripts/test-mime-text.ts  (part of `npm run mcp:lint`)
 */
import {
  buildTextMessage, buildTextMessageRaw, decodeHeaderWord, decodeQuotedPrintable, encodeHeaderWord, encodeQuotedPrintable,
  headerValue, QP_LINE_MAX,
} from '../src/lib/mimeText';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

/** Independent RFC 2045 decoder (not the module's own), so the encoder is checked against the spec, not itself. */
function refDecode(qp: string): string {
  const unsoft = qp.replace(/=\r\n/g, '');
  const bytes = Buffer.from(unsoft.replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return bytes.toString('utf8');
}
const lines = (s: string) => s.split('\r\n');
const longestLine = (s: string) => Math.max(...lines(s).map((l) => l.length));
const crlf = (s: string) => s.replace(/\r\n|\r|\n/g, '\r\n');

// The shape of the production report: one paragraph of 609 characters, no newline.
const paragraph = 'Thanks for the quick turnaround on the draft. I read it twice on my phone this morning and the structure holds up well: the opening states the problem in one sentence, the middle three paragraphs each carry exactly one argument with its evidence, and the close names the decision you are asking for and the date you need it by. Two things I would still change before it goes out. First, the second paragraph quotes a number without saying where it came from, so add the source in parentheses. Second, the last line reads as a question but it is really a request, so make it one. Otherwise send it as is.';
check('fixture is a single long line', !/[\r\n]/.test(paragraph) && paragraph.length > 500);

console.log('encodeQuotedPrintable');
const qp = encodeQuotedPrintable(paragraph);
check('every encoded line is within 76 columns', longestLine(qp) <= QP_LINE_MAX);
check('the paragraph is soft-wrapped, not hard-wrapped', lines(qp).length > 1 && lines(qp).slice(0, -1).every((l) => l.endsWith('=')));
check('an independent decoder recovers the paragraph exactly', refDecode(qp) === paragraph);
check('the module decoder agrees', decodeQuotedPrintable(qp) === paragraph);
check('output is printable ASCII only', /^[\x20-\x7e\t\r\n]*$/.test(qp));

const unicode = 'Résumé — café ✓ 日本語 🎉 naïve "quotes" & <tags> = equals';
const qpU = encodeQuotedPrintable(unicode);
check('non-ASCII and "=" are =XX escaped, nothing else is', /^[\x20-\x7e\t\r\n]*$/.test(qpU) && qpU.includes('=3D') && !/[^=\r\n]=[^0-9A-F\r\n]/.test(qpU));
check('unicode round-trips', refDecode(qpU) === unicode);
check('hex digits are upper case', !/=[0-9a-f]{2}/.test(qpU) || /=[0-9A-F]{2}/.test(qpU) && !/=[0-9]?[a-f]/.test(qpU));

check('trailing space and tab are encoded', encodeQuotedPrintable('abc ') === 'abc=20' && encodeQuotedPrintable('tab\t') === 'tab=09');
check('interior whitespace is literal', encodeQuotedPrintable('a b\tc') === 'a b\tc');
check('line endings normalise to CRLF', encodeQuotedPrintable('a\nb\r\nc\rd') === 'a\r\nb\r\nc\r\nd');
check('blank lines survive', refDecode(encodeQuotedPrintable('p1\n\np2\n')) === 'p1\r\n\r\np2\r\n');
check('empty body encodes to empty', encodeQuotedPrintable('') === '');
check('a 75-column line needs no soft break', encodeQuotedPrintable('x'.repeat(75)) === 'x'.repeat(75));
check('a 76-column line gets exactly one soft break', lines(encodeQuotedPrintable('x'.repeat(76))).length === 2 && refDecode(encodeQuotedPrintable('x'.repeat(76))) === 'x'.repeat(76));
// A multi-byte character whose =XX tokens straddle the 76th column must move whole to the next line.
for (let pad = 68; pad <= 76; pad++) {
  const s = `${'a'.repeat(pad)}é tail`;
  const e = encodeQuotedPrintable(s);
  check(`an =XX token is never split across a soft break (pad ${pad})`, longestLine(e) <= QP_LINE_MAX && refDecode(e) === s && !/=[0-9A-F]?=\r\n/.test(e));
}

console.log('encodeQuotedPrintable: randomised round trip');
let seed = 20261005;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const alphabet = [...'abc XYZ=\t.,;', '\n', '\r\n', 'é', '—', '🎉', '日', '  ', '='];
let fuzzOk = true;
for (let i = 0; i < 300 && fuzzOk; i++) {
  let s = '';
  const n = Math.floor(rnd() * 400);
  for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  const e = encodeQuotedPrintable(s);
  if (longestLine(e) > QP_LINE_MAX || refDecode(e) !== crlf(s) || !/^[\x20-\x7e\t\r\n]*$/.test(e)) { fuzzOk = false; console.error('    failing input:', JSON.stringify(s)); }
}
check('300 random bodies: lines ≤ 76, ASCII only, decode to the CRLF-normalised input', fuzzOk);

console.log('headerValue / encodeHeaderWord');
check('CR/LF cannot start a new header', headerValue('x\r\nBcc: victim@example.com') === 'x Bcc: victim@example.com');
check('other control characters are dropped, tabs kept', headerValue('a\x01b\x7fc\td') === 'abc\td');
check('pure ASCII is left readable', encodeHeaderWord('FGAC: plain') === 'FGAC: plain');
const dash = 'Your agent has asked 3 times to send email to bob@example.com — approve it?';
const encDash = encodeHeaderWord(dash);
check('non-ASCII becomes RFC 2047 base64 words', /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=(\r\n =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)*$/.test(encDash));
check('every encoded word is ≤ 75 characters', encDash.split('\r\n ').every((w) => w.length <= 75));
check('the words decode back to the subject', decodeHeaderWord(encDash) === dash);
const longSubject = '🎉'.repeat(40) + 'é'.repeat(40);
const encLong = encodeHeaderWord(longSubject);
check('a long subject folds into several words, none splitting a code point', encLong.split('\r\n ').length > 2 && encLong.split('\r\n ').every((w) => w.length <= 75 && !Buffer.from(w.slice(10, -2), 'base64').toString('utf8').includes('�')) && decodeHeaderWord(encLong) === longSubject);

console.log('buildTextMessage');
const msg = buildTextMessage({ to: 'owner@example.com', subject: 'Draft feedback', body: paragraph });
const [head, ...rest] = msg.split('\r\n\r\n');
const bodyPart = rest.join('\r\n\r\n');
check('headers: To, Subject, MIME-Version, Content-Type, quoted-printable, in that order',
  head === 'To: owner@example.com\r\nSubject: Draft feedback\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable');
check('no From when none is given (Gmail stamps the sender)', !/^From:/m.test(msg));
check('the body decodes to the input', refDecode(bodyPart) === paragraph);
check('no line of the whole message exceeds 76 columns', longestLine(msg) <= QP_LINE_MAX);
check('CRLF only, never a bare LF', !/[^\r]\n/.test(msg));

const full = buildTextMessage({ from: 'FGAC <support@example.com>', replyTo: 'support@example.com', to: 'owner@example.com', cc: 'delegate@example.org', subject: 'S — t', body: 'B', extra: { 'X-FGAC-Notice': 'dead_grant' } });
check('From, Reply-To, To, Cc lead; the extra header follows Subject',
  full.startsWith('From: FGAC <support@example.com>\r\nReply-To: support@example.com\r\nTo: owner@example.com\r\nCc: delegate@example.org\r\nSubject: =?UTF-8?B?') && /\?=\r\nX-FGAC-Notice: dead_grant\r\nMIME-Version: 1\.0\r\n/.test(full));
for (const field of ['to', 'subject', 'cc', 'from', 'replyTo'] as const) {
  const m = buildTextMessage({ to: 'a@example.com', subject: 's', body: '', [field]: `v\r\nBcc: victim@example.com` });
  check(`a CRLF in ${field} cannot add a header`, !m.includes('\r\nBcc'));
}
check('a CRLF in an extra header value cannot add a header', !buildTextMessage({ to: 'a@example.com', subject: 's', body: '', extra: { 'X-T': 'v\r\nBcc: x@example.com' } }).includes('\r\nBcc'));
let threw = false;
try { buildTextMessage({ to: 'a@example.com', subject: 's', body: '', extra: { 'Bad Name:': 'v' } }); } catch { threw = true; }
check('an invalid extra header name throws', threw);
check('a body that is only "=" signs round-trips', refDecode(buildTextMessage({ to: 'a@example.com', subject: 's', body: '='.repeat(100) }).split('\r\n\r\n')[1]) === '='.repeat(100));

console.log('buildTextMessageRaw');
const raw = buildTextMessageRaw({ to: 'owner@example.com', subject: 'Draft feedback', body: paragraph });
check('is base64url', /^[A-Za-z0-9_-]+$/.test(raw));
check('decodes to the message', Buffer.from(raw, 'base64url').toString('utf8') === msg);

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nmimeText: all checks passed');
