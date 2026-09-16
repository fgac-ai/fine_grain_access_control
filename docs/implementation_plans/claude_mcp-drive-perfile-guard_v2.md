# MCP Drive per-file guard + deletion invariant + token audience binding — implementation plan v2

Branch: `claude/mcp-drive-perfile-guard` · PR #147 · Date: 2026-09-16

Revision history: v1 covered Items 1 and 2 (the two "Out of scope" follow-ups
of PR #143). v2 adds Item 3, a finding from the preview QA run of this branch
that Ken asked to close in the same PR rather than as a separate task.
Items 1 and 2 are unchanged from v1; see
`claude_mcp-drive-perfile-guard_v1.md` for their full text and the local
validation record.

## Item 1 — id-addressed Drive calls on the MCP route bypassed per-file rules

Unchanged from v1. Validated locally (23/23 rows of capability 10 A14) and on
the PR #147 preview (24/24 rows), both 2026-09-16.

## Item 2 — "DELETE is never available" rested on the method enum alone

Unchanged from v1. `scripts/test-raw-method-guard.ts` pins the four layers.

## Item 3 — MCP bearer tokens were not audience-bound

### Finding

During the preview run, a bearer minted with
`resource=<preview A>/api/mcp` was accepted by `<preview B>/api/mcp`.
Investigation (all 2026-09-16):

- Clerk's `at+jwt` access tokens carry `iss`, `sub`, `client_id`, `scope`,
  `jti`, `exp`, `iat`, `nbf` and **no `aud`** — observed on three tokens minted
  with three different `resource` values. Clerk's authorization-server
  metadata lists `aud` only under `claims_supported` (an ID-token claim),
  advertises no resource-indicator support, and RFC 8707 appears nowhere in
  Clerk's OAuth docs or its 2025-06-13 OAuth changelog. Clerk ignores
  `resource` today.
- FGAC's `verifyMcpAuth` runs two strategies (Clerk `auth()` +
  `verifyClerkToken`, then a direct `jose` verify); both check signature +
  issuer, neither checks audience. `@clerk/mcp-tools` 0.5.0's
  `verifyClerkToken` checks `isAuthenticated`, `clientId`, `scopes`, `userId`
  only.
- The MCP authorization spec (2025-06-18, "Token Handling" and "Token
  Audience Binding and Validation") says servers MUST validate that tokens
  were issued specifically for them, "**when the Authorization Server
  supports the capability**", and MUST reject tokens that do not include
  them in the audience claim "or otherwise verify that they are the intended
  recipient".

### Risk assessment

The issuer check is what binds tokens today: only tokens from FGAC's own
Clerk instance verify, and every resource server behind one instance is an
FGAC deployment — the production instance serves fgac.ai only; the
development instance serves localhost and Vercel previews. No third-party
resource server shares either instance, so cross-host replay is confined to
FGAC's own hosts and there is no confused-deputy path to another service.
Google tokens are never derived from the MCP bearer (they come from Clerk's
stored grant for the resolved user), so token passthrough is not possible.
Classification: **spec-compliance gap, not a live exposure**. Worth closing
because the gap silently persists the day Clerk starts emitting `aud` unless
the server already checks it.

### Change

1. `src/lib/mcpAudience.ts` (pure): `canonicalResource` (lowercase
   scheme+host, no trailing slash, per the spec's canonical-URI rules),
   `expectedMcpAudiences(requestUrl, profileSlug)` — the base `/api/mcp`
   URL of the request's origin plus the profile-slug URL when the request is
   profile-addressed (the slug is addressing, not a different server, so a
   base-resource token is valid at every profile URL of the host; a token for
   profile A is not valid at profile B) — `audienceClaim`,
   `checkTokenAudience`, `decodeJwtPayload`.
2. `verifyMcpAuth` (route.ts): after either strategy verifies the token, read
   `aud` from the verified payload. Present and not naming this server →
   reject (`outcome: invalid_token`, `error_class: 'audience_mismatch'`,
   standard 401 handshake). Absent → accept and stamp `aud_present: false`.
   No behaviour change for any token Clerk issues today.
3. Analytics: `aud_present` and `error_class: 'audience_mismatch'` on
   `mcp_auth_attempt` (docs/analytics.md, docs/monitoring.md §1). The first
   `aud_present: true` row in production is the signal that Clerk honours
   `resource` and binding is enforced end-to-end.
4. `scripts/test-mcp-audience.ts` in `npm run mcp:lint`: the 2026-09-16 case
   (another preview host's audience) is rejected; absent aud accepted;
   trailing slash / uppercase host accepted; profile-slug matrix; garbage aud
   rejected without throwing.

### Not done, and why

- Token introspection (`/oauth/token_info`) returns client id and scopes,
  not a resource, so it cannot bind either.
- Asking Clerk to honour RFC 8707 is the only complete fix; the server-side
  check above makes FGAC ready for it with no further change.

## Validation

- `npm run mcp:lint` (incl. the new test), `tsc --noEmit`, eslint: clean.
- Preview: the bearer minted during the A14 preview run (no `aud`) must still
  authenticate on the redeployed preview (`tools/list` 200), proving the
  absent-aud path is a no-op for Clerk's current tokens.
