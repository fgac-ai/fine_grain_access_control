/**
 * Plain-text RFC 5322 messages FGAC hands to the Gmail API (`messages/send`,
 * field `raw`). Shared by the typed `gmail_send` MCP tool
 * (src/app/api/mcp/route.ts), the owner notices (approvalNotifyCopy.ts) and
 * the sales-lead confirmation (salesLead.ts), so every message FGAC itself
 * assembles leaves with the same headers and the same body encoding.
 *
 * Why quoted-printable (2026-10-05). A `text/plain` body sent with no
 * Content-Transfer-Encoding — or with `8bit` — reaches Gmail's outbound relay
 * as unencoded text, and the relay folds every line longer than the RFC 5322
 * recommended 78 characters by inserting REAL line breaks. The sender's Sent
 * copy keeps each paragraph as the one line the agent wrote; the delivered copy
 * arrives wrapped at ~72 columns, so on a phone every paragraph renders ragged
 * (a short tail stranded under each wrapped line). Quoted-printable
 * (RFC 2045 §6.7) wraps at the ENCODING layer instead: soft breaks (`=` then
 * CRLF) that the recipient's client removes, so the paragraph arrives intact.
 * Measured between the two QA accounts; the delivered-copy comparison is in
 * docs/implementation_plans/claude-xenodochial-meitner-8b1f5b_v1.md.
 *
 * `google_api_modify` passes an agent's own raw MIME through untouched — its
 * tool description tells agents to declare an encoding themselves.
 */

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

export interface TextMessage {
  to: string;
  subject: string;
  /** Plain text; any line endings. Sent as UTF-8 quoted-printable. */
  body: string;
  /** Omitted by gmail_send: Gmail stamps the authenticated mailbox as From. */
  from?: string;
  replyTo?: string;
  cc?: string;
  /** Extra headers written after Subject (e.g. the X-FGAC-Notice DSN tag). */
  extra?: Record<string, string>;
}

const HEADER_NAME = /^[!-9;-~]+$/; // RFC 5322 field-name: printable ASCII except ':'

/**
 * The RFC 5322 message: addressing headers, Subject (RFC 2047 when needed),
 * extras, then `MIME-Version`, `Content-Type: text/plain; charset=utf-8` and
 * `Content-Transfer-Encoding: quoted-printable`, a blank line and the encoded
 * body. CRLF throughout.
 */
export function buildTextMessage(msg: TextMessage): string {
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
  h.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable');
  return `${h.join('\r\n')}\r\n\r\n${encodeQuotedPrintable(msg.body)}`;
}

/** The `raw` field of Gmail's messages/send: the message, base64url. */
export function buildTextMessageRaw(msg: TextMessage): string {
  return Buffer.from(buildTextMessage(msg), 'utf8').toString('base64url');
}
