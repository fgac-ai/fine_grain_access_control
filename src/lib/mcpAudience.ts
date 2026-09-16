/**
 * Token audience binding for the MCP resource server (RFC 8707 / MCP auth
 * spec 2025-06-18 "Token Audience Binding and Validation").
 *
 * The spec: clients MUST send `resource=<canonical MCP server URI>` on the
 * authorization and token requests, and servers MUST reject tokens that do
 * not name them in the audience claim "or otherwise verify that they are the
 * intended recipient". Binding only happens "when the Authorization Server
 * supports the capability" — and Clerk, FGAC's authorization server, does not
 * today: its `at+jwt` access tokens carry `iss`, `sub`, `client_id`, `scope`,
 * `jti`, `exp`, `iat`, `nbf` and NO `aud` (observed on three tokens minted
 * 2026-09-16 with different `resource` values), its authorization-server
 * metadata advertises no resource-indicator support, and RFC 8707 appears
 * nowhere in its OAuth docs. Consequence, verified the same day: a bearer
 * minted with `resource=<preview A>/api/mcp` was accepted by `<preview B>`.
 *
 * What DOES bind tokens today is the issuer check in `verifyMcpAuth`: only
 * tokens from FGAC's own Clerk instance verify, and every resource server
 * behind one instance is an FGAC deployment (production instance → fgac.ai;
 * development instance → localhost + Vercel previews). No third-party
 * resource server shares the instance, so cross-host replay is confined to
 * FGAC's own hosts — a spec-compliance gap, not a live confused-deputy path.
 *
 * This module closes the gap in the only way available without Clerk's
 * cooperation, and future-proofs it: when an `aud` IS present (the day Clerk
 * honours `resource`, or a token from any other source), it must name this
 * server. Absent `aud` is accepted and counted (`aud_present: false` on
 * `mcp_auth_attempt`), so the first `aud_present: true` in production is the
 * signal that binding has become enforceable end-to-end.
 *
 * Pure (no db/env imports): unit-tested by scripts/test-mcp-audience.ts.
 */

/** Canonical form for comparison: lowercase scheme+host, no trailing slash,
 * no fragment. Path case is preserved (the slug is case-sensitive). */
export function canonicalResource(uri: string): string | null {
  let url: URL;
  try { url = new URL(uri); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * The audiences this deployment answers to for a request: its base MCP URL
 * and, for a profile-addressed request, the slug URL too. A token minted for
 * the base resource is valid at every profile URL of the same host — the slug
 * is addressing (which profile's rules apply), not a different server — while
 * a token minted for profile A is NOT valid at profile B.
 */
export function expectedMcpAudiences(requestUrl: string, profileSlug?: string | null): string[] {
  const base = canonicalResource(new URL(requestUrl).origin + '/api/mcp');
  if (!base) return [];
  return profileSlug ? [base, `${base}/${profileSlug}`] : [base];
}

export type AudienceCheck =
  | { present: false }
  | { present: true; ok: boolean; aud: string[] };

/** Read the `aud` claim off a JWT payload. Only meaningful AFTER the token's
 * signature has been verified — never authorize on an unverified claim. */
export function audienceClaim(payload: unknown): string[] | undefined {
  const aud = (payload as { aud?: unknown } | null)?.aud;
  if (typeof aud === 'string') return aud.length > 0 ? [aud] : undefined;
  if (Array.isArray(aud)) {
    const strs = aud.filter((a): a is string => typeof a === 'string' && a.length > 0);
    return strs.length > 0 ? strs : undefined;
  }
  return undefined;
}

export function checkTokenAudience(aud: string[] | undefined, expected: string[]): AudienceCheck {
  if (!aud || aud.length === 0) return { present: false };
  const want = new Set(expected.map(canonicalResource).filter((e): e is string => e !== null));
  const ok = aud.some(a => {
    const c = canonicalResource(a);
    return c !== null && want.has(c);
  });
  return { present: true, ok, aud };
}

/** Decode a JWT payload without verification (for reading `aud` after the
 * signature was already checked by the verifying strategy). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    const obj = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
