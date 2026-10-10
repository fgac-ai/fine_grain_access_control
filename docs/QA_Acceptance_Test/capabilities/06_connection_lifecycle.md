# Capability: Connection Lifecycle

> v2 — REPLACES `capabilities/06_connection_lifecycle.md` when Phase B
> (instant-start, `connector-growth_v1.md`) ships. Own-user connections
> auto-attach to the Default profile instead of starting Pending; the
> pending state remains only for flows that need another person's consent
> (delegation, capability 04). Also fixes v1's stale A3 wording — the
> pending message changed in the directory-readiness refactor.

## Assertions

### A1: Discovery endpoints return valid metadata
- Fetch `/.well-known/oauth-authorization-server`
- Fetch `/.well-known/oauth-protected-resource/mcp`
- **Expected**: Valid JSON with `authorization_endpoint`, `token_endpoint`,
  `registration_endpoint`; the protected-resource `resource` field is the full
  MCP URL including the `/api/mcp` path

### A2: Unauthenticated MCP requests return 401 on every verb
- POST, GET, and DELETE to `/api/mcp` without auth
- **Expected**: HTTP 401 with a `WWW-Authenticate` header whose
  `resource_metadata` points at the protected-resource document

### A3: New agent auto-attaches and works immediately
- Authenticate a new DCR client via OAuth, then call `list_accounts`
- **Expected**: Tool succeeds read-only on the first call — no pending
  message, no dashboard visit. The connection is bound to the Default
  profile (see capability 13 for the full posture assertions)

### A4: New connection is visible and reviewable in the dashboard
- Check the dashboard via the browser agent after A3
- **Expected**: The connection appears under its profile in **Connected
  Agents** with client name and last-used time, plus a new-connection notice
  (banner or equivalent) with review/block controls. No approval step is
  required or offered for own-user connections

### A5: Reattaching a connection to another profile works
- From the dashboard, move the A3 connection from the Default profile to a
  second profile with different rules, then retry a tool call
- **Expected**: The connection now operates under the second profile's
  rules (verify via `get_my_permissions` — different key label/rules), and
  appears under that profile's tab

### A6: get_my_permissions shows correct data
- Call `get_my_permissions` on an attached connection
- **Expected**: Shows connection ID, nickname, proxy key label, accessible
  emails, applicable rules

### A7: Blocked connection rejected
- Detach/block an attached connection in the dashboard, then retry tool call
- **Expected**: "🚫 This connection has been blocked by the user."
- **Note**: on an attached agent card the control is labelled **"Detach"**;
  it posts the same `block` action

### A8: Unblocked connection restored
- Unblock a blocked connection, then retry tool call
- **Expected**: Tool works again, connection back under Connected Agents for
  its profile
- **Note**: blocked agents appear on every profile tab (a blocked connection
  has no key binding to scope it by). The control is **"Unblock into this
  profile"** and re-binds the connection to whichever profile tab you are on

### A9: Nickname editing works inline
- Click the agent name on an attached card, edit, press Enter (Escape cancels)
- **Expected**: Updates immediately, persists on refresh

### A10: Two agents see different permissions
- Two separate DCR clients attached to different profiles
- **Expected**: Each agent sees only its own connection, rules, and email
  access

### A11: Revoked or expired keys still cut off attached connections
- Revoke (or expire) the proxy key behind an attached connection, then retry
  a tool call
- **Expected**: Blocked — auto-attach does not weaken the key-liveness check
  from the directory-readiness refactor. Since 2026-10-09 the refusal names
  the cause: "🚫 This connection has been blocked: the agent profile it was
  attached to was revoked." followed by a dashboard link (still 🚫 /
  `denied_by_policy`, not an error)

### A12: Profile-addressed URL binds a new connection to that profile
- Create (or reuse) a non-default profile; connect a NEW DCR client via
  `/api/mcp/<slug>` where `<slug>` is the profile label slugified
  (lowercase, non-alphanumerics → `-`, e.g. "All Access" → `all-access`)
- Discovery must work per-URL first: unauthenticated POST to
  `/api/mcp/<slug>` returns 401 whose `resource_metadata` points at
  `/.well-known/oauth-protected-resource/mcp/<slug>`, and that document's
  `resource` is the full URL including the slug (the RFC 9728 probe form
  `/.well-known/oauth-protected-resource/api/mcp/<slug>` serves the same
  document)
- **Expected**: After OAuth, the connection appears in the dashboard already
  bound to the slug's profile — no dashboard step. An unknown slug (typo or
  revoked profile) still connects but binds to the Default profile

### A13: Profile-addressed URLs never rebind an existing connection
- Take an attached connection bound to profile X and send its requests to
  profile Y's URL (same bearer token, different slug)
- **Expected**: The connection stays bound to X — the slug applies only when
  a connection is first created; rebinding remains a dashboard-only action
  (A5)

### A14: A connection on a revoked profile stays visible and can be re-attached
- **Never revoke the profile bound to the stored QA bearer's connection**
  (`scripts/qa-mcp-token.ts`). Create a throwaway profile, bind a SECOND
  connection to it (A12 profile URL or A5 reattach), then revoke the
  throwaway profile from its tab ("Revoke key" → "Confirm revoke")
- Visit every profile tab (and `/dashboard` with no active profile, if
  reachable without touching the QA bearer's profile)
- **Expected**:
  - The connection is listed in Connected Agents on EVERY profile tab with a
    "Profile revoked" badge, the revoked profile's name and revocation time,
    and "Attach to this profile" / "Block" actions; a warning banner reads
    "1 agent lost its profile" and its button scrolls to that card
  - `GET /api/connections` returns it with `state: "profile_revoked"` and
    `revokedProfile.revokedAt` set; `status` is unchanged (`approved`)
  - The "connected with safe defaults" banner no longer counts it, and when
    it shows for other connections its review link points at a tab whose
    Connected Agents card lists them ("below" only on that tab)
  - MCP tool calls on it return the A11 profile-revoked refusal
  - "Attach to this profile" on an active tab restores tool calls on the
    next request with that profile's permissions — no new OAuth/DCR
  - Attaching through `POST /api/connections` to a revoked profile id is
    refused with 409

