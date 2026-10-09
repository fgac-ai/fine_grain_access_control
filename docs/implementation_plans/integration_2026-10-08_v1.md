# Integration train 2026-10-08: OpenClaw + Hermes clients and setup guides, temporary-key reachability ping, neonctl retries (v1)

Branch: `integration/2026-10-08` (from `origin/main` at `4c9119a`, the #195 merge).
Architecture: `docs/adr/002_integration_trains.md` (seventh train).
Sidebar group: `Train 2026-10-08`.

## Candidate table (the selection Ken approved, 2026-10-08)

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #196 | Names OpenClaw and Hermes clients; the Python MCP SDK UA is no longer a scanner; serves the RFC 9728 PRM path `/.well-known/oauth-protected-resource/api/mcp` | OpenClaw probes that path on every login (it 404'd, and one fetch hit its 60 s timeout); Hermes read as a crawler | 0 prod users of either client today; this gates the listings | Local + own preview: both real clients end to end, `mcp-auth-probe` 4/4 | Yes, lands first |
| `claude/agent-ecosystem-listings` | `/openclaw` and `/hermes` setup guides, ClawHub skill, Hermes catalog staging | Listing assets; publication gated on #196 | New install path from two agent ecosystems (vendor publication stays an owner action) | Local only (plan v3) | Yes, after #196 |
| #197 | `GET|HEAD /api/proxy/ping` and a ping-first temporary-key recipe | 56 of 111 claude-code keys (7 d) never used, 54 of the 66 never-used on 18 accounts where no key ever worked (inferred: sandbox blocks fgac.ai) | Walled sandboxes stop minting dead keys and fall back to windowed reads; target never-used < 20% (§7.34) | Unit, `mcp:lint`, `tsc`; preview pending | Yes |
| `claude/neonctl-transient-retry` | Retry transient neonctl failures; stop blaming auth | Prune/db:branch die on blips with a misleading diagnosis | Tooling only | Unit (`test-neonctl-runner`) | Yes |
| #194 | ChatGPT plugin packet + explicit tool hints + challenge route | Directory prep | Hints change runtime behaviour for every client; submission still blocked (generic API tools, reviewer sign-in) | Unit, `tsc` | No: hold. Its RFC 9728 route duplicates #196's (take #196's, proven with real clients); rebase without the route when the ChatGPT tool set is decided |
| Muse packet | Docs only | — | None at runtime | n/a | Not taken |
| `great-dhawan-c05848` | Capability 21 draft + plans (09-24) | Likely superseded by the Drive tree work | None | n/a | No: stale |
| #188 | Drive card override count | Already shipped in #193 | — | — | No: close as shipped |
| #121, #72 and two August branches | Old growth / sheets / QA-guard work | Far behind `main` | — | — | No: stale |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #196 | `claude/mcp-client-openclaw-hermes` | none | — |
| listings | `claude/agent-ecosystem-listings` | none | — |
| #197 | `claude/temp-key-never-used` | none (auto-merged `src/app/api/mcp/route.ts`, `docs/analytics.md`, `docs/monitoring.md` with #196) | — |
| neon | `claude/neonctl-transient-retry` | `package.json` | union of the `mcp:lint` chains (adds `test-neonctl-runner` to `main`'s chain, which already had `test-google-reconnect-url`) |
| train fix | — | — | `scripts/lib/neonctl.ts`: two `no-explicit-any` lint errors from the neon branch removed (typed catch; JSON default generic) |

## Registries after landing

- Capability 23 (temporary keys): **A14** added by #197 (next free after A13). No collisions.
- No migrations.
- `mcp:lint`: adds `test-neonctl-runner` (#196's `test-mcp-client-class` cases and #197's
  `test-temporary-api-keys` cases ride existing entries).

## Validation

- **Unit (train head):** `tsc --noEmit` clean; `npm run mcp:lint` exit 0; eslint clean on every
  changed `.ts/.tsx` file (the remaining repo-wide eslint errors are pre-existing on `main`:
  `qa-dcr-setup.ts`, `ApprovedSettling.tsx`, `useGooglePicker.ts`).
- **Preview + QA:** pending. Scope:
  - capability 23 (temporary keys) A1, A11, A12, and the new **A14**: unauthenticated ping
    returns `fgac-proxy-ok`; authenticated ping reports valid / expired / revoked and emits
    `temp_api_key_pinged`; no Google call (#197);
  - hosted MCP discovery: `mcp-auth-probe` against the preview, including the RFC 9728 path
    (200), plus a `list_accounts` + `gmail_list` smoke through a real client (#196);
  - `/openclaw`, `/hermes`, `/setup` render (light + dark, phone width), copy buttons work,
    no console errors (listings);
  - neon: covered by unit tests only (tooling, not deployed).
- **Not testable before production:** the Hermes CIMD naming path (prod Clerk only), as noted
  in #196.
