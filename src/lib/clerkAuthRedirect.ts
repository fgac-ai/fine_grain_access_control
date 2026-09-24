/**
 * Clerk auth-redirect telemetry — the loop nobody could see.
 *
 * On 2026-09-21 a localhost session got stuck bouncing between `/dashboard`
 * and Clerk's hosted sign-in: the server logged Clerk's "Refreshing the
 * session token resulted in an infinite redirect loop" warning dozens of
 * times while the browser never landed. Root causes there were local (a
 * pruned Neon branch + stale Clerk cookies), but the same shape on
 * production — the app and Clerk's sign-in / handshake endpoints handing a
 * browser back and forth — would have produced NO signal: `sign_in_completed`
 * fires only on success, and Clerk's warning lives in Vercel's ~1 h runtime
 * log. This module is the PURE part of the fix: it recognises the two Clerk
 * redirects middleware can return (hosted sign-in, dev/prod handshake), turns
 * the request + response into the `clerk_auth_redirect` event's properties,
 * and keeps a short-lived per-browser bounce counter in a marker cookie so
 * "how many times has THIS browser been sent to Clerk in the last five
 * minutes" is a property, not a query.
 *
 * Edge-safe on purpose (middleware imports it): no Node APIs, no DB, no user
 * identity (pre-auth there is none). Nothing here carries a raw cookie — the
 * Clerk cookie behind `client_hash` goes through the same keyed hash the
 * approval funnel uses for recipient addresses. Sibling of approvalWall.ts.
 */
import { analyticsHash } from './approvalLinks';
import { isDocumentNavigation } from './approvalWall';
import { classifyApproveClient, type ApproveClient } from './approveClientClass';

export const CLERK_AUTH_REDIRECT_EVENT = 'clerk_auth_redirect';
export const CLERK_AUTH_REDIRECT_DISTINCT_ID = 'anonymous-clerk-redirect';
export const CLERK_BOUNCE_COOKIE = 'fgac_clerk_bounce';
/** The window one marker keeps counting. Clerk's own loop detector
 *  (`__clerk_redirect_count`) trips at 3 hops inside one handshake; five
 *  minutes covers a whole sign-in round trip plus a few retries, and a person
 *  who comes back later is a fresh series. */
export const CLERK_BOUNCE_WINDOW_S = 5 * 60;

export type ClerkRedirectKind = 'sign_in' | 'handshake';

/**
 * Which Clerk redirect a middleware response is, if any.
 *
 * - `handshake`: Location is Clerk's frontend API `…/v1/client/handshake`
 *   (clerkMiddleware returns this itself, before our handler runs, whenever
 *   the session state is ambiguous — expired token, missing dev browser).
 * - `sign_in`: Location is a Clerk sign-in / sign-up page carrying
 *   `redirect_url` — what `auth.protect()`'s thrown control-flow error turns
 *   into for a signed-out document navigation.
 *
 * The same-origin redirect Clerk issues when a dev-instance handshake RETURNS
 * (`?__clerk_handshake=…` stripped off the URL) is deliberately null: it is
 * the second half of a hop already counted as `handshake`, and production has
 * no such hop at all.
 */
export function classifyClerkRedirect(
  location: string | null | undefined,
  requestOrigin: string,
): ClerkRedirectKind | null {
  if (!location) return null;
  let url: URL;
  try { url = new URL(location, requestOrigin); } catch { return null; }
  if (/\/v1\/client\/handshake\/?$/.test(url.pathname)) return 'handshake';
  if (/(^|\/)sign-(in|up)(\/|$)/.test(url.pathname)
    && (url.origin !== requestOrigin || url.searchParams.has('redirect_url'))) {
    return 'sign_in';
  }
  return null;
}

/** Path segments that are identifiers (uuids, numeric ids, hex or opaque
 *  tokens) become `:id`, so `path` groups by route and never carries an id. */
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,}|[A-Za-z0-9_-]{24,})$/i;

export function stripPathIds(pathname: string): string {
  const stripped = pathname
    .split('/')
    .map(seg => (ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/');
  return (stripped || '/').slice(0, 120);
}

export interface BounceMarker {
  /** Random per-series id (16 hex). Not derived from anything; it only ties
   *  the bounces of one browser within one window together. */
  id: string;
  /** Unix seconds of the first redirect in this series. */
  first: number;
  /** Redirects in this series so far, this one included. */
  count: number;
}

/** Cookie payload `id.first.count` — dot-separated so it needs no quoting. */
export function encodeBounceMarker(m: BounceMarker): string {
  return `${m.id}.${m.first}.${m.count}`;
}

export function decodeBounceMarker(value: string | undefined | null): BounceMarker | null {
  if (!value) return null;
  const [id, first, count] = value.split('.');
  const f = Number(first);
  const c = Number(count);
  if (!/^[0-9a-f]{16}$/.test(id ?? '') || !Number.isInteger(f) || f <= 0 || !Number.isInteger(c) || c <= 0) return null;
  return { id, first: f, count: c };
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** The marker to set on THIS redirect: one more bounce in the current series
 *  when the existing marker is inside the window, else a fresh series. */
export function advanceBounceMarker(
  existing: string | undefined | null,
  nowMs = Date.now(),
  newId: () => string = randomId,
): BounceMarker {
  const now = Math.floor(nowMs / 1000);
  const prev = decodeBounceMarker(existing);
  if (prev && now - prev.first <= CLERK_BOUNCE_WINDOW_S && now >= prev.first) {
    return { id: prev.id, first: prev.first, count: prev.count + 1 };
  }
  return { id: newId(), first: now, count: 1 };
}

export interface ClerkAuthRedirectHit {
  kind: ClerkRedirectKind;
  /** The protected path being requested, ids stripped. */
  path: string;
  /** Clerk's own account of why (`x-clerk-auth-reason`), e.g.
   *  `session-token-expired`, `dev-browser-missing`,
   *  `session-token-and-uat-missing`. Absent when Clerk set none. */
  reason?: string;
  /** `x-clerk-auth-status` on the redirect: `handshake` or `signed-out`. */
  auth_status?: string;
  /** Keyed hash of the Clerk cookie that identifies this browser to Clerk —
   *  `__session` when present, else a non-zero `__client_uat`, else the dev
   *  browser token. Absent for a cookie-less browser. Never the raw value. */
  client_hash?: string;
  /** `client_hash` when there is one, else the bounce series id — the key
   *  the loop query groups on. */
  browser_key: string;
  has_session_cookie: boolean;
  /** `__client_uat` present with a non-zero value (Clerk believes this
   *  browser has a client). `0` is what a signed-out browser carries. */
  has_client_cookie: boolean;
  /** Clerk's own per-handshake hop counter (`__clerk_redirect_count`) as the
   *  request carried it; Clerk gives up and signs the browser out at 3. */
  clerk_redirect_count: number;
  client: ApproveClient;
  agent_driven: boolean;
  user_agent: string;
  /** True for a document navigation — the only case Clerk redirects a
   *  signed-out visit to sign-in (fetches get a 404). */
  navigation: boolean;
  bounce_id: string;
  bounce_count: number;
  /** Seconds since the first redirect of this series. */
  bounce_age_s: number;
}

export interface ClerkAuthRedirectInput {
  kind: ClerkRedirectKind;
  url: URL;
  requestHeaders: Headers;
  /** Request cookies by name (a plain map so this stays testable). */
  cookies: Record<string, string>;
  responseHeaders: Headers;
  marker: BounceMarker;
  nowMs?: number;
}

function findCookie(cookies: Record<string, string>, base: string): string | undefined {
  // Clerk suffixes cookie names per publishable key on multi-instance hosts
  // (`__session_<suffix>`); the bare name comes first when both exist.
  if (cookies[base] !== undefined) return cookies[base];
  const suffixed = Object.keys(cookies).find(n => n.startsWith(`${base}_`));
  return suffixed ? cookies[suffixed] : undefined;
}

export async function describeClerkAuthRedirect(input: ClerkAuthRedirectInput): Promise<ClerkAuthRedirectHit> {
  const { kind, url, requestHeaders, cookies, responseHeaders, marker } = input;
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const session = findCookie(cookies, '__session');
  const clientUat = findCookie(cookies, '__client_uat');
  const devBrowser = cookies['__clerk_db_jwt'];
  const hasClient = clientUat !== undefined && clientUat !== '0';
  const identity = session || (hasClient ? clientUat : undefined) || devBrowser || undefined;
  const client_hash = identity ? await analyticsHash('fgac-clerk-client', identity) : undefined;
  const ua = requestHeaders.get('user-agent') ?? '';
  const reason = responseHeaders.get('x-clerk-auth-reason') ?? undefined;
  const auth_status = responseHeaders.get('x-clerk-auth-status') ?? undefined;
  const redirectCount = Number(cookies['__clerk_redirect_count']);
  return {
    kind,
    path: stripPathIds(url.pathname),
    ...(reason ? { reason: reason.slice(0, 80) } : {}),
    ...(auth_status ? { auth_status: auth_status.slice(0, 40) } : {}),
    ...(client_hash ? { client_hash } : {}),
    browser_key: client_hash ?? marker.id,
    has_session_cookie: session !== undefined,
    has_client_cookie: hasClient,
    clerk_redirect_count: Number.isFinite(redirectCount) ? redirectCount : 0,
    ...classifyApproveClient(ua),
    user_agent: ua.slice(0, 160),
    navigation: isDocumentNavigation(requestHeaders),
    bounce_id: marker.id,
    bounce_count: marker.count,
    bounce_age_s: Math.max(0, now - marker.first),
  };
}
