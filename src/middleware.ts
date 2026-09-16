import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextFetchEvent, NextRequest } from 'next/server';
import { MCP_PROFILE_PATH_RE } from '@/lib/profileSlugs';
import {
  APPROVAL_WALL_COOKIE,
  APPROVAL_WALL_COOKIE_MAX_AGE_S,
  APPROVAL_WALL_DISTINCT_ID,
  APPROVAL_WALL_EVENT,
  describeApprovalWallHit,
  encodeApprovalWallCookie,
  isApprovalWallCandidate,
  markerMatchesHit,
} from '@/lib/approvalWall';
import { captureEdgeEvent } from '@/lib/posthogEdge';

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)']);

const clerkHandler = clerkMiddleware(async (auth, req, event) => {
  const url = req.nextUrl.clone();
  const hostname = url.hostname;

  // Profile-addressed MCP URLs: /api/mcp/<slug> is the same MCP server, with
  // the slug naming which of the caller's agent profiles a NEW connection
  // should bind to (addressing, not authorization — the bearer token still
  // decides the user, and the slug only resolves among that user's profiles).
  // mcp-handler matches the pathname '/api/mcp' exactly, so the slug is moved
  // into a request header before the route sees it.
  const profileMatch = url.pathname.match(MCP_PROFILE_PATH_RE);
  if (profileMatch) {
    url.pathname = '/api/mcp';
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-fgac-profile-slug', profileMatch[1]);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // Route token exchange requests
  if (hostname.startsWith('oauth2.') && url.pathname === '/token') {
    url.pathname = '/api/auth/token';
    return NextResponse.rewrite(url);
  }

  // Route API Proxy requests (production subdomain: gmail.fgac.ai)
  if (hostname.startsWith('gmail.')) {
    url.pathname = `/api/proxy${url.pathname}`;
    return NextResponse.rewrite(url);
  }

  // Local dev: The Google SDK's rootUrl only uses the origin for URL construction,
  // so requests arrive at /gmail/v1/... instead of /api/proxy/gmail/v1/...
  // In production, the gmail.fgac.ai subdomain + the rewrite above handles this.
  if (process.env.NODE_ENV === 'development' && url.pathname.startsWith('/gmail/')) {
    url.pathname = `/api/proxy${url.pathname}`;
    return NextResponse.rewrite(url);
  }

  if (isProtectedRoute(req)) {
    // Approval sign-in wall (src/lib/approvalWall.ts). A signed-out visit to
    // an approval link never reaches the page — this redirect is the only
    // place it can be observed. The event carries action + target_hash (the
    // join to approval_link_minted) and the client class (Claude desktop's
    // in-app browser holds no FGAC session, so it hits this wall every time);
    // the cookie lets sign_in_completed say "signed in after a wall hit and
    // landed somewhere other than the approve page" in one row.
    if (isApprovalWallCandidate(url)) {
      const { userId } = await auth();
      if (userId) {
        // Context reached the page: retire any marker so a later, unrelated
        // sign-in in this browser is not attributed to this wall hit.
        if (req.cookies.has(APPROVAL_WALL_COOKIE)) {
          const res = NextResponse.next();
          res.cookies.delete(APPROVAL_WALL_COOKIE);
          return res;
        }
        return;
      }
      const hit = await describeApprovalWallHit(url, req.headers);
      // One row per wall hit, not per bounce: a browser stuck in a sign-in
      // callback loop re-hits this wall every few seconds (QA 2026-09-16 saw
      // 28 rows from one sign-in on a dev instance). A fresh marker for the
      // same request means this hit is already counted.
      const repeat = markerMatchesHit(req.cookies.get(APPROVAL_WALL_COOKIE)?.value, hit);
      if (!repeat) {
        event.waitUntil(captureEdgeEvent(APPROVAL_WALL_DISTINCT_ID, APPROVAL_WALL_EVENT, { ...hit }));
      }
      // The marker rides on Clerk's own sign-in redirect. `auth.protect()`
      // THROWS a control-flow error that clerkMiddleware turns into the
      // redirect (a 404 for non-document fetches), so the cookie cannot be
      // attached here — the outer wrapper below reads it back off `req` and
      // sets it on whatever redirect Clerk produced.
      if (hit.navigation && !repeat) pendingWallMarkers.set(req, encodeApprovalWallCookie(hit));
    }
    await auth.protect();
  }
});

/** Wall hits whose marker cookie still has to be attached to Clerk's redirect
 *  (keyed by the request object, which Clerk passes through unchanged). */
const pendingWallMarkers = new WeakMap<NextRequest, string>();

function attachWallMarker(req: NextRequest, res: Response | null | undefined | void): void {
  const marker = pendingWallMarkers.get(req);
  if (!marker || !res) return;
  pendingWallMarkers.delete(req);
  if (res.status < 300 || res.status > 399 || !(res instanceof NextResponse)) return;
  res.cookies.set({
    name: APPROVAL_WALL_COOKIE,
    value: marker,
    maxAge: APPROVAL_WALL_COOKIE_MAX_AGE_S,
    path: '/',
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
  });
}

/**
 * Clerk's decodeJwt (@clerk/backend 3.4.7, chunk-HVNR6UQP) JSON-parses the
 * header/payload of any 3-segment Bearer token without a try/catch, so a
 * structurally malformed token (`Bearer bogus.token.value`) throws a raw
 * SyntaxError inside clerkMiddleware's authenticateRequest — before any route
 * handler runs — and surfaces as a 500. Well-formed-but-invalid JWTs come back
 * as TokenVerificationError values and 401 correctly; only the malformed shape
 * escapes. Convert exactly that escape into the 401 the route's auth wrapper
 * would have produced, so malformed tokens fail closed. /api/mcp responses
 * carry the resource_metadata pointer mcp-handler puts on its own 401s, so MCP
 * clients still enter OAuth discovery.
 */
export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  try {
    const res = await clerkHandler(req, event);
    attachWallMarker(req, res);
    return res;
  } catch (err) {
    const hasBearer = req.headers.get('authorization')?.toLowerCase().startsWith('bearer ');
    if (!(err instanceof SyntaxError) || !hasBearer) throw err;

    console.warn('[middleware] Rejecting malformed bearer token:', err.message);
    const isMcp = req.nextUrl.pathname.startsWith('/api/mcp');
    const slugMatch = req.nextUrl.pathname.match(MCP_PROFILE_PATH_RE);
    const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(/:$/, '');
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    const origin = host ? `${proto}://${host}` : req.nextUrl.origin;
    const metadataPath = `/.well-known/oauth-protected-resource/mcp${slugMatch ? `/${slugMatch[1]}` : ''}`;
    const wwwAuthenticate = `Bearer error="invalid_token", error_description="Malformed access token"`
      + (isMcp ? `, resource_metadata="${origin}${metadataPath}"` : '');
    return new NextResponse(
      JSON.stringify({ error: 'invalid_token', error_description: 'Malformed access token' }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': wwwAuthenticate,
        },
      },
    );
  }
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
