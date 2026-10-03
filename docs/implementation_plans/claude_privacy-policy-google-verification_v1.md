# Privacy policy rewrite for Google OAuth verification — v1

**Branch:** `claude/privacy-policy-google-verification` (from `main` at 8620dee, 2026-10-03)
**Trigger:** Google rejected the OAuth verification submission for GCP project
727876597677 (the production consent screen, now requesting the restricted
`https://www.googleapis.com/auth/drive` scope) with: *"Your privacy policy page
at https://fgac.ai/privacy does not have sufficient content."*

## 1. Why the current page fails

`src/app/privacy/page.tsx` (89 lines, pre-change):

| Problem | Evidence |
| --- | --- |
| "Last Updated" renders today's date on every request | `{new Date().toLocaleDateString()}` — reads as a template to a reviewer |
| Names scopes FGAC does not request (`gmail.readonly`, `gmail.send`) and omits the ones it does (`drive.file`, `drive`) | scope constants in `src/app/dashboard/googleReconnect.ts`, `src/app/NavUserButton.tsx`, `src/lib/googleTokenScopes.ts` |
| No per-scope access/use/storage table, no security section, nothing on AI agents, delegation, service emails, cookies, rights, children, changes | — |
| States a 90-day log purge and a 30-day post-deletion purge that do not exist | no request-log table in `src/db/schema.ts`; `src/app/api/cron/` holds only `deliver-webhooks`, `renew-watches`, `sweep-bounces` (`vercel.json`); `src/db/tombstoneUser.ts` keeps the row |

## 2. Claim → evidence (every statement on the new page)

| Claim on the page | Where it is verified |
| --- | --- |
| Sign-in requests Google basic profile + `gmail.modify` + `drive.file`; full `drive` only via the flagged "Enable full Drive access" card and the nav connect-account scopes for flagged users | `src/app/dashboard/googleReconnect.ts:15-18,54`, `src/app/NavUserButton.tsx:6-7,35`, `src/app/dashboard/EnableDriveAccessCard.tsx` (header comment), `scripts/test-drive-scope-gating.ts`, `docs/architecture_and_strategy.md` "Google Drive Tree Access" item 5 |
| `drive.file` covers files picked in the Google Picker or created/copied by the agent | `src/app/dashboard/useGooglePicker.ts`, `docs/architecture_and_strategy.md` per-file section item 4 |
| Full-Drive use: lineage via `files.get` (`id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails`), 10-minute in-process cache, dashboard tree + search, filtered `files.list` | `src/lib/driveLineage.ts:5-20,42-43` (`CACHE_TTL_MS = 10 * 60_000`), `src/lib/driveTreeServer.ts`, `src/app/api/mcp/route.ts`, `src/app/api/proxy/[...path]/route.ts` |
| Full `drive` only requested from users on the PostHog `drive_tree` flag; flag evaluated with Clerk id + email | `src/lib/featureFlags.ts` header |
| Gmail/Drive content passes through in memory, is never persisted | no content column in `src/db/schema.ts`; inserts touch only the tables listed there (`grep "\.insert("`) |
| Permanent deletion refused | `src/app/api/proxy/[...path]/route.ts:711-714`, MCP `google_api_modify` schema (`DELETE` never available, `messages/batchDelete` refused) `src/app/api/mcp/route.ts:3825,3971` |
| Dashboard fetches label names live for the rule editor (not stored) | `src/app/api/gmail/labels/route.ts`, `src/app/dashboard/RuleControls.tsx:61`, `EditRuleButton.tsx:62` |
| Google access token sent to the browser only to open the Picker | `src/app/api/auth/google-picker-token/route.ts` (`accessToken` in the response) |
| What the database stores | `src/db/schema.ts`: `users` (email, Clerk id, `deleted_at`), `proxy_keys` (key, label, `drive_default`, revoked/expiry), `access_rules` (pattern, `target_resource_id`, `resource_name`), `email_delegations`, `key_email_access` (`target_email`), `agent_connections` (client id/name, nickname), `approval_requests` (action, `target_hash`, `resource_name`, `link_query`/`wall_query` carrying the signed link incl. the target in the clear, timestamps), `account_refusals` (`requested_email`), `google_grant_failures` (`account_email`, reason), `email_bounces` (address, DSN code), `notification_subscriptions`/`webhook_deliveries` (Gmail message ids only), `partner_apps`, `short_links` (counter only) |
| No Google tokens in FGAC's database; Clerk is the token vault | no token column in `src/db/schema.ts`; `clerkClient().users.getUserOauthAccessToken` everywhere a token is needed |
| Account deletion: keys revoked, delegations revoked both ways, access rows deleted, user row kept inert | `src/app/api/webhooks/clerk/route.ts:12-16`, `src/db/tombstoneUser.ts:14-21` |
| Rules are hard-deleted when removed; keys revoked (and deletable) | `grep "db\.delete("`: `accessRules` ×5, `keyRuleAssignments` ×7, `keyEmailAccess` ×3, `proxyKeys` ×1 |
| Service emails: approval reminder (repeat mint, unopened, ≥5 min), account-refusal notice (3rd refusal in 24 h), dead-grant / scope-missing notice (first refusal per episode, CC delegate), contact-sales confirmation; one per event, 3 per person per day, 10 dead-grant notices per hour globally; sent from the support mailbox through FGAC's own proxy, never through a user's grant | `src/lib/approvalNotify.ts` header, `src/lib/approvalNotifyCopy.ts:116,123,248` (`NOTIFY_MAX_PER_DAY = 3`, `NOTIFY_MIN_GAP_MS`, `ACCOUNT_REFUSAL_NOTIFY_AFTER = 3`), `src/lib/salesLead.ts`, `docs/analytics.md` `google_grant_dead_notified` |
| Bounce sweep reads DSNs in the support mailbox, records permanent bounces by address | `src/lib/emailBounceSweep.ts`, `src/app/api/cron/sweep-bounces/route.ts`, `email_bounces` schema comment |
| Delegation: owner grants a delegate's keys access to the owner's mailbox; revocable; tombstone revokes both directions | `src/db/schema.ts` `email_delegations`, `src/db/tombstoneUser.ts:23-26` |
| New MCP connections attach to the Default Profile; user can move/block them | `src/db/schema.ts` `proxy_keys.is_default` comment, `agent_connections` |
| Partner apps receive thin webhook pings (Gmail message ids only, never content) | `src/db/schema.ts` `webhook_deliveries` comment, `docs/distribution_architecture.md` "Partner Handoff" |
| PostHog receives: Clerk id, email, name (`identify`), server events keyed by Clerk id, `$mcp_tool_call` / `proxy_request` metadata (tool, outcome, denial code, `account_email`, `account_requested`, `file_id`, `file_mime_type`, `client_name`, `user_agent`, Google error codes/messages), exceptions (type/message/stack only), feature-flag evaluation with id + email | `src/app/PostHogIdentify.tsx`, `src/lib/posthogServer.ts`, `src/app/api/webhooks/clerk/route.ts:59`, `docs/analytics.md` event catalog rows for `$mcp_tool_call`, `proxy_request`, `connector_install_started` (`install_fingerprint` = salted hash of IP + UA) |
| PostHog session replay is ON for fgac.ai pages, inputs masked by default, console logs captured, replays kept 30 days; IPs not anonymised | PostHog `project-get` (project 343912, 2026-10-03): `session_recording_opt_in: true`, `session_recording_retention_period: 30d`, `capture_console_log_opt_in: true`, `anonymize_ips: false`, `session_recording_masking_config: null` (→ PostHog default `maskAllInputs: true`, docs/session-replay/privacy); `src/app/providers.tsx` does not disable recording |
| PostHog event retention "up to seven years" | PostHog docs `data/events-retention`: free plan 1 year, paid plans 7 years (plan tier not readable through the connector — upper bound stated) |
| Cookies: Clerk session cookies; `fgac_last_account` / `fgac_prev_account` (Clerk ids only, 7 days); `fgac_approval_wall` (30 min); `fgac_clerk_bounce` (5 min); PostHog `ph_*` cookie/localStorage | `src/lib/secondAccount.ts:37-45`, `src/lib/approvalWall.ts:32-35`, `src/lib/clerkAuthRedirect.ts:30-35`, posthog-js default persistence |
| Contact-sales form: email, company, team size, needs → PostHog + confirmation email CC sales@ | `src/lib/salesLead.ts`, `src/app/pricing/` |
| Waitlist form is retired (route exists, no caller) | `grep -rn "api/waitlist" src` → only the route file |
| Footer and docs page link to /privacy | `src/app/layout.tsx:123`, `src/app/docs/page.tsx:294`, `src/app/page.tsx:279` |
| Encryption in transit/at rest, security headers | `docs/archive/casa-tier-2/CASA_SAQ_Answers.md` Q5 (TLS 1.2+, Neon at-rest encryption, CSP/X-Frame-Options), Clerk webhook signature verification `src/app/api/webhooks/clerk/route.ts:40-51` |

## 3. Decisions for Ken

1. **Retention wording vs. new cron.** The old page promised a 90-day purge of
   request logs and a 30-day purge after account deletion. Neither exists:
   request metadata lives in PostHog (not our database) and the Clerk
   `user.deleted` webhook tombstones the user row (keys/delegations revoked,
   row kept inert). **Chosen: state what is true** — no new cron. The page now
   says the inert account record is kept and that erasure can be requested by
   email. If a hard-delete-on-request is preferred, that is a follow-up
   (`tombstoneUser` + a manual script), not a policy change.
2. **No legal entity or governing law named.** Nothing in the repo names an
   LLC/Inc. or a jurisdiction, so the page says "FGAC.ai" and states US hosting
   only. Add the entity name to the Contact section when one exists.
3. **Session replay is on with console-log capture.** The policy now discloses
   it (inputs masked, 30-day retention). If you would rather not disclose
   replay, turn it off in PostHog project settings and I will drop the paragraph.
4. **PostHog event retention** is stated as "up to seven years" (paid-plan
   figure; free is one year). Tighten if you know the tier.
5. **Account self-deletion path.** The page offers both the Clerk account menu
   (Manage account → Security) and email. Confirm Clerk's "delete self" is on.

## 4. Changes

- `src/app/privacy/page.tsx` — rewritten (fixed effective date, TOC, 14 sections,
  per-scope table, Limited Use callout with the verbatim sentence and the
  `#additional_requirements_for_specific_api_scopes` link, cookies, sub-processor
  and retention tables, rights, children, changes, contact). Design tokens from
  `src/app/globals.css`, phone-width friendly (tables stack below `sm`).
- `src/app/terms/page.tsx` — only where it contradicted the policy: fixed
  effective date (was today's date), service description now names Gmail, Drive,
  Sheets, Docs, Slides and the MCP/REST surfaces, "email content" → "email and
  file content", heading typo "acceptable Use", class names moved to the same
  design tokens so the two legal pages render identically.
- `docs/user_guide.md` — new "Privacy and your data" section pointing at the
  policy (no such section existed).
- `docs/tech_stack.md` — data-flow step 1 now lists `drive.file` beside
  `gmail.modify`.

## 5. Validation

- Local: `preview_start fgac-dev`, `/privacy` and `/terms` at desktop and 375 px
  widths; dark emulation (the site is light-only: `.dark` is never applied,
  `color-scheme: light`); console clean; all anchors resolve.
- Preview: `/deploy-pr-preview` once (static content).
- Google: Ken resubmits the verification with the live https://fgac.ai/privacy.

## 6. Out of scope

Legal-entity naming, a hard-delete script, changing PostHog replay settings,
`docs/user_guide.md`'s stale "SecureAgent" branding.
