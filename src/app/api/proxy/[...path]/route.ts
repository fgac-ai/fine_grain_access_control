import { NextRequest, NextResponse } from 'next/server';
import { DRIVE_FILE_KINDS, ACTIVE_DRIVE_FILE_KINDS } from '@/lib/driveFileKinds';
import { driveFileKindForPath, extractDriveFileKindId, hasDotSegment } from '@/app/api/mcp/googleApiPolicy';
import { db } from '@/db';
import { users, proxyKeys, emailDelegations, keyEmailAccess, accessRules, keyRuleAssignments } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { clerkClient } from '@clerk/nextjs/server';
import { compileRulePattern } from '@/lib/rulePatterns';
import { checkReadRestrictions } from '@/lib/gmailRules';
import { captureServerEvent } from '@/lib/posthogServer';
import { GOOGLE_FETCH_TIMEOUT_MS, CLERK_TOKEN_TIMEOUT_MS, withTimeout, isUpstreamTimeout } from '@/lib/upstreamTimeouts';
import { classifyClerkTokenError } from '@/lib/googleTokenFailure';
import { driveTreeFlagOn } from '@/lib/featureFlags';
import { liveTokenScopes, DRIVE_FULL_SCOPE } from '@/lib/googleTokenScopes';
import {
  resolveDriveTreeAccess, effectiveDriveAccess, settingsFromRules, normalizeDriveDefault, driveDenialText, widenListFields,
  type DriveDefault, type DriveSetting,
} from '@/lib/driveTreeAccess';
import {
  agentCreatedGrant, createdDriveFileFromBody, isResumableInitiation, injectCreateId,
  classifyProxyDriveCall, legacyUnruledDriveDecision, createMetadataMimeType,
} from '@/lib/agentCreatedFiles';
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
  /**
   * Which branch of the Drive guard decided an id-addressed call (same values
   * as the MCP `drive_file_gate` prop): `rule` / `tree` / `mime_gated` /
   * `mime_other` / `invisible`.
   */
  driveFileGate?: string;
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
  init: { method: string; headers: Headers; body?: ArrayBuffer | string },
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

/** Google's response passed through with hop-by-hop encoding stripped. */
function passthroughResponse(forward: { status: number; body: string; headers: Headers }): NextResponse {
  const responseHeaders = new Headers(forward.headers);
  responseHeaders.delete('content-encoding');
  return new NextResponse(forward.body, { status: forward.status, headers: responseHeaders });
}

async function trackedProxyRequest(request: NextRequest, params: { path: string[] }) {
  const telemetry: ProxyTelemetry = {};
  const started = Date.now();
  const response = await handleProxyRequest(request, params, telemetry);

  const fullPath = params.path.join('/');
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

  captureServerEvent(telemetry.clerkUserId ?? 'anonymous-proxy', 'proxy_request', {
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
    drive_file_gate: telemetry.driveFileGate,
  });

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


// ─── DRIVE TREE ENGINE (feature-flagged folder-inherited access) ─────────────
// Mirror of the MCP route's engine (src/lib/driveTreeAccess.ts): with the
// key owner's flag on and the live token carrying the full `drive` scope,
// the Drive-file guard, the per-kind handlers and Drive listings below defer
// to the folder-lineage resolver instead of the per-file rule table alone.

type ProxyDriveTree = {
  token: ProxyGoogleToken;
  settings: Map<string, DriveSetting[]>;
  driveDefault: DriveDefault;
  fetchMeta: MetaFetcher;
  clerkUserId: string;
};

function isDriveListPath(fullPath: string): boolean {
  return /^drive\/v3\/files$/.test(fullPath.split('?')[0]);
}

async function proxyDriveTreeEngine(
  dbUser: { id: string; email: string; clerkUserId: string },
  proxyKeyId: string,
  fullPath: string,
  telemetry: ProxyTelemetry,
): Promise<ProxyDriveTree | null> {
  const drivePath = /^(upload\/)?drive\/v[23]\/files/.test(fullPath) || !!driveFileKindForPath(fullPath);
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

/** One Drive metadata GET (mimeType + name) with the owner's token; the raw Google answer on failure. */
async function fetchDriveMimeType(googleToken: string, fileId: string): Promise<
  | { ok: true; mimeType: string | null; name: string | null }
  | { ok: false; status: number; body: string }
> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType,name&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${googleToken}` },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
  const meta = (await res.json()) as { mimeType?: unknown; name?: unknown };
  return { ok: true, mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : null, name: typeof meta.name === 'string' ? meta.name : null };
}

/**
 * Pre-name a resumable upload (see isResumableInitiation): one
 * files.generateIds call, injected into the initiation metadata. Null when
 * the id cannot be injected — the upload then proceeds unchanged and the
 * file simply goes ungranted, as before.
 */
async function prepareResumableCreate(googleToken: string, body: ArrayBuffer | undefined): Promise<{ body: string; id: string; name: string | null; mimeType: string | null } | null> {
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files', {
      headers: { Authorization: `Bearer ${googleToken}` },
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const id = ((await res.json()) as { ids?: unknown }).ids;
    if (!Array.isArray(id) || typeof id[0] !== 'string') return null;
    const injected = injectCreateId(body ? new TextDecoder().decode(body) : '', id[0]);
    if (!injected) return null;
    const meta = JSON.parse(injected) as { name?: unknown; mimeType?: unknown };
    return { body: injected, id: id[0], name: typeof meta.name === 'string' ? meta.name : null, mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : null };
  } catch (err) {
    console.error('[Proxy] Could not pre-name a resumable Drive upload:', err);
    return null;
  }
}

/**
 * A file the agent just created is its own output — a Read & Write rule for
 * this key, the same auto-grant the MCP route writes
 * (src/lib/agentCreatedFiles.ts). Under the Drive tree engine every kind is
 * granted (without it the profile default, often Read, refused the agent's
 * next rename or update of its own file). Under the per-file model only
 * Sheets / Docs / Slides are, exactly as MCP's grantDriveCreatedFile does —
 * before 2026-10-05 the REST proxy granted nothing there, so the legacy
 * guard denied the agent's own spreadsheet as "not exposed".
 */
async function grantProxyCreatedFile(
  googleToken: string, treeActive: boolean, clerkUserId: string, userId: string, proxyKeyId: string,
  file: { id: string; name: string | null; mimeType: string | null },
): Promise<void> {
  try {
    let { name, mimeType } = file;
    if (!mimeType) {
      // A `fields` mask can strip mimeType from the create response.
      const meta = await fetchDriveMimeType(googleToken, file.id);
      if (meta.ok) { mimeType = meta.mimeType; name = name ?? meta.name; }
    }
    const grant = agentCreatedGrant(mimeType, treeActive);
    if (!grant) return;
    const [rule] = await db.insert(accessRules).values({
      userId,
      ruleName: `Agent-created: ${name || file.id}`,
      service: grant.service,
      actionType: grant.actionType,
      targetResourceId: file.id,
      targetKind: grant.targetKind,
      resourceName: name,
    }).returning();
    await db.insert(keyRuleAssignments).values({ proxyKeyId, accessRuleId: rule.id });
    captureServerEvent(clerkUserId, 'drive_file_auto_granted', { via: 'rest_proxy', node_kind: grant.targetKind ?? 'file', service: grant.service, drive_tree: treeActive });
  } catch (err) {
    console.error('[Proxy] Failed to auto-grant agent-created Drive file:', err);
  }
}

async function handleProxyRequest(request: NextRequest, params: { path: string[] }, telemetry: ProxyTelemetry) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 });
    }

    const keyValue = authHeader.split(' ')[1];
    const fullPath = params.path.join('/');
    // Same guard as the MCP classifier: a `..` segment would let the per-file
    // check authorize one id while Google serves another.
    if (hasDotSegment(fullPath)) {
      return NextResponse.json({ error: 'Invalid path: "." and ".." segments are not forwarded.' }, { status: 400 });
    }

    // ─── 1. Authenticate Proxy Key ──────────────────────────────────────────
    const dbKey = await db
      .select()
      .from(proxyKeys)
      .where(eq(proxyKeys.key, keyValue))
      .limit(1)
      .then(res => res[0]);

    if (!dbKey) {
      return NextResponse.json({ error: 'Invalid API Key' }, { status: 401 });
    }

    // Check revocation
    if (dbKey.revokedAt) {
      return NextResponse.json({ error: 'This API key has been revoked.' }, { status: 401 });
    }

    // Check expiration
    if (dbKey.expiresAt && dbKey.expiresAt < new Date()) {
      return NextResponse.json({ error: 'This API key has expired.' }, { status: 401 });
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

    // Drive tree engine (null unless the flag is on for this owner, the path
    // is a Drive/Sheets/Docs/Slides path, and the live token carries `drive`).
    const driveTree = await proxyDriveTreeEngine(dbUser, dbKey.id, fullPath, telemetry);

    // ─── GOOGLE DRIVE PER-FILE ACCESS GUARD ──────────────────────────────────
    // Policy: never override Google's native API behavior for discovery —
    // listing (`drive/v3/files`) passes through untouched (under drive.file it
    // naturally shows only app-granted files; agents discover FGAC-exposed
    // sheet ids via get_my_permissions). But ACCESS to a specific file must
    // respect the same sheets rules as the Sheets API, or drive get/export
    // would be a bypass around them. Calls are classified exactly as the MCP
    // route classifies them (classifyProxyDriveCall): a copy is a READ of its
    // source, and the `upload/` media update of an existing file is gated too.
    // The owner's Google token, fetched at most once per request (the guard's
    // mimeType lookup, the create auto-grant, and the forward share it).
    let ownGoogleToken: ProxyGoogleToken | null | undefined = driveTree?.token;
    const getOwnGoogleToken = async () => {
      if (ownGoogleToken === undefined) ownGoogleToken = await fetchClerkGoogleToken(dbUser.clerkUserId, dbUser.clerkUserId, telemetry);
      return ownGoogleToken;
    };
    const driveCall = classifyProxyDriveCall(request.method, fullPath);
    if (driveCall && driveCall.kind !== 'create') {
      const fileId = driveCall.fileId;
      const isMutating = driveCall.kind !== 'copy' && driveCall.isMutating;
      if (driveTree) {
        telemetry.driveFileGate = 'tree';
        const denied = await proxyDriveTreeDenial(driveTree, fileId, isMutating, telemetry);
        if (denied) return denied;
        // Permitted — falls through to the generic Google passthrough below.
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

        // A Drive file may be exposed as a spreadsheet, a document, or a
        // presentation — any kind's rule authorizes it; a block on any denies it.
        const fileRules = ACTIVE_DRIVE_FILE_KINDS.flatMap(k =>
          applicableFileRules(allUserRules, rulesWithAssignments, assignedRuleIds, DRIVE_FILE_KINDS[k].service, fileId),
        );
        const blockTypes = new Set(ACTIVE_DRIVE_FILE_KINDS.map(k => DRIVE_FILE_KINDS[k].actionTypes.block));
        const readWriteTypes = new Set(ACTIVE_DRIVE_FILE_KINDS.map(k => DRIVE_FILE_KINDS[k].actionTypes.readWrite));
        const notExposed = () => NextResponse.json({
          error: `Access Denied: File '${fileId}' is not exposed in FGAC rules for this API key.`
        }, { status: 403 });

        if (fileRules.length === 0) {
          // No rule names the file: what it IS decides (legacyUnruledDriveDecision,
          // same policy as the MCP route's checkDriveFileAccess). A copy's
          // source and a file's comments need a rule whatever it is, so they
          // skip the lookup.
          if (driveCall.kind !== 'file') return notExposed();
          const token = await getOwnGoogleToken();
          if (!token) {
            return NextResponse.json({
              error: `Could not fetch Google access token for '${dbUser.email}'. The account owner may need to reconnect their Google account.`
            }, { status: 403 });
          }
          const meta = await fetchDriveMimeType(token.token, fileId);
          if (!meta.ok) {
            // Invisible to this token (never picked, not app-created) or a
            // Google failure: Google's own answer, and nothing is forwarded.
            telemetry.driveFileGate = 'invisible';
            return new NextResponse(meta.body, { status: meta.status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
          }
          if (legacyUnruledDriveDecision(driveCall, meta.mimeType) === 'not_exposed') {
            telemetry.driveFileGate = 'mime_gated';
            return notExposed();
          }
          telemetry.driveFileGate = 'mime_other';
          // Permitted — Google's per-file drive.file grant is the gate.
        } else {
          telemetry.driveFileGate = 'rule';
          if (fileRules.some(r => blockTypes.has(r.actionType))) {
            return NextResponse.json({
              error: `Access Denied: Access to file '${fileId}' has been explicitly blocked.`
            }, { status: 403 });
          }
          if (isMutating && !fileRules.some(r => readWriteTypes.has(r.actionType))) {
            return NextResponse.json({
              error: `Access Denied: Write operations on file '${fileId}' are restricted to Read-Only.`
            }, { status: 403 });
          }
          // Permitted — falls through to the generic Google passthrough below.
        }
      }
    }

    // ─── PER-FILE PROXY HANDLER (Sheets / Docs / Slides) ─────────────────────
    // One handler for every per-file kind, driven by the kind descriptor:
    // deny-by-default per-file rules on the key owner's own Google token (no
    // delegated-mailbox path exists here), then forward to the kind's API host.
    // Kind detection and id extraction are the MCP classifier's own helpers,
    // so the REST proxy and google_api_get/modify accept exactly the same
    // spellings (`v4/spreadsheets/{id}`, `docs/v1/documents/{id}`, bare
    // `presentations/{id}`) and disagree on none.
    const fileKind = driveFileKindForPath(fullPath);
    if (fileKind) {
      const d = DRIVE_FILE_KINDS[fileKind];
      telemetry.targetEmail = dbUser.email;
      telemetry.accountDelegated = false;
      const fileId = extractDriveFileKindId(fileKind, fullPath);
      if (!fileId) {
        return NextResponse.json({ error: `Invalid ${d.productName} API path` }, { status: 400 });
      }

      const isMutatingRequest = request.method !== 'GET' && request.method !== 'HEAD';
      if (driveTree) {
        const denied = await proxyDriveTreeDenial(driveTree, fileId, isMutatingRequest, telemetry);
        if (denied) return denied;
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
        return NextResponse.json({
          error: `Access Denied: ${d.nounCap} '${fileId}' is not exposed in FGAC rules for this API key.`
        }, { status: 403 });
      }

      // Check explicit block
      if (applicableRules.some(r => r.actionType === d.actionTypes.block)) {
        return NextResponse.json({
          error: `Access Denied: Access to ${d.noun} '${fileId}' has been explicitly blocked.`
        }, { status: 403 });
      }

      // Check write restrictions
      if (isMutatingRequest) {
        if (!applicableRules.some(r => r.actionType === d.actionTypes.readWrite)) {
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
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${realGoogleToken.token}`);
      headers.delete('host');

      let requestBody: ArrayBuffer | undefined = undefined;
      if (isMutatingRequest) {
        requestBody = await request.clone().arrayBuffer();
      }

      const forward = await forwardToGoogle(googleUrl, {
        method: request.method,
        headers,
        body: requestBody,
      }, telemetry);
      if (!forward.ok) return forward.response;
      return passthroughResponse(forward);
    }

    // ─── 2. Resolve Target Email (Gmail Proxy Handler) ───────────────────────────
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

    const applicableRules = allUserRules.filter(rule => {
      const isGlobal = !rulesWithAssignments.has(rule.id);
      const isAssignedToThisKey = assignedRuleIds.has(rule.id);
      const emailMatches = !rule.targetEmail ||
        rule.targetEmail.toLowerCase() === targetEmail.toLowerCase();
      return (isGlobal || isAssignedToThisKey) && emailMatches;
    });

    // ─── 5. Evaluate Send / Outbound Rules ──────────────────────────────────
    if (request.method === 'POST' && fullPath.includes('messages/send')) {
      const body = await request.clone().json().catch(() => ({}));

      let toAddress = null;
      if (body.raw) {
        try {
          const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
          const toMatch = decoded.match(/^To:\s*(.+)$/im);
          if (toMatch) {
            toAddress = toMatch[1].trim();
          }
        } catch {
          // Ignore decode errors
        }
      }

      if (toAddress) {
        const sendRules = applicableRules.filter(r => r.service === 'gmail' && r.actionType === 'send_whitelist');

        if (sendRules.length > 0) {
          let isWhitelisted = false;
          for (const rule of sendRules) {
            if (!rule.regexPattern) continue;
            const regex = compileRulePattern(rule.regexPattern);
            if (!regex) {
              console.error(`Skipping unusable pattern on rule '${rule.ruleName}'`);
              continue;
            }
            if (regex.test(toAddress)) {
              isWhitelisted = true;
              break;
            }
          }
          if (!isWhitelisted) {
            return NextResponse.json({
              error: `Unauthorized email address. Please ask your user to add '${toAddress}' to the sending whitelist.`
            }, { status: 403 });
          }
        } else {
          return NextResponse.json({
            error: `Unauthorized email address. Please ask your user to add '${toAddress}' to the sending whitelist. Default access is DENIED.`
          }, { status: 403 });
        }
      }
    }

    // ─── 6. Evaluate Deletion Rules ─────────────────────────────────────────
    if (request.method === 'DELETE') {
      if (fullPath.includes('messages/trash') || fullPath.includes('emptyTrash')) {
        return NextResponse.json({
          error: "Action Denied: Global safeguard prevents permanent deletion of all emails."
        }, { status: 403 });
      }
    }

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
    const realGoogleToken = tokenOwnerClerkUserId === dbUser.clerkUserId
      ? await getOwnGoogleToken()
      : await fetchClerkGoogleToken(tokenOwnerClerkUserId, dbUser.clerkUserId, telemetry);

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

    // Drive tree engine: a Drive listing is forwarded with a fields mask wide
    // enough to resolve each file's lineage, then filtered below.
    const filterListing = !!driveTree && request.method === 'GET' && isDriveListPath(fullPath);
    if (filterListing) {
      const urlParams = new URLSearchParams(request.nextUrl.searchParams);
      const widened = widenListFields(urlParams.get('fields'));
      if (widened !== undefined) urlParams.set('fields', widened);
      finalQueryString = urlParams.toString() ? `?${urlParams.toString()}` : '';
    }

    const googleUrl = `https://www.googleapis.com/${fullPath}${finalQueryString}`;
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${realGoogleToken.token}`);
    headers.delete('host');

    let requestBody: ArrayBuffer | string | undefined = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      requestBody = await request.clone().arrayBuffer();
    }

    // Creates and copies are auto-granted to this key — every kind under the
    // Drive tree engine, Sheets/Docs/Slides under the per-file model (MCP
    // parity). A resumable upload is named up front (its file never comes
    // back through here); under the per-file model only when its metadata
    // names a kind that would be granted, so other uploads are untouched.
    // Drive calls never reach a delegated mailbox (the path names no user),
    // so realGoogleToken is the key owner's own.
    const driveCreate = driveCall?.kind === 'create' || driveCall?.kind === 'copy';
    const resumableWanted = driveCreate && isResumableInitiation(request.method, fullPath, request.nextUrl.searchParams)
      && (!!driveTree || agentCreatedGrant(createMetadataMimeType(requestBody ? new TextDecoder().decode(requestBody as ArrayBuffer) : ''), false) !== null);
    const resumable = resumableWanted
      ? await prepareResumableCreate(realGoogleToken.token, requestBody as ArrayBuffer | undefined)
      : null;
    if (resumable) {
      requestBody = resumable.body;
      headers.delete('content-length');
      headers.set('content-type', 'application/json; charset=UTF-8');
    }

    const forward = await forwardToGoogle(googleUrl, {
      method: request.method,
      headers,
      body: requestBody,
    }, telemetry);
    if (!forward.ok) return forward.response;

    if (driveCreate && forward.status >= 200 && forward.status < 300) {
      let created = null;
      if (resumable) {
        created = { id: resumable.id, name: resumable.name, mimeType: resumable.mimeType ?? request.headers.get('x-upload-content-type') };
      } else {
        try { created = createdDriveFileFromBody(JSON.parse(forward.body)); } catch { /* not JSON */ }
      }
      if (created) await grantProxyCreatedFile(realGoogleToken.token, !!driveTree, dbUser.clerkUserId, dbUser.id, dbKey.id, created);
    }

    const returnBody = forward.body;
    const isJson = forward.headers.get('content-type')?.includes('application/json');

    // ─── 9. Evaluate Read / Inbound Rules ───────────────────────────────────
    // Shared with the MCP tools and the push-notification filter
    // (checkReadRestrictions), so the three read paths cannot drift. Gates on
    // every Gmail GET — not just messages/* — because thread (and draft)
    // reads return the same message content and previously bypassed rules on
    // this path while the MCP path checked them.
    if (request.method === 'GET' && fullPath.startsWith('gmail/') && isJson) {
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

    if (filterListing && driveTree && forward.status === 200 && isJson) {
      const filtered = await proxyFilterDriveListing(driveTree, returnBody);
      const responseHeaders = new Headers(forward.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      return new NextResponse(filtered, { status: 200, headers: responseHeaders });
    }

    return passthroughResponse(forward);

  } catch (error) {
    console.error('Proxy Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
