# Meta Muse Connector Platform — submission prep (v1, 2026-09-25)

Branch `claude/facebook-muse-marketplace-42e936`. Docs and one asset; no
runtime code changes.

## Question and answer

Ken asked whether FGAC should be published on Meta's marketplace for agent
tools. Meta's Muse (consumer personal agent, launched 2026-09-08, US-only,
~2.5M downloads in 13 days) opened a reviewed connector directory on
2026-09-18 at muse.ai/platform. Assessment: worth a submission — Muse is the
first non-Claude surface whose audience (consumer, free, phone-first) matches
ours; every developer-tool listing so far (Smithery, Cursor, MCP registry,
Grok) has produced one user in total. Expectations are low: Gmail and the
Google Workspace apps are already in Muse's directory, no Muse client has
ever touched fgac.ai, and Meta has 2,000+ submissions queued with no SLA.
Ken's decision: prepare everything so only the final submit click is his.

## Deliverables

| item | path |
|---|---|
| Paste-ready packet: every form field in order, decision points, owner checklist, live verification, risks, plus the independent musedirectory.ai listing | `docs/connector_submission/muse_connector_packet.md` |
| Same values keyed like the form's submit payload (as two other submitters captured it) | `docs/connector_submission/muse_submission.json` |
| Icon meeting Meta's rule (512×512 PNG/SVG, ≤ 256 KiB): 52 KB, rendered from `logo-400.png` with Pillow (Lanczos upscale, 256-colour quantise — the RGBA render was 282 KB) | `public/logo-512.png` |
| Ledger rows + attribution note | `docs/growth-channels.md` |

## What was verified live (2026-09-25)

Unauthenticated `POST /api/mcp` → 401 with `resource_metadata` pointing at
`/.well-known/oauth-protected-resource/mcp`; authorization-server metadata
advertises DCR, PKCE S256 and CIMD; server card lists 21 tools; privacy,
terms, docs and logo URLs all 200. PostHog: no Muse/Meta client string on
any auth, initialize, tool-call or install event since 2026-08-25; the only
Muse-adjacent hit is `musedirectory.ai-scout/1.0` (independent site).

## Decisions left to Ken (marked in the packet)

1. Connector name: long descriptive form (matches registry title) vs plain
   `FGAC.ai`.
2. Reviewer credentials: "on request via support@fgac.ai" (default) vs inline
   in "Anything else?" as the Claude directory submission did.
3. Payments: "does not accept payments" (Pro is billed on fgac.ai).

## Open risk, deliberately not built

Muse's custom-connector path favours API-key auth; our MCP endpoint accepts
only Clerk OAuth tokens. The packet's dry-run step (add a custom connector to
`https://fgac.ai/api/mcp` from the Muse account) is the test. If consent
cannot complete in Muse's VM browser, the follow-up is either an API-key
bearer path on `/api/mcp` or a static OAuth client registered for Muse's
callback host — a separate PR after the dry run, not a guess before it.

## Validation

Docs-only change: `npm run mcp:lint` unaffected (no `server.json` or tool
change); no preview QA applies. Checked: JSON parses, field lengths
(name 56/80, short description 139/160, directory description 401/600), icon
dimensions and size, hook-safe addresses (only `support@fgac.ai` and
placeholders).
