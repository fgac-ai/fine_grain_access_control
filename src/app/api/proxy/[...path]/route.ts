import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { DRIVE_FILE_KINDS, ACTIVE_DRIVE_FILE_KINDS, kindForMimeType } from '@/lib/driveFileKinds';
import {
  driveFileKindForPath, extractDriveFileKindId, hasDotSegment, classifyGoogleApiCall, canonicalizeGoogleApiPath,
  extractSendRecipients, extractRfc822Recipients, extractDraftSendInfo, draftSendRecipients,
} from '@/app/api/mcp/googleApiPolicy';
import { db } from '@/db';
import { users, proxyKeys, emailDelegations, keyEmailAccess, accessRules, keyRuleAssignments, temporaryApiKeys, resumableUploads } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  isTemporaryKey, hashTemporaryKey, hashUploadId, requestOrigin, PROXY_MAX_REQUEST_BYTES, RECOMMENDED_CHUNK_BYTES,
} from '@/lib/temporaryApiKeys';
import { clerkClient } from '@clerk/nextjs/server';
import { checkReadRestrictions, checkSendWhitelist, loadApplicableRules, type SendDenial } from '@/lib/gmailRules';
import { captureServerEvent } from '@/lib/posthogServer';
import { GOOGLE_FETCH_TIMEOUT_MS, CLERK_TOKEN_TIMEOUT_MS, withTimeout, isUpstreamTimeout } from '@/lib/upstreamTimeouts';
import { classifyClerkTokenError } from '@/lib/googleTokenFailure';
import { driveTreeFlagOn } from '@/lib/featureFlags';
import { liveTokenScopes, DRIVE_FULL_SCOPE } from '@/lib/googleTokenScopes';
import {
  resolveDriveTreeAccess, effectiveDriveAccess, settingsFromRules, normalizeDriveDefault, driveDenialText, widenListFields,
  classifyDriveDiscovery, driveDiscoveryRefusal, sharedDriveAccess, sharedDriveBlockedText, filterSharedDrives,
  type DriveDefault, type DriveSetting, type DriveDiscovery,
} from '@/lib/driveTreeAccess';
import { resolveDriveLineage, resolveLineageFrom, parseDriveFileMeta, driveMetaUrl, LineageError, MAX_LINEAGE_HOPS, type MetaFetcher } from '@/lib/driveLineage';

export const dynamic = 'force-dynamic';

/** Same fallback chain as the MCP route's DASHBOARD_URL (trimmed: pasted
 * Vercel vars have shipped with trailing whitespace). */
const DASHBOARD_URL = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}` : '')
  || 'http://localhost:3000';

/** The Gmail scope FGAC requests at sign-in, plus the broader legacy grant —
 * mirror of the MCP route's GMAIL_SCOPES (see its gmailScopeDenial for the
 * missing-scope lockout this guards against). */
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'];

// Match the MCP route: without this the route runs at the platform default
// (≤ 15 s), which is BELOW the 50 s Google bound — a slow-but-recoverable
// Google call would die at the function kill before the classified timeout
// ever fired, exactly the invisible failure the bound exists to prevent.
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return trackedProxyRequest(request, await params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return trackedProxyRequest(request, await params);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return trackedProxyRequest(request, await params);
}

// Sheets values:update and batchUpdate are PUT/PATCH-shaped; without these
// exports Next.js answers 405 before FGAC's rules ever run.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return trackedProxyRequest(request, await params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return trackedProxyRequest(request, await params);
}

/** Identity resolved inside handleProxyRequest, reported back for analytics. */
type ProxyTelemetry = {
  clerkUserId?: string;
  proxyKeyId?: string;
  /** Google account the call resolved to (own or delegated mailbox). */
  targetEmail?: string;
  /** True when access came through an email delegation rather than the key owner's own mailbox. */
  accountDelegated?: boolean;
  /** Wall-clock spent talking to Google (one exchange per proxy call). */
  googleMs?: number;
  /** Wall-clock spent fetching the Google token from Clerk. */
  tokenMs?: number;
  /** Set when the upstream exchange failed before Google answered: 'timeout' | 'network'. */
  errorStatus?: string;
  /** Machine-readable reason when FGAC refused the call before Google (classifier code). */
  denialCode?: string;
  /** 'standing' (a profile key) or 'temporary' (create_temporary_api_key). */
  keyKind?: 'standing' | 'temporary';
  /** temporary_api_keys.id — joins to temp_api_key_created.temp_key_id. */
  tempKeyId?: string;
  /** Why a 401 happened: 'invalid' | 'revoked' | 'expired' | 'parent_revoked' | 'parent_expired' | 'missing'. */
  authFailureReason?: string;
  requestBytes?: number;
  /** Known only when Google sent Content-Length (streamed) or the body was buffered. */
  responseBytes?: number;
  /** The response body was piped through, never buffered. */
  streamed?: boolean;
  /** 'media' | 'multipart' | 'resumable_init' | 'resumable_chunk' | 'resumable_status'. */
  uploadType?: string;
  uploadIdHash?: string;
  /** Final chunk of a resumable upload was accepted (Google 200/201). */
  uploadComplete?: boolean;
  /** FGAC refused the body as too large (413) before Vercel's own cap could. */
  oversizeRefused?: boolean;
  /** A Drive create through the proxy: the created file's FGAC kind, or 'other'. */
  fileCreatedKind?: string;
};

/**
 * Captures one `proxy_request` PostHog event per pass-through call. Distinct id
 * is the key owner's Clerk user id (same id the dashboard identifies), so API
 * usage merges into the same PostHog person as their web activity. A 403 can be
 * either an FGAC denial or an upstream Google 403 — the status is recorded
 * as-is; the key/user attribution is what matters for usage analytics.
 */

/**
 * Clerk Google-token fetch with refresh-failure observability (see the MCP
 * route's getGoogleToken): a Clerk "cannot refresh" 422 otherwise surfaces
 * as a generic 403, indistinguishable in analytics from real permission
 * problems. Returns null on any failure.
 */
type ProxyGoogleToken = {
  token: string;
  /** undefined = Clerk did not report scopes; never enforce on missing metadata. */
  hasGmailScope?: boolean;
};

async function fetchClerkGoogleToken(
  clerkUserIdForToken: string, reporterClerkUserId: string, telemetry: ProxyTelemetry,
): Promise<ProxyGoogleToken | null> {
  const client = await clerkClient();
  const started = Date.now();
  try {
    const tokenResponse = await withTimeout(
      client.users.getUserOauthAccessToken(clerkUserIdForToken, 'oauth_google'),
      CLERK_TOKEN_TIMEOUT_MS,
    );
    telemetry.tokenMs = Date.now() - started;
    const grant = tokenResponse.data?.[0];
    if (!grant?.token) return null;
    const scopes = Array.isArray(grant.scopes) ? grant.scopes : undefined;
    return {
      token: grant.token,
      hasGmailScope: scopes ? scopes.some(s => GMAIL_SCOPES.includes(s)) : undefined,
    };
  } catch (err) {
    telemetry.tokenMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    // Same classifier as the MCP path (since 2026-09-09), so a revoked grant
    // reads as `grant_revoked` here too instead of hiding in `clerk_error`.
    const cls = classifyClerkTokenError(err);
    captureServerEvent(reporterClerkUserId, 'google_token_fetch_failed', {
      reason: isUpstreamTimeout(err) ? 'timeout' : cls.reason,
      via: 'proxy',
      ...(cls.clerkStatus !== undefined ? { clerk_status: cls.clerkStatus } : {}),
      ...(cls.clerkCode ? { clerk_code: cls.clerkCode } : {}),
    });
    console.error(`[PROXY] Google token fetch failed (${cls.reason}):`, message);
    return null;
  }
}

/**
 * The one Google exchange behind every proxy call, bounded so a hung upstream
 * becomes a classified 504/502 instead of riding into the function kill
 * (which would also destroy the proxy_request capture). Returns the raw
 * status/body/headers because the Gmail handler evaluates read rules against
 * the body before responding.
 */
type GoogleForward =
  | { ok: true; status: number; body: string; headers: Headers }
  | { ok: false; response: NextResponse };

async function forwardToGoogle(
  url: string,
  init: { method: string; headers: Headers; body?: ArrayBuffer },
  telemetry: ProxyTelemetry,
): Promise<GoogleForward> {
  const started = Date.now();
  try {
    const googleResponse = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    // The signal also covers body streaming, so a response that stalls after
    // headers aborts into the same classified branch below.
    const body = await googleResponse.text();
    telemetry.googleMs = Date.now() - started;
    return { ok: true, status: googleResponse.status, body, headers: googleResponse.headers };
  } catch (err) {
    telemetry.googleMs = Date.now() - started;
    if (isUpstreamTimeout(err)) {
      telemetry.errorStatus = 'timeout';
      return {
        ok: false,
        response: NextResponse.json({
          error: `Google did not answer within ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s. This is Google-side slowness, not a permissions problem. ` +
            'Retry a read once after a short pause; for a write, verify whether it was applied before retrying.',
        }, { status: 504 }),
      };
    }
    telemetry.errorStatus = 'network';
    return {
      ok: false,
      response: NextResponse.json({
        error: `Could not reach the Google API: ${err instanceof Error ? err.message : 'network error'}.`,
      }, { status: 502 }),
    };
  }
}

/**
 * The caller's request headers, minus the ones that describe the caller's
 * own connection to FGAC rather than the request to Google. `fetch` refuses
 * `expect` outright ("expect header not supported") — and curl and many SDKs
 * send `Expect: 100-continue` on every body over 1 MB, which turned each such
 * upload into a 502 — and computes framing (`content-length`,
 * `transfer-encoding`) from the body it is actually given. The caller's
 * Authorization is replaced with the owner's Google token by every caller.
 */
const CONNECTION_HEADERS = ['host', 'expect', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'content-length', 'proxy-connection'];

function forwardableHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const name of CONNECTION_HEADERS) headers.delete(name);
  return headers;
}

/** Google's response passed through with hop-by-hop encoding stripped. */
function passthroughResponse(forward: { status: number; body: string; headers: Headers }, telemetry?: ProxyTelemetry): NextResponse {
  const responseHeaders = new Headers(forward.headers);
  responseHeaders.delete('content-encoding');
  // fetch() already decoded the body, so Google's encoded length is wrong now.
  responseHeaders.delete('content-length');
  if (telemetry) telemetry.responseBytes = Buffer.byteLength(forward.body);
  return new NextResponse(forward.body, { status: forward.status, headers: responseHeaders });
}

/**
 * Streamed upstream budget: the whole response must arrive before the 60 s
 * function kill, so the stream gets the function's remaining headroom rather
 * than the 50 s buffered bound. Downloads larger than this window can use
 * HTTP Range requests (the temporary-key recipe says so).
 */
const STREAM_TIMEOUT_MS = 55_000;

/**
 * Forward and PIPE Google's response body instead of buffering it. Vercel's
 * 4.5 MB cap applies to buffered response bodies only, so this is what lets
 * a Drive download or a large attachment through. Only for responses FGAC
 * never needs to inspect (every Gmail read rule runs on a buffered body).
 */
async function streamFromGoogle(
  url: string,
  init: { method: string; headers: Headers; body?: ArrayBuffer },
  telemetry: ProxyTelemetry,
): Promise<NextResponse> {
  const started = Date.now();
  try {
    const googleResponse = await fetch(url, { ...init, signal: AbortSignal.timeout(STREAM_TIMEOUT_MS) });
    telemetry.googleMs = Date.now() - started;
    const responseHeaders = new Headers(googleResponse.headers);
    if (responseHeaders.has('content-encoding')) {
      // fetch() decodes on the fly; the encoded length no longer describes the body.
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
    }
    const length = Number(responseHeaders.get('content-length'));
    if (Number.isFinite(length) && length > 0) telemetry.responseBytes = length;
    telemetry.streamed = true;
    return new NextResponse(googleResponse.body, { status: googleResponse.status, headers: responseHeaders });
  } catch (err) {
    telemetry.googleMs = Date.now() - started;
    telemetry.errorStatus = isUpstreamTimeout(err) ? 'timeout' : 'network';
    console.error('[PROXY] streamed Google call failed:', err instanceof Error ? `${err.message} (${String((err as { cause?: unknown }).cause)})` : err);
    return isUpstreamTimeout(err)
      ? NextResponse.json({ error: `Google did not start answering within ${STREAM_TIMEOUT_MS / 1000}s. Retry once after a short pause.` }, { status: 504 })
      : NextResponse.json({ error: `Could not reach the Google API: ${err instanceof Error ? err.message : 'network error'}.` }, { status: 502 });
  }
}

/** How a request uses Google's upload protocol, for telemetry and routing. */
function uploadTypeOf(request: NextRequest): string | undefined {
  const params = request.nextUrl.searchParams;
  if (params.get('upload_id')) {
    const range = request.headers.get('content-range') ?? '';
    return /^bytes \*\//i.test(range) ? 'resumable_status' : 'resumable_chunk';
  }
  const type = params.get('uploadType');
  if (type === 'resumable') return 'resumable_init';
  if (type === 'media' || type === 'multipart') return type;
  return undefined;
}

/**
 * Response headers a resumable upload may hand back. Everything else is
 * dropped: Google's upload responses carry `X-GUploader-UploadID`, which is
 * Google's session id — returning it would let a caller rebuild Google's own
 * session URL and send bytes straight to Google, past every FGAC check.
 */
const UPLOAD_RESPONSE_HEADERS = ['content-type', 'range'];

function uploadResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of UPLOAD_RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * A resumable upload was just opened through FGAC: bind Google's session to
 * this profile and hand the caller a session URL on FGAC's own host with
 * FGAC's own opaque id, so every chunk comes back through the proxy. Fails
 * closed: a 200 whose session URL cannot be adopted becomes a 502, and Google's
 * session URL (or id) never reaches the caller on any path.
 */
async function adoptResumableSession(
  request: NextRequest,
  response: NextResponse,
  session: { parentKeyId: string; kind: string; tokenOwnerClerkUserId: string; targetEmail?: string; fileId?: string },
  telemetry: ProxyTelemetry,
): Promise<NextResponse> {
  if (response.status !== 200) {
    return new NextResponse(response.body, { status: response.status, headers: uploadResponseHeaders(response.headers) });
  }
  const location = response.headers.get('location');
  let googleUrl: URL | null = null;
  try { googleUrl = location ? new URL(location) : null; } catch { googleUrl = null; }
  if (!googleUrl || googleUrl.hostname !== 'www.googleapis.com' || !googleUrl.searchParams.get('upload_id')) {
    telemetry.errorStatus = 'upload_session_unadoptable';
    return NextResponse.json({ error: 'Google opened the upload but did not return a usable session; nothing was uploaded. Retry the initiation once.' }, { status: 502 });
  }
  const fgacUploadId = randomBytes(24).toString('base64url');
  const uploadIdHash = hashUploadId(fgacUploadId);
  telemetry.uploadIdHash = uploadIdHash.slice(0, 16);
  await db.insert(resumableUploads).values({
    uploadIdHash,
    googleSessionUrl: googleUrl.toString(),
    parentKeyId: session.parentKeyId,
    kind: session.kind,
    tokenOwnerClerkUserId: session.tokenOwnerClerkUserId,
    targetEmail: session.targetEmail,
    fileId: session.fileId,
    // Google keeps a resumable session for about a week.
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  const headers = uploadResponseHeaders(response.headers);
  // On the gmail.fgac.ai proxy host the middleware already maps every path
  // onto /api/proxy, so the prefix there would be applied twice.
  const origin = requestOrigin(request);
  const prefix = new URL(origin).hostname.startsWith('gmail.') ? '' : '/api/proxy';
  headers.set('location', `${origin}${prefix}${googleUrl.pathname}?uploadType=resumable&upload_id=${fgacUploadId}`);
  return new NextResponse(response.body, { status: 200, headers });
}

async function trackedProxyRequest(request: NextRequest, params: { path: string[] }) {
  const telemetry: ProxyTelemetry = {};
  const started = Date.now();
  const response = await handleProxyRequest(request, params, telemetry);

  // `upload/` media variants belong to their non-upload twin's service.
  const fullPath = params.path.join('/').replace(/^upload\//, '');
  const fileKind = driveFileKindForPath(fullPath);
  const service = fileKind
    ? DRIVE_FILE_KINDS[fileKind].service
    : /^drive\/v[23]\//.test(fullPath) ? 'drive'
    : 'gmail';
  // 504 is only ever minted by forwardToGoogle's timeout branch (Google's own
  // 504s pass through with errorStatus unset, and they mean the same thing:
  // the upstream ran out of time).
  const outcome = response.status < 400 ? 'success'
    : response.status === 401 ? 'auth_failed'
    : response.status === 403 ? 'denied'
    : response.status === 504 ? 'timeout'
    : 'error';

  const capture = (extra: Record<string, unknown> = {}) => captureServerEvent(telemetry.clerkUserId ?? 'anonymous-proxy', 'proxy_request', {
    service,
    method: request.method,
    status: response.status,
    outcome,
    duration_ms: Date.now() - started,
    proxy_key_id: telemetry.proxyKeyId,
    account_email: telemetry.targetEmail,
    account_delegated: telemetry.accountDelegated,
    google_ms: telemetry.googleMs,
    token_ms: telemetry.tokenMs,
    error_status: telemetry.errorStatus,
    denial_code: telemetry.denialCode,
    // Temporary keys + large transfers (docs/monitoring.md §7.34).
    key_kind: telemetry.keyKind,
    temp_key_id: telemetry.tempKeyId,
    auth_failure_reason: telemetry.authFailureReason,
    request_bytes: telemetry.requestBytes,
    response_bytes: telemetry.responseBytes,
    streamed: telemetry.streamed,
    upload_type: telemetry.uploadType,
    upload_id_hash: telemetry.uploadIdHash,
    upload_complete: telemetry.uploadComplete,
    oversize_refused: telemetry.oversizeRefused,
    file_created_kind: telemetry.fileCreatedKind,
    ...extra,
  });

  // A piped body's size is known only once it has been sent (Google sends
  // Drive media chunked, without Content-Length). Count the bytes on the way
  // through and capture when the stream ends — `duration_ms` then covers the
  // whole transfer, and a client that hangs up mid-download is recorded as
  // `stream_aborted` with the bytes it got.
  if (telemetry.streamed && response.body) {
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk); },
      flush() { capture({ response_bytes: bytes }); },
    });
    const body = response.body.pipeThrough(counter);
    // pipeThrough does not surface a downstream cancel to `flush`; watch it.
    const reader = body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      },
      cancel(reason) {
        capture({ response_bytes: bytes, stream_aborted: true });
        return reader.cancel(reason);
      },
    });
    return new NextResponse(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  capture();
  return response;
}

/**
 * Extract the Gmail userId from the API path.
 * Gmail API paths look like: gmail/v1/users/{userId}/messages/...
 * Returns the userId segment, or 'me' if not found.
 */
function extractGmailUserId(fullPath: string): string {
  const match = fullPath.match(/gmail\/v1\/users\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : 'me';
}

/**
 * Per-file rule check shared by the Sheets, Docs, and Drive-file guards.
 * Returns the rules for `service` that apply to this key and match `fileId`.
 */
function applicableFileRules(
  allUserRules: Array<{ id: string; service: string; actionType: string; targetResourceId: string | null; regexPattern: string | null }>,
  rulesWithAssignments: Set<string>,
  assignedRuleIds: Set<string>,
  service: string,
  fileId: string,
) {
  return allUserRules.filter(rule => {
    if (rule.service !== service) return false;
    const isGlobal = !rulesWithAssignments.has(rule.id);
    const isAssignedToThisKey = assignedRuleIds.has(rule.id);
    const resourceMatches = (rule.targetResourceId === fileId) || (rule.regexPattern === fileId);
    return (isGlobal || isAssignedToThisKey) && resourceMatches;
  });
}

/**
 * A pre-flight refusal: nothing was sent to Google. The classifier's reason
 * text is shared with the MCP tools; the REST surface drops the MCP outcome
 * emoji prefix (same convention as the read-restriction denial below).
 */
function denied(telemetry: ProxyTelemetry, code: string, reason: string): NextResponse {
  telemetry.denialCode = code;
  return NextResponse.json({ error: reason.replace(/^(?:🚫|❌)\s*/u, ''), code }, { status: 403 });
}

/** Send-whitelist refusal in the REST proxy's long-standing wording (the MCP
 * copy points at approval links this surface does not mint). */
function sendDenied(telemetry: ProxyTelemetry, denial: SendDenial): NextResponse {
  const r = denial.deniedRecipient;
  const reason = denial.code === 'send_disabled' && r
    ? `Unauthorized email address. Please ask your user to add '${r}' to the sending whitelist. Default access is DENIED.`
    : denial.code === 'recipient_not_whitelisted' && r
      ? `Unauthorized email address. Please ask your user to add '${r}' to the sending whitelist.`
      : denial.code === 'recipients_undetermined' && denial.message.includes('RFC 2822')
        ? 'Could not determine the message recipients, so sending was denied. Send a JSON body {"raw": "<base64url RFC 2822 message>"} ' +
          '(or the RFC 822 message itself on upload/…?uploadType=media) with To/Cc/Bcc headers.'
        : denial.message;
  return denied(telemetry, denial.code, reason);
}

/**
 * Recipients of a messages/send request: a JSON `{raw}` body, or — on the
 * `upload/` media form — the RFC 822 message itself. Null (→ refused) for
 * anything else, including multipart and resumable uploads.
 */
async function sendRecipientsFromRequest(request: NextRequest): Promise<string[] | null> {
  const text = await request.clone().text();
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('json') || /^\s*\{/.test(text)) return extractSendRecipients(text);
  if (contentType.startsWith('message/rfc822')) return extractRfc822Recipients(text);
  return null;
}

/**
 * Forward a Drive call (already authorized above) on the key owner's own
 * token — Drive files, like Sheets/Docs/Slides, are only ever the owner's;
 * there is no delegated-mailbox path for them. The path is canonicalized so
 * the bare `v3/files/…` spelling the classifier accepts reaches Drive.
 */
async function forwardDriveCall(
  request: NextRequest, fullPath: string, owner: { id: string; clerkUserId: string; email: string }, telemetry: ProxyTelemetry,
  profileKeyId: string,
  driveTree: ProxyDriveTree | null = null,
  /** The existing file a resumable update targets (re-checked on every chunk). */
  fileId?: string,
  /** POST drive/v3/files (incl. upload/ media/multipart): grant the result to the profile. */
  isCreate = false,
  /** The tree engine's verdict on a discovery read (PR #181): which listing filter applies. */
  driveDiscovery: DriveDiscovery | null = null,
): Promise<NextResponse> {
  telemetry.targetEmail = owner.email;
  telemetry.accountDelegated = false;
  // The Drive tree engine already holds the owner's token.
  const realGoogleToken = driveTree?.token ?? await fetchClerkGoogleToken(owner.clerkUserId, owner.clerkUserId, telemetry);
  if (!realGoogleToken) {
    return NextResponse.json({
      error: `Could not fetch Google access token for user '${owner.email}'. Please reconnect your Google account.`
    }, { status: 403 });
  }
  const headers = forwardableHeaders(request);
  headers.set('Authorization', `Bearer ${realGoogleToken.token}`);
  const isMutating = request.method !== 'GET' && request.method !== 'HEAD';
  const canonicalPath = canonicalizeGoogleApiPath(fullPath);
  // Drive tree engine: a Drive listing is forwarded with a fields mask wide
  // enough to resolve each file's lineage, then filtered below.
  const filterListing = !!driveTree && driveDiscovery?.kind === 'filter_files';
  const filterDrives = !!driveTree && driveDiscovery?.kind === 'filter_drives';
  let search = request.nextUrl.search;
  if (filterListing) {
    const urlParams = new URLSearchParams(request.nextUrl.searchParams);
    const widened = widenListFields(urlParams.get('fields'));
    if (widened !== undefined) urlParams.set('fields', widened);
    search = urlParams.toString() ? `?${urlParams.toString()}` : '';
  }
  const url = `https://www.googleapis.com/${canonicalPath}${search}`;
  const body = isMutating ? await request.clone().arrayBuffer() : undefined;
  if ((filterListing || filterDrives) && driveTree) {
    // The tree engine must read the listing to filter it: buffered.
    const forward = await forwardToGoogle(url, { method: request.method, headers, body }, telemetry);
    if (!forward.ok) return forward.response;
    if (forward.status === 200 && forward.headers.get('content-type')?.includes('application/json')) {
      const filtered = filterListing
        ? await proxyFilterDriveListing(driveTree, forward.body)
        : proxyFilterSharedDrives(driveTree, forward.body);
      const responseHeaders = new Headers(forward.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      telemetry.responseBytes = Buffer.byteLength(filtered);
      return new NextResponse(filtered, { status: 200, headers: responseHeaders });
    }
    return passthroughResponse(forward, telemetry);
  }
  if (isCreate && telemetry.uploadType !== 'resumable_init') {
    // A create's answer is the new file's small JSON resource: buffer it, so
    // the created file can be granted to the profile before replying.
    const forward = await forwardToGoogle(url, { method: request.method, headers, body }, telemetry);
    if (!forward.ok) return forward.response;
    if (forward.status === 200) await grantProxyCreatedFile(owner, profileKeyId, forward.body, realGoogleToken.token, telemetry);
    return passthroughResponse(forward, telemetry);
  }
  // Everything else is piped: Drive media downloads and exports can be far
  // over Vercel's 4.5 MB buffered-response cap, and FGAC never inspects them.
  const response = await streamFromGoogle(url, { method: request.method, headers, body }, telemetry);
  if (telemetry.uploadType === 'resumable_init') {
    return adoptResumableSession(request, response, {
      parentKeyId: profileKeyId, kind: 'drive', tokenOwnerClerkUserId: owner.clerkUserId, fileId,
    }, telemetry);
  }
  return response;
}

// ─── DRIVE TREE ENGINE (feature-flagged folder-inherited access) ─────────────
// Mirror of the MCP route's engine (src/lib/driveTreeAccess.ts): with the
// key owner's flag on and the live token carrying the full `drive` scope,
// the Drive-file guard, the per-kind handlers and Drive discovery reads
// (classifyDriveDiscovery: listings filtered, unfilterable ones refused) defer
// to the folder-lineage resolver instead of the per-file rule table alone.

type ProxyDriveTree = {
  token: ProxyGoogleToken;
  settings: Map<string, DriveSetting[]>;
  driveDefault: DriveDefault;
  fetchMeta: MetaFetcher;
  clerkUserId: string;
};

async function proxyDriveTreeEngine(
  dbUser: { id: string; email: string; clerkUserId: string },
  proxyKeyId: string,
  fullPath: string,
  telemetry: ProxyTelemetry,
): Promise<ProxyDriveTree | null> {
  // Every drive/ path, not only drive/v[23]/files: changes, drives and v2
  // listings name files too (2026-10-03 review).
  const drivePath = /^(upload\/)?drive\//i.test(fullPath) || !!driveFileKindForPath(fullPath);
  if (!drivePath) return null;
  if (!(await driveTreeFlagOn({ clerkUserId: dbUser.clerkUserId, email: dbUser.email }))) return null;
  const token = await fetchClerkGoogleToken(dbUser.clerkUserId, dbUser.clerkUserId, telemetry);
  if (!token) return null;
  const scopes = await liveTokenScopes(token.token);
  if (!scopes || !scopes.includes(DRIVE_FULL_SCOPE)) return null;

  const [allRules, allAssignments, key] = await Promise.all([
    db.select().from(accessRules).where(eq(accessRules.userId, dbUser.id)),
    db.select().from(keyRuleAssignments),
    db.select({ driveDefault: proxyKeys.driveDefault }).from(proxyKeys).where(eq(proxyKeys.id, proxyKeyId)).then(r => r[0]),
  ]);
  const rulesWithAssignments = new Set(allAssignments.map(a => a.accessRuleId));
  const assignedToKey = new Set(allAssignments.filter(a => a.proxyKeyId === proxyKeyId).map(a => a.accessRuleId));
  const applicable = allRules.filter(r => !rulesWithAssignments.has(r.id) || assignedToKey.has(r.id));

  const fetchMeta: MetaFetcher = async (id) => {
    try {
      const res = await fetch(driveMetaUrl(id), {
        headers: { Authorization: `Bearer ${token.token}` },
        signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, status: res.status, error: `Google ${res.status}` };
      const meta = parseDriveFileMeta(await res.json());
      return meta ? { ok: true, meta } : { ok: false, error: 'Drive returned file metadata without an id.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  return { token, settings: settingsFromRules(applicable), driveDefault: normalizeDriveDefault(key?.driveDefault), fetchMeta, clerkUserId: dbUser.clerkUserId };
}

/** 403 with the engine's denial text (same wording as the MCP path, minus the outcome emoji), or null when allowed. */
async function proxyDriveTreeDenial(engine: ProxyDriveTree, fileId: string, isMutating: boolean, telemetry: ProxyTelemetry): Promise<NextResponse | null> {
  let decision;
  let label = fileId;
  try {
    const lineage = await resolveDriveLineage(engine.clerkUserId, fileId, engine.fetchMeta);
    label = lineage.file.name || fileId;
    decision = resolveDriveTreeAccess(lineage.nodes, engine.settings, engine.driveDefault, isMutating);
  } catch (err) {
    if (!(err instanceof LineageError)) throw err;
    telemetry.errorStatus = err.code;
    telemetry.denialCode = err.code;
    if (err.code === 'file_not_found') {
      return NextResponse.json({ error: `Google Drive reports no file '${fileId}' visible to this Google account — the id is wrong, the file was deleted, or it was never shared with this account.` }, { status: 404 });
    }
    if (err.code === 'lineage_too_deep') {
      return NextResponse.json({ error: `'${fileId}' sits more than ${MAX_LINEAGE_HOPS} folders deep, deeper than FGAC resolves.` }, { status: 403 });
    }
    return NextResponse.json({ error: `Could not resolve where '${fileId}' lives in Google Drive (${err.message}); FGAC fails closed. Retry once.` }, { status: 502 });
  }
  if (decision.allowed) return null;
  telemetry.errorStatus = decision.denial === 'blocked' ? 'drive_blocked' : decision.denial === 'read_only' ? 'drive_read_only' : 'drive_not_exposed';
  telemetry.denialCode = telemetry.errorStatus;
  const text = driveDenialText(decision, label, engine.driveDefault, `${DASHBOARD_URL}/dashboard`).replace(/^🚫 /u, '');
  return NextResponse.json({ error: text }, { status: 403 });
}

/** Filter a files.list body: Blocked files are withheld and counted (fail closed per file). */
async function proxyFilterDriveListing(engine: ProxyDriveTree, body: string): Promise<string> {
  let data: { files?: unknown[] } | null = null;
  try { data = JSON.parse(body); } catch { return body; }
  if (!data || !Array.isArray(data.files)) return body;
  const kept: unknown[] = [];
  let withheld = 0;
  for (const f of data.files) {
    const meta = parseDriveFileMeta(f);
    let access: 'read' | 'write' | 'block' = 'block';
    if (meta) {
      try {
        const lineage = await resolveLineageFrom(engine.clerkUserId, meta, engine.fetchMeta);
        access = effectiveDriveAccess(lineage.nodes, engine.settings, engine.driveDefault).access;
      } catch { access = 'block'; }
    }
    if (access === 'block') withheld++; else kept.push(f);
  }
  return JSON.stringify({ ...data, files: kept, withheld });
}

/**
 * Per-file access for an id-addressed Drive call: the tree engine when it is
 * on for this owner, else the per-file rule table (a Sheet/Doc/Slides rule
 * of any kind authorizes the file; a block on any kind denies it). Shared by
 * the request guard and by every resumable chunk of a Drive update, so a file
 * switched to Blocked or Read Only mid-upload stops receiving bytes.
 */
async function driveFileDenial(
  dbUser: { id: string; email: string; clerkUserId: string },
  profileKeyId: string,
  fileId: string,
  isMutating: boolean,
  driveTree: ProxyDriveTree | null,
  telemetry: ProxyTelemetry,
): Promise<NextResponse | null> {
  if (driveTree) return proxyDriveTreeDenial(driveTree, fileId, isMutating, telemetry);
  const allUserRules = await db
    .select()
    .from(accessRules)
    .where(eq(accessRules.userId, dbUser.id));

  const keyAssignments = await db
    .select()
    .from(keyRuleAssignments)
    .where(eq(keyRuleAssignments.proxyKeyId, profileKeyId));

  const assignedRuleIds = new Set(keyAssignments.map(a => a.accessRuleId));
  const allAssignments = await db.select().from(keyRuleAssignments);
  const rulesWithAssignments = new Set(allAssignments.map(a => a.accessRuleId));

  const fileRules = ACTIVE_DRIVE_FILE_KINDS.flatMap(k =>
    applicableFileRules(allUserRules, rulesWithAssignments, assignedRuleIds, DRIVE_FILE_KINDS[k].service, fileId),
  );
  const blockTypes = new Set(ACTIVE_DRIVE_FILE_KINDS.map(k => DRIVE_FILE_KINDS[k].actionTypes.block));
  const readWriteTypes = new Set(ACTIVE_DRIVE_FILE_KINDS.map(k => DRIVE_FILE_KINDS[k].actionTypes.readWrite));

  if (fileRules.length === 0) {
    // No rule names the file. FGAC has rule types only for Sheets, Docs and
    // Slides, so — as on the MCP path (checkDriveFileAccess) — ask Google what
    // the file IS: a Sheets/Docs/Slides file needs a rule; any other kind
    // (an uploaded PDF or binary, the agent's own uploads included) rides
    // Google's per-file drive.file grant; a file the token cannot see at all
    // is refused here. Before this, every non-Sheets/Docs/Slides file was
    // refused on REST, so an agent could upload a file and never touch it again.
    const token = await fetchClerkGoogleToken(dbUser.clerkUserId, dbUser.clerkUserId, telemetry);
    const meta = token ? await forwardToGoogle(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType&supportsAllDrives=true`,
      { method: 'GET', headers: new Headers({ Authorization: `Bearer ${token.token}` }) }, telemetry,
    ) : null;
    if (!meta || !meta.ok || meta.status !== 200) {
      telemetry.denialCode = 'file_grant_missing_at_google';
      return NextResponse.json({
        error: `Google Drive reports no file '${fileId}' visible to this account through FGAC — the id is wrong, the file was deleted, ` +
          'or it was never picked in FGAC or created by an agent. Expose it from the FGAC dashboard.',
      }, { status: 404 });
    }
    let mimeType: string | undefined;
    try { mimeType = (JSON.parse(meta.body) as { mimeType?: string }).mimeType; } catch { /* treated as other */ }
    if (kindForMimeType(mimeType)) {
      telemetry.denialCode = 'file_not_exposed';
      return NextResponse.json({
        error: `Access Denied: File '${fileId}' is not exposed in FGAC rules for this API key.`
      }, { status: 403 });
    }
    return null;
  }
  if (fileRules.some(r => blockTypes.has(r.actionType))) {
    telemetry.denialCode = 'drive_blocked';
    return NextResponse.json({
      error: `Access Denied: Access to file '${fileId}' has been explicitly blocked.`
    }, { status: 403 });
  }
  if (isMutating && !fileRules.some(r => readWriteTypes.has(r.actionType))) {
    telemetry.denialCode = 'drive_read_only';
    return NextResponse.json({
      error: `Access Denied: Write operations on file '${fileId}' are restricted to Read-Only.`
    }, { status: 403 });
  }
  return null;
}

/**
 * A Drive file the agent just created through the proxy is its own output:
 * a Sheets/Docs/Slides file gets a Read & Write rule scoped to the creating
 * profile — the same auto-grant the MCP route applies (autoGrantAgentCreatedFile)
 * — so the agent can keep working on what it uploaded or converted. Other
 * kinds need no rule (they ride Google's per-file drive.file grant). A failed
 * grant is logged, never fatal: the file exists, and the next call simply
 * refuses as not exposed.
 */
async function grantProxyCreatedFile(
  dbUser: { id: string; clerkUserId: string },
  profileKeyId: string,
  createdBody: string,
  token: string,
  telemetry: ProxyTelemetry,
): Promise<void> {
  let file: { id?: string; name?: string; mimeType?: string } | null = null;
  try { file = JSON.parse(createdBody); } catch { return; }
  if (!file?.id) return;
  let { name, mimeType } = file;
  if (!mimeType) {
    const meta = await forwardToGoogle(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?fields=name,mimeType&supportsAllDrives=true`,
      { method: 'GET', headers: new Headers({ Authorization: `Bearer ${token}` }) }, telemetry,
    );
    if (meta.ok && meta.status === 200) {
      try { ({ name = name, mimeType } = JSON.parse(meta.body) as { name?: string; mimeType?: string }); } catch { /* leave ungated */ }
    }
  }
  const kind = kindForMimeType(mimeType);
  telemetry.fileCreatedKind = kind ?? 'other';
  if (!kind) return;
  const d = DRIVE_FILE_KINDS[kind];
  try {
    const [rule] = await db.insert(accessRules).values({
      userId: dbUser.id,
      ruleName: `Agent-created: ${name || file.id}`,
      service: d.service,
      actionType: d.actionTypes.readWrite,
      targetResourceId: file.id,
      resourceName: name ?? null,
    }).returning();
    await db.insert(keyRuleAssignments).values({ proxyKeyId: profileKeyId, accessRuleId: rule.id });
    captureServerEvent(dbUser.clerkUserId, d.createdAnalytics.event, { [d.createdAnalytics.idProp]: file.id, origin: 'rest_proxy', auto_granted: true });
  } catch (err) {
    console.error(`[PROXY] Failed to auto-grant agent-created ${d.noun}:`, err);
    captureServerEvent(dbUser.clerkUserId, d.createdAnalytics.event, { [d.createdAnalytics.idProp]: file.id, origin: 'rest_proxy', auto_granted: false });
  }
}

/**
 * The key ↔ mailbox grant behind a Gmail call, re-checked on every resumable
 * chunk (a delegation revoked or a mailbox unticked mid-upload stops it).
 * Mirror of the Gmail handler's steps 3 + 3b.
 */
async function gmailMailboxDenial(profileKeyId: string, targetEmail: string): Promise<NextResponse | null> {
  const access = await db.select().from(keyEmailAccess)
    .where(eq(keyEmailAccess.proxyKeyId, profileKeyId))
    .then(rows => rows.find(r => r.targetEmail.toLowerCase() === targetEmail.toLowerCase()));
  if (!access) {
    return NextResponse.json({ error: `This API key no longer has access to '${targetEmail}'.` }, { status: 403 });
  }
  if (access.delegationId) {
    const delegation = await db.select().from(emailDelegations)
      .where(eq(emailDelegations.id, access.delegationId)).limit(1).then(res => res[0]);
    if (!delegation || delegation.status !== 'active') {
      return NextResponse.json({ error: `Access to '${targetEmail}' has been revoked by its owner.` }, { status: 403 });
    }
  }
  return null;
}

/** End of the RFC 822 header block (index of the blank line), or -1. */
function headerBlockEnd(text: string): number {
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  if (crlf === -1) return lf;
  if (lf === -1) return crlf;
  return Math.min(crlf, lf);
}

/** Google persists resumable bytes in 256 KiB units: the first non-zero offset it can ever hold. */
const RESUMABLE_UNIT = 256 * 1024;

/** `Content-Range` of a chunk: a byte range, a status query, or unparseable. */
function parseContentRange(range: string, bodyBytes: number): { kind: 'chunk'; start: number } | { kind: 'status' } | null {
  if (!range) return bodyBytes > 0 ? { kind: 'chunk', start: 0 } : null; // one-shot PUT of the whole upload
  if (/^bytes \*\/\d+$/i.test(range)) return { kind: 'status' };
  const m = range.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  if (!m) return null;
  const start = Number(m[1]);
  return Number.isSafeInteger(start) ? { kind: 'chunk', start } : null;
}

/**
 * One chunk (or status query) of a resumable upload FGAC opened. Authorized
 * by the session row — opened through FGAC by the SAME profile (a temporary
 * key resolves to its parent, so a fresh key can resume an upload an expired
 * one started) — and by the access the initiation needed, re-checked now:
 * the Drive file's rule for an update, the key ↔ mailbox grant for Gmail.
 *
 * Gmail sends: the recipients live in the RFC 822 headers. Google persists
 * resumable bytes in 256 KiB units, so every byte before offset 256 KiB can
 * only ever come from a chunk that starts at 0. FGAC therefore requires the
 * whole header block inside the first 256 KiB, checks every To/Cc/Bcc in any
 * chunk that starts at 0, and accepts no other offset below 256 KiB — nor any
 * later chunk or status query until a byte-0 chunk has passed.
 */
async function handleResumableChunk(
  request: NextRequest,
  uploadId: string,
  profileKeyId: string,
  dbUser: { id: string; email: string; clerkUserId: string },
  telemetry: ProxyTelemetry,
): Promise<NextResponse> {
  const uploadIdHash = hashUploadId(uploadId);
  telemetry.uploadIdHash = uploadIdHash.slice(0, 16);
  if (request.method !== 'PUT') {
    return denied(telemetry, 'resumable_method', 'Resumable upload chunks must be sent with PUT to the session URL returned at initiation.');
  }
  const session = await db.select().from(resumableUploads)
    .where(eq(resumableUploads.uploadIdHash, uploadIdHash)).limit(1).then(res => res[0]);
  if (!session || session.parentKeyId !== profileKeyId) {
    return denied(telemetry, 'resumable_session_unknown',
      'This upload session was not opened through FGAC with this agent profile. Start the upload with ' +
      'uploadType=resumable through the FGAC proxy and send every chunk to the session URL it returns.');
  }
  if (session.expiresAt < new Date()) {
    return denied(telemetry, 'resumable_session_expired', 'This upload session is more than a week old and Google has discarded it. Start the upload again.');
  }

  // Access the initiation needed, re-checked on every chunk.
  if (session.kind === 'drive' && session.fileId) {
    const engine = await proxyDriveTreeEngine(dbUser, profileKeyId, `drive/v3/files/${session.fileId}`, telemetry);
    const fileDenial = await driveFileDenial(dbUser, profileKeyId, session.fileId, true, engine, telemetry);
    if (fileDenial) return fileDenial;
  }
  if (session.kind === 'gmail_send') {
    const mailboxDenial = await gmailMailboxDenial(profileKeyId, session.targetEmail ?? dbUser.email);
    if (mailboxDenial) return mailboxDenial;
  }

  const range = request.headers.get('content-range') ?? '';
  const body = await request.arrayBuffer();
  telemetry.requestBytes = body.byteLength;
  const parsed = parseContentRange(range, body.byteLength);

  if (session.kind === 'gmail_send') {
    if (session.recipientVerdict === 'denied') {
      return denied(telemetry, 'recipient_not_whitelisted', 'This message\'s recipients were refused on its first chunk, so the rest of the upload is refused too. Nothing was sent.');
    }
    if (!parsed) {
      return denied(telemetry, 'resumable_range_invalid', 'Send each chunk with a "Content-Range: bytes START-END/TOTAL" header (or "bytes */TOTAL" for a status query). Nothing was sent.');
    }
    if (parsed.kind === 'chunk' && parsed.start === 0) {
      // Latin-1 keeps one char per byte, so a split UTF-8 sequence later in
      // the chunk cannot shift or hide the header block.
      const text = Buffer.from(body).toString('latin1');
      const end = headerBlockEnd(text);
      if (end === -1 || end >= RESUMABLE_UNIT - 4) {
        return denied(telemetry, 'recipients_undetermined',
          'The first chunk of a Gmail send must contain the complete message header block (every To/Cc/Bcc header and the blank ' +
          'line after them), and the header block must end within the first 256 KB of the message. Resend from byte 0. Nothing was sent.');
      }
      const recipients = extractRfc822Recipients(text.slice(0, end));
      const rules = await loadApplicableRules(dbUser.id, profileKeyId, session.targetEmail ?? dbUser.email);
      const denial = checkSendWhitelist(rules, recipients);
      await db.update(resumableUploads)
        .set({ recipientVerdict: denial ? 'denied' : 'allowed' })
        .where(eq(resumableUploads.id, session.id));
      if (denial) return sendDenied(telemetry, denial);
    } else if (session.recipientVerdict !== 'allowed') {
      return denied(telemetry, 'recipients_undetermined',
        'Send the chunk that starts at byte 0 first: FGAC checks a Gmail send\'s recipients in the message headers there. Nothing was sent.');
    } else if (parsed.kind === 'chunk' && parsed.start < RESUMABLE_UNIT) {
      return denied(telemetry, 'resumable_range_invalid',
        `Chunks after the first must start at a multiple of 256 KB (Google's resumable unit); resend from byte 0 instead. Nothing was sent.`);
    }
  }

  const token = await fetchClerkGoogleToken(session.tokenOwnerClerkUserId, dbUser.clerkUserId, telemetry);
  if (!token) {
    return NextResponse.json({ error: 'Could not fetch the Google access token for this upload. The account owner may need to reconnect their Google account.' }, { status: 403 });
  }
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token.token}`);
  if (range) headers.set('Content-Range', range);
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  const forward = await forwardToGoogle(session.googleSessionUrl, {
    method: 'PUT', headers, body: parsed?.kind === 'status' ? undefined : body,
  }, telemetry);
  if (!forward.ok) return forward.response;
  if (forward.status === 200 || forward.status === 201) {
    telemetry.uploadComplete = true;
    // A resumable Drive CREATE completes here: grant the new file like any
    // create — on the completing data chunk only (a later status query also
    // answers 200 with the file, and must not grant it twice).
    if (session.kind === 'drive' && !session.fileId && parsed?.kind === 'chunk') {
      await grantProxyCreatedFile(dbUser, profileKeyId, forward.body, token.token, telemetry);
    }
  }
  telemetry.responseBytes = Buffer.byteLength(forward.body);
  // Allow-listed headers only (see UPLOAD_RESPONSE_HEADERS): never Google's upload id.
  return new NextResponse(forward.body, { status: forward.status, headers: uploadResponseHeaders(forward.headers) });
}

/** drives.list under the tree engine: Blocked shared drives withheld, `withheld` says how many. */
function proxyFilterSharedDrives(engine: ProxyDriveTree, body: string): string {
  let data: { drives?: unknown[] } | null = null;
  try { data = JSON.parse(body); } catch { return body; }
  if (!data || !Array.isArray(data.drives)) return body;
  return JSON.stringify(filterSharedDrives(data, engine.settings, engine.driveDefault));
}

async function handleProxyRequest(request: NextRequest, params: { path: string[] }, telemetry: ProxyTelemetry) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      telemetry.authFailureReason = 'missing';
      return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 });
    }

    const keyValue = authHeader.split(' ')[1];
    // Canonical spelling (bare `v3/files` → `drive/v3/files`, Drive slashes
    // collapsed) so the guards below and the forwarded URL see one path —
    // `drive/v3/files/` or `files//{id}` must not slip past an exact match.
    const fullPath = canonicalizeGoogleApiPath(params.path.join('/'));
    // Same guard as the MCP classifier: a `..` segment would let the per-file
    // check authorize one id while Google serves another.
    if (hasDotSegment(fullPath)) {
      return NextResponse.json({ error: 'Invalid path: "." and ".." segments are not forwarded.' }, { status: 400 });
    }

    // ─── 1. Authenticate Proxy Key ──────────────────────────────────────────
    // A temporary key (create_temporary_api_key) is a pointer to its parent
    // profile key: from here on `dbKey` IS the parent, so every rule,
    // mailbox, and delegation check below runs exactly as for the profile.
    const authFailed = (reason: string, error: string) => {
      telemetry.authFailureReason = reason;
      return NextResponse.json({ error }, { status: 401 });
    };
    let dbKey: typeof proxyKeys.$inferSelect | undefined;
    if (isTemporaryKey(keyValue)) {
      telemetry.keyKind = 'temporary';
      const tempKey = await db
        .select()
        .from(temporaryApiKeys)
        .where(eq(temporaryApiKeys.keyHash, hashTemporaryKey(keyValue)))
        .limit(1)
        .then(res => res[0]);
      if (!tempKey) return authFailed('invalid', 'Invalid API Key');
      telemetry.tempKeyId = tempKey.id;
      if (tempKey.revokedAt) {
        return authFailed('revoked', 'This temporary API key was revoked in the FGAC dashboard. Ask the user before creating another one.');
      }
      if (tempKey.expiresAt < new Date()) {
        return authFailed('expired',
          'This temporary API key has expired. Call create_temporary_api_key for a new one and continue — ' +
          'an unfinished resumable upload is not lost: PUT an empty body with "Content-Range: bytes */TOTAL" to the ' +
          'same session URL (with the new key) to learn how many bytes arrived, then resume from there.');
      }
      dbKey = await db.select().from(proxyKeys).where(eq(proxyKeys.id, tempKey.parentKeyId)).limit(1).then(res => res[0]);
      if (!dbKey) return authFailed('invalid', 'Invalid API Key');
      if (dbKey.revokedAt) {
        return authFailed('parent_revoked', 'The agent profile this temporary key belongs to has been revoked, so the key no longer works.');
      }
      if (dbKey.expiresAt && dbKey.expiresAt < new Date()) {
        return authFailed('parent_expired', 'The agent profile this temporary key belongs to has expired, so the key no longer works.');
      }
    } else {
      telemetry.keyKind = 'standing';
      dbKey = await db
        .select()
        .from(proxyKeys)
        .where(eq(proxyKeys.key, keyValue))
        .limit(1)
        .then(res => res[0]);

      if (!dbKey) return authFailed('invalid', 'Invalid API Key');

      // Check revocation
      if (dbKey.revokedAt) return authFailed('revoked', 'This API key has been revoked.');

      // Check expiration
      if (dbKey.expiresAt && dbKey.expiresAt < new Date()) return authFailed('expired', 'This API key has expired.');
    }

    // Fetch the owning user (the delegate / key creator)
    const dbUser = await db
      .select()
      .from(users)
      .where(eq(users.id, dbKey.userId))
      .limit(1)
      .then(res => res[0]);

    if (!dbUser) {
      return NextResponse.json({ error: 'User not found.' }, { status: 401 });
    }

    telemetry.proxyKeyId = dbKey.id;
    telemetry.clerkUserId = dbUser.clerkUserId;

    // ─── Size guard ─────────────────────────────────────────────────────────
    // Vercel rejects request bodies over 4.5 MB before this code runs — with
    // no guidance and no telemetry. Refuse a little below that ourselves, with
    // the fix in the text, so the refusal is both explained and counted.
    telemetry.uploadType = uploadTypeOf(request);
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 0) telemetry.requestBytes = declaredLength;
    if (Number.isFinite(declaredLength) && declaredLength > PROXY_MAX_REQUEST_BYTES) {
      telemetry.oversizeRefused = true;
      return NextResponse.json({
        error: `Request body is ${Math.round(declaredLength / 1024)} KB; the FGAC proxy accepts at most ${PROXY_MAX_REQUEST_BYTES / 1024} KB per request. ` +
          `Upload large files with Google's resumable protocol (uploadType=resumable) in chunks of ${RECOMMENDED_CHUNK_BYTES / (1024 * 1024)} MB ` +
          '(a multiple of 256 KB, except the last chunk). create_temporary_api_key returns a step-by-step recipe.',
      }, { status: 413 });
    }

    // ─── Resumable upload chunks ───────────────────────────────────────────
    // A PUT carrying `upload_id` continues a session FGAC opened (the session
    // URL was rewritten to this host at initiation). It is authorized by the
    // session binding, not by re-classifying the path.
    const uploadId = request.nextUrl.searchParams.get('upload_id');
    if (uploadId) {
      return handleResumableChunk(request, uploadId, dbKey.id, dbUser, telemetry);
    }

    // ─── CLASSIFY (shared policy with the MCP raw tools) ──────────────────────
    // One classifier for both surfaces (googleApiPolicy.ts), so the REST proxy
    // and google_api_get/modify agree on what a path IS: `upload/` media
    // variants classify as their non-upload twins, `batch/` multiplexers and
    // DELETE are refused, never-can-work families are refused. Until
    // 2026-10-03 this route dispatched on its own anchored regexes, and
    // everything they missed — `upload/drive/v3/files/{id}`, calendar, batch —
    // fell into the Gmail branch and was forwarded with the owner's token.
    const cls = classifyGoogleApiCall(fullPath, request.method);
    if (cls.kind === 'denied') return denied(telemetry, cls.code, cls.reason);
    // REST is deny-by-default for families FGAC does not enforce (the MCP tools
    // classify-and-pass them; this surface never has). Drive discovery reads —
    // listing, about, generateIds — stay open: never override Google's native
    // discovery (under drive.file a listing only shows app-granted files).
    if (cls.kind === 'passthrough' && !(cls.family.startsWith('drive/') && !cls.isMutating)) {
      return denied(telemetry, 'raw_api_family_unsupported',
        `This Google API path is not available through the FGAC REST proxy. Supported: Gmail (gmail/v1/…), ` +
        `Sheets, Docs, and Slides files exposed in FGAC rules, and Drive calls on those files (drive/v3/files/{id}).`);
    }

    // Resumable uploads are relayed only where FGAC can keep enforcing on the
    // chunks: a Drive create, a Drive update (per-file rule re-checked per
    // chunk), and a Gmail send (recipients checked on byte 0). Anything else
    // — drafts/send, insert/import, Sheets — would let chunk bytes change
    // what the initiation was authorized for.
    if (telemetry.uploadType === 'resumable_init') {
      const relayable = cls.kind === 'drive_create' || (cls.kind === 'drive_file' && cls.isMutating) || cls.kind === 'gmail_send';
      if (!relayable) {
        return denied(telemetry, 'resumable_unsupported',
          'Resumable uploads through FGAC are supported for Drive file uploads (create or update) and Gmail messages/send. ' +
          'Use uploadType=media or multipart (up to 4 MB) for this endpoint.');
      }
      if (cls.kind === 'gmail_send' && /"raw"\s*:/.test(await request.clone().text())) {
        return denied(telemetry, 'recipients_undetermined',
          'A resumable Gmail send carries the message in the uploaded bytes, not in the initiation metadata: remove "raw" from the initiation body.');
      }
    }

    // Drive tree engine (null unless the flag is on for this owner, the path
    // is a Drive/Sheets/Docs/Slides path, and the live token carries `drive`).
    // `upload/` media variants address the same files as their twins.
    const driveTree = await proxyDriveTreeEngine(
      dbUser, dbKey.id, canonicalizeGoogleApiPath(fullPath).replace(/^upload\//, ''), telemetry,
    );

    // Drive discovery under the tree engine (PR #181): listing-shaped reads can
    // name Blocked files, so they are filtered in forwardDriveCall or refused here.
    const driveDiscovery: DriveDiscovery | null = driveTree ? classifyDriveDiscovery(fullPath, request.method) : null;
    if (driveDiscovery?.kind === 'refuse') {
      telemetry.denialCode = 'drive_discovery_unfiltered';
      return NextResponse.json({ error: driveDiscoveryRefusal(driveDiscovery.endpoint) }, { status: 403 });
    }
    if (driveTree && driveDiscovery?.kind === 'shared_drive'
      && sharedDriveAccess(driveDiscovery.driveId, '', driveTree.settings, driveTree.driveDefault) === 'block') {
      telemetry.denialCode = 'drive_blocked';
      return NextResponse.json({ error: sharedDriveBlockedText(driveDiscovery.driveId) }, { status: 403 });
    }

    // ─── GOOGLE DRIVE PER-FILE ACCESS GUARD ──────────────────────────────────
    // Policy: never override Google's native API behavior for discovery —
    // listing passes through (above; filtered by the tree engine when on). But ACCESS to a specific file
    // (metadata, media get/update incl. `upload/`, export, comments, copy)
    // must respect the same per-file rules as the Sheets/Docs/Slides APIs, or
    // Drive would be a bypass around them.
    if (cls.kind === 'drive_file' || cls.kind === 'file_comments' || cls.kind === 'drive_copy') {
      // A copy creates a file from this one; the REST proxy has always
      // required Read & Write for it (it was a mutating POST to the file).
      const isMutating = cls.kind === 'drive_copy' || cls.isMutating;
      const fileDenial = await driveFileDenial(dbUser, dbKey.id, cls.fileId, isMutating, driveTree, telemetry);
      if (fileDenial) return fileDenial;
      return forwardDriveCall(request, fullPath, dbUser, telemetry, dbKey.id, driveTree,
        cls.kind === 'drive_file' ? cls.fileId : undefined);
    }

    // Drive discovery reads and Drive-side creates (POST drive/v3/files, incl.
    // the `upload/` variant): the new file is app-owned, so no existing file
    // is reachable through them.
    if (cls.kind === 'passthrough' || cls.kind === 'drive_create') {
      return forwardDriveCall(request, fullPath, dbUser, telemetry, dbKey.id, driveTree, undefined, cls.kind === 'drive_create', driveDiscovery);
    }

    // ─── PER-FILE PROXY HANDLER (Sheets / Docs / Slides) ─────────────────────
    // One handler for every per-file kind, driven by the kind descriptor:
    // deny-by-default per-file rules on the key owner's own Google token (no
    // delegated-mailbox path exists here), then forward to the kind's API host.
    // Kind detection and id extraction are the MCP classifier's own helpers,
    // so the REST proxy and google_api_get/modify accept exactly the same
    // spellings (`v4/spreadsheets/{id}`, `docs/v1/documents/{id}`, bare
    // `presentations/{id}`) and disagree on none.
    if (cls.kind === 'file' || cls.kind === 'file_create') {
      const fileKind = cls.fileKind;
      const d = DRIVE_FILE_KINDS[fileKind];
      telemetry.targetEmail = dbUser.email;
      telemetry.accountDelegated = false;
      const fileId = extractDriveFileKindId(fileKind, fullPath);
      if (!fileId) {
        return NextResponse.json({ error: `Invalid ${d.productName} API path` }, { status: 400 });
      }

      const isMutatingRequest = request.method !== 'GET' && request.method !== 'HEAD';
      if (driveTree) {
        const treeDenial = await proxyDriveTreeDenial(driveTree, fileId, isMutatingRequest, telemetry);
        if (treeDenial) return treeDenial;
      } else {
      const allUserRules = await db
        .select()
        .from(accessRules)
        .where(eq(accessRules.userId, dbUser.id));

      const keyAssignments = await db
        .select()
        .from(keyRuleAssignments)
        .where(eq(keyRuleAssignments.proxyKeyId, dbKey.id));

      const assignedRuleIds = new Set(keyAssignments.map(a => a.accessRuleId));
      const allAssignments = await db.select().from(keyRuleAssignments);
      const rulesWithAssignments = new Set(allAssignments.map(a => a.accessRuleId));

      const applicableRules = applicableFileRules(
        allUserRules, rulesWithAssignments, assignedRuleIds, d.service, fileId,
      );

      if (applicableRules.length === 0) {
        telemetry.denialCode = `${d.service}_not_exposed`;
        return NextResponse.json({
          error: `Access Denied: ${d.nounCap} '${fileId}' is not exposed in FGAC rules for this API key.`
        }, { status: 403 });
      }

      // Check explicit block
      if (applicableRules.some(r => r.actionType === d.actionTypes.block)) {
        telemetry.denialCode = `${d.service}_blocked`;
        return NextResponse.json({
          error: `Access Denied: Access to ${d.noun} '${fileId}' has been explicitly blocked.`
        }, { status: 403 });
      }

      // Check write restrictions
      if (isMutatingRequest) {
        if (!applicableRules.some(r => r.actionType === d.actionTypes.readWrite)) {
          telemetry.denialCode = `${d.service}_read_only`;
          return NextResponse.json({
            error: `Access Denied: Write operations on ${d.noun} '${fileId}' are restricted to Read-Only.`
          }, { status: 403 });
        }
      }
      }

      // Fetch Real Google Token from Clerk (the engine already holds it)
      const realGoogleToken = driveTree?.token ?? await fetchClerkGoogleToken(dbUser.clerkUserId, dbUser.clerkUserId, telemetry);

      if (!realGoogleToken) {
        return NextResponse.json({
          error: `Could not fetch Google access token for user '${dbUser.email}'. Please reconnect your Google account.`
        }, { status: 403 });
      }

      // Forward to the kind's API host (sheets/docs/slides.googleapis.com)
      const prefix = `${d.apiPathPrefix}/`;
      const rest = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
      // Bare `presentations/{id}` spelling (accepted by the classifier) needs
      // the version segment Google expects.
      const cleanPath = rest.startsWith(`${d.apiVersion}/`) ? rest : `${d.apiVersion}/${rest}`;
      const googleUrl = `https://${d.apiHost}/${cleanPath}${request.nextUrl.search}`;
      const headers = forwardableHeaders(request);
      headers.set('Authorization', `Bearer ${realGoogleToken.token}`);

      let requestBody: ArrayBuffer | undefined = undefined;
      if (isMutatingRequest) {
        requestBody = await request.clone().arrayBuffer();
      }

      // Piped, not buffered: a large spreadsheet read can exceed Vercel's
      // 4.5 MB buffered-response cap, and FGAC never inspects these bodies.
      return streamFromGoogle(googleUrl, {
        method: request.method,
        headers,
        body: requestBody,
      }, telemetry);
    }

    // ─── 2. Resolve Target Email (Gmail Proxy Handler) ───────────────────────────
    // Only Gmail classes remain: every other kind returned above. Assert it so
    // a new RawCallClass kind can never fall into this branch by default again.
    if (cls.kind !== 'gmail_read' && cls.kind !== 'gmail_write' && cls.kind !== 'gmail_send' && cls.kind !== 'gmail_draft_send') {
      return denied(telemetry, 'raw_api_family_unsupported', 'This Google API path is not available through the FGAC REST proxy.');
    }
    const gmailUserId = extractGmailUserId(fullPath);

    // Resolve 'me' to the key owner's primary email, or use the specific email from the path
    let targetEmail: string;
    if (gmailUserId === 'me') {
      targetEmail = dbUser.email;
    } else {
      targetEmail = gmailUserId;
    }

    // ─── 3. Check Key ↔ Email Access ────────────────────────────────────────
    const emailAccess = await db
      .select()
      .from(keyEmailAccess)
      .where(
        and(
          eq(keyEmailAccess.proxyKeyId, dbKey.id),
          eq(keyEmailAccess.targetEmail, targetEmail.toLowerCase()),
        )
      )
      .limit(1)
      .then(res => res[0]);

    // Also try case-insensitive match
    const emailAccessFallback = emailAccess || await db
      .select()
      .from(keyEmailAccess)
      .where(eq(keyEmailAccess.proxyKeyId, dbKey.id))
      .then(rows => rows.find(r => r.targetEmail.toLowerCase() === targetEmail.toLowerCase()));

    if (!emailAccessFallback) {
      return NextResponse.json({
        error: `This API key does not have access to '${targetEmail}'.`
      }, { status: 403 });
    }

    // Delegation observability: which mailbox this call resolved to, and
    // whether access came through a delegation.
    telemetry.targetEmail = emailAccessFallback.targetEmail;
    telemetry.accountDelegated = !!emailAccessFallback.delegationId;

    // ─── 3b. Re-check the delegation behind delegated access ────────────────
    // key_email_access is a grant record, not proof the grant is still valid.
    // A row created through a delegation must be backed by an ACTIVE delegation
    // at request time — otherwise revoking access in the dashboard would not
    // actually revoke anything, which is the promise the revoke dialog makes.
    if (emailAccessFallback.delegationId) {
      const delegation = await db
        .select()
        .from(emailDelegations)
        .where(eq(emailDelegations.id, emailAccessFallback.delegationId))
        .limit(1)
        .then(res => res[0]);

      if (!delegation || delegation.status !== 'active') {
        console.warn(
          `[PROXY] Blocked request for '${targetEmail}': delegation ${emailAccessFallback.delegationId} is ${delegation?.status ?? 'missing'}`,
        );
        return NextResponse.json({
          error: `Access to '${targetEmail}' has been revoked by its owner.`
        }, { status: 403 });
      }
    }

    // ─── 4. Load Applicable Rules ───────────────────────────────────────────
    const applicableRules = await loadApplicableRules(dbUser.id, dbKey.id, targetEmail);

    // ─── 5. Evaluate Send / Outbound Rules ──────────────────────────────────
    // Same recipient policy as the MCP tools (checkSendWhitelist): EVERY
    // To/Cc/Bcc address must be whitelisted, and a message whose recipients
    // cannot be determined is refused — never forwarded blind. The body may be
    // a JSON `{raw}` or, on `upload/…?uploadType=media`, the RFC 822 message.
    // A resumable initiation carries no message yet (only upload metadata):
    // the recipients are checked on the session's first chunk instead
    // (handleResumableChunk), and no byte reaches Google before they pass.
    if (cls.kind === 'gmail_send' && telemetry.uploadType !== 'resumable_init') {
      const denial = checkSendWhitelist(applicableRules, await sendRecipientsFromRequest(request));
      if (denial) return sendDenied(telemetry, denial);
    }

    // DELETE never reaches this point: the classifier refuses it (deletion is
    // a product guarantee on every surface).

    // ─── 7. Resolve the token owner's Clerk user ID ─────────────────────────
    // If the target email is the key owner's own email, use their Clerk ID.
    // If it's a delegated email, look up the email owner's Clerk ID.
    let tokenOwnerClerkUserId: string;

    if (targetEmail.toLowerCase() === dbUser.email.toLowerCase()) {
      // Own email — use the key owner's token
      tokenOwnerClerkUserId = dbUser.clerkUserId;
    } else {
      // Delegated email — find the email owner
      const emailOwner = await db.select().from(users)
        .where(eq(users.email, targetEmail))
        .limit(1)
        .then(res => res[0]);

      if (!emailOwner) {
        return NextResponse.json({
          error: `Email '${targetEmail}' owner not found in system.`
        }, { status: 403 });
      }

      // Verify there's an active delegation
      const delegation = await db.select().from(emailDelegations)
        .where(and(
          eq(emailDelegations.ownerUserId, emailOwner.id),
          eq(emailDelegations.delegateUserId, dbUser.id),
          eq(emailDelegations.status, 'active'),
        ))
        .limit(1)
        .then(res => res[0]);

      if (!delegation) {
        return NextResponse.json({
          error: `Access to '${targetEmail}' has been revoked or is not delegated to you.`
        }, { status: 403 });
      }

      tokenOwnerClerkUserId = emailOwner.clerkUserId;
    }

    // ─── 8. Fetch Real Google Token from Clerk ──────────────────────────────
    const realGoogleToken = await fetchClerkGoogleToken(tokenOwnerClerkUserId, dbUser.clerkUserId, telemetry);

    if (!realGoogleToken) {
      return NextResponse.json({
        error: `Could not fetch Google access token for '${targetEmail}'. The account owner may need to reconnect their Google account.`
      }, { status: 403 });
    }

    // Gmail-scope pre-flight, mirror of the MCP route's gmailScopeDenial: a
    // grant whose Gmail checkbox was left unchecked at consent 403s on every
    // Gmail call until reconnected, so calling Google is pointless and the
    // opaque upstream 403 sends callers into retry loops.
    if (realGoogleToken.hasGmailScope === false) {
      captureServerEvent(dbUser.clerkUserId, 'google_scope_missing', {
        via: 'proxy',
        account_delegated: telemetry.accountDelegated ?? false,
      });
      return NextResponse.json({
        error: `The Google account '${targetEmail}' is connected WITHOUT Gmail permission — most likely the Gmail checkbox was left unchecked on Google's consent screen. ` +
          `Every Gmail call will fail until the account owner reconnects and approves Gmail access; retrying will not help. ` +
          // for= binds the link to the account it repairs — the Accounts page
          // refuses to auto-fire reconnect for a different signed-in user.
          `One-click fix (opens Google's consent screen directly): ${DASHBOARD_URL}/dashboard/accounts?reconnect=1&for=${encodeURIComponent(targetEmail)}`,
      }, { status: 403 });
    }

    // ─── 8a. drafts/send: resolve the STORED draft's recipients ─────────────
    // drafts/send delivers mail, so it rides the same whitelist as
    // messages/send — but the recipients live in the draft. Fetch it
    // (format=raw) and union with any inline message.raw; anything
    // unresolvable is refused (mirror of the MCP gmail_draft_send branch).
    if (cls.kind === 'gmail_draft_send') {
      const bodyText = await request.clone().text();
      const draftInfo = extractDraftSendInfo(bodyText);
      const { draftId } = draftInfo;
      if (!draftId) {
        return sendDenied(telemetry, { code: 'recipients_undetermined', message: 'Could not determine which draft to send. Provide the draft id in a JSON body: {"id": "<draftId>"}.' });
      }
      const draftPath = canonicalizeGoogleApiPath(fullPath).replace(/^upload\//i, '').replace(/\/send$/i, `/${encodeURIComponent(draftId)}`);
      const draft = await forwardToGoogle(`https://www.googleapis.com/${draftPath}?format=raw`, {
        method: 'GET',
        headers: new Headers({ Authorization: `Bearer ${realGoogleToken.token}` }),
      }, telemetry);
      if (!draft.ok) return draft.response;
      let draftRaw: unknown;
      try { draftRaw = (JSON.parse(draft.body) as { message?: { raw?: unknown } })?.message?.raw; } catch { /* not JSON */ }
      if (draft.status >= 400 || typeof draftRaw !== 'string') {
        return sendDenied(telemetry, { code: 'recipients_undetermined', message: `The draft could not be fetched to verify its recipients (Google answered ${draft.status}). Nothing was sent.` });
      }
      // Stored draft ∪ inline message; fails closed when either side cannot
      // be parsed (shared with the MCP drafts/send path, PR #180).
      const denial = checkSendWhitelist(applicableRules, draftSendRecipients(draftRaw, draftInfo));
      if (denial) return sendDenied(telemetry, denial);
    }

    // ─── 8. Forward to Google ───────────────────────────────────────────────
    // For list queries, inject label filtering if rules exist
    let finalQueryString = request.nextUrl.search;
    if (request.method === 'GET' && fullPath.includes('messages') && !fullPath.match(/messages\/[^/]+$/)) {
      const urlParams = new URLSearchParams(request.nextUrl.searchParams);
      let existingQ = urlParams.get('q') || '';
      
      const labelBlacklists = applicableRules.filter(r => r.service === 'gmail' && r.actionType === 'label_blacklist');
      const labelWhitelists = applicableRules.filter(r => r.service === 'gmail' && r.actionType === 'label_whitelist');
      
      for (const rule of labelBlacklists) {
        if (rule.regexPattern) existingQ += ` -label:${rule.regexPattern}`;
      }
      
      if (labelWhitelists.length > 0) {
        const whitelistQuery = labelWhitelists.filter(r => !!r.regexPattern).map(r => `label:${r.regexPattern}`).join(' OR ');
        if (whitelistQuery) existingQ += ` {${whitelistQuery}}`;
      }
      
      if (existingQ.trim() !== '') {
        urlParams.set('q', existingQ.trim());
      }
      finalQueryString = urlParams.toString() ? `?${urlParams.toString()}` : '';
    }

    const googleUrl = `https://www.googleapis.com/${fullPath}${finalQueryString}`;
    const headers = forwardableHeaders(request);
    headers.set('Authorization', `Bearer ${realGoogleToken.token}`);

    let requestBody: ArrayBuffer | undefined = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      requestBody = await request.clone().arrayBuffer();
    }

    // ─── 8b. Attachments: rules on the parent message, then stream ──────────
    // An attachment is only as readable as the email that carries it (same
    // rule as MCP gmail_get_attachment). Its own body is never inspected, so
    // it is piped: Gmail attachments run to 25 MB (≈ 33 MB as JSON), far
    // over Vercel's 4.5 MB buffered-response cap.
    const attachmentMatch = request.method === 'GET'
      && fullPath.match(/^(gmail\/v1\/users\/[^/]+\/messages\/[^/]+)\/attachments\/[^/]+$/);
    if (attachmentMatch) {
      const parent = await forwardToGoogle(`https://www.googleapis.com/${attachmentMatch[1]}?format=full`, {
        method: 'GET', headers: new Headers({ Authorization: `Bearer ${realGoogleToken.token}` }),
      }, telemetry);
      if (!parent.ok) return parent.response;
      if (parent.status >= 400) return passthroughResponse(parent, telemetry);
      let parsedParent: unknown = null;
      try { parsedParent = JSON.parse(parent.body); } catch { /* not JSON */ }
      const restriction = checkReadRestrictions(applicableRules, parsedParent ?? parent.body);
      if (restriction) {
        captureServerEvent(dbUser.clerkUserId, 'read_restriction_enforced', { via: 'rest_proxy', restriction });
        return NextResponse.json({ error: restriction.replace(/^🚫 /u, '') }, { status: 403 });
      }
      return streamFromGoogle(googleUrl, { method: 'GET', headers }, telemetry);
    }

    // ─── 8c. Resumable initiation: hand back an FGAC session URL ────────────
    if (telemetry.uploadType === 'resumable_init') {
      const response = await streamFromGoogle(googleUrl, { method: request.method, headers, body: requestBody }, telemetry);
      return adoptResumableSession(request, response, {
        parentKeyId: dbKey.id,
        kind: cls.kind === 'gmail_send' ? 'gmail_send' : 'gmail',
        tokenOwnerClerkUserId: tokenOwnerClerkUserId,
        targetEmail,
      }, telemetry);
    }

    const forward = await forwardToGoogle(googleUrl, {
      method: request.method,
      headers,
      body: requestBody,
    }, telemetry);
    if (!forward.ok) return forward.response;

    const returnBody = forward.body;
    const isJson = forward.headers.get('content-type')?.includes('application/json');

    // ─── 9. Evaluate Read / Inbound Rules ───────────────────────────────────
    // Shared with the MCP tools and the push-notification filter
    // (checkReadRestrictions), so the three read paths cannot drift. Gates on
    // every Gmail GET — not just messages/* — because thread (and draft)
    // reads return the same message content and previously bypassed rules on
    // this path while the MCP path checked them.
    if (cls.kind === 'gmail_read' && isJson) {
      let parsedBody: unknown = null;
      try { parsedBody = JSON.parse(returnBody); } catch { /* not JSON */ }
      const restriction = checkReadRestrictions(applicableRules, parsedBody ?? returnBody);
      if (restriction) {
        captureServerEvent(dbUser.clerkUserId, 'read_restriction_enforced', { via: 'rest_proxy', restriction });
        // REST surface: same text as the MCP denial, minus the MCP outcome-
        // classification emoji prefix.
        return NextResponse.json({ error: restriction.replace(/^🚫 /u, '') }, { status: 403 });
      }
    }

    return passthroughResponse(forward, telemetry);

  } catch (error) {
    console.error('Proxy Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
