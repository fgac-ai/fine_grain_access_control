/**
 * Temporary API keys — short-lived REST-proxy keys an MCP connection mints so
 * a script the agent runs can move payloads too large for tool calls.
 *
 * A temporary key is a pointer to its parent profile key, never a profile of
 * its own: the proxy resolves it to `parentKeyId` on every request, so every
 * rule, refusal, and revocation of the profile applies to it unchanged.
 * Plan: docs/implementation_plans/large-api-payload-options_v5.md
 *
 * Pure helpers (no db/env imports) so scripts/test-temporary-api-keys.ts can
 * exercise them directly.
 */
import { createHash, randomBytes } from 'crypto';

/** Every temporary key starts with this; standing profile keys are `sk_proxy_<hex>`. */
export const TEMP_KEY_PREFIX = 'sk_proxy_tmp_';
export const TEMP_KEY_DEFAULT_TTL_MINUTES = 15;
export const TEMP_KEY_MAX_TTL_MINUTES = 60;
/** Live (unexpired, unrevoked) temporary keys one connection may hold. */
export const TEMP_KEY_MAX_LIVE_PER_CONNECTION = 10;

export const TEMP_KEY_PURPOSES = ['upload', 'download', 'send_attachment', 'bulk_calls', 'other'] as const;
export type TempKeyPurpose = typeof TEMP_KEY_PURPOSES[number];

/**
 * Largest request body the proxy accepts. Vercel rejects bodies over 4.5 MB
 * before FGAC code runs (no telemetry, no guidance), so the proxy refuses
 * anything over this itself — with guidance — and agents are told 4 MB
 * chunks. 4 MiB chunks (16 × 256 KiB, Google's resumable granularity) fit.
 */
export const PROXY_MAX_REQUEST_BYTES = 4 * 1024 * 1024 + 256 * 1024;
export const RECOMMENDED_CHUNK_BYTES = 4 * 1024 * 1024;

export function isTemporaryKey(value: string): boolean {
  return value.startsWith(TEMP_KEY_PREFIX);
}

export function hashTemporaryKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateTemporaryKey(): { key: string; hash: string; last4: string } {
  const key = `${TEMP_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  return { key, hash: hashTemporaryKey(key), last4: key.slice(-4) };
}

/** Requested lifetime → granted lifetime (whole minutes, 1…60, default 15). */
export function clampTtlMinutes(requested: number | undefined): { granted: number; capped: boolean } {
  if (requested === undefined || !Number.isFinite(requested)) {
    return { granted: TEMP_KEY_DEFAULT_TTL_MINUTES, capped: false };
  }
  const whole = Math.round(requested);
  if (whole > TEMP_KEY_MAX_TTL_MINUTES) return { granted: TEMP_KEY_MAX_TTL_MINUTES, capped: true };
  return { granted: Math.max(1, whole), capped: false };
}

/** Coarse size bucket for analytics (never the raw number — it is caller-chosen). */
export function expectedBytesBucket(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const mb = 1024 * 1024;
  if (bytes < mb) return '<1M';
  if (bytes < 4.5 * mb) return '1-4.5M';
  if (bytes < 35 * mb) return '4.5-35M';
  return '35M+';
}

/** The host serving this request (preview, localhost, or production). */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const forwardedHost = req.headers.get('x-forwarded-host');
  const forwardedProto = req.headers.get('x-forwarded-proto');
  if (forwardedHost) return `${forwardedProto || url.protocol.replace(':', '')}://${forwardedHost.split(',')[0].trim()}`;
  return url.origin;
}

/** SHA-256 of a Google resumable upload_id (the id itself is a capability; never stored). */
export function hashUploadId(uploadId: string): string {
  return createHash('sha256').update(uploadId).digest('hex');
}

/**
 * The guidance returned with a minted key: what it is, how to use it for the
 * stated purpose, and how to recover. Plain text; the agent reads it once.
 */
export function temporaryKeyRecipe(opts: {
  key: string; baseUrl: string; purpose: TempKeyPurpose; ttlGranted: number; ttlRequested?: number; capped: boolean; expiresAt: Date;
}): string {
  const api = `${opts.baseUrl}/api/proxy`;
  const lifetime = opts.capped
    ? `${opts.ttlGranted} minutes (granted ${opts.ttlGranted} of the ${opts.ttlRequested} requested; 60 is the maximum)`
    : `${opts.ttlGranted} minutes`;
  const lines = [
    `Temporary API key created. It expires in ${lifetime}, at ${opts.expiresAt.toISOString()}.`,
    '',
    `api_key: ${opts.key}`,
    `base_url: ${api}`,
    '',
    'It carries exactly this connection\'s FGAC permissions (same rules, same refusals). It is not a Google token. ' +
      'This key works for any Google REST call this connection\'s rules allow; the main uses are large email ' +
      'attachments and Drive uploads, and the recipes below are examples.',
    'Keep the key out of anything that leaves this session: don\'t show it to the user, put it in a URL or query ' +
      'string, log it, or commit it. Hand it to your script through a private temp file (chmod 600) or an ' +
      'environment variable, and delete the file when done. The examples read it from KEY_FILE:',
    '  Best: write api_key into KEY_FILE with your file-writing tool, then chmod 600 it, so the key never appears in command text. Or from a shell:',
    '  KEY_FILE=<your scratch dir>/fgac_key; (umask 077; printf %s \'<api_key>\' > "$KEY_FILE")',
    '  ... curl -H "Authorization: Bearer $(cat "$KEY_FILE")" ... ; rm -f "$KEY_FILE"   # when done',
    `The proxy speaks the Google REST API: replace https://www.googleapis.com with ${api} ` +
      '(and sheets/docs/slides.googleapis.com with the same base plus sheets/v4, docs/v1, slides/v1). ' +
      'Send the key as "Authorization: Bearer <api_key>". Google client libraries work by overriding their root URL.',
    'Gmail paths take the mailbox (MAILBOX below): users/me is your FGAC sign-in address; for any other mailbox ' +
      '(a linked or delegated one) use users/<address> — list_accounts names them.',
    'Limits: each request body must be 4 MB or less (larger requests are refused with 413). ' +
      'Each request must finish within ~55 s; for very large downloads use HTTP Range requests.',
  ];
  const auth = '-H "Authorization: Bearer $(cat "$KEY_FILE")"';
  const recipes: Record<TempKeyPurpose, string[]> = {
    download: [
      'Download a Drive file (any size, one request, streamed):',
      `  curl -sS ${auth} -o out.bin "${api}/drive/v3/files/FILE_ID?alt=media"`,
      'Download a Gmail attachment (returns Gmail JSON; base64url-decode `data`):',
      `  curl -sS ${auth} "${api}/gmail/v1/users/MAILBOX/messages/MSG_ID/attachments/ATT_ID"`,
    ],
    upload: [
      'Upload a file to Drive with a resumable upload in 4 MB chunks:',
      `  1. curl -sS -i -X POST ${auth} -H "Content-Type: application/json" \\`,
      `       -H "X-Upload-Content-Length: TOTAL_BYTES" -d '{"name":"report.pdf"}' \\`,
      `       "${api}/upload/drive/v3/files?uploadType=resumable"     # Location header = SESSION_URL`,
      '  2. PUT each 4 MB slice to SESSION_URL with the same Authorization header and',
      '     "Content-Range: bytes START-END/TOTAL"; 308 = keep going, 200/201 = done (body has the file id).',
      'Python: googleapiclient build("drive","v3", credentials=None, ...) with client_options={"api_endpoint": BASE_URL} ' +
        'and MediaFileUpload(path, resumable=True, chunksize=4*1024*1024), sending the key (read from KEY_FILE) as a Bearer header.',
      'To overwrite an existing file, PATCH .../upload/drive/v3/files/FILE_ID?uploadType=resumable instead of POST.',
    ],
    send_attachment: [
      'Send an email with a large attachment (Gmail allows 25 MB of attachments). Build the full RFC 822 message ' +
        '(To/Cc/Bcc/Subject headers FIRST, then the MIME body), then pick by message size:',
      '  Up to ~3 MB — JSON with the base64url message (base64 adds ~33%, the request must stay under 4 MB):',
      `    curl -sS -X POST ${auth} -H "Content-Type: application/json" \\`,
      `      --data-binary @body.json "${api}/gmail/v1/users/MAILBOX/messages/send"   # body.json = {"raw":"<base64url>"}`,
      '  Up to 4 MB — the raw bytes in one request:',
      `    curl -sS -X POST ${auth} -H "Content-Type: message/rfc822" \\`,
      `      --data-binary @message.eml "${api}/upload/gmail/v1/users/MAILBOX/messages/send?uploadType=media"`,
      '  Above 4 MB — resumable:',
      `    1. curl -sS -i -X POST ${auth} -H "Content-Type: application/json" \\`,
      `         -H "X-Upload-Content-Type: message/rfc822" -H "X-Upload-Content-Length: TOTAL_BYTES" -d '{}' \\`,
      `         "${api}/upload/gmail/v1/users/MAILBOX/messages/send?uploadType=resumable"   # Location = SESSION_URL`,
      '    2. PUT the message in 4 MB slices with "Content-Range: bytes START-END/TOTAL". The FIRST slice must',
      '       contain every To/Cc/Bcc header: FGAC checks all recipients against the send whitelist there.',
    ],
    bulk_calls: [
      'Make the calls you need in a loop with this key as the Bearer token, e.g.',
      `  curl -sS ${auth} "${api}/gmail/v1/users/MAILBOX/messages?q=from:example"`,
    ],
    other: [
      `Call ${api}/<google api path> exactly as you would call https://www.googleapis.com/<path>.`,
    ],
  };
  return [
    ...lines,
    '',
    ...recipes[opts.purpose],
    '',
    'Upload chunks must be multiples of 256 KB (except the last). 4 MB = 16 × 256 KB.',
    'If the key expires mid-upload, call create_temporary_api_key again and resume: Google keeps the upload ' +
      'session for about a week. PUT an empty body with "Content-Range: bytes */TOTAL" to SESSION_URL to learn ' +
      'how many bytes arrived (308 + Range header), then continue from there.',
  ].join('\n');
}
