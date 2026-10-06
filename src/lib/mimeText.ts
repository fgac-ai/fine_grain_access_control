/**
 * RFC 5322 messages FGAC hands to the Gmail API (`messages/send`, field
 * `raw`). Shared by the typed `gmail_send` MCP tool (src/app/api/mcp/route.ts),
 * the owner notices (approvalNotifyCopy.ts) and the sales-lead confirmation
 * (salesLead.ts), so every message FGAC itself assembles leaves with the same
 * shape: `multipart/alternative` — the plain text the caller wrote, plus a
 * minimal HTML rendering of it — both parts UTF-8 quoted-printable.
 *
 * Why an HTML alternative (measured 2026-10-05, delivered copies fetched with
 * `format=raw`). Gmail does not forward a `text/plain` body as submitted: it
 * decodes the part — whatever its Content-Transfer-Encoding, quoted-printable
 * included — and re-serialises it with its own folding, inserting REAL line
 * breaks at word boundaries around 72 columns. The sender's Sent copy keeps
 * each paragraph as one line; the recipient's copy arrives folded, and on a
 * phone every paragraph renders ragged (a short tail stranded under each
 * wrapped line). A `text/html` part is preserved intact, Gmail's clients
 * render the HTML alternative when one exists, and the phone view reflows
 * correctly — which is also how the claude.ai Gmail connector's messages
 * arrive unbroken. So the HTML part is what fixes the user-visible symptom;
 * quoted-printable on both parts keeps every encoded line within 76 columns
 * so nothing FGAC emits ever needs folding by anyone.
 * Measurements and the blocked QA-account experiment are recorded in
 * docs/implementation_plans/claude-xenodochial-meitner-8b1f5b_v2.md.
 *
 * `google_api_modify` passes an agent's own raw MIME through untouched — its
 * tool description tells agents to add a text/html alternative themselves.
 */
import { randomBytes } from 'node:crypto';

/** RFC 2045 §6.7: an encoded line is at most 76 characters, soft break included. */
export const QP_LINE_MAX = 76;

/**
 * Quoted-printable encode UTF-8 text. Line endings are normalised to CRLF
 * (any of CRLF, CR, LF on input); `=`, every byte outside printable ASCII and
 * trailing whitespace are written as `=XX`; an `=XX` token is never split
 * across a soft break. Decoding the result yields the input with CRLF line
 * endings.
 */
export function encodeQuotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const literal = (b >= 0x21 && b <= 0x7e && b !== 0x3d) || ((b === 0x20 || b === 0x09) && !last);
      const tok = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (cur.length + tok.length > QP_LINE_MAX - 1) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n');
}

/** Inverse of encodeQuotedPrintable, for tests and for reading delivered copies. */
export function decodeQuotedPrintable(encoded: string): string {
  const joined = encoded.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * One header value: CR/LF (which would start a new header — a Bcc injection)
 * become a space, other control characters are dropped.
 */
export function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}

/** Input bytes per RFC 2047 encoded word: 45 bytes → 60 base64 chars + 12 of framing ≤ 75. */
const HEADER_WORD_BYTES = 45;

/**
 * RFC 2047 encoding for a header that may carry non-ASCII (an em dash, an
 * emoji, a non-Latin subject). Pure printable ASCII is returned as is. Longer
 * text becomes several encoded words, each ≤ 75 characters and split only
 * between code points, folded onto continuation lines; a decoder joins
 * adjacent encoded words back into one string.
 */
export function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const chunks: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (chunk && Buffer.byteLength(chunk + ch, 'utf8') > HEADER_WORD_BYTES) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Decode a Subject built by encodeHeaderWord (tests, delivered-copy checks). */
export function decodeHeaderWord(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .split(/\r?\n[ \t]/)
    .map((w) => w.replace(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/, (_m, b64: string) => Buffer.from(b64, 'base64').toString('utf8')))
    .join('');
}

// ─── Plain text → minimal HTML ──────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const URL_RE = /https?:\/\/[^\s<>"]+/g;

/** One line of text → escaped HTML with bare URLs wrapped in anchors. Trailing
 * sentence punctuation stays outside the link; a closing parenthesis stays
 * out only when the URL has no matching opening one. */
function linkifyLine(line: string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    let url = m[0];
    let tail = '';
    const punct = url.match(/[.,;:!?]+$/);
    if (punct) {
      url = url.slice(0, -punct[0].length);
      tail = punct[0];
    }
    while (url.endsWith(')') && url.split('(').length < url.split(')').length) {
      url = url.slice(0, -1);
      tail = `)${tail}`;
    }
    out += `${escapeHtml(line.slice(last, m.index))}<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>${escapeHtml(tail)}`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * The HTML alternative: one `<p>` per paragraph (paragraphs are separated by
 * blank lines), `<br>` for the line breaks inside a paragraph, leading
 * indentation kept as non-breaking spaces, bare URLs made clickable, every
 * other character escaped, CRLF line endings. No styling — the recipient's client renders its
 * own defaults, which is what a plain message deserves.
 */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '').split(/\n{2,}/);
  const blocks = paragraphs.map((p) => {
    const lines = p.split('\n').map((line) => {
      const lead = line.match(/^[ \t]+/)?.[0] ?? '';
      return '&nbsp;'.repeat(lead.replace(/\t/g, '    ').length) + linkifyLine(line.slice(lead.length));
    });
    return `<p>${lines.join('<br>\r\n')}</p>`;
  });
  return `<div>\r\n${blocks.join('\r\n')}\r\n</div>`;
}

// ─── The message ────────────────────────────────────────────────────────────

export interface TextMessage {
  to: string;
  subject: string;
  /** Plain text; any line endings. Sent as UTF-8 quoted-printable, with an HTML alternative generated from it. */
  body: string;
  /** Omitted by gmail_send: Gmail stamps the authenticated mailbox as From. */
  from?: string;
  replyTo?: string;
  cc?: string;
  /** Extra headers written after Subject (e.g. the X-FGAC-Notice DSN tag). */
  extra?: Record<string, string>;
}

const HEADER_NAME = /^[!-9;-~]+$/; // RFC 5322 field-name: printable ASCII except ':'

/** A MIME boundary that cannot occur in quoted-printable output (20 random hex digits; keeps the Content-Type header under 78 columns). */
export function newBoundary(): string {
  return `fgac-${randomBytes(10).toString('hex')}`;
}

/**
 * The RFC 5322 message: addressing headers, Subject (RFC 2047 when needed),
 * extras, `MIME-Version: 1.0`, `Content-Type: multipart/alternative`, then
 * the `text/plain` part and the `text/html` part, each
 * `charset=utf-8` and `Content-Transfer-Encoding: quoted-printable`. CRLF
 * throughout. `boundary` is injectable for deterministic tests.
 */
export function buildTextMessage(msg: TextMessage, boundary: string = newBoundary()): string {
  const h: string[] = [];
  if (msg.from) h.push(`From: ${headerValue(msg.from)}`);
  if (msg.replyTo) h.push(`Reply-To: ${headerValue(msg.replyTo)}`);
  h.push(`To: ${headerValue(msg.to)}`);
  if (msg.cc) h.push(`Cc: ${headerValue(msg.cc)}`);
  h.push(`Subject: ${encodeHeaderWord(headerValue(msg.subject))}`);
  for (const [name, value] of Object.entries(msg.extra ?? {})) {
    if (!HEADER_NAME.test(name)) throw new Error(`mimeText: invalid header name ${JSON.stringify(name)}`);
    h.push(`${name}: ${headerValue(value)}`);
  }
  h.push('MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type: string, content: string) =>
    `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encodeQuotedPrintable(content)}`;
  return `${h.join('\r\n')}\r\n\r\n` +
    `--${boundary}\r\n${part('text/plain', msg.body)}\r\n` +
    `--${boundary}\r\n${part('text/html', textToHtml(msg.body))}\r\n` +
    `--${boundary}--\r\n`;
}

/** The `raw` field of Gmail's messages/send: the message, base64url. */
export function buildTextMessageRaw(msg: TextMessage, boundary?: string): string {
  return Buffer.from(buildTextMessage(msg, boundary), 'utf8').toString('base64url');
}

/**
 * Split a message built by buildTextMessage (or a delivered copy of one) into
 * its header block and decoded parts — tests and QA runbooks use it to check
 * what arrived.
 */
export function parseTextMessage(message: string): { headers: string; parts: Array<{ type: string; encoding: string; raw: string; decoded: string }> } {
  const sep = message.indexOf('\r\n\r\n');
  const headers = message.slice(0, sep);
  const boundary = headers.replace(/\r\n[ \t]+/g, ' ').match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  if (!boundary) {
    const encoding = /^Content-Transfer-Encoding:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? '';
    const raw = message.slice(sep + 4);
    return { headers, parts: [{ type: /^Content-Type:\s*([^;\r\n]+)/im.exec(headers)?.[1]?.trim() ?? '', encoding, raw, decoded: /quoted-printable/i.test(encoding) ? decodeQuotedPrintable(raw) : raw }] };
  }
  const parts = message.slice(sep + 4).split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--')).map((chunk) => {
    const body = chunk.replace(/^\r\n/, '');
    const i = body.indexOf('\r\n\r\n');
    const ph = body.slice(0, i);
    const raw = body.slice(i + 4).replace(/\r\n$/, '');
    const encoding = /^Content-Transfer-Encoding:\s*(.+)$/im.exec(ph)?.[1]?.trim() ?? '';
    return { type: /^Content-Type:\s*([^;\r\n]+)/im.exec(ph)?.[1]?.trim() ?? '', encoding, raw, decoded: /quoted-printable/i.test(encoding) ? decodeQuotedPrintable(raw) : raw };
  });
  return { headers, parts };
}
