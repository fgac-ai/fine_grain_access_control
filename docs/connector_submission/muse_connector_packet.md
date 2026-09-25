# Meta Muse Connector Platform — Submission Packet (paste-ready)

> **Status (2026-09-25): packet ready, NOT submitted.** The form at
> https://muse.ai/platform opens only for a signed-in Muse account (Muse is
> US-only, 18+), and its three attestations are the owner's to tick. Nothing
> here submits itself. Public repo: no credentials or private addresses in this
> file — placeholders in `<ANGLE_BRACKETS>` are filled from 1Password at
> submit time.

| File | What it is |
|---|---|
| this document | every form field in order, with the value to paste and the decision points |
| `muse_submission.json` | the same values keyed like the form's submit payload (`createConnectorSubmissionAction`) |
| `public/logo-512.png` | the icon: 512×512 PNG, 52 KB (the form wants 512×512 PNG or SVG, ≤ 256 KiB); rendered from `public/logo-400.png`; served at `https://fgac.ai/logo-512.png` once this branch deploys |
| `reviewer_runbook.md` | the reviewer Google account (fixtures, rules) built for the Claude directory — reused for Meta's end-to-end test |
| `listing_copy.md` | the Claude directory copy this packet was adapted from |

## How Muse's form works (researched 2026-09-25)

- Meta opened the platform on 2026-09-18. It is a hosted web form, no manifest,
  no repo PR. Three steps: **Overview → Technical specs → Review**. Field rules
  below were captured from the live form by two other submitters on 2026-09-19
  and 2026-09-22 (KaiCalls, Arni Labs) and match Manufact's walkthrough:
  name ≤ 80 chars, company ≤ 120, http(s) URLs, HTTPS endpoint, icon 512×512
  PNG/SVG ≤ 256 KiB, connection type *Raw API* or *Existing MCP*, auth
  multi-select *API keys* / *OAuth with PKCE* / *Other*. One packet also
  recorded a ≤ 160-char short-description field; if the form shows it, use
  the one below, otherwise that sentence opens "Anything else?".
- Review: "functional, security, and legal requirements" plus end-to-end
  testing; editors pick featured placement by usage. Meta's welcome email of
  2026-09-24 said over 2,000 submissions in the first days, a developer
  portal "in the coming days", onboarding "in waves over the coming weeks".
  No SLA, fee or revenue share is published.
- **Muse Connector Terms** (`https://muse.ai/platform/terms`) render only when
  signed in — read them at submit time; nobody on our side has seen them.
- **Gmail and Google Workspace are already listed** (Gmail read with send as a
  separate permission; Calendar, Docs, Drive, Sheets, Slides, Forms,
  Contacts, Tasks). Our copy therefore leads with what those connectors do
  not do: several accounts, delegated inboxes, per-sender / label / content
  rules, one-click approvals, editing limited to chosen files.

## Step 1 — Overview

**Connector name** (≤ 80) — DECISION 1
> `FGAC.ai — Multiple Gmail Accounts, Sheets, Docs & Slides`

Alternative: plain `FGAC.ai` (the Claude directory name). The long form
matches the MCP Registry title and cursor.directory listing; "Gmail" is
descriptive use, not the connector's own name (registry rule).

**Company or developer** (≤ 120)
> `FGAC.ai`

**Product website**
> `https://fgac.ai`

**Short description** (≤ 160, only if the form shows the field)
> `Connect Muse to several Gmail accounts and let it edit only the Google Sheets, Docs and Slides you choose, under rules you set per account.`

**Example prompts** (one per line; the form has no count limit — trim to
six if it does)
```
Summarize my unread email across my work and personal Gmail.
Check my school inbox for anything from the registrar this week.
Reply to my landlord's last email and say Tuesday afternoon works.
Add today's expenses as a new row in the Tracking tab of my Budget spreadsheet.
Update my job-applications sheet: set Acme's status to "interview".
Fix the typos in my cover letter Google Doc and tighten the first paragraph.
Add a closing slide with next steps to my project presentation.
Read the support inbox my teammate shared with me and list what needs a reply today.
```

**Connector icon**
> upload `public/logo-512.png` (512×512 PNG, 52 KB)

**Payments** — DECISION 3
> **Does not accept payments.** The Free plan is free; the Pro plan
> ($5 / month per person, `https://fgac.ai/pricing`) is billed by FGAC on
> fgac.ai, never inside Muse, so Muse's Stripe Link path is not used.

**Your name**
> `Ken Yesh`

**Work email** (the form asks for a company address)
> `<YOUR_WORK_EMAIL>` — your @fgac.ai address (kept out of this file by the
> repo's email guard)

**Support email or URL**
> `support@fgac.ai`

**Privacy policy**
> `https://fgac.ai/privacy`

**Terms of service**
> `https://fgac.ai/terms`

**Anything else?**
> paste the block under **"Anything else?" block** below

## Step 2 — Technical specs

**Connection type**
> `Existing MCP`

**Hosted MCP endpoint** (HTTPS)
> `https://fgac.ai/api/mcp`

**API or MCP documentation**
> `https://fgac.ai/docs`

**Access requirements**
> Free for occasional use, no card required; a Pro plan ($5 / month per
> person) is listed for regular use at https://fgac.ai/pricing. Needs a Google
> account (personal Gmail or Google Workspace). Sign-in and Google consent
> happen inside the connect flow; there is no separate FGAC sign-up. Right
> after connecting, the agent can read that account's mail. Sending email,
> editing spreadsheets, docs or slides, and reading other people's inboxes
> stay off until the account owner turns them on in the FGAC dashboard or
> approves the one-click link that a denied request returns. Available
> worldwide; the only region limits are Google's. No published rate limits
> beyond Google's own API quotas.

**Authentication methods** (multi-select)
> ☑ **OAuth with PKCE**
> ☐ API keys — leave unticked: the MCP endpoint accepts OAuth access tokens
> only (`sk_proxy_` keys work on the REST proxy, not on `/api/mcp`)
> ☑ Other, text: `OAuth 2.1 with dynamic client registration (RFC 7591) and Client ID Metadata Documents. A pre-registered static client id and redirect URI for Muse's callback host can be issued on request via support@fgac.ai.`

## "Anything else?" block

Paste verbatim (the short description opens it in case the form has no
separate description field):

> Connect Muse to several Gmail accounts and let it edit only the Google
> Sheets, Docs and Slides you choose, under rules you set per account.
>
> FGAC.ai is a permission layer between Muse and Google. Muse's built-in
> Gmail connector covers one account with a read/send switch. FGAC adds what
> people ask for next: several Gmail accounts in one place (work, school,
> personal); inboxes other people delegate to you from their own dashboard
> (a boss's or a team inbox, no password sharing); and Google Sheets, Docs
> and Slides that Muse can edit only on the files you pick. Every request
> passes a rule engine before it touches Google: deny by default, read-only
> on connect, no deletion ever, read rules that hide sensitive mail (2FA
> codes, password resets, bank alerts) by label or content pattern, send
> whitelists per recipient or domain, and one-click approvals when the agent
> needs more. Each account and each delegation keeps its own rules and is
> revocable in one click.
>
> Technical notes for review:
> - Hosted remote MCP server, Streamable HTTP (JSON-RPC 2.0 over POST) at
>   https://fgac.ai/api/mcp. In production since August 2026; listed in the
>   Claude connector directory (https://claude.ai/directory/connectors/fgac-ai)
>   and the official MCP Registry as ai.fgac/fgac.
> - OAuth 2.1: authorization code + PKCE S256, refresh tokens, dynamic client
>   registration (RFC 7591), Client ID Metadata Documents. Authorization
>   server https://clerk.fgac.ai; metadata at
>   https://fgac.ai/.well-known/oauth-authorization-server; protected-resource
>   metadata at https://fgac.ai/.well-known/oauth-protected-resource/mcp.
>   Unauthenticated requests return 401 with WWW-Authenticate
>   resource_metadata. A static client id and redirect URI for Muse's
>   callback host can be issued on request.
> - 21 tools, each titled and annotated (readOnlyHint, destructiveHint,
>   idempotentHint, openWorldHint); inventory at
>   https://fgac.ai/.well-known/mcp/server-card.json. Read tools run without
>   friction; write tools are rule-checked; a denied call returns a one-click
>   approval link, never a silent failure. Deletion is not possible through
>   the connector.
> - Data: FGAC calls Google's APIs only with the user's own Google OAuth
>   grant and applies that user's rules. Nothing is stored beyond what the
>   rules need and nothing is used for training. Privacy:
>   https://fgac.ai/privacy.
> - End-to-end test account: a reviewer Google account with fixtures is ready
>   (ordinary mail, one message with a verification code that a read rule
>   blocks, one message labelled Confidential that a label rule blocks, an
>   editable "Team Budget (Demo)" spreadsheet, and a send whitelist that
>   allows exactly one recipient, support@fgac.ai). <CREDENTIALS_LINE>
>   Suggested script after connecting: "Summarize my unread email" (two
>   fixtures are blocked and the reply names the rule); "Read the email about
>   my verification code" (denied); "Email support@fgac.ai that the review
>   test succeeded" (sends); "Email anyone@example.com hello" (denied, with
>   an approval link, nothing sent); "Append a row to the Tracking tab of the
>   Team Budget spreadsheet: today, 42" (succeeds); "Request permission to
>   send email to demo@example.com" (returns an approval link and states
>   nothing is granted until the owner approves).

`<CREDENTIALS_LINE>` — DECISION 2, pick one:

- **On request** (default, keeps a Google password out of a free-text
  field): `Credentials are available on request from support@fgac.ai and
  are sent within one business day.`
- **Inline** (what the Claude directory submission did; fastest review):
  paste the Step 1 block from `reviewer_runbook.md` Part 2 with the real
  `<REVIEWER_EMAIL>`, `<REVIEWER_PASSWORD>` and `<1PASSWORD_2FA_LINK>` from
  1Password (vault `FGAC`, item `connector-reviewer`). The 2FA link mints
  live codes — it goes into Meta's form and nowhere else.

## Step 3 — Review

Three required attestations, owner only:

1. *I confirm I'm authorized to submit this connector and its brand assets.*
2. *I understand that submission doesn't guarantee approval and promotion is
   based on usage and editorial discretion.*
3. *I agree to the Muse Connector Terms.* — read `muse.ai/platform/terms`
   first; it only renders signed in.

Then **Submit for review**. Save the confirmation email (Meta replied to
other submitters within minutes: "We'll review … and get in touch").

## Owner checklist before pressing submit

- [ ] Signed in to Muse (US account) — the form is behind Muse sign-in.
- [ ] DECISION 1 name, DECISION 2 credentials line, DECISION 3 payments (no).
- [ ] Real work email typed into the form (not in this file).
- [ ] Reviewer account still works: sign in at fgac.ai/dashboard as the
      reviewer account and confirm the "Team Budget (Demo)" exposure and the
      three rules from `reviewer_runbook.md` Part 1 step 4 are still there
      (a fresh copy of main is not involved — this is production).
- [ ] **Dry run inside Muse** (recommended, and the one thing nobody has
      verified): from the same Muse account, add a *custom connector* to
      `https://fgac.ai/api/mcp`, described as a remote MCP server over
      streamable HTTP. Muse's client should hit the 401, read the resource
      metadata, register a client dynamically and open our Clerk consent in
      its VM browser. If consent completes and `list_accounts` returns the
      reviewer account, Meta's end-to-end test will pass the same way. If
      the OAuth leg stalls, that is the finding under **Known gaps** below —
      submit anyway, and tick "Other" to say a static client can be issued.
- [ ] Upload `public/logo-512.png`.
- [ ] After submit: date + status in `docs/growth-channels.md` ledger; keep
      the confirmation email; watch for the developer-portal invite.

## What was verified live on 2026-09-25

| check | result |
|---|---|
| `POST https://fgac.ai/api/mcp` without auth | 401, `WWW-Authenticate: Bearer … resource_metadata="https://fgac.ai/.well-known/oauth-protected-resource/mcp"` ✓ |
| `/.well-known/oauth-protected-resource/mcp` | resource `https://fgac.ai/api/mcp`, AS `https://clerk.fgac.ai` ✓ |
| `/.well-known/oauth-authorization-server` | authorize / token / `registration_endpoint` present, PKCE `S256`, `client_id_metadata_document_supported: true`, grants: authorization_code, refresh_token, device_code ✓ |
| `/.well-known/mcp/server-card.json` | `ai.fgac/fgac` v0.1.1, 21 tools ✓ |
| `/privacy`, `/terms`, `/docs`, `/logo-400.png` | all 200 ✓ |
| icon | `public/logo-512.png` 512×512, 52 KB (≤ 256 KiB) ✓ |
| Muse / Meta client traffic on fgac.ai to date | none; only `musedirectory.ai-scout/1.0` (independent site) read our OAuth metadata on 2026-09-23 |

## Known gaps and risks

- **OAuth in Muse's VM.** Muse's own write-up of custom connectors says
  API-key auth is the smooth path and OAuth "may still work through Muse's
  browser, but expect more back and forth". Our endpoint is OAuth-only. If
  the dry run or Meta's test cannot finish consent, the fix is an API-key
  bearer path on `/api/mcp` (not built; `verifyMcpAuth` in
  `src/app/api/mcp/route.ts` takes Clerk tokens only) or a static client
  registered against Muse's callback host — decide after the dry run, not
  before.
- **Google 2FA on the reviewer account.** A Google sign-in from Meta's
  datacenter browser will likely trigger the challenge; the 1Password 2FA
  share link (inline option) or a same-day reply (on-request option) covers
  it.
- **Vercel firewall.** Muse's egress IPs are unknown. If Meta reports a
  challenge page, check the Vercel firewall log for the review window.
- **Directory competition.** Meta's own Gmail / Workspace connectors sit in
  the same directory. The listing's job is the multi-account, delegation and
  rules story, not "Gmail".

## musedirectory.ai (independent, not Meta) — optional listing

Their scout crawls the official MCP Registry, read our OAuth metadata on
2026-09-23 and did **not** list us; a search for "fgac" returns nothing.
`https://musedirectory.ai/submit` health-checks the endpoint on submit ("if
the endpoint responds to an MCP handshake"), which an OAuth-protected server
answers with a 401 plus resource metadata — if their check wants an
unauthenticated `initialize`, expect a follow-up by email. Free, live within
a day if it passes.

| field | value |
|---|---|
| Connector name | `FGAC.ai — Multiple Gmail Accounts, Sheets, Docs & Slides` |
| MCP endpoint (HTTPS) | `https://fgac.ai/api/mcp` |
| Developer / company | `FGAC.ai` — `https://fgac.ai` |
| Category | Productivity (Email if the list has it) |
| Muse status | pick the option closest to "submitted to Meta's directory / works as a custom connector" — after the dry run |
| Authentication type | OAuth |
| Pricing tier | Free (Freemium if offered — a paid Pro plan exists) |
| Tagline | `Several Gmail accounts, and only the Sheets, Docs and Slides you choose` |
| Description (≤ 600) | `FGAC.ai connects Muse to several Gmail accounts at once — work, school, personal, and inboxes teammates delegate to you — and lets it edit only the Google Sheets, Docs and Slides you pick. Every request passes a rule engine first: read-only on connect, no deletion, sensitive mail hidden by label or pattern, send whitelists, and one-click approvals when the agent needs more. Free for occasional use.` |
| Contact email | `support@fgac.ai` |

## Sources

Meta: https://muse.ai/platform · https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ ·
form fields as captured by other submitters: https://github.com/KaiCalls/kaicalls-mcp/pull/5 ·
https://github.com/arni-labs/katagami/pull/386 · walkthrough: https://manufact.com/blog/submit-mcp-server-to-muse ·
connector list: https://postfa.st/blog/meta-muse-connectors-list · custom connectors:
https://parallel.ai/articles/meta-muse-custom-integrations · directory: https://musedirectory.ai/about
