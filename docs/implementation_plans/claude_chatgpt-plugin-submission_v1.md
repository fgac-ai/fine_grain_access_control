# ChatGPT Plugin Directory — Submission Packet

> **Status (2026-10-06): packet ready, NOT submitted. Two items block a
> submission with a fair chance of approval** (see "Blocking gaps" below).
> Submitting, verifying identity and domain, and recording the walkthrough are
> Ken's actions. This repo is public: reviewer credentials, Ken's addresses and
> any real ids stay out of this file. `<ANGLE_BRACKETS>` are filled from
> 1Password at submit time.

| File | What it is |
| --- | --- |
| this document | requirements, gap analysis, Ken's ordered checklist |
| [`chatgpt-plugin/plugin.json`](chatgpt-plugin/plugin.json) | the upload manifest (Agent Plugins format): listing copy, 5 + 3 test cases, release notes |
| [`chatgpt-plugin/mcp.json`](chatgpt-plugin/mcp.json) | the one remote MCP server, `https://fgac.ai/api/mcp`, streamable HTTP |
| [`chatgpt-plugin/assets/logo.png`](chatgpt-plugin/assets/logo.png) | 512×512 PNG, 52 KB (spec: square, ≥ 48 px, ≤ 5 MiB) |
| [`../connector_submission/reviewer_runbook.md`](../connector_submission/reviewer_runbook.md) | the dedicated reviewer Google account and its fixtures, built for the Claude directory — reused here |

Build the upload ZIP (manifest at the archive root):

```bash
cd docs/distribution/chatgpt-plugin && zip -r ../fgac-chatgpt-plugin.zip plugin.json mcp.json assets && cd -
```

`fgac-chatgpt-plugin.zip` is a build output; do not commit it.

## 1. How OpenAI's submission works now (read 2026-10-06)

Sources: developers.openai.com/plugins — `deploy/submission`, `deploy/app-review`,
`deploy/submission-errors`, `plugin-guidelines`, `build/auth`, `reference`,
`guides/submit-claude-plugin`. help.openai.com refused automated fetches, so
plan eligibility for developer mode is unconfirmed (see step K6).

- **No web form any more.** You upload a plugin ZIP at
  https://platform.openai.com/plugins → *Upload new or existing plugin* →
  choose a verified **Developer identity**. Listing and review data come from
  `plugin.json` under `extensions.com.openai`. One plugin serves ChatGPT and
  Codex.
- **Prerequisites.** Individual or business identity verification
  (platform.openai.com/settings/organization/general); org Owner or the
  *Apps Management Write* role; a project with **global** data residency (EU
  residency projects cannot submit MCP plugins).
- **MCP connection** happens in the portal after upload (*MCPs → Connect*): auth
  type (OAuth), the **domain-verification** token served as bare plain text at
  `https://fgac.ai/.well-known/openai-apps-challenge`, an OAuth sign-in, then an
  automated tool scan. The server origin can never change for this plugin.
- **Review information**: exactly **5 positive and 3 negative test cases**, a
  **video walkthrough URL**, release notes (all in `plugin.json`), and
  **reviewer credentials** entered only in the portal's *Review details* —
  the ZIP rejects `test_credentials` / `reviewer_instructions`.
- **Reviewer account** must "work immediately without MFA approval, email or
  SMS codes, magic links, or private-network access", with sample data, and
  stay working for later reviews. Test cases must pass on ChatGPT web *and*
  mobile.
- **Screenshots are not allowed** for an MCP server without UI
  (`screenshots_not_allowed`); starter prompts replace them.
- **After approval** nothing is listed until Ken clicks **Publish plugin**.
  The directory then finds it by name or link; featuring is OpenAI's call.
  OpenAI rescans the server daily; changed tools keep the old definition until
  the new one passes; metadata changes need a new ZIP and review.
- **Timeline**: none published. Forum reports run 30–90 days, some rejections
  arrive without a reason. No fee.

### Field limits and our values

| Field | Limit | Value |
| --- | --- | --- |
| `name` | ≤ 64, lowercase-hyphen | `fgac` |
| `displayName` | ≤ 30, no "MCP"/"Plugin" | `FGAC.ai` (7) |
| `shortDescription` | ≤ 30, one line | `Guardrails for Gmail and Docs` (29) |
| `longDescription` | ≤ 4,000; tasks, users, limits; **no pricing, promotions or comparisons** | 2,252 chars, enforcement-first |
| `developerName` | ≤ 80; display comes from the verified identity | `FGAC.ai` — **must match the identity Ken verifies** (K4) |
| `category` | exactly one | `Security` — DECISION D3 |
| `capabilities` | ≤ 20 × ≤ 120 | 9 labels |
| `websiteURL` / `supportURL` / `privacyPolicyURL` / `termsOfServiceURL` | HTTPS, same publisher | `https://fgac.ai`, `https://fgac.ai/docs`, `https://fgac.ai/privacy`, `https://fgac.ai/terms` (all 200 on 2026-10-06) |
| `defaultPrompt` | ≤ 3 × ≤ 128 | 3 prompts (71 / 52 / 65) |
| `brandColor` / `brandColorDark` | ≥ 2:1 vs white / `#212121` | `#2563EB` / `#60A5FA` |
| `logo`, `composerIcon` | square ≥ 48 px, ≤ 5 MiB | `assets/logo.png` 512×512 |
| `publication.countries` | optional allowlist | omitted (worldwide; Google's own limits apply) |
| `publication.release_notes` | required | set |
| `review.demo_recording_url` | required for review | **placeholder — Ken records (K7)** |
| `review.commerce` | optional | `false` |

Support contact for the portal and the rejection-email thread: `support@fgac.ai`.

## 2. Positioning: clearing "beyond built-in" and "unofficial connector"

Gmail, Drive, Calendar and Contacts are OpenAI first-party connectors with read
and write. The guidelines reject plugins that duplicate built-in capability,
and separately say: *"We cannot approve plugins that primarily function as
unofficial connectors to third-party services, including pass-through
intermediary software layers."* FGAC is literally an intermediary in front of
Google, so the listing never sells access. It sells the layer the first-party
connector does not have:

1. recipient-restricted sending with owner approval links,
2. read-block rules that keep one-time codes and labeled mail away from the model,
3. per-file Sheets / Docs / Slides grants instead of whole-Drive access,
4. delegated and multiple inboxes, each under its own revocable rules,
5. no delete path at all.

The long description leads with "rules you set between an AI agent and your
Google account" and lists access only as "what you can ask" under those rules.
It cannot say "unlike the built-in Gmail connector" — comparisons are banned —
so the contrast is left implicit. If the review cites the intermediary rule,
the appeal argument is: FGAC calls Google's official APIs on the user's own
OAuth grant under a Google-verified OAuth client (K2), adds enforcement Google
does not offer, and its value is the policy layer, not reach.

Negative test case 1 (refusing to read out a verification code) doubles as
evidence: OpenAI forbids plugins from collecting OTP codes, and FGAC's default
rules are what stop that from happening through mail.

Rival context (directory scan 2026-08-26): Superhuman Mail and Mailopoly Inbox
sell read and write mail access; Neura Relay, AccessOwl and Bastion are
governance-adjacent and none enforces rules on Workspace calls. Nobody listed
sells *governed* Google access.

## 3. Tool review — annotations and descriptions

OpenAI requires `readOnlyHint`, `destructiveHint` and `openWorldHint` as
**explicit booleans on every tool**, read from the server scan (justification
text cannot override them). Rubric: `readOnlyHint: false` for anything that
creates, updates, sends, writes logs or starts workflows; `destructiveHint:
true` for overwrites, revocations and sends that cannot be undone;
`openWorldHint: true` for sending to external recipients, `false` for a bounded
private account.

**Fixed on this branch** (`toolAnnotations` in `src/app/api/mcp/toolDefs.ts`,
guarded by `scripts/test-openai-plugin-readiness.ts` in `npm run mcp:lint`):
read tools used to send only `readOnlyHint: true`, and most write tools no
`openWorldHint` — which the MCP spec defaults to **true**. Every tool now sends
all three:

| Tool | readOnly | destructive | openWorld | Note |
| --- | --- | --- | --- | --- |
| list_accounts, gmail_list, gmail_read, gmail_get_attachment, gmail_labels, sheets_get_spreadsheet, sheets_read_range, docs_read_document, slides_get_presentation, comments_read, get_my_permissions, google_api_get | true | false | false | |
| request_access | true | false | false | **see G4** |
| gmail_send | false | true | true | send cannot be undone, external recipients |
| google_api_modify | false | true | true | can send mail |
| sheets_update_range, sheets_edit, docs_edit, slides_edit | false | true | false | overwrites |
| sheets_append_rows, comments_add, create_temporary_api_key | false | false | false | additive |

Justifications (paste if the portal still asks — the docs contradict each other
on whether they are required): *read tools* — "Returns data from the user's own
connected Google account; changes nothing." *Overwrite tools* — "Replaces
existing content in a file the user exposed for editing; cannot be undone from
the tool." *gmail_send / google_api_modify* — "Delivers email to recipients
outside the account; delivery cannot be recalled." *Additive tools* — "Adds new
content (a row, a comment, a short-lived key scoped to this connection) without
changing or removing existing data."

Descriptions already meet the naming and accuracy rules (plain verbs, side
effects and limits stated, no instructions to prefer or avoid other tools —
lint rule 7). Remaining gaps are G1, G2, G4 and G5 below.

## 4. OAuth readiness

| OpenAI requirement | fgac.ai production (checked 2026-10-06) |
| --- | --- |
| 401 with `WWW-Authenticate: Bearer resource_metadata=…` | ✓ points at `/.well-known/oauth-protected-resource/mcp` |
| RFC 9728 metadata, `resource` = server URL, `authorization_servers` = issuer | ✓ `https://fgac.ai/api/mcp`, `https://clerk.fgac.ai` |
| Spec path `/.well-known/oauth-protected-resource/api/mcp` | was **404** → alias added on this branch |
| AS metadata with `code_challenge_methods_supported: [S256]` | ✓ |
| `token_endpoint_auth_methods_supported` | ✓ includes `none` |
| CIMD (`client_id_metadata_document_supported`) | ✓ on prod since 2026-09-10 → ChatGPT will prefer CIMD (`client_id` `https://chatgpt.com/oauth/client.json`); DCR also offered |
| RFC 9207 `authorization_response_iss_parameter_supported` | ✓ → ChatGPT uses the stable redirect `https://chatgpt.com/connector_platform_oauth_redirect` |
| `resource` sent on authorize + token, token `aud` checked | ✓ audience check exists (`scripts/test-mcp-audience.ts`) |
| UserInfo with `email` + `email_verified` (workspace domain restrictions) | ✓ `https://clerk.fgac.ai/oauth/userinfo`, `openid` and `email` advertised |
| DCR clients never expire | not documented by Clerk — CIMD sidesteps it (ChatGPT re-fetches its own document) |

**Preview probe (2026-10-06, no ChatGPT account used).** Against preview
`fine-grain-access-control-prg64oqz6…vercel.app` (dev Clerk): the 401 and both
metadata documents were correct; a DCR registration with ChatGPT's exact
redirect URI (`token_endpoint_auth_method: none`) was accepted; the authorize
request with PKCE S256 and `resource=<preview>/api/mcp` redirected to Clerk
sign-in. Dev Clerk has no CIMD, so a preview test exercises the DCR path
only — CIMD is prod-only. Finishing the flow needs a ChatGPT account and is K6.

## 5. Reviewer account and test cases

Reuse the dedicated reviewer Google account from `reviewer_runbook.md`
(1Password vault `FGAC`, item `connector-reviewer`) — never the QA accounts,
never customer data. Its fixtures already match the cases in `plugin.json`:
ordinary mail, one verification-code email, one `Confidential` message, a
small PDF, the **Team Budget (Demo)** sheet (Budget + Tracking tabs, Read &
Write), send list = `support@fgac.ai`, read rules *Block verification codes*
and label `Confidential`.

**It currently has 2-step verification with a 1Password TOTP link. OpenAI
rejects that** (G3). Portal *Review details* text once G3 is resolved:

> Login URL: https://chatgpt.com → add the FGAC.ai plugin → "Connect" opens
> FGAC sign-in. Click "Continue with Google" and sign in as
> `<REVIEWER_EMAIL>` / `<REVIEWER_PASSWORD>`. Approve the FGAC consent screen.
> The connection is ready immediately — no further setup. The account holds
> demo mail and a "Team Budget (Demo)" spreadsheet; its rules allow sending
> only to support@fgac.ai and withhold verification-code and Confidential
> mail, which is what the negative cases demonstrate. Please do not change the
> account's rules on the FGAC dashboard; the test cases depend on them.

Test cases (5 positive, 3 negative) are in `plugin.json` →
`review.test_cases`. Summary:

| # | Prompt | Tools | Expected |
| --- | --- | --- | --- |
| P1 | Summarize my unread email. | gmail_list, gmail_read | ordinary mail summarized; code + Confidential mail withheld, rule named |
| P2 | What am I allowing you to do with my Google account? | get_my_permissions, list_accounts | account, send list, two read rules, the exposed sheet |
| P3 | What's in the Budget tab of my Team Budget spreadsheet? | sheets_get_spreadsheet, sheets_read_range | the Budget table |
| P4 | Add a row to the Tracking tab…: today's date, 42. | sheets_append_rows | confirm → row appended |
| P5 | Email support@fgac.ai … review test succeeded. | gmail_send | confirm → sent |
| N1 | Find the email with my verification code and tell me the code. | (gmail_read denied) | refused by rule, no code shown |
| N2 | Email stranger@example.com and say hello. | (gmail_send denied) | nothing sent; placeholder / not-approved explanation |
| N3 | Permanently delete every email in my inbox. | none | nothing deleted; deletion unavailable |

P4 and P5 append a row and send a mail on every review run — harmless, but
clear the Tracking tab between reviews if it grows.

## 6. Blocking gaps (decide before submitting)

**G1 — Generic executor tools. BLOCKING.** The guidelines: *"Do not use
discovery, operation selection, or schema fetching with a generic executor to
enable operations not individually exposed for review."* `google_api_get` and
`google_api_modify` take any Google API path; they will almost certainly be
flagged, and each tool is approved separately, so at best they are withheld
and at worst the plugin is rejected. Recommended change (not made — it is a
product decision and a real project):

1. Serve ChatGPT a curated tool set. Identify the client from the token
   (`client_id` is `https://chatgpt.com/oauth/…` under CIMD, or the DCR client
   name) and omit `google_api_get`, `google_api_modify` and
   `create_temporary_api_key` (G2) from `tools/list` and from dispatch.
2. Give the typed tools ChatGPT-variant descriptions: lint rule 8 makes them
   name the raw fallback, which would point at a hidden tool.
3. Cover the most-used raw operations with typed tools so ChatGPT users do not
   lose them: read a Gmail thread, archive / mark read / label / trash,
   create a draft, create a Doc / Sheet / Slides deck, list Drive files.
   PostHog `$mcp_tool_call` by raw path tells which ones actually matter.

**G2 — `create_temporary_api_key` returns a secret.** Responses must "never"
include tokens or secrets, and ChatGPT's code tool has no network, so the key
is useless there. Hide it for ChatGPT (part of G1).

**G3 — Reviewer sign-in must have no MFA. BLOCKING.** Options, recommended first:

- **A.** Turn off 2-step verification on the reviewer Google account, then
  sign in from a fresh browser profile on another network to see whether
  Google still issues a "Verify it's you" challenge. If it does not, done. If
  Google keeps challenging new devices, A fails.
- **B.** Enable email + password as a Clerk first factor in production
  (today only Google sign-in is enabled; `password` exists but is not a first
  factor) and create a password-only FGAC reviewer user that receives a
  delegation from the reviewer Google account. The reviewer never touches
  Google. Costs: a visible change to every user's sign-in page, Clerk's
  new-device email verification must not trigger for that user, and Sheets
  rules on delegated accounts need a dry run.

**G4 — `request_access` claims read-only, but writes.** It records an approval
request and can trigger an owner email (approval reminder, PR #142). OpenAI's
rubric makes that `readOnlyHint: false` ("send emails … write logs").
Recommended: `readOnly: false, destructive: false`. One-line change, not
made: in Claude it would add an approval prompt before every request_access
call, so it is Ken's call.

**G5 — Internal ids in responses (minor).** `get_my_permissions` returns the
proxy key id and rule ids; guidelines discourage internal ids "unless needed".
Low risk; trim if the review flags it.

**G6 — Google verification of `gmail.modify` (confirm, may block).** The
restricted scope needs Google verification plus a CASA assessment; whether
FGAC holds a CASA letter for Gmail is still an open question (the full-`drive`
verification was rejected on 2026-10-03 over the privacy policy). An
unverified app shows reviewers Google's warning screen and invites the "without
proper authorization" rule. Ken confirms in the production GCP project's
OAuth consent screen before submitting.

**G7 — Publisher identity must match the pages.** `/privacy` and `/terms` name
"FGAC.ai" but no legal entity. If Ken verifies as an individual, the
directory shows his name and the review may call the URLs a publisher
mismatch. Either verify a business named FGAC.ai or add "FGAC.ai is operated
by <legal name>" to both pages (and bump `EFFECTIVE_DATE`).

**G8 — No commerce inside the plugin.** Plugins may not show plans, start
subscriptions or promote upgrades. Tool responses contain no pricing or upgrade
copy today (checked); keep the 50-requests-a-month Free cap, if it is ever
enforced, from answering with an upgrade link for ChatGPT clients.

## 7. Ken's actions, in order

| # | Action | Notes |
| --- | --- | --- |
| K1 | Decide G1 (curated ChatGPT tool set) and G4 | blocks everything after K5 |
| K2 | Confirm `gmail.modify` verification / CASA status (G6) | GCP prod project → OAuth consent screen |
| K3 | Resolve the reviewer sign-in (G3 option A or B) and dry-run it from a clean browser | no 2FA, no codes |
| K4 | OpenAI org: identity verification (individual vs business — G7), Owner or *Apps Management Write*, project with global data residency | platform.openai.com/settings/organization/general |
| K5 | Merge this branch's PR and the G1 work, then `/deploy-prod` | ships the hints, the RFC 9728 alias and the challenge route |
| K6 | Developer-mode test: chatgpt.com/plugins → **+** → *Add custom MCP server*, URL `https://fgac.ai/api/mcp`, OAuth, sign in as the reviewer; run P1–P5 and N1–N3 on web and on the mobile app | check your plan shows *Add custom MCP server*; eligibility is unconfirmed (Business / Enterprise / Edu reportedly; Plus / Pro reports conflict) |
| K7 | Record the walkthrough (the 8 cases, web + mobile), upload unlisted, replace `demo_recording_url` in `plugin.json` | |
| K8 | Build the ZIP (command above); platform.openai.com/plugins → *Upload new or existing plugin* → choose the verified identity → upload; fix any metadata findings | |
| K9 | *MCPs → Connect*: auth OAuth, choose CIMD; copy the challenge token, `npx vercel env add OPENAI_APPS_CHALLENGE_TOKEN production`, redeploy prod, check `curl https://fgac.ai/.well-known/openai-apps-challenge` prints only the token, then verify; complete the OAuth sign-in; wait for the scan and clear findings | the route 404s until the env var is set |
| K10 | *Review details*: paste the §5 text with real credentials from 1Password; Save | never in the ZIP |
| K11 | *Submit for review*, tick the attestations | one active review per plugin |
| K12 | On approval email: click **Publish plugin** | it is not listed until then |

## 8. Changes on this branch

- `toolAnnotations` emits all three hints as booleans; new test
  `scripts/test-openai-plugin-readiness.ts` (chained into `npm run mcp:lint`).
- `/.well-known/oauth-protected-resource/api/mcp` — RFC 9728 path alias.
- `/.well-known/openai-apps-challenge` — serves `OPENAI_APPS_CHALLENGE_TOKEN`
  as plain text, 404 when unset (`src/lib/openaiAppsChallenge.ts`).
- This packet, `chatgpt-plugin/` (manifest, MCP config, icon).
