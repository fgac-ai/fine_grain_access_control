# Connectors Directory — Listing Copy & Portal Answers (v2, keyword-first)

Draft answers for every step of the submission portal
(claude.ai/admin-settings/directory/submissions/new). Paste-ready; edit taste,
not facts. v2 rewrites the match-surface text (tagline, description, use
cases) in the phrases users actually type — connector search matches
conversation context against listing metadata, so these exact words are how
we get surfaced.

## Keyword map (phrase users say → where it appears)

| User phrase | Placement |
|---|---|
| "multiple Gmail accounts" / "work and personal email" | tagline + description sentence 1 + use case 1 |
| "check my other inbox" / "team inbox" / "boss's inbox" | description (multi-account bullet) + use case 4 |
| "update my Google Sheet" / "add rows to a spreadsheet" | tagline + description sentence 2 + use case 3 |
| "log data to a sheet" / "tracking spreadsheet" | use case 3 |
| "email assistant" / "triage my inbox" | use case 1 |
| "can't read my 2FA codes" / "safe email access" | description (guardrails paragraph) |

## Listing step

**Server name** (≤100 chars)
> FGAC.ai

**Tagline** (≤55 chars) — DECIDED (user, 2026-08-15):
> `Manage Multiple Gmail Accounts & Edit Google Sheets` (51)

**Description** (≤2,000 chars) — DECIDED (user, 2026-08-15):

> Connect Claude to Multiple Gmail Accounts, Work, School and Personal and
> let it update Google Sheets for you! Through FGAC.ai you can give Claude
> precise access to the specific sheets and senders you want.
>
> More Google Workspace Connections Coming Soon!

> **PENDING UPDATE (Google Slides support, 2026-09-17)**: the connector now
> also serves Google Slides (per-presentation rules, same `drive.file` grant,
> typed tools `slides_get_presentation`, `slides_edit`; comments via the
> existing `comments_*` pair). Tool count 19 → 21. Tagline candidate (≤55):
> `Gmail, Sheets, Docs & Slides — on your terms` (43). Blocked on the
> Google Slides API being enabled on the production GCP project — do not
> resubmit the listing before that is confirmed live.
>
> **PENDING UPDATE (Google Docs support, 2026-08-20; tool reshape
> 2026-08-23)**: the connector now also serves Google Docs (per-document
> read and full batchUpdate editing behind the same per-file rules — tools
> `docs_read_document`, `docs_edit`; `sheets_edit` and the
> `comments_read`/`comments_add` pair landed in the same reshape, and the
> plain-text `docs_append_text`/`docs_replace_text` wrappers were removed).
> The DECIDED tagline/description above predate this
> and need the owner's sign-off before resubmission. Proposed tagline
> (≤55 chars): `Gmail, Google Sheets & Docs — on your terms` (43).
> Proposed description addition: "…and let it update Google Sheets and
> Google Docs for you! … precise access to the specific sheets, docs and
> senders you want."

(Earlier keyword-first draft kept below for reference — its bullet points
remain useful raw material if the description is ever expanded; the
use-cases step still carries the remaining search-phrase clusters.)

<details><summary>Superseded draft (v2 keyword-first)</summary>

> Connect one or many Gmail accounts — work, personal, and delegated team
> inboxes — and let Claude read mail, send guarded email, and update your
> Google Sheets: read values, edit cells, and append rows on exactly the
> spreadsheets you choose.
>
> Every request passes through FGAC's rule engine before it touches Google —
> deny by default, allow on your terms:
>
> • **Instant start** — connect and your agent can read this account's mail
> immediately. It cannot send, edit, or delete anything until you say so.
> • **Multiple Gmail accounts** — teammates and your other accounts delegate
> their inboxes to your agent from their own dashboard; your agent targets
> any granted inbox ("check my work email", "summarize the support inbox").
> Every delegation keeps its own rules and is revocable in one click.
> • **Editable Google Sheets** — expose individual spreadsheets read-only or
> read & write; agents can update cells and append rows there and nowhere
> else. The rest of your Drive doesn't exist to them.
> • **One-click approvals** — when an agent needs more (a new recipient, a
> new sheet), it asks; you approve exactly that grant from a single-use
> link. No settings spelunking.
> • **Guardrails** — read rules hide sensitive mail (2FA codes, password
> resets, financial alerts) by label or content pattern; send whitelists
> limit outbound mail to recipients you approve; deletion is never possible.
>
> Under the hood: annotated read-only tools that run without friction,
> guarded write tools, and a rule-checked raw API escape hatch covering the
> full Gmail and Sheets API surface. Your data is never stored or used for
> training; see fgac.ai/privacy.
>
> Free for personal use. Connected in under a minute.

</details>

**Categories** (1-5): Productivity; Email; Spreadsheets/Data; Developer Tools
(pick what the portal's actual taxonomy offers — Productivity first).

**Documentation URL**: `https://fgac.ai/docs`
**Privacy policy URL**: `https://fgac.ai/privacy`
**Support contact**: `support@fgac.ai`

**Icon**: square PNG, 512×512, cropped from `public/logo-v2.png` (the current
brand mark — the only logo asset in the repo; older variants were removed).

**URL slug** (PERMANENT — cannot change after publication)
> Recommended: `fgac` (short, matches domain). Alternative: `fgac-ai`.

**Allowed link URIs** (optional field): one entry — `https://fgac.ai`. We
don't call `ui/open-link` today (links are plain text in tool results), but
the declaration is inert, we own the origin, and it pre-clears any future
embedded-approval-card upgrade. Never list domains we don't own.

> **MCP Registry / Smithery**: the registry manifest is `server.json` at the repo
> root (name `ai.fgac/fgac`, ≤100-char description derived from the
> tagline above); ledger and publishing steps in `docs/growth-channels.md`.

## Connection step

- Server URL: `https://fgac.ai/api/mcp` (https ✓)
- Transport: **Streamable HTTP**
- Same URL for every user: **Yes**

## Use cases step

- Primary use cases (each a distinct search-phrase cluster):
  1. **Inbox triage across accounts** — "summarize my unread email", morning
     triage across work and personal Gmail in one prompt, sensitive mail
     shielded by rules.
  2. **Guarded sending** — an email assistant that can only reply to
     recipients and domains you approve; a denied send becomes a one-click
     approval link.
  3. **Sheets logging and updates** — "append today's totals to the tracking
     sheet", "update the status column": read, edit, and append rows on
     exposed spreadsheets, read-only or read & write per sheet.
  4. **Delegated inboxes** — an EA-style agent over a boss's or team inbox,
     delegated from the owner's own dashboard with independent rules and
     one-click revocation. No password sharing.
- What users need first: nothing but a Google account — sign-in happens
  during connect, and the agent immediately gets safe read-only access to
  that account's mail. Upgrades (sending, Sheets, other inboxes) are granted
  from the dashboard or via one-click approval links. Free tier — no plan
  required.
- Reads data, writes data, or both: **Both** (reads mail/sheets; writes are
  limited to whitelisted sends and Read & Write spreadsheets).

## Company step

- Company: FGAC.ai — website `https://fgac.ai`
- Contact: pre-filled from the submitting account.

## Authentication step

- **OAuth with Dynamic Client Registration** (`oauth_dcr`) — our authorization
  server is Clerk at `clerk.fgac.ai`; DCR + PKCE S256 supported out of the box;
  discovery at `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource/mcp` (resource includes the
  `/api/mcp` path).
- Note for later: if directory traffic makes DCR client accumulation a
  problem, migrate to CIMD or Anthropic-held credentials
  (mcp-review@anthropic.com), per docs/implementation_plans/connector-approval-audit_v2.md.

## Data handling step

- The API called is **our own first-party service** (fgac.ai), which proxies
  Google's Gmail/Sheets APIs strictly on the user's own OAuth grant, applying
  the user's access rules. MCP domain (fgac.ai) = service domain.
- Personal health data: **No**. Sponsored content: **No**.

## Test & launch step

- Use docs/connector_submission/reviewer_runbook.md Part 2 verbatim, with real
  credentials filled in from 1Password.
- Attestation "you have run every tool yourself": true — QA runs exercised all
  14 tools (including request_access) through the MCP endpoint
  (docs/QA_Acceptance_Test/qa-results.json); do one final custom-connector
  pass from Claude.ai before submitting.

## Compliance step (7 acknowledgments)

All seven apply cleanly: directory guidelines ✓; first-party API ✓; no
financial transactions ✓; no AI media generation ✓; no prompt-injection
patterns in tool descriptions (linted in CI) ✓; no conversation-data
collection beyond tool needs ✓; public documentation live at fgac.ai/docs ✓.

## Pre-submission checklist (final pass)

- [ ] support@fgac.ai delivery tested with an email from an outside address
- [x] fgac.ai/docs live in production
- [ ] Reviewer account built + dry-run (reviewer_runbook.md Part 1, step 5)
- [x] Icon cropped square, 512×512 PNG (from logo-v2.png)
- [ ] No Vercel firewall/challenge rules blocking 160.79.104.0/21
- [ ] Final custom-connector smoke test from Claude.ai (all 14 tools listed
      with annotations; one read, one denied read, one send, one denied send,
      one request_access)
