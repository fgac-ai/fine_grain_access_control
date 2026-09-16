/**
 * Approval sign-in wall — the hop the funnel could not see.
 *
 * `/dashboard/approve` sits in the Clerk-protected route group, so a
 * SIGNED-OUT visit never renders the page: middleware bounces it to Clerk's
 * hosted sign-in before `approval_link_opened` can fire. That is the exact
 * hop the Claude desktop in-app browser takes (it holds no FGAC session), and
 * PostHog had no row for it — the whole class showed up as "minted, never
 * opened". Sized 2026-09-15: of 110 never-opened requests since 2026-09-09,
 * 15 had the owner sign in within the hour, every one landing on the default
 * profile page instead of the approve page (8 of those sign-ins came from
 * Claude desktop's browser).
 *
 * This module is the PURE part of that instrumentation: it turns a wall hit
 * (URL + request headers) into the event's properties, and encodes the
 * short-lived marker cookie the sign-in event reads back so "signed in after
 * a wall hit, landed somewhere other than the approve page" is one row.
 * Edge-safe on purpose — middleware imports it — so no Node APIs, no DB, and
 * no user identity (pre-auth there is none; the join to the request runs on
 * `action` + `target_hash`, which `approval_link_minted` already carries).
 */
import {
  APPROVAL_ACTIONS,
  APPROVAL_PARAMS,
  approvalTargetHash,
  type ApprovalActionName,
} from './approvalLinks';
import { classifyApproveClient, type ApproveClient } from './approveClientClass';

export const APPROVAL_WALL_EVENT = 'approval_sign_in_wall';
export const APPROVAL_WALL_DISTINCT_ID = 'anonymous-approve-wall';
export const APPROVAL_WALL_COOKIE = 'fgac_approval_wall';
/** Long enough to cover a Google sign-in round trip, short enough that a
 *  later, unrelated sign-in is not attributed to a stale wall hit. */
export const APPROVAL_WALL_COOKIE_MAX_AGE_S = 30 * 60;

export interface ApprovalWallHit {
  /** Validated against the action enum; anything else is `unknown`. */
  action: ApprovalActionName | 'unknown';
  proxy_key_id?: string;
  /** Same HMAC as the mint/open events — the join key across the wall. */
  target_hash?: string;
  client: ApproveClient;
  agent_driven: boolean;
  user_agent: string;
  /** True for a document navigation (the case Clerk redirects); false for the
   *  fetches Clerk answers with 404 — agents and scripts probing the link. */
  navigation: boolean;
}

/** A `/dashboard/approve` URL that carries an approval link's own params. */
export function isApprovalWallCandidate(url: URL): boolean {
  return url.pathname === '/dashboard/approve'
    && url.searchParams.has(APPROVAL_PARAMS.action)
    && url.searchParams.has(APPROVAL_PARAMS.signature);
}

/** Mirrors Clerk's own document-request test (`protect.js`): only these get
 *  the sign-in redirect; everything else is a 404. */
export function isDocumentNavigation(headers: Headers): boolean {
  const dest = headers.get('sec-fetch-dest');
  if (dest === 'document' || dest === 'iframe') return true;
  return headers.get('accept')?.includes('text/html') ?? false;
}

export async function describeApprovalWallHit(url: URL, headers: Headers): Promise<ApprovalWallHit> {
  const rawAction = url.searchParams.get(APPROVAL_PARAMS.action) ?? '';
  const action = APPROVAL_ACTIONS.includes(rawAction as ApprovalActionName)
    ? (rawAction as ApprovalActionName)
    : 'unknown';
  const key = url.searchParams.get(APPROVAL_PARAMS.key) ?? undefined;
  const target = url.searchParams.get(APPROVAL_PARAMS.target) ?? '';
  const ua = headers.get('user-agent') ?? '';
  return {
    action,
    proxy_key_id: key || undefined,
    target_hash: await approvalTargetHash(target),
    ...classifyApproveClient(ua),
    user_agent: ua.slice(0, 160),
    navigation: isDocumentNavigation(headers),
  };
}

/** Cookie payload: `a=<action>&h=<target_hash>&t=<unix seconds>` — plain
 *  URL-encoded so it needs no quoting and the client can parse it with
 *  URLSearchParams. Never carries the key id: the sign-in event does not
 *  need it and the cookie is client-readable. */
export function encodeApprovalWallCookie(hit: Pick<ApprovalWallHit, 'action' | 'target_hash'>, nowMs = Date.now()): string {
  const q = new URLSearchParams();
  q.set('a', hit.action);
  if (hit.target_hash) q.set('h', hit.target_hash);
  q.set('t', String(Math.floor(nowMs / 1000)));
  return q.toString();
}

export interface ApprovalWallMarker {
  approval_wall_action: string;
  approval_wall_target_hash?: string;
  /** Seconds between the wall hit and the read (the sign-in completing). */
  approval_wall_age_s: number;
}

/** Inverse of encodeApprovalWallCookie; null for anything malformed. */
export function decodeApprovalWallCookie(value: string | undefined | null, nowMs = Date.now()): ApprovalWallMarker | null {
  if (!value) return null;
  let q: URLSearchParams;
  try { q = new URLSearchParams(value); } catch { return null; }
  const action = q.get('a');
  const t = Number(q.get('t'));
  if (!action || !Number.isFinite(t) || t <= 0) return null;
  const hash = q.get('h') || undefined;
  return {
    approval_wall_action: action,
    ...(hash ? { approval_wall_target_hash: hash } : {}),
    approval_wall_age_s: Math.max(0, Math.floor(nowMs / 1000) - t),
  };
}

/** Read one cookie out of a `document.cookie` string (client side). */
export function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return rest.join('='); }
    }
  }
  return undefined;
}
