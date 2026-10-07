# OpenClaw + Hermes Agent — real-client connection QA (v1)

Branch: `claude/mcp-client-openclaw-hermes` · 2026-10-07

## Goal

Before publishing ClawHub and Hermes `optional-mcps/` listings (branch
`claude/agent-ecosystem-listings`), prove a real OpenClaw and a real Hermes
Agent can discover, OAuth (MCP auth discovery + Clerk DCR), and call a tool on
`/api/mcp`, and that analytics names both.

## Environment used

- Local dev server via `preview_start fgac-dev` (autoPort; dev Clerk
  `pumped-quetzal-63`).
- **Clients ran natively on the host, not in Docker.** Docker Desktop here is
  20.10 (no Mac host networking) and the `openclaw:local` base image does not
  exist, so the 04_openclaw container would need a from-source image build and
  still could not receive a 127.0.0.1 loopback callback from the host browser.
  Native installs in isolated prefixes (scratchpad) keep the loopback on the
  host:
  - OpenClaw 2026.9.8 (npm, needs Node ≥24.16 → Node 24.21 tarball), `HOME`
    isolated.
  - Hermes Agent @ 8e85a0fd (git, needs Python ≥3.14 → uv-managed 3.14,
    `uv sync --frozen --extra mcp`), `HERMES_HOME` isolated.
- Consent driven by a qa-setup-driver runner in the built-in pane (it DOES
  reach 127.0.0.1 loopbacks; Path B CDP Chrome's Google session had lapsed).

## Observed so far

| | OpenClaw 2026.9.8 | Hermes Agent 8e85a0fd |
| --- | --- | --- |
| Discovery | follows 401 `resource_metadata`, ALSO probes `/.well-known/oauth-protected-resource/api/mcp` (404 before this branch) | follows header |
| Registration | DCR, `client_name` "OpenClaw MCP" | DCR on dev Clerk (dev AS metadata has no `client_id_metadata_document_supported`); CIMD expected on prod |
| Redirect URI | `http://127.0.0.1:8989/oauth/callback` (accepted first try) | `http://127.0.0.1:27890/callback` |
| Authorize params | no `scope`, no `resource` | `resource`, full scopes incl. `offline_access`, `prompt=consent` |
| Callback window | ~2 min | ~5 min |

## Fixes on this branch

1. `/.well-known/oauth-protected-resource/api/mcp` — RFC 9728 path-insertion
   location for the base resource (the `[slug]` variant already existed).
   Auth probe gains `oauth-resource-metadata-rfc9728-path`.
2. Classifier (`src/lib/mcpClientSignals.ts`) — pending wire strings from the
   live calls. Known from source: Hermes' content-type preflight initialize is
   `hermes-probe`, which the scanner vocabulary reads as a crawler.

## Pending

- Neon `db:branch` blocked by a slow Neon API (each call >60 s → neonctl
  gives up); tool calls wait on it.
