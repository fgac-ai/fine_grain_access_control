# OpenClaw + Hermes Agent — real-client connection QA (v2)

Branch: `claude/mcp-client-openclaw-hermes` · 2026-10-07 · supersedes v1

## Goal

Before publishing ClawHub and Hermes `optional-mcps/` listings (branch
`claude/agent-ecosystem-listings`), prove a real OpenClaw and a real Hermes
Agent can discover, OAuth (MCP auth discovery + Clerk DCR), and call a tool on
`/api/mcp`, and that analytics names both.

## Environment used

- Local dev server via `preview_start fgac-dev` (autoPort → :55171; dev Clerk
  `pumped-quetzal-63`; Neon branch `claude-mcp-client-openclaw-hermes`, created
  on the 5th `db:branch` attempt — Neon's API took >60 s per call that hour).
- **Clients ran natively on the host, not in the 04_openclaw Docker container.**
  Docker Desktop here is 20.10 (no Mac host networking) and no `openclaw:local`
  base image exists, so the container would need a from-source image build and
  still could not receive a 127.0.0.1 loopback callback from the host browser.
  Isolated installs under the session scratchpad keep the loopback on the host:
  - OpenClaw **2026.9.8** (npm; needs Node ≥24.16 → Node 24.21), `HOME` isolated.
  - Hermes Agent **@ 8e85a0fd** (git; needs Python ≥3.14 → uv-managed 3.14,
    `uv sync --frozen --extra mcp`), `HERMES_HOME` isolated.
- Consent: qa-setup-driver runner, USER_A, built-in pane (it DOES reach
  127.0.0.1 loopbacks). Path B CDP Chrome's Google session has lapsed (password
  prompt) — needs a human re-sign-in before it is usable again.
- Tool calls: no model API key on this host, so each client's OWN MCP runtime
  was driven directly (OpenClaw `createSessionMcpRuntime(...).callTool` — the
  runtime `mcp probe` and agent turns use; Hermes `discover_mcp_tools` +
  `registry.dispatch` — the handler an agent turn dispatches). Transport,
  OAuth provider, token store and refresh are the clients' own; only the LLM
  turn is skipped.

## Results

| Step | OpenClaw 2026.9.8 | Hermes 8e85a0fd |
| --- | --- | --- |
| add server | PASS `openclaw mcp add fgac --url …/api/mcp --transport streamable-http --auth oauth` | PASS `mcp_servers.fgac {url, auth: oauth}` |
| discovery | PASS — follows 401 `resource_metadata`; ALSO probes `/.well-known/oauth-protected-resource/api/mcp` (404 before this branch; one such fetch hit its 60 s timeout) | PASS — follows header |
| DCR | PASS, `client_name` "OpenClaw MCP", auth method none | PASS, "Hermes Agent" (dev Clerk has no CIMD → DCR fallback; re-registers on every login) |
| redirect URI | `http://127.0.0.1:8989/oauth/callback`, accepted first try | `http://127.0.0.1:27890/callback` |
| authorize params | no `scope`, no `resource` (Clerk still granted `profile email offline_access`) | `resource`, all scopes + `offline_access`, `prompt=consent` |
| consent + callback | PASS on retry (first try missed its ~2 min window) | PASS on retry (~5 min window) |
| `mcp probe` / `mcp test` | PASS, 22 tools | PASS, 22 tools |
| `list_accounts` | PASS | PASS |
| `gmail_list` | PASS | PASS |
| token refresh (expiry back-dated in the client's own store) | PASS, new access token | PASS, new access token |
| audience (`mcpAudience.ts`) | no issue — Clerk tokens carry no `aud` | no issue |

## Identification strings (dev PostHog)

| | OpenClaw | Hermes |
| --- | --- | --- |
| DCR `client_name` | OpenClaw MCP | Hermes Agent |
| `clientInfo` | `openclaw-bundle-mcp` 0.0.0 | `mcp` 0.1.0 (Python SDK default) |
| UA, MCP requests | `undici` | `python-httpx2/2.7.0` |
| UA, discovery | `undici` | `Hermes-Agent/unknown` (git install, no version) |
| client_id (prod) | opaque DCR id | CIMD URL `https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json` (prod Clerk advertises `client_id_metadata_document_supported: true`; doc lists 127.0.0.1/localhost :27890–27894) |
| class BEFORE | `direct`, unlabelled | **`scanner`** (`ua:python-httpx2/`) on tokenless rows; tool calls named `mcp` |
| class AFTER | `direct` / `product:openclaw` | `direct` / `product:hermes` (UA, names, or CIMD client_id); tool calls named `hermes-agent` on prod CIMD connections |

Prod baseline (30 d): zero authenticated rows for either client; `python-httpx2/`
matched 168 tokenless discovery rows + 3 invalid tokens, no authenticated row.

## Fixes on this branch

1. `/.well-known/oauth-protected-resource/api/mcp` — RFC 9728 path-insertion
   location for the base resource (the `[slug]` variant already existed).
   Auth probe gains `oauth-resource-metadata-rfc9728-path`.
2. `classifyMcpClient` — `PRODUCT_CLIENTS` gains openclaw and hermes, with an
   optional `clientIdPrefixes` match; `python-httpx2/` moves from scanner
   prefix to stock runtime (it is the MCP Python SDK's transport now).
3. `productClientName` — an SDK-default name (`mcp`) on a VERIFIED client_id
   matching a product's CIMD URL becomes the product's name for the
   connection row and its tool calls; raw report kept as
   `client_name_reported` on `mcp_client_initialize`.
4. Tests: `scripts/test-mcp-client-class.ts` (product signals, httpx2 no
   longer scanner, productClientName, structural wiring). Docs: analytics.md,
   monitoring.md.

## Known limits

- The CIMD naming path (3) cannot run before production: dev Clerk (local and
  previews) has no CIMD, so Hermes registers via DCR there and its tool calls
  stay `mcp`. Unit-tested + typechecked only.
- A Hermes user on an AS without CIMD (or `cimd: false`) stays `mcp`; naming
  those would need a Clerk OAuth-application lookup by client_id (follow-up).

## After deploy — how to read it

```sql
SELECT properties.client_class_signal, count(), uniq(distinct_id)
FROM events
WHERE event IN ('mcp_auth_attempt','connector_install_started')
  AND properties.client_class_signal IN ('product:openclaw','product:hermes')
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY 1
```
and `$mcp_tool_call` by `properties.client_name IN ('openclaw-bundle-mcp','hermes-agent','mcp')`.
Before = 0 for both.
