/**
 * Second-account detection and the delegate link — the PURE part.
 *
 * Why this exists (production, week to 2026-09-21): FGAC's multi-account
 * model is "sign in as the second Google account and delegate its mailbox to
 * your first FGAC account". Three people in one week did something else —
 * signed out of account A, created account B minutes later in the same
 * browser, and then got stuck: B opened A's approval link over and over
 * (every open a wrong-account wall whose only control was "Sign out"), or
 * clicked "+ Add account" → "Got it" on B exactly as on A, because the
 * explainer told B to "sign in as the other account" — which B already was.
 *
 * Nothing in the app knew the two accounts shared a browser, and PostHog
 * cannot pair them either (`posthog.reset()` on sign-out rotates the device
 * id). So middleware stamps two cookies on every signed-in dashboard request:
 *
 *   fgac_last_account  = the Clerk user id signed in on the last request, and
 *                        when it was seen;
 *   fgac_prev_account  = written when `last` changes hands: the PREVIOUS id,
 *                        when it was last seen, and when the switch happened.
 *
 * Clerk user ids only — no email, nothing a third party can read as an
 * address — and the server resolves them to accounts when it needs to. The
 * dashboard reads `prev` to offer the fresh account "attach this mailbox to
 * the account you were just in"; the approve page reads both to decide
 * whether the wrong-account visitor is plausibly the owner's other identity
 * (which orders the wall's controls: delegate first, sign-out second).
 *
 * The delegate link (`/dashboard/accounts?delegate_to=<users.id>`) is the
 * thing the second account can ACT on: whoever opens it signed in gets a
 * one-click "attach my mailbox to that account". It is deliberately not
 * signed — a link-holder can only ever name their OWN account as the
 * recipient (the same power the delegation form already gives anyone who
 * knows an email), and the defence is the confirm step naming the recipient
 * and the consequence.
 */

export const LAST_ACCOUNT_COOKIE = 'fgac_last_account';
export const PREV_ACCOUNT_COOKIE = 'fgac_prev_account';
/** Both markers live a week: a person who comes back days later to finish
 *  setting up their second account still gets the prompt once. */
export const ACCOUNT_MARKER_MAX_AGE_S = 7 * 24 * 60 * 60;
/** The previous account must have been active this recently, relative to
 *  the switch, for the two sessions to count as adjacent (one person, one
 *  sitting). Older = a shared computer or an unrelated visit: no prompt. */
export const ADJACENT_SESSION_MS = 2 * 60 * 60_000;
/** How long after the switch the dashboard keeps offering the prompt. */
export const PRIOR_ACCOUNT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Re-stamp `last` only when it is older than this, so idle navigation does
 *  not carry a Set-Cookie on every request. */
export const LAST_ACCOUNT_REFRESH_MS = 60_000;

export const DELEGATE_TO_PARAM = 'delegate_to';

export type DelegationSurface = 'approve_wall' | 'dashboard_banner' | 'accounts_link' | 'add_account_dialog';
export type DelegationVia = 'form' | 'approve_wall' | 'dashboard_banner' | 'accounts_link';

export interface LastAccountMarker {
  clerkUserId: string;
  /** ms epoch of the last signed-in dashboard request by this account. */
  seenAt: number;
}

export interface PrevAccountMarker {
  clerkUserId: string;
  /** ms epoch of the previous account's last request before the switch. */
  lastSeenAt: number;
  /** ms epoch of the first request by the account that replaced it. */
  switchedAt: number;
}

const CLERK_ID_RE = /^user_[A-Za-z0-9]{10,64}$/;

export function encodeLastAccount(m: LastAccountMarker): string {
  return `${m.clerkUserId}.${Math.floor(m.seenAt / 1000)}`;
}

export function decodeLastAccount(value: string | undefined | null): LastAccountMarker | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const clerkUserId = value.slice(0, dot);
  const seen = Number(value.slice(dot + 1));
  if (!CLERK_ID_RE.test(clerkUserId) || !Number.isFinite(seen) || seen <= 0) return null;
  return { clerkUserId, seenAt: seen * 1000 };
}

export function encodePrevAccount(m: PrevAccountMarker): string {
  return `${m.clerkUserId}.${Math.floor(m.lastSeenAt / 1000)}.${Math.floor(m.switchedAt / 1000)}`;
}

export function decodePrevAccount(value: string | undefined | null): PrevAccountMarker | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length < 3) return null;
  const switched = Number(parts.pop());
  const lastSeen = Number(parts.pop());
  const clerkUserId = parts.join('.');
  if (!CLERK_ID_RE.test(clerkUserId) || !Number.isFinite(lastSeen) || !Number.isFinite(switched) || lastSeen <= 0 || switched <= 0) return null;
  return { clerkUserId, lastSeenAt: lastSeen * 1000, switchedAt: switched * 1000 };
}

export interface MarkerTransition {
  /** New `last` value, or null to leave the cookie as it is. */
  last: LastAccountMarker | null;
  /** New `prev` value, or null to leave the cookie as it is. */
  prev: PrevAccountMarker | null;
}

/**
 * What the markers become after a signed-in request by `currentClerkUserId`.
 *
 *  - first sight of any account: `last` = current, `prev` untouched;
 *  - same account again: `last` re-stamped once it is older than the refresh
 *    interval, `prev` untouched;
 *  - a DIFFERENT account than `last`: `prev` = the old `last` (with the switch
 *    time = now), `last` = current. A `prev` that already names the current
 *    account (A → B → back to A) is superseded by B, so the prompt A sees
 *    is about B — the account that was just active — and never about itself.
 */
export function transitionAccountMarkers(
  last: LastAccountMarker | null,
  currentClerkUserId: string,
  nowMs: number,
): MarkerTransition {
  if (!last) return { last: { clerkUserId: currentClerkUserId, seenAt: nowMs }, prev: null };
  if (last.clerkUserId === currentClerkUserId) {
    if (nowMs - last.seenAt < LAST_ACCOUNT_REFRESH_MS) return { last: null, prev: null };
    return { last: { clerkUserId: currentClerkUserId, seenAt: nowMs }, prev: null };
  }
  return {
    last: { clerkUserId: currentClerkUserId, seenAt: nowMs },
    prev: { clerkUserId: last.clerkUserId, lastSeenAt: last.seenAt, switchedAt: nowMs },
  };
}

export interface PriorAccount {
  clerkUserId: string;
  /** Seconds between the previous account's last request and the switch. */
  gapS: number;
  /** Seconds since the switch. */
  sinceSwitchS: number;
}

/**
 * The account this browser held just before the current one, if the two
 * sessions were adjacent — the candidate for "is that also you?".
 *
 * Reads `prev` first (the durable record of a switch). On the very first
 * request after a switch the middleware transition has not landed in the
 * browser yet, so the still-unrotated `last` naming another account is the
 * same fact, with the switch happening now.
 */
export function priorAccountCandidate(
  last: LastAccountMarker | null,
  prev: PrevAccountMarker | null,
  currentClerkUserId: string,
  nowMs: number,
): PriorAccount | null {
  let candidate: PrevAccountMarker | null = null;
  if (last && last.clerkUserId !== currentClerkUserId) {
    candidate = { clerkUserId: last.clerkUserId, lastSeenAt: last.seenAt, switchedAt: nowMs };
  } else if (prev && prev.clerkUserId !== currentClerkUserId) {
    candidate = prev;
  }
  if (!candidate) return null;
  const gap = candidate.switchedAt - candidate.lastSeenAt;
  const since = nowMs - candidate.switchedAt;
  if (gap < 0 || gap > ADJACENT_SESSION_MS) return null;
  if (since < 0 || since > PRIOR_ACCOUNT_WINDOW_MS) return null;
  return { clerkUserId: candidate.clerkUserId, gapS: Math.round(gap / 1000), sinceSwitchS: Math.round(since / 1000) };
}

/** Whether this browser held `ownerClerkUserId`'s session just before the
 *  current one — the approve page's "plausibly the same person" test. */
export function priorSessionMatches(
  last: LastAccountMarker | null,
  prev: PrevAccountMarker | null,
  currentClerkUserId: string,
  ownerClerkUserId: string,
  nowMs: number,
): boolean {
  const prior = priorAccountCandidate(last, prev, currentClerkUserId, nowMs);
  return prior !== null && prior.clerkUserId === ownerClerkUserId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The delegate link's target is a `users.id` (opaque uuid, never an email). */
export function isDelegateTarget(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Path of the delegate link for `targetUserId` — the account that RECEIVES
 *  the mailbox. Origin is added by whoever renders it (window.location on the
 *  dashboard, DASHBOARD_URL in the MCP surface). */
export function delegateLinkPath(targetUserId: string): string {
  return `/dashboard/accounts?${DELEGATE_TO_PARAM}=${encodeURIComponent(targetUserId)}`;
}
