# Revoked profile orphans its connections — v1

Branch: `claude/revoked-key-orphaned-connections` (ADR-002 feature branch, no PR;
one `[preview]` opt-in for the signed-in UI pass).
Found by: full hosted-MCP QA regression 2026-10-09, train `integration/2026-10-08`
(PR #199) — key lifecycle A1/A2 and connection lifecycle A11.

## Problem

Revoking an agent profile sets `proxy_keys.revoked_at` and leaves every
`agent_connections` row bound to it at `status = 'approved'`. The MCP route
correctly refused those connections (key-liveness check → "blocked by the
user"), but the dashboard:

- listed approved connections only on their own profile's tab
  (`c.status === 'approved' && c.proxyKeyId === profileId`), and a revoked
  profile has no tab — so the connection was on no page at all;
- still counted it in the "connected with safe defaults" banner, whose
  "Review or block it below" pointed at a card that did not list it (that
  card only lists the ACTIVE tab's agents, so "below" was also false for
  any connection on another tab);
- offered no re-attach path; re-running OAuth reuses the same
  `(user, client_id)` row, so the client was lost for good.

Second finding (key lifecycle A2): no rendered page showed a revoked profile with
its timestamp — the legacy `KeyControls` list that had it is no longer rendered
by the profile UI. **Decision: the spec is right, the UI was wrong** — revocation
is an audit event; the timestamp belongs on the page.

## Design

Derive state instead of rewriting rows: `src/lib/connectionState.ts`

- `connectionState(conn, keysById)` → `pending | approved | blocked | profile_revoked`;
  `profile_revoked` = row approved but key revoked, expired, deleted (SET NULL)
  or unknown. Deriving covers every connection orphaned before this fix with no
  backfill and no schema change.
- `isKeyLive(key)` — the one liveness rule, now shared by the MCP route,
  `cli-token`, and `/api/connections`.
- `reviewTarget(recent, activeId)` — "below" only when the active tab lists
  every recent connection; otherwise the tab to link to.

Surfaces:

| surface | change |
| --- | --- |
| `GET /api/connections` | adds `state` and `revokedProfile {label, revokedAt, expiresAt}`; `status` unchanged |
| `POST /api/connections` approve | 409 when the target profile is revoked/expired (attaching there was a silent dead end) |
| Connected Agents card | `profile_revoked` connections on EVERY tab: "Profile revoked" badge, old profile name + revocation time, Attach to this profile / Block |
| no-active-profile view | lists orphaned agents (display-only) with "create a profile, then attach" |
| banners | new "N agents lost their profile" warning; safe-defaults banner counts live connections only and links to the right tab |
| revoked profiles | collapsible "N revoked profiles" card on every dashboard page: struck-through label, Revoked badge, date + time |
| MCP refusal | `profile_revoked` reason: "🚫 This connection has been blocked: the agent profile it was attached to was revoked." + dashboard link (still 🚫 / `denied_by_policy`) |
| `cli-token` | no longer hands out a revoked key; returns `profile_revoked` 403 with the dashboard link |
| revoke confirm copy | says agents move to "Profile revoked" until re-attached |

Out of scope: rolling a key (`rollProxyKey`) also revokes the old key and so also
orphans its connections into `profile_revoked` — now visible and one-click
re-attachable, but auto-moving them onto the new key is a separate behaviour
change (flagged for follow-up).

## QA

- Connection lifecycle **A14** (new): visible on every tab, API `state`, banner
  link truthful, MCP refusal text, re-attach restores calls without new OAuth,
  409 on attaching to a revoked profile. Never revoke the profile bound to the
  stored QA bearer's connection (`scripts/qa-mcp-token.ts`) — use a throwaway
  profile + second connection.
- Connection lifecycle **A11**: refusal text updated.
- Key lifecycle **A2**: expected location made concrete (revoked-profiles card,
  rendered text, date AND time).

## Validation log

- `tsc --noEmit` clean; `npm run mcp:lint` green incl. new
  `scripts/test-connection-state.ts` (19 checks).
- Local: dev server on Neon branch `claude-revoked-key-orphaned-connections`
  compiles; `/api/connections` and `/api/mcp` 401 unauthenticated, no server
  errors. Signed-in local dashboard is not drivable in this environment (pane
  refuses localhost), so the UI pass runs on the `[preview]` deployment.
- Preview: _pending_
