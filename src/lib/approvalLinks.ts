/**
 * Deterministic signed approval links.
 *
 * A denial (or the request_access tool) builds a stateless, signed URL
 * describing exactly one grant. The owning user opens the link, a confirm
 * page shows precisely what is being granted, and approving applies it.
 *
 * DETERMINISTIC (2026-08-25 redesign): the URL is a pure function of
 * (userId, proxyKeyId, action, target). Denying the same operation twice
 * produces the SAME url — a retrying agent re-emits one link instead of
 * minting a fresh one per attempt. The previous design minted a unique
 * single-use JWT per denial, which produced ~1.45 distinct URLs per real
 * request (worst observed: 17) and made a funnel converting near 58% report
 * as 31%, because every retry counted as another unopened request.
 *
 * Security properties, and where each actually lives:
 *   - AUTHORIZATION is the owning user's Clerk session plus a live
 *     proxy_keys ownership check in approveMagicLink — NOT the signature.
 *     A key belonging to someone else is refused by the database lookup.
 *   - The HMAC prevents FORGERY: only FGAC can author a valid approval URL,
 *     so a crafted link cannot be used to socially-engineer a click.
 *   - The signature binds the OWNER implicitly: userId is an HMAC input but
 *     never appears in the URL, and verification recomputes it with the
 *     SIGNED-IN user. A link opened by anyone else fails to verify.
 *   - No expiry and no single-use (both retired 2026-08-25). Each generated
 *     a dead end — "Link expired" and "Link already used" — and neither
 *     protected anything the session check does not already cover. The URL
 *     is inert without the owner's Clerk session.
 *
 * Re-approving after the grant was revoked is PERMITTED by design: the URL
 * is permanent, and re-granting needs the owner's session plus an explicit
 * click on a page naming the grant — the same bar as re-adding the rule in
 * the dashboard.
 *
 * The signing key is derived from CLERK_SECRET_KEY so no new secret needs to
 * be provisioned. Rotating the Clerk secret invalidates outstanding links.
 */

import { DRIVE_FILE_KINDS, kindForApprovalAction, type DriveFileKind } from './driveFileKinds';

export type ApprovalAction =
  | { action: 'send_whitelist'; recipient: string }
  | { action: 'send_all' }
  | { action: 'sheets_expose'; spreadsheetId: string; resourceName?: string }
  | { action: 'sheets_write'; spreadsheetId: string; resourceName?: string }
  | { action: 'docs_expose'; documentId: string; resourceName?: string }
  | { action: 'docs_write'; documentId: string; resourceName?: string }
  | { action: 'slides_expose'; presentationId: string; resourceName?: string }
  | { action: 'slides_write'; presentationId: string; resourceName?: string };

export type ApprovalActionName = ApprovalAction['action'];

export const APPROVAL_ACTIONS: readonly ApprovalActionName[] = [
  'send_whitelist', 'send_all', 'sheets_expose', 'sheets_write', 'docs_expose', 'docs_write',
  'slides_expose', 'slides_write',
] as const;

/**
 * Build the per-file approval action for a kind at a level. This is the ONE
 * construction site for per-file actions, and it is a switch on the kind on
 * purpose: the union above pairs each action name with its own id key, and
 * only an explicit per-member literal lets the compiler verify that pairing
 * (a descriptor-driven `{ [d.idKey]: id }` would need a cast and could pair
 * `slides_write` with `documentId` without a type error). Adding a kind means
 * adding its two union members and its case here — nowhere else.
 */
export function fileApprovalActionFor(
  kind: DriveFileKind,
  level: 'expose' | 'write',
  fileId: string,
  resourceName?: string,
): ApprovalAction {
  const write = level === 'write';
  const named = resourceName ? { resourceName } : {};
  switch (kind) {
    case 'sheet': return write
      ? { action: 'sheets_write', spreadsheetId: fileId, ...named }
      : { action: 'sheets_expose', spreadsheetId: fileId, ...named };
    case 'doc': return write
      ? { action: 'docs_write', documentId: fileId, ...named }
      : { action: 'docs_expose', documentId: fileId, ...named };
    case 'slide': return write
      ? { action: 'slides_write', presentationId: fileId, ...named }
      : { action: 'slides_expose', presentationId: fileId, ...named };
  }
}

/** The per-file kind an approval payload or action targets, if any. */
export const approvalFileKind = kindForApprovalAction;

/** The file id a per-file approval payload carries (under the kind's id key). */
export function approvalFileId(p: Pick<ApprovalPayload, 'action' | 'spreadsheetId' | 'documentId' | 'presentationId'>): string | undefined {
  const kind = kindForApprovalAction(p.action);
  return kind ? p[DRIVE_FILE_KINDS[kind].idKey] : undefined;
}

/** URL query parameter names — short, because the URL is shown to humans. */
export const APPROVAL_PARAMS = { action: 'a', key: 'k', target: 'r', signature: 's' } as const;

export interface ApprovalPayload {
  userId: string;      // FGAC users.id that must approve (never in the URL)
  proxyKeyId: string;  // profile/key the grant is scoped to
  action: ApprovalActionName;
  recipient?: string;
  spreadsheetId?: string;
  documentId?: string;
  presentationId?: string;
  /** Display name, when a caller knows it. Never carried in the URL. */
  resourceName?: string;
  /** Deterministic analytics id joining minted → opened → approved. */
  requestId: string;
}

/** The single field an action targets: recipient, or the per-file id. */
export function actionTarget(action: ApprovalAction): string {
  switch (action.action) {
    case 'send_whitelist': return action.recipient;
    case 'send_all': return '';
    case 'sheets_expose':
    case 'sheets_write': return action.spreadsheetId;
    case 'docs_expose':
    case 'docs_write': return action.documentId;
    case 'slides_expose':
    case 'slides_write': return action.presentationId;
  }
}

/** Canonical string every derived value is computed over. */
function canonical(userId: string, proxyKeyId: string, action: string, target: string): string {
  // \n is not valid in any component (ids are UUIDs, actions are an enum, and
  // targets are Google file ids or email addresses), so this is unambiguous.
  return [userId, proxyKeyId, action, target].join('\n');
}

function b64url(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(label: string, message: string): Promise<string> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error('CLERK_SECRET_KEY missing — cannot sign approval links');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${label}:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/** Tamper-proofing signature carried in the URL as `s`. */
export async function approvalSignature(
  userId: string, proxyKeyId: string, action: string, target: string,
): Promise<string> {
  return (await hmac('fgac-approval-links', canonical(userId, proxyKeyId, action, target))).slice(0, 32);
}

/**
 * Deterministic analytics id. Derived under a DIFFERENT label than the
 * signature so that publishing request_id to PostHog can never leak a value
 * that helps forge a URL.
 */
export async function approvalRequestId(
  userId: string, proxyKeyId: string, action: string, target: string,
): Promise<string> {
  return (await hmac('fgac-approval-request-id', canonical(userId, proxyKeyId, action, target))).slice(0, 22);
}

/**
 * Hashed target for analytics grouping. Spreadsheet ids, document ids, and
 * recipient addresses are customer data and must not sit in analytics in the
 * clear — the hash is enough to tell two requests apart.
 */
export async function approvalTargetHash(target: string): Promise<string | undefined> {
  if (!target) return undefined;
  return (await hmac('fgac-approval-target', target)).slice(0, 16);
}

/** Timing-safe string compare (both operands are fixed-length base64url). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Build the approval URL and the ids analytics joins on. Deterministic: the
 * same arguments always produce the same url and requestId.
 */
export async function mintApprovalLink(
  baseUrl: string,
  userId: string,
  proxyKeyId: string,
  action: ApprovalAction,
): Promise<{ url: string; query: string; requestId: string; targetHash?: string }> {
  // Env-sourced base URLs have shipped with a trailing newline before (a
  // pasted Vercel env var), which breaks every link at the client — most
  // clients truncate at the newline and land on the site root. Sanitize here
  // so every caller is covered, whatever the env value looks like.
  const origin = baseUrl.trim().replace(/\/+$/, '');
  const target = actionTarget(action);
  const [signature, requestId, targetHash] = await Promise.all([
    approvalSignature(userId, proxyKeyId, action.action, target),
    approvalRequestId(userId, proxyKeyId, action.action, target),
    approvalTargetHash(target),
  ]);
  const q = new URLSearchParams();
  q.set(APPROVAL_PARAMS.action, action.action);
  q.set(APPROVAL_PARAMS.key, proxyKeyId);
  if (target) q.set(APPROVAL_PARAMS.target, target);
  q.set(APPROVAL_PARAMS.signature, signature);
  // `query` is what the ledger stores (approval_requests.link_query) so the
  // dashboard's pending-approvals banner can re-open the link as minted.
  const query = q.toString();
  return { url: `${origin}/dashboard/approve?${query}`, query, requestId, targetHash };
}

export async function mintApprovalUrl(
  baseUrl: string,
  userId: string,
  proxyKeyId: string,
  action: ApprovalAction,
): Promise<string> {
  return (await mintApprovalLink(baseUrl, userId, proxyKeyId, action)).url;
}

export type VerifyResult =
  | { ok: true; payload: ApprovalPayload }
  | { ok: false; reason: 'invalid' };

/** Raw query params as read from the approve page URL. */
export interface ApprovalSearchParams {
  a?: string;
  k?: string;
  r?: string;
  s?: string;
}

/**
 * Verify approval params against the SIGNED-IN user.
 *
 * The signature is recomputed with `signedInUserId`, so a link minted for a
 * different user simply fails to verify — that is what makes the owner
 * binding work without putting a user id in the URL. Authorization still
 * rests on the live proxy-key ownership check downstream; this only proves
 * the URL was authored by FGAC for this user.
 */
export async function verifyApprovalParams(
  signedInUserId: string,
  params: ApprovalSearchParams,
): Promise<VerifyResult> {
  const action = params.a;
  const proxyKeyId = params.k;
  const target = params.r ?? '';
  const signature = params.s;
  if (!action || !proxyKeyId || !signature) return { ok: false, reason: 'invalid' };
  if (!APPROVAL_ACTIONS.includes(action as ApprovalActionName)) return { ok: false, reason: 'invalid' };

  const expected = await approvalSignature(signedInUserId, proxyKeyId, action, target);
  if (!safeEqual(expected, signature)) return { ok: false, reason: 'invalid' };

  const name = action as ApprovalActionName;
  const requestId = await approvalRequestId(signedInUserId, proxyKeyId, name, target);
  return {
    ok: true,
    payload: {
      userId: signedInUserId,
      proxyKeyId,
      action: name,
      requestId,
      recipient: name === 'send_whitelist' ? target : undefined,
      ...fileIdFields(name, target),
    },
  };
}

/** `{ <idKey>: target }` for a per-file action, `{}` otherwise. */
export function fileIdFields(action: string, target: string): Partial<ApprovalPayload> {
  const kind = kindForApprovalAction(action);
  return kind ? { [DRIVE_FILE_KINDS[kind].idKey]: target } : {};
}

/**
 * Analytics-only peek at params that failed verification: reports the action
 * so `approval_link_opened` can still be attributed. Never use for
 * authorization — nothing here has been verified.
 */
export function peekApprovalParams(params: ApprovalSearchParams): { action?: string } {
  return {
    action: params.a && APPROVAL_ACTIONS.includes(params.a as ApprovalActionName) ? params.a : undefined,
  };
}

/** Human-readable one-line description of what approving would grant. */
export function describeApproval(p: ApprovalPayload): string {
  switch (p.action) {
    case 'send_whitelist':
      return `Allow this agent to send email to ${p.recipient}`;
    case 'send_all':
      return 'Allow this agent to send email to ANY recipient, from every mailbox on its profile';
    // Every per-file action is listed so the switch stays exhaustive: a new
    // action without copy is a compile error, never a raw slug on the
    // consent page. The copy itself comes from the kind descriptor.
    case 'sheets_expose':
    case 'sheets_write':
    case 'docs_expose':
    case 'docs_write':
    case 'slides_expose':
    case 'slides_write': {
      const d = DRIVE_FILE_KINDS[kindForApprovalAction(p.action)!];
      const level = p.action === d.approvalActions.write ? 'read & write' : 'read-only';
      return `Give this agent ${level} access to ${d.noun} ${p.resourceName || approvalFileId(p)}`;
    }
  }
}
