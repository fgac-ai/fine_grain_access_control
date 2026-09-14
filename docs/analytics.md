# Product Analytics (PostHog)

How FGAC.ai instruments usage, how PostHog persons map to Clerk users, and how to
keep internal/QA traffic out of the numbers.

## Identity model

- **Distinct id = Clerk user id, everywhere.** The dashboard calls
  `posthog.identify(clerkUserId)` on sign-in (`src/app/PostHogIdentify.tsx`); the
  MCP server, API proxy, and Clerk webhook capture server-side events with the
  same id (`src/lib/posthogServer.ts`). One PostHog person per Clerk user, with
  `email`/`name` person properties.
- Signed-out visitors stay anonymous (`person_profiles: 'identified_only'`).
  `posthog.reset()` runs on sign-out so shared browsers don't cross-link users.
- **`signup_source` person property** (`$set_once`): fresh accounts (<10 min
  old) are stamped `website` on their first identified dashboard visit
  (`PostHogIdentify`) or `claude_connector` on their first MCP connection —
  whichever touchpoint a new account reaches first wins.
- **Delegation observability**: tool/proxy events carry `account_email` and
  `account_delegated` (which mailbox a call resolved to, own vs delegated) via
  `src/lib/toolCallContext.ts` (AsyncLocalStorage rides the props from account
  resolution to the single capture site).

**Organizations.** There is no org object; an organization is inferred from
email domains on two fields that need not agree — `person.properties.email`
(the sign-up address) and `properties.account_email` on `$mcp_tool_call` (the
mailbox being accessed, own or delegated). Roll both up by domain family
(first DNS label, hyphens stripped; consumer providers excluded, universities
kept) and read them together: a delegation rollout shows as many sign-ups and
one caller, a consultant reading company mailboxes shows only on the mailbox
side. Teammates who signed up solely to grant a delegation never connect an
agent and are not "never-called" churn. Queries: `monitoring.md` 7.20a–d.

## Event catalog

| Event | Source | Key properties |
| --- | --- | --- |
| `$pageview` | client (`PostHogPageView.tsx`) | `$current_url` |
| `sign_up_started` | client (`SignUpCta.tsx`, all sign-up CTAs) | `cta_location`: nav / hero / bottom_cta |
| `directory_link_clicked` | client (`DirectoryCta.tsx`, all links to the Claude connectors directory listing) | `cta_location`: announcement_bar / setup_step1 / docs_support / dashboard_connect |
| `flyer_scanned` | server (`/go/[slug]` QR redirect) | `slug`, `slug_known`, `campaign`, `variant`, `channel`, `destination`, `device`, `$raw_user_agent`/`$useragent` (the visitor's UA — without it PostHog's virtual traffic classification marks every scan `$virt_is_bot` / `no_user_agent` and bot-filtered views drop all real scans; added 2026-08-30), `geo_city`/`geo_country` (from Vercel headers; `$geoip_disable` set so the server IP isn't resolved). **Bot-filtered** (link-preview crawlers get the redirect but no event) and captured with a random distinct id per scan — `count()` is scans, not people. Joins to the web funnel via `utm_content`/`ref` = slug on the landing `$pageview`. Links managed via `npm run links` (`scripts/short-links.ts`); per-slug running totals also live in the `short_links.scan_count` column |
| `sign_up_completed` | server (Clerk webhook, `user.created`) | `$set.email` |
| `sign_in_completed` | client (`SignInTelemetry.tsx`, dashboard pages) | `gmail_scope`, `drive_file_scope`, `needs_drive_file` (user has Sheets/Docs rules), `drive_file_narrowed` (= needs it and arrived without it). Once per Clerk `lastSignInAt` (localStorage-keyed; fires only within 10 min of the sign-in). Added 2026-09-04: PostHog had no sign-in signal, and a plain Google sign-in rewrites Clerk's grant with the sign-in scope set — no `drive.file` — so `drive_file_narrowed` is the per-sign-in count of users whose Sheets/Docs access a sign-in just broke. Detection query: monitoring.md §7.12 |
| `video_played` | client (`TrackedVideoEmbed.tsx`, all Descript demo embeds) | `video_id`, `video_title`, `page` |
| `$mcp_tool_call` | server (`/api/mcp`, every tool) | `$mcp_tool_name`, `$mcp_duration_ms`, `$mcp_is_error`, `client_id`, `client_name`, `user_agent`, `outcome`, `account_email`, `account_delegated`; raw tools add `raw_api_kind`, `raw_api_family`, `raw_api_endpoint`, `raw_api_mutating`; denials add `denial_code`, and denials carrying an approval link add `approval_request_id` (joins to the approval funnel); failures add `error_status`, `error_reason`, `error_domain`, `failure_reason`, `gmail_404_site`; per-file sheets/docs calls add `file_id` + `file_service` (stamped in `checkFilePermission`, so every typed sheets/docs tool, comments tool, and raw per-file API call carries them — denied outcomes included — making per-file time-to-first-success queryable and joining to `rule_saved.file_id`); `gmail_get_attachment` adds `attachment_selector` and, on 404 recovery paths, `attachment_selfheal`; windowed reads (`gmail_get_attachment`, `gmail_read`, `docs_read_document`, `sheets_get_spreadsheet`, `sheets_read_range`, `google_api_get`) add `window_offset`, `window_chars`, `window_total_chars`; calls that reach Google add `google_ms` (cumulative wall-clock inside `googleFetch`) and `token_ms` (Clerk token fetch); calls whose Clerk token fetch failed on the first attempt add `google_token_retry` (`recovered` = the single server-side retry got the token and the call went on normally; `retry_failed` = it did not, and the event also carries `google_token_error`) |
| `proxy_request` | server (`/api/proxy/[...path]`) | `service` (gmail/sheets/drive), `method`, `status`, `outcome` (`success`/`auth_failed`/`denied`/`timeout`/`error`), `duration_ms`, `proxy_key_id`, `account_email`, `account_delegated`, `google_ms`, `token_ms`; upstream failures add `error_status` (`timeout`/`network`) |
| `mcp_connection_created` | server (`/api/mcp` auth layer) | `connection_id`, `client_id`, `client_name`/`client_version` (from MCP `initialize` clientInfo, when the creating request was one — **in practice ~never**: the client's concurrent SSE GET usually wins the row-insert race, so this event fires nameless; measured 0/10 with a name 2026-08-27→29. Use `mcp_connection_client_identified` or person-level `mcp_client_initialize` for client attribution), `auto_attached`, `account_age_seconds` |
| `mcp_connection_client_identified` | server (`/api/mcp` auth layer, backfill-on-touch) | `connection_id`, `client_id`, `client_name`, `client_version`. Fires **once per connection**, on the first initialize that replaces the opaque `client_id` placeholder name — the reliable connection→client-product mapping (join on `connection_id`) |
| `mcp_client_initialize` | server (`/api/mcp` auth layer, every authenticated `initialize`) | `client_name`, `client_version` (the client's self-reported MCP clientInfo), `client_id`, `user_agent`. Once per MCP session, one row per event — **deliberately never sampled or coalesced** (decision 2026-09-09): automation that starts a fresh Claude Code process every ~30 s made this the largest event in the project (~50% of daily volume from 2 clients), but the per-event timestamps and versions are exactly what exposed that pattern, and volume is ~6% of the plan. Loop clients are named by the `docs/monitoring.md` 7.16 query and excluded from per-request ratios there, not suppressed here. The substrate for the per-product split (Cowork / Claude Code / Claude.ai) |
| `delegation_created` | server (dashboard action) | `delegate_email`, `reactivated` |
| `account_linked` | server (dashboard action) | `target_email`, `delegated`, `via` |
| `approval_link_minted` | server (`/api/mcp` — policy denial, send denial, `request_access`) | `action`, `request_id`, `target_hash`, `mint_count`, `via` (`send_denial`/`request_access`; absent for policy denials), and on `request_access` mints since 2026-09-08 `has_resource_name` (the request has a title — passed on this call or stored by an earlier one in `approval_requests.resource_name`, shown on the approve page: the only name source for a file Google does not share with FGAC yet) and `resource_name_supplied` (this call passed one). **Fires once per mint ATTEMPT**, so `uniq(request_id)` is demand and `count()` is retry pressure |
| `approval_link_opened` | server (approve-page load, `/dashboard/approve`) | `status` (`fresh`/`already_granted`/`wrong_account`/`invalid`), `request_id` (real id for `wrong_account` — recomputed against the resolved owner; `undefined` only for `invalid`), `action`, `agent_driven`, `user_agent`; since 2026-09-09 `client` (`browser` / `claude_desktop` / `agent`, from `src/lib/approveClientClass.ts`). **`claude_desktop` is a person** — the Claude desktop app's in-app browser sends a Chrome UA with a `Claude/<build>` token, and before this the bare "claude" agent test counted those opens as `agent_driven: true` (19 opens / 7 people in the 30 days to 2026-09-09, every one followed by that person's own pageviews and pick-button clicks). Read human reach as `client != 'agent'`; `agent_driven` on older rows overstates agents by exactly this class. Fires on every server render of the page (a route refresh or navigation re-renders it — local QA 2026-09-09 saw extra rows while the tab sat idle), so rows overcount opens: always read `uniq(request_id)` |
| `approval_link_approved` | server (`actions.ts`, all approval paths) | `action`, `request_id`; per-file grants add `substituted` and `granted_count`. **Fires only when a grant is actually written.** A submit that finds every grant already active fires `approval_link_replayed` instead (since PR for `claude/dreamy-tesla-946fdc`, 2026-09-05). Before that fix the picked-file path re-fired this event (and inserted a duplicate rule) on every extra click of an unguarded button — raw counts between 2026-08-25 and the fix are inflated (81 links → 93 events in the last pre-fix week); read the funnel as `uniq(request_id)`, never `count()` |
| `approval_link_replayed` | server (`actions.ts`, `approveMagicLink` / `applyFileGrantApproval`) | `action`, `request_id`, `path` (`grant_active` = generic idempotency short-circuit; `picked` = every picked file already granted). A no-op re-submit of a link whose grant is already live: a double-click that slipped past the client-side guard, a re-opened permanent link, or a retry after the success page. Not a funnel stage — its rate is the duplicate-submit rate. Runbook: `monitoring.md` 7.14 |
| `read_restriction_enforced` | server (`/api/mcp`) | `via` (tool name), `restriction` |
| `rule_saved` | server (`reportRuleSave` in dashboard `actions.ts` — manual rule form, `exposeFilesFromPicker`, magic-link `insertFileRule`; `grantFileAccessPOST` in `fileAccessHandlers.ts`) | `mode` (`create`/`update`), `service`, `action_type`, `via` (`dashboard_manual` = manual rule form, Gmail-only in today's UI / `dashboard_picker` = server-action Picker expose (recovery + profile flows) / `grant_api` = the REST grant endpoint — the dashboard's Picker manager AND any API caller, so it is the only reachable seam for a hand-typed sheet/doc id / `magic_link` = approval-page grant), `file_id` (when the rule targets a sheet/doc — the join key to `$mcp_tool_call.file_id`); `dashboard_manual` adds `scoped`, `assigned_keys`, and pattern shape (`pattern_kind`/`pattern_length` — the pattern itself is NEVER sent: send patterns are real addresses); `dashboard_picker` adds `profile_scoped`; `grant_api` adds `assigned_keys` when key syncing was requested; `magic_link` adds `request_id` (joins the approval funnel) |
| `rule_save_failed` | server (dashboard `actions.ts`, manual rule form validation) | `mode`, `service`, `action_type`, `via` (`dashboard_manual`), `reason`, pattern shape props as above |
| `picker_scope_redirect` | client (`useGooglePicker`) | `kind` (`sheet`/`doc`). Fires immediately BEFORE the `drive.file` OAuth consent redirect — the funnel's riskiest hop: a `picker_scope_redirect` with no subsequent `picker_opened` is a user who never came back from consent. Page context via `$pathname` |
| `picker_opened` | client (`useGooglePicker`) | `kind`, `from_oauth_return` (true when the picker auto-reopened after the consent round-trip), `attempt` (since 2026-09-08: Nth Picker open in this page session — `attempt > 1` after a `picker_cancelled` is the recovery panel's Try again working) |
| `picker_picked` | client (`useGooglePicker`) | `kind`, `count` (files picked) |
| `picker_cancelled` | client (`useGooglePicker`) | `kind`; since 2026-09-08 `attempt`, `elapsed_ms` (open → cancel), `from_oauth_return`. On the approve page a cancel now renders a recovery panel (what the agent asked for, by title when `request_access` supplied one, else by Google id + "the picker lists files by name") with an in-place Try again; before that a cancel changed nothing on screen. Measured 09-03 → 09-07: 13 of 33 Picker opens ended in a cancel, every one from a plain open (`from_oauth_return: false`) |
| `picker_flow_error` | client (`useGooglePicker`, pre-existing) | `stage`, `message` |
| `picker_token_requested` | server (`/api/auth/google-picker-token`, the first request a pick-button click makes) | `result` (`ok` / `no_token` = Clerk holds no Google grant for this user / `error`), `has_drive_file_scope` (false sends the browser into the reconnect leg — a dead or narrowed grant reads as this, see `google_scope_missing`), `scope_source` (`google-tokeninfo` / `clerk-cache`), `app_id_resolved`, `page` (Referer pathname: `/dashboard/approve`, a profile page, `/dashboard/accounts`). Added 2026-09-09 as the **server-side twin of the browser's `picker_*` funnel**: posthog-js is blocked for a share of users — 8 of the 65 people who opened an approval link in the 30 days to 2026-09-09 sent no client-side event at all (two of that week's three "opened, never picked" accounts among them) — so a person with a `link_open` verification and no `picker_opened` could be a non-click OR an ad-blocked browser, and only this row tells them apart. One row per click; `count()` vs the same person's `picker_opened` is the telemetry-blind share. Runbook: `monitoring.md` 7.15 |
| `google_reconnect_started` / `_returned` / `_verified` / `_incomplete` / `_wrong_account` | client (`ReconnectGoogleButton`, Accounts page) | The reconnect funnel (closed 2026-09-03 — `returned`/`verified` are new; before them, silence after `started` was ambiguous between abandoned consent, a session dropped during the OAuth round-trip, and plain success). `started` {`source`} fires before the consent redirect; `returned` when the page processes `?reconnected=1` (fires even after a mid-flow re-sign-in — the redirect_url chain preserves the param); `verified` when the tokeninfo poll confirms both scopes; `incomplete` {`missing_scopes`} when it does not; `wrong_account` {`intended_for`} when a bound reconnect link is opened by the wrong user. Detection query: monitoring.md §7.8 |
| `sheets_grant_verification` | server (approve-page load via `/api/rules/verify-sheets-access`, approval in `actions.ts`, rule creation in `createRule`/`grantFileAccessPOST`, recovery re-checks) | `result` (`ok`/`missing`/`unknown`), `via` (`link_open`/`magic_link`/`post_approval`/`dashboard_manual`/`grant_api`/`recovery`), `spreadsheet_id`; `magic_link` + `result: missing` (since 2026-09-08, with `picked_count` and `request_id`) = the approve page's post-pick verification found none of the picked files reachable and sent the user back to pick again — the retry loop one launch-cohort user ran 12 times in two minutes before granting from the dashboard instead; before this only the successful `magic_link` verification was captured. `grant_api` (and `dashboard_manual`, for direct server-action calls — the manual modal is Gmail-only today) = grant verified at rule birth (the stranded-at-birth case — telemetry only, a Google hiccup never fails rule creation); `recovery` = EVERY recovery-UI re-check, captured regardless of result (attempts that stay `missing` are the funnel's stuck users — before this, only successes were visible via `sheets_grant_recovered`, which still fires on `ok`) |
| `sheets_grant_recovered` | server (`/api/rules/verify-sheets-access`) | `spreadsheet_id` |
| `docs_grant_verification` / `docs_grant_recovered` | server (`/api/rules/verify-docs-access`, approval in `actions.ts`) | docs twins of the sheets grant-funnel events, with `document_id` |
| `google_token_fetch_failed` | server (MCP `getGoogleToken`, proxy `fetchClerkGoogleToken`, `getOwnerGoogleToken`) | `reason` (`refresh_failed` = Clerk 422 cannot-refresh, `clerk_error`, `timeout` = MCP-path Clerk call exceeded 15 s, `no_token` = Clerk answered with no stored Google grant — MCP path only, fires since 2026-09-04; before that this class stamped only the tool-call prop; `owner_not_found` = Clerk 404 `resource_not_found` for the mailbox owner's stored user id — the owner's FGAC account was deleted, or the row came from another Clerk instance; MCP path, since 2026-09-04; `grant_revoked` = Clerk 400 `oauth_token_retrieval_error`, Clerk asked Google to refresh and Google refused — every production instance inspected carried Google's `invalid_grant "Token has been expired or revoked."` (user revoked FGAC in Google, changed their Google password, or the grant aged out); deterministic, a reconnect repairs it; all three paths, since 2026-09-09 — before that this code fell through to `clerk_error`), `via` (`mcp`/`proxy`/`grant_check`), `account_delegated`; since 2026-09-04 the MCP path adds `retried` (a server-side retry already ran and failed — see `google_token_retry`) and, when Clerk threw an API error, `clerk_status` / `clerk_code` (Clerk's HTTP status and first error code — enum-like, so the next triage can see what Clerk said; the proxy and grant-check paths stamp them since 2026-09-09), plus `provider_error` when Clerk relays the upstream error (the current SDK drops it, so expect it absent). The `$mcp_tool_call` event also carries `google_token_error` and, since 2026-09-09, `google_token_clerk_code` on affected calls, so the per-tool error table can split dead grants from upstream trouble without a join. Added 2026-08-20 after the dev-instance refresh-token loss was found; this is the signal for whether production users hit it too. **The event fires only on FINAL failure**: a fetch that fails and recovers on the retry fires nothing here and stamps `google_token_retry: 'recovered'` on the tool call instead (docs/monitoring.md §7.13) |
| `google_token_identity_fallback` | server (MCP `getGoogleToken`) | `via` (`mcp`). Fires when a key owner's own mailbox is reached through the identity-drift self-heal added in `4b551018` — the target address is not a delegation but IS one of the owner's verified Clerk addresses. Unsampled, and independent of `$mcp_tool_call`, so `uniq(person)` is exactly the drifted population still being rescued; the same call also carries `google_token_identity_fallback: true` on `$mcp_tool_call`. Expected to trend to zero as users self-heal — see docs/monitoring.md 7.4 |
| `google_scope_missing` | server (MCP `gmailScopeDenial` / `driveFileScopeDenial`, proxy Gmail handler) | `via` (`mcp`/`proxy`), `scope` (`gmail` / `drive_file`; absent on pre-2026-08-29 events, all of which are gmail), `account_delegated`. Fires when a call is pre-flight denied because Clerk's granted scopes for the account lack what the surface rides on: Gmail calls need `gmail.modify` / `mail.google.com`; non-Gmail calls (typed sheets_*/docs_*/comments_* tools and raw Sheets/Docs/Slides/Drive paths) need `drive.file` — the "checkbox left unchecked at consent" (or pre-drive.file connection) states, which would 403 on every such call until reconnect. Unsampled and independent of `$mcp_tool_call`, so `uniq(person)` is the size of the locked-out population; the same call carries `google_scope_missing: true` on `$mcp_tool_call` and pre-flight-denies with `denial_code` = `failure_reason` = `'gmail_scope_missing'` / `'drive_file_scope_missing'` (outcome `denied_by_policy` since 2026-09-03; `failed` from 2026-08-28 to then) instead of surfacing Google's 403 (outcome `error`). Added 2026-08-28 after repeated per-user gmail_list 403s; drive_file variant 2026-08-29. Since 2026-09-04 a metadata-based denial is confirmed against Google's tokeninfo before it fires — Clerk's scope record is a cache of the last completed OAuth request, and a plain Google sign-in rewrites it without `drive.file` — and when tokeninfo disagrees the call proceeds with `clerk_scope_cache_stale: true` on `$mcp_tool_call`. Since 2026-09-05 tokeninfo decides in BOTH directions (cached ~once per account per token lifetime): a record that claims a scope the token lacks — a no-consent sign-in over a narrow refresh token — is denied as usual and stamps `clerk_scope_record_overstates: true`; monitoring.md §7.12a |
| `mcp_transport_rejected` | server (`/api/mcp` `withTransportObservability`, every transport-level 4xx) | `reason` (`discover_probe` = MCP 2026-07-28 `server/discover` probe answered with the legacy 400, benign and expected; `unsupported_protocol_version` = the same rejection on any other method, a truly refused client; `sdk`; `parse_error` = our own 400 for a non-JSON body), `status`, `message`, `rpc_method` (first method, scalar), `rpc_methods` (array), `tool`, `protocol_version_header`, `client_id`, `user_agent`. Runbook: `monitoring.md` 7.9 |
| `mcp_input_validation_failed` | server (`/api/mcp`, tee of a 2xx `tools/call` response) | `tool`, `kind` (`invalid_arguments`/`unknown_tool`), `message`. The SDK's own `isError` -32602 results, which never reach `withToolAnalytics`. Runbook: `monitoring.md` 7.10 |
| `mcp_auth_attempt` | server (`/api/mcp` `verifyMcpAuth`) | `outcome` (`ok`/`invalid_token`/`no_token`), `client_id`, `strategy_used` (`clerk`/`direct`/`none`), `memo_hit`, `optimizations_enabled`, `success_sample_rate`, `error_class`, `kid` (on `invalid_token` only), `method`; since 2026-09-10 also `user_agent`, `client_name` (from an unauthenticated `initialize`, when the request was one) and `client_class` / `client_class_signal` (`claude` / `internal` / `scanner` / `direct`, see `classifyMcpClient` in `src/lib/mcpClientSignals.ts`; since 2026-09-12 a `direct` row from a bare runtime UA with no `clientInfo` carries `client_class_signal = 'ua:stock-runtime-no-name'` — unnamed automation, read separately from the unlabelled `direct` rows per monitoring.md 7.21e) — so a 401 spike is attributable from this event alone; the day after the MCP Registry listing (2026-09-10) registry crawlers and health probes produced ~6× the usual `no_token` volume and every non-probe `invalid_token`, and `client_class = 'scanner'` is what keeps them out of the alert and the funnel (monitoring.md 2–3, 7.5, 7.21). Auth-health substrate for the JWKS/strategy optimizations. **Failures are unsampled; successes are a 1-in-20 per-request sample** — multiply `ok` by 20 for volume, valid only from the 2026-08-25 fix onward (two earlier versions sampled per-token and were biased; see docs/monitoring.md 1). `kid = 'probe'` marks our own synthetic probes, not users |
| `agent_doc_created` | server (`/api/mcp`, raw `POST v1/documents`) | `document_id`, `auto_granted` (docs twin of `agent_sheet_created`) |
| `connector_install_started` | server (`.well-known` OAuth discovery routes, `/api/mcp` auth layer) | `touchpoint` (`oauth_discovery`/`mcp_401`), `endpoint`, `reason` (`no_token`/`invalid_token`), `method`, `user_agent`, `install_fingerprint` (salted sha256 of ip+user-agent — the uniqueness key; see funnel note below), `client_name`/`client_version` (mcp_401 only, when the unauthenticated request was an MCP `initialize`); since 2026-09-10 `client_class` / `client_class_signal` on both touchpoints — `scanner` marks MCP registry crawlers, directory health probes, security scanners and SEO bots (classified from user_agent AND client_name: about a third of the crawlers run on a stock HTTP client and only identify themselves in `clientInfo.name`), `internal` our own probes, `claude` the Anthropic products, `direct` everything else (with `client_class_signal = 'ua:stock-runtime-no-name'` marking the tokenless bare-runtime rows that carry no `clientInfo`, since 2026-09-12). Filter `coalesce(properties.client_class, '') NOT IN ('scanner', 'internal')` before reading any of this as demand; rows before the deploy carry no class |

### The approval funnel: count REQUESTS, not links

**An approval request is one `request_id`. Mint events per `request_id` are
retries, not demand.**

`request_id` is a deterministic HMAC of (user, proxy key, action, target), so
denying the same operation repeatedly re-emits the SAME id and the same URL.
Join `approval_link_minted` → `approval_link_opened` → `approval_link_approved`
on it, and count `uniq(request_id)` at every stage.

This is the definition the funnel lacked before 2026-08-25, and its absence was
expensive. The old `link_id` was a per-mint JWT `jti`, so every agent retry
produced a new id and looked like fresh unopened demand. The same 14-day window
read as **31% approved** counted per link and **~58%** counted per request;
`sheets_expose`, reported as the worst-converting action at 30.7%, was actually
the best established one at 83.3% because it simply had the most retries
(2.93 links per request). Four separate analyses produced four different
numbers — 26%, 31%, 68%, 58% — purely from choosing different groupings.

Two further cautions when reading this funnel:

- **Report approvals, not opens.** `approval_link_approved` requires a form
  submit on a page naming the grant; it is the only stage that proves a
  deliberate human act. `approval_link_opened` only proves an authenticated
  session rendered the page — measured against client-side pageviews, ~23% of
  approve-page loads were an AI agent rather than a person, which is why
  `agent_driven` now rides on the event.
- **Send denials mint TWO requests** (`send_whitelist` and `send_all`), of
  which a human can only ever open one. Send actions therefore carry roughly
  double the request count of a single-option denial.
- **Server-side events carry no browser user agent**, so PostHog labels every
  `posthog-node` event `Automation` / `$virt_is_bot: true`. That label is a
  capture artifact and says nothing about human involvement — do not filter on
  it. (Control: client-side `$pageview` splits Regular/AI Agent normally.)

**HogQL gotcha:** `properties.status` silently returns NULL on the `events`
table — `status` is shadowed by a table field, so dot access resolves to the
wrong thing. The property IS ingested; read it as
`JSONExtractString(properties, 'status')`. Verified 2026-08-25 after the
dot-access form made a correctly-emitted property look missing on both
production and development events. `action`, `request_id`, `agent_driven` and
`user_agent` are unaffected and work with dot access.

**Approvals are counted per link, and only real writes count.** Since 2026-09-05
`approval_link_approved` fires once per grant actually written; replays of an
already-live grant fire `approval_link_replayed`. Between 2026-08-25 and that fix
the picked-file approval path had no client-side pending guard and no
server-side dedupe, so one rage-clicked link could emit 14–20 approve events
(and insert as many duplicate rules). Conversion computed from raw event counts
over that window is wrong in the multi-fire direction — 7d to 2026-09-05 read
66/93 = 71% raw against 30/81 = 37% per link. Always divide
`uniq(request_id)` by `uniq(request_id)`; see `monitoring.md` 7.14 for the query.

`approval_requests` (Postgres) mirrors this in SQL — one row per request with
`mint_count`, `opened_at`, and `approved_at` — so the same questions are
answerable without the analytics pipeline.

**Read the funnel per action, and locate the loss before naming a fix
(2026-09-08).** Minted → opened → approved per `request_id`, split by
`action`, separates an *open-step* leak (the agent received the link, the user
never loaded the page) from a *Picker-step* leak (the page loaded, the pick or
submit did not happen). In the week to 2026-09-08 `docs_expose` converted 0 of
13 while `sheets_expose` converted 17 of 36 — but 12 of the 13 docs links were
never opened (sheets: 24 of 36 opened), and the single opener cancelled the
Picker seven times. Nothing in the docs approve path was broken: the same week
`docs_write` links completed the pick-first path 20 of 25 times with
`docs_grant_verification` firing at `link_open`, `magic_link` and
`post_approval`. Two joins that matter for this reading:

- **Denial code ≠ link action.** A write attempt on an unexposed doc is denied
  with `denial_code=docs_not_exposed` on `$mcp_tool_call` but mints a
  **`docs_write`** link (`fileApprovalLevel` picks the level the operation
  needs). Count link actions from `approval_link_minted.action`, never from the
  denial code. The same holds for sheets.
- **A read link approved at the write level is recorded as the write action**
  (`approval_link_approved.action` follows the effective grant). Join approvals
  back to mints on `request_id` before reading any per-action approval count;
  the `docs_expose` 0/13 above survived that join.

Query: `monitoring.md` 7.19.

**Retry pressure is mostly batches and scheduled jobs, not loops (2026-09-11).**
`mint_count` per `request_id` and denials-per-person-per-5-minutes
(`monitoring.md` 7.22) were read for 2026-09-04 → 09-11 before changing any
denial text. Of the requests minted more than once, the highest counts came
from three shapes, none of which is an agent ignoring the text:

- **A batch, not a retry.** The largest send burst (12 `send_disabled`
  denials in 19 s, one claude.ai user) was twelve DIFFERENT recipients issued
  in one assistant turn — twelve distinct `send_whitelist` request ids plus
  one `send_all` id at `mint_count` 12. The agent then stopped, relayed the
  link, and the user approved `send_all` 65 s after the last denial; the
  twelve sends succeeded on the next turn. `AGENT_APPROVAL_PROTOCOL` (appended
  to every linked denial since 2026-08-19) was obeyed — text cannot recall
  calls already emitted. Read a same-request `mint_count` next to
  `uniq(target_hash)` before calling it retry pressure: many targets in a
  short window is a batch.
- **A scheduled task with a wrong `account`.** One Claude-desktop hourly job
  hit `account_not_permitted` 18 times as ❌ (pre-2026-09-08) and 23 more
  times as the 🚫 form that names the fix; no delegation was ever created for
  that person, so the parameter is simply wrong. When the agent reads the
  refusal it applies the fix within seconds (the `sheets_not_exposed` rows
  that follow some of the hourly hits are the default-account retry) — but
  the task re-sends the same value on its next run with a fresh context. The
  text now says the task itself must change; only the user can stop the
  cadence.
- **A user stuck on the approve page.** `sheets_write` at `mint_count` 9 in
  13 minutes with two opens and no approval, before the Picker-cancel recovery
  shipped (2026-09-09). The retries were the agent being told "try again" by a
  user whose approval had not gone through; that is a page defect, not copy.

The denials that lacked ANY next step were the ones to fix: explicit blocks
(`sheets_blocked` / `docs_blocked`, no link by design) and a failed link mint
returned a bare "Access Denied". Every refusal now ends with an explicit
stop-and-ask sentence; the builders live in `src/lib/denialCopy.ts` and are
pinned by `scripts/test-denial-copy.ts`. Outcome classification is unchanged
(the emoji prefix stays first). Measure the effect on `mint_count` per
`request_id` and with 7.22; the send-batch shape will not move, the hourly
job will only move when its owner edits it.

The two `sheets_grant_*` events instrument the **picker-first sheets
approval funnel**: opening a sheets approval link verifies the Google-side
`drive.file` grant (`via=link_open`); `result=missing` puts the Picker +
demo-video step BEFORE the approve button, and the approval itself re-fires
with `via=magic_link`. Picking a different sheet than the agent asked for is
an explicit substitution — `approval_link_approved` then carries
`substituted: true` and `granted_count`, making wrong-agent-id frequency
measurable. `/dashboard/sheets-setup` remains the recovery path for
pre-existing stranded rules (dashboard chips, MCP error links); a verified
re-check there fires `sheets_grant_recovered`. Funnel health =
`link_open{missing}` → `magic_link{ok}` conversion.

**"Opened, never approved" is not one population.** Reviewed 2026-09-09 (7 days,
production): of the accounts that opened a sheets/docs link and never approved
it, two had their agent CREATE a new spreadsheet through `google_api_modify`
within ~2 minutes of the open — auto-granted (`agent_sheet_created
{auto_granted: true}`), and both accounts were productive on the new sheet the
same day (60+ successful `sheets_*` calls on ids different from the denied one)
while the original sheet stayed unexposed and kept minting. Two more accounts
took the same route without ever opening the link. The link funnel reads all
four as leaks; the user's need was met by a substitute file. Before calling an
opened-not-approved link a stuck user, check the person's `agent_sheet_created`
/ `agent_doc_created` and successful `$mcp_tool_call.file_id` after the gate
hit (query: `monitoring.md` 7.15). The remaining opened-not-approved cases that
week were a sheet in a *different Google account* than the one connected to
FGAC (the Picker can never list it; both users cancelled within seconds and
went hunting through account settings — the approve page now names the
connected account and says to share the file with it) and a Workspace user
whose docs live in a shared drive (PR #126).

**The sheets/docs adoption funnel** (instrumented end to end since the PR #72
salvage, 2026-09): `picker_scope_redirect` → `picker_opened` →
`picker_picked` → `rule_saved{via}` → `*_grant_verification{result=ok}` →
first successful `$mcp_tool_call` carrying that `file_id`. The client picker
events cover the dashboard leg (the consent redirect being the riskiest hop —
`picker_scope_redirect` without a following `picker_opened` is an abandoned
consent; `picker_token_requested` is the server-side row for the same click and
is the only one that survives an ad blocker); `rule_saved.via` splits the three rule-creation paths
(`dashboard_manual`/`dashboard_picker`/`grant_api`/`magic_link` — the
dashboard Picker leg is `via IN ('dashboard_picker','grant_api')`); the
grant-verification
events say whether Google actually holds the `drive.file` grant (every path,
stranded-at-birth included); and `file_id` on `$mcp_tool_call` closes the
loop — per-file time-to-first-success from pick to working agent call. Join
the server stages on `file_id`; the client stages join per-person per-session
(picker events carry no file id until the pick).

`$mcp_tool_call` uses PostHog's **canonical MCP Analytics schema** (event and
`$mcp_*` property names) so PostHog's built-in MCP views resolve the tool name.
`$mcp_is_error` is true only for upstream failures/exceptions; the finer-grained
FGAC story is in the custom `outcome` property: `success`, `denied_by_policy`
(🚫 FGAC rule), `pending_approval` (⏳ connection not yet approved),
`size_capped` (⚠️ deliberate refusal to return an oversized payload — the tool
worked; before 2026-08-24 this classified as `failed` and inflated
`gmail_get_attachment` error-rate readings), `failed` (❌ auth/input problems — these carry `failure_reason`, see below),
`error` (upstream Google failure), `exception`.
Unauthenticated calls attribute to the `anonymous-mcp` / `anonymous-proxy` persons.

**The `error` vs `failed` vs `denied_by_policy` boundary (2026-09):**
`error` (`$mcp_is_error=true`) means FGAC or Google is unhealthy — 5xx,
`timeout`, `network`, throttling 403s (`usageLimits`), exceptions. `failed`
(`$mcp_is_error=false`) means the caller or user can fix it by acting
differently. The 2026-09-02 demotion moved three Google-guidance results from
`error` to ❌ `failed` (`fileGrantErrorResult`, `gmailNotFoundResult`,
`commentsErrorResult`) on the assumption that the Connector Directory reads
`$mcp_is_error`. **Measured 2026-09-03, that assumption was wrong**: the
directory's published per-tool error rate matches `outcome IN (error, failed)`
(google_api_modify showed 18.3% = error+failed; error alone was ~12%), so ❌
does not keep a result out of the public metric — only refusal-shaped 🚫
results (`denied_by_policy`) are excluded. Accordingly, on 2026-09-03 the
subset that is a *deterministic grant refusal carrying its own remediation*
graduated from ❌ to 🚫: the scope pre-flights (`gmailScopeDenial` /
`driveFileScopeDenial`, `denial_code: 'gmail_scope_missing' /
'drive_file_scope_missing'`, `failure_reason` still stamped for continuity)
and the per-file "not shared with FGAC at Google" 403/404 guidance
(`fileGrantErrorResult`, and id-addressed passthrough 404s, `denial_code:
'file_grant_missing_at_google'`). Stale-id 404s (`gmailNotFoundResult`,
`commentsErrorResult`) stay ❌ `failed`: they are caller-data errors, not
access refusals, and claiming otherwise would game the metric. Internal
observability is unchanged: rows still carry `error_status`, `error_reason`,
`error_domain`, and `gmail_404_site` where applicable. Error-rate trend
queries must not compare across these deploys — split on `outcome` and
date-bound at the deploy windows (2026-09-02 demotion, 2026-09-03 graduation).

**Malformed file ids never mint a link (drive-file-id hardening,
2026-09-09):** every per-file entry point (typed `sheets_*` / `docs_*` /
`comments_*` tools, the raw Sheets/Docs/comments branches of `google_api_get`
/ `google_api_modify`, and `request_access`) validates the caller-supplied id
BEFORE the rule lookup and before any approval link is minted
(`resolveDriveFileId` → `parseDriveFileId`). A value that is not a Drive id
(`[A-Za-z0-9_-]{20,80}`) is refused as 🚫 `denied_by_policy` with
`denial_code: 'file_id_malformed'` and no `approval_request_id`; a Docs URL
passed as a `spreadsheetId` (or the reverse) is `file_id_wrong_kind`, also
link-free, because a docs link for a sheet id is the same dead end (the
Documents Picker view never lists the sheet). Unambiguous forms are
normalized rather than refused — a full `docs.google.com/…/d/<id>/edit?usp=…`
URL, `drive.google.com/open?id=<id>`, or `<id>/edit` / `<id>#gid=0` residue —
and the event carries `file_id_input: 'url' | 'suffixed'` (`'malformed'` on
refusal; absent for a bare id) so URL-pasting agents stay countable, with
`file_id` then holding the normalized id. Before this change a `<realId>/edit`
or junk 44-character value was denied as `*_not_exposed` and minted a live
link for the literal value (verified locally 2026-09-08) that Google could
never verify — a dead end that looked like a one-click approval. Production
ids in the week to 2026-09-08 were all well-formed, so this is hardening,
not the cause of the docs_expose gap (`claude_busy-jang-032d40_v1`). Metric
boundary: these are caller-data errors like stale-id 404s, but they were
already 🚫 (`*_not_exposed`) before, so staying 🚫 moves nothing in the
public rate; `denial_code` is what separates them from real not-exposed
demand — exclude `file_id_*` codes from any not-exposed / approval-demand
count, and expect the `sheets_not_exposed` / `docs_not_exposed` counts in
monitoring.md §7 queries to drop by exactly the malformed share.

> **Legacy naming (before 2026-08):** tool calls were captured as a custom
> `mcp_tool_call` event with `tool` / `duration_ms` properties. That name
> collides with the event PostHog's archived beta MCP SDK once emitted, so the
> PostHog UI labels it "MCP tool call (legacy)" and its MCP views show no tool
> name (they read `$mcp_tool_name`). The old events still exist under the old
> name — insights spanning the rename must query both. Nothing in this codebase
> should ever emit `mcp_tool_call` again; QA capability 16 asserts this.

**Failure detail (2026-08 grant-race fixes):** every non-OK Google response
adds `error_status` (HTTP status, `network`, or `timeout`) to the
`$mcp_tool_call` event.
Sheets failures whose matching FGAC rule is fresh also carry
`sheets_grant_age_seconds`, and when the post-approval grace retry engaged,
`sheets_grace_retries` + `sheets_grace_recovered` — `recovered=true` volume is
the direct measure of how often the drive.file propagation race would have
surfaced an error to an agent. Google Docs calls carry the same trio under
`docs_grant_age_seconds` / `docs_grace_retries` / `docs_grace_recovered`.

**Google failure reason (gmail-failure-path-telemetry plan, 2026-08-26):**
`error_status` records only the HTTP status, which Google multiplexes across
unrelated conditions — most consequentially 403, which covers both a
missing/revoked OAuth scope and plain throttling. Every non-OK response now
also stamps `error_reason` (Google's `error.errors[0].reason`, e.g.
`rateLimitExceeded`, `insufficientPermissions`, `domainPolicy`) and
`error_domain` (`error.errors[0].domain`, e.g. `usageLimits`) when present.
These are Google-defined enum strings, never customer data. Since the
raw-api-error-quality change (2026-08-29), the extractor also reads the
gRPC-style `error.details[]` ErrorInfo shape that Sheets v4 / Docs v1 /
Slides v1 return (their bodies carry no legacy `errors[]` array — before
this, every error from those APIs landed with a null `error_reason`), and
when no reason enum exists anywhere, `error_reason` falls back to Google's
canonical `error.status` string (`PERMISSION_DENIED`, `NOT_FOUND`). `describeGoogleError`
branches its 403 remediation on them: before this, the 403 text asserted the
scope cause unconditionally and told rate-limited callers to reconnect a
working Google account — advice that is wrong for the whole `usageLimits`
class and that suppressed the retry which would have succeeded. **The
`insufficientPermissions` vs `usageLimits` split in production was unmeasured
when this shipped** (no PostHog query access at the time); `error_reason` is
what makes it measurable.

**Upstream timeout classification (sheets-tool-timeout-errors plan,
2026-08-28):** `googleFetch` aborts any single Google exchange at 50 s
(`GOOGLE_FETCH_TIMEOUT_MS`) and stamps `error_status: 'timeout'`. Before
this, a hung Google call ran into the route's 60 s `maxDuration` and Vercel
killed the function — which also destroyed the `$mcp_tool_call` capture (it
fires on handler completion, flushed in `after()`), so genuine upstream
timeouts were **invisible in PostHog**: the 2026-08-27 user-reported Sheets
timeouts left zero server-side telemetry. The 50 s bound comes from 30 days
of production durations: every tool's p99 ≤ ~13 s, but the 2026-08-23
Google slowdown produced reads that stalled 42–59 s and then succeeded, so
a tighter bound (e.g. 25 s) would have failed 11 calls that recovered.
`google_ms` (cumulative time inside `googleFetch`, summed across grace
retries) and `token_ms` (Clerk token fetch, bounded at 15 s) split
`$mcp_duration_ms` into Google-time vs FGAC-time, so "was Google slow?" is
answerable per call: `google_ms ≈ $mcp_duration_ms` means yes.

The proxy path gets the same treatment (shared constants in
`src/lib/upstreamTimeouts.ts`): its Google exchange is bounded at 50 s
(timeout → HTTP 504, `outcome: 'timeout'`, `error_status: 'timeout'`;
unreachable → 502, `error_status: 'network'`), its Clerk token fetch at
15 s, and `proxy_request` carries `google_ms` / `token_ms`. The proxy route
also now exports `maxDuration = 60` — it previously ran at the platform
default (≤ 15 s), so a slow-but-recoverable Google call died at the function
kill before any 50 s bound could matter.

`gmail_get_attachment` issues two requests — the parent message read, then the
attachment read — and both used to return the same generic "check the ID"
404. `gmail_404_site` (`message` | `attachment`) records which one failed.
`attachment` is the informative value: it means the parent read *succeeded*,
so the `messageId` is valid and the `attachmentId` is stale — the recoverable
case, since Gmail re-issues attachment ids when a message is re-indexed. This
property is the direct measure of open question "what is behind the
gmail_get_attachment 404s".

Since the attachment-selfheal change (2026-08-28), the server recovers that
case itself: the handler already holds a fresh parent read, so on an
attachment 404 — or a 400 (`Invalid attachment token`, Google's response to a
malformed/truncated id; measured against production 2026-08-28) — it
re-resolves against the parent's current attachment list and retries once when
the message has exactly one attachment.
`attachment_selfheal` records the branch — `recovered` (stale id healed,
outcome is success; the row still carries the first fetch's
`error_status: 404` or `400`), `retry_failed` (fresh id also failed), `ambiguous`
(several attachments; the error lists the current ids so recovery is one
retry), `no_attachments` (the id belongs to some other message).
`attachment_selector` (`id` | `filename`) says how the caller identified the
attachment — the new `filename` parameter resolves against the fresh parent
and cannot go stale, so a rising `filename` share is agents adopting the
robust path. Post-deploy confirmation query: breakdown of
`attachment_selfheal` for `tool = 'gmail_get_attachment'`, external users;
the fix is working if `recovered` absorbs the bulk of former 404 errors and
the tool's error rate converges toward the other Gmail read tools.

**Account-resolution failures (`failure_reason`):** `resolveAccountAndToken`'s
failure branches (`no_proxy_key`, `no_accessible_accounts`,
`account_not_permitted`, `google_token_unavailable`, and since 2026-09-04
`delegation_inactive` — the access row exists but the delegation behind it is
no longer active, so there is no token to fetch and nothing to reconnect)
return text without ever reaching Google, so they carry no `error_status` and
which branch fired used to be unrecoverable — the `outcome='failed'` blind
class. `failure_reason` names the branch.

**`account_not_permitted` splits by who chose the account (2026-09-08).** When
the CALLER passed an explicit `account` the key does not cover, the response is
a 🚫 refusal (outcome `denied_by_policy`, `denial_code: 'account_not_permitted'`,
`failure_reason` still stamped) that lists the usable accounts and says to omit
the parameter — the key's account list is user-configured policy, and one
Claude-desktop scheduled job hit the ❌ form hourly for four days (17 rows,
2026-09-05 → 09-08) with the fix never stated. Since 2026-09-11 it also says not
to retry with the same value, that no approval link exists for it, and — because
that same job went on to hit the 🚫 form 23 times in the next three days — that
a scheduled task must be corrected by its owner. When no account was given and
the owner's own address is not on the key, it stays ❌ `failed`: nothing the
caller sent caused it (0 rows since the split shipped), but the text now names
what would work.

**`google_token_unavailable` splits by cause (2026-09-04).** The tool-call
event's `google_token_error` says why Clerk returned no token (`no_token`,
`refresh_failed`, `grant_revoked` since 2026-09-09, `owner_not_found`,
`clerk_error`, `timeout`), and the outcome
now follows the cause: `no_token` / `refresh_failed` / `grant_revoked` /
`owner_not_found` are
states that cannot clear on their own, so they answer as a 🚫 refusal (outcome
`denied_by_policy`, `denial_code: 'google_token_unavailable'`, `failure_reason`
still stamped) naming who must act — the owner-bound reconnect link for the
first three, "sign in to FGAC again, then re-delegate" with no link for a missing
owner account; `clerk_error` /
`timeout` stay ❌ `failed` with retry-first guidance. `grant_revoked` is Clerk's
400 `oauth_token_retrieval_error` (Google refused the refresh: "Token has been
expired or revoked"); until 2026-09-09 it fell through to `clerk_error`, so the
three accounts it hit on 2026-09-08/09 got a pointless retry, ❌ "usually
temporary" text, and no reconnect link — 23 failures, zero recoveries, one
account retrying `sheets_get_spreadsheet` 14 times (docs/monitoring.md §7.13).
Do not compare `clerk_error` counts across that deploy either. Rationale, measured over
30 days of production: every MCP-path token failure was `clerk_error`, and the
one account producing one per day was healthy — a sibling call on the same
delegated mailbox ~100 ms away succeeded every time. The route now retries
that class once server-side (`google_token_retry`), so post-deploy the daily
`clerk_error` row should disappear from `google_token_fetch_failed` and
reappear as `google_token_retry='recovered'` on a successful tool call. Do not
compare `google_token_unavailable` failure counts across the deploy — split on
`outcome` and `google_token_error`. `error_reason` is deliberately NOT stamped
for this class: it means "Google returned this reason", and the token layer
never reached Google — `google_token_error` is the queryable cause.

> **Do not "tidy" these into `errorResult`.** They stay `textResult` on
> purpose. Note (2026-09-03): the ❌ `failed` class DOES count in the
> Connector Directory's published error rate (see the boundary section above)
> — these four stay `failed` anyway because a missing key, inaccessible
> account, or unfetchable token is a genuine malfunction of the connection,
> not a policy refusal. The scope pre-flights that used to sit alongside them
> graduated to 🚫 `denied_by_policy` because those ARE grant-state refusals
> with a one-click fix. `failure_reason` is also deliberately separate from
> `error_status`, which means "Google returned this HTTP status"; overloading
> it would corrupt that series.

**Response-size monitoring (google-docs-support plan v5, D7 — monitoring
only, no caps):** every `$mcp_tool_call` event carries `response_chars` and
`response_kb`, the serialized size of the tool result FGAC returned. MCP
clients impose their own tool-result budgets (Claude Code rejects results
over ~25k tokens), so a server-side "success" can be silently discarded
client-side. The confirmation question these props exist to answer: what
fraction of successful reads exceed ~25k tokens' worth of chars for
`client_name`-identified Claude Code connections, and do those calls
correlate with abandoned tool sequences? If material, per-kind caps with
recovery guidance get built (Phase 6 of the plan) with thresholds calibrated
from this distribution. `gmail_get_attachment` additionally carries
`attachment_chars`/`attachment_kb` on EVERY outcome that reaches the
attachment fetch — including the over-cap ⚠️ refusal (`outcome=size_capped`
since 2026-08-24), where the generic props only see the short refusal
message, so these are the only record of the actual size that triggered the
cap. Events where the attachment fetch itself failed can't carry a measured
size; those instead carry `attachment_declared_kb`, the size declared in the
parent message's MIME metadata (stamped before the fetch), so error rows are
still attributable to size vs genuine upstream failure. (These
two props were documented ahead of the code: the original commit `5aa23bd`
was stranded on an unmerged branch and the props first ship with the
raw-api-classification change, 2026-08-21.) The pre-existing 200k-char cap
is unchanged.

**Windowed large responses (gmail-attachment-pagination plan v3):** the
2026-08 size-capped demand was bimodal — 8 of 11 external `size_capped` rows
were 215–331 KB documents (barely over the cap), 3 were 1.8–17.5 MB. Rather
than the server guessing (extraction, fixed chunk sizes), the pattern is
caller-directed windowing: `offset` + `limit` params on every read tool with a
potentially-oversized payload — the agent sizes windows to its *own* harness's
tool-result budget. Windows are plain substrings (base64url data for
`gmail_get_attachment`; the serialized response for `gmail_read` — body
untruncated when windowed — `docs_read_document`, `sheets_get_spreadsheet`,
`sheets_read_range`, and `google_api_get`) inside a uniform envelope
(`total_chars`, `next_offset`), so contiguous windows concatenate to exactly
the original payload. Deliberately NOT windowed: tools with native Google
pagination (`gmail_list`, `comments_read`), small bounded reads, and all
write tools (re-issuing a write to page its response would repeat the side
effect). The ⚠️ `size_capped` refusal
remains for over-cap attachment calls that pass no window params, stays
non-`isError`, and names the continuation. Windowed calls stamp
`window_offset`, `window_chars`, `window_total_chars`. Confirmation queries:
external `size_capped` events should be followed (same user, minutes) by
windowed calls rather than silence; `window_total_chars` distribution sizes
real large-payload demand per tool.

**Raw Google API classification (raw-api-classification plan):** every
`google_api_get` / `google_api_modify` call stamps four props at
classification time, denials included — `raw_api_kind` (the
`classifyGoogleApiCall` result: `sheets`, `sheets_create`, `docs`,
`docs_create`, `gmail_read`, `gmail_send`, `gmail_draft_send`, `gmail_write`,
`passthrough`, `denied`),
`raw_api_family` (Google product: `gmail`, `spreadsheets`, `documents`,
`slides`, or the classifier's first-two-segments family for passthroughs;
omitted on denials, which carry `denial_code` — except
`raw_api_family_unsupported` denials, which keep the family so per-family
demand for un-granted APIs stays visible), `raw_api_endpoint` (the HTTP method plus
the **id-stripped** path template from `templateGoogleApiPath`, e.g.
`GET gmail/v1/users/me/messages/{id}` — identifiers are customer data and
high-cardinality, so they never land on events), and `raw_api_mutating`.
Passthrough calls additionally keep `raw_api_passthrough: true`. Raw paths
were never captured before this change, so there is no backfill — coverage
starts at the deploy.

Since raw-api-error-quality (2026-08-29): classification+stamping runs in the
tool handler **before** account resolution, so resolution failures carry the
raw props too (previously they landed with null endpoint/family);
`messages/send` templates literally instead of as `messages/{id}` (new
template value — historical events keep the old one); families FGAC's grant
can never authorize (People, Calendar, Tasks, YouTube, …) are refused
pre-flight with `denial_code: 'raw_api_family_unsupported'` (outcome
`denied_by_policy`, family kept on the event) instead of forwarding to Google
and surfacing an opaque 403/404 error; Slides paths route to
`slides.googleapis.com` as passthrough family `slides` (they previously hit
`www.googleapis.com`, which does not serve Slides, and 404ed unconditionally).

Since gmail-write-allow-by-default (2026-08-30): non-send Gmail writes are no
longer denied — they land as `raw_api_kind: 'gmail_write'` (family `gmail`,
`raw_api_mutating: true`, id-stripped endpoint), which is the demand feed for
the future Gmail-write rule engine. `drafts/send` lands as `gmail_draft_send`
and rides the send whitelist. `denial_code: 'gmail_write_unsupported'` now
means ONLY a permanent-deletion attempt (`messages/batchDelete`) — historical
events with that code (pre-2026-08-30) cover ALL non-send Gmail writes, so
trend queries must not compare across the deploy. New code
`gmail_settings_unsupported` = a Gmail settings write refused for missing
`gmail.settings.*` scopes (family `gmail` kept on both, like the
family-unsupported denials). `messages/batchModify`, `batchDelete`, `insert`,
and `import` are new literal template values (previously `messages/{id}`).

**`client_name`:** populated from the MCP `initialize` handshake's
clientInfo — the auth layer parses it (the only request that carries it in
stateless streamable HTTP; see `src/lib/mcpClientSignals.ts`), stores it on
`agent_connections.client_name` at creation, and backfills rows still holding
the opaque `client_id` placeholder on their next initialize (that backfill
also fires `mcp_connection_client_identified`, since the creating request is
in practice never the initialize POST and `mcp_connection_created` therefore
fires nameless). It then rides on
every `$mcp_tool_call` (via `requireApproval`) alongside `user_agent`, and
`mcp_client_initialize` records it once per session — this is what makes the
per-product split (Cowork / Claude Code / Claude.ai) reproducible. Coverage
starts at the deploy; rows for clients that never re-initialize stay opaque.
Capturing DCR `client_name` at OAuth registration remains a possible
supplement.

**`connector_install_started`: never read raw counts as people, and never
read fingerprints as claude.ai people either.** It fires anonymously
(distinct_id `anonymous-mcp`) from the only FGAC-owned touchpoints that exist
before a Clerk account: the OAuth discovery endpoints
(`touchpoint=oauth_discovery`, recurs on reconnects) and unauthenticated MCP
requests (`touchpoint=mcp_401`). The mcp_401 emission is **per-request
identical to `mcp_auth_attempt` failures by construction** (same `!authInfo`
path in `verifyMcpAuth`; `reason` ≡ `outcome`), so raw event counts are
401/retry volume — an established client with an expired token can emit
dozens of "installs" a day, which is exactly the artifact that made
install→signup conversion look like it collapsed in late August 2026.
`install_fingerprint` (salted sha256 of ip+user-agent; salt =
`ANALYTICS_FINGERPRINT_SALT`, falling back to `CLERK_SECRET_KEY`) de-duplicates
**direct** clients only: claude.ai traffic reaches us through Anthropic's
shared egress proxy, so for `user_agent = 'Claude-User'` one fingerprint is
one Anthropic IP serving many users (2026-09-08: 22 fingerprints for three
weeks of `Anthropic/ClaudeAI` installs against 55 completed accounts). The
directory top-of-funnel proxy is therefore the count of unauthenticated
claude.ai `initialize` requests (`client_name = 'Anthropic/ClaudeAI'`,
`reason='no_token'`, `method='POST'`) — one per attempt plus retries, an
upper bound — compared against Clerk accounts created through the connector
(`npm run funnel:scopes -- --prod`). Coverage starts at the client-name
capture (2026-08-24); earlier data supports no attempt count at all. Filter
crawlers with `client_class` (since 2026-09-10: the MCP Registry listing
brought ~60 distinct crawlers and health probes in its first nine hours, and
`direct_client_fingerprints` went 11 → 96 on scanner traffic alone; many of
them run on a stock `node`/`undici`/`python-httpx` user-agent and are only
identifiable by `client_name`, which is why the class reads both fields —
`monitoring.md` 7.21). Named queries: `monitoring.md` 7.5 (attempts),
7.17 (directory disconnect-rate model) and 7.18 (per-person funnel). Rotating
the salt resets fingerprint continuity — compare uniques only within one salt
era.

Payload capture is deliberately **off**: we never send `$mcp_parameters` or
`$mcp_response` (they would carry customer mail/sheet content into PostHog).
For the same reason, do not adopt `@posthog/mcp` / `npx @posthog/wizard
mcp-analytics`, which captures both with no redaction option.

Every event (client and server) carries an `environment` property:
`development` (localhost), `preview` (`*.vercel.app`), or `production` — all three
Vercel environments share one PostHog project, so filter on it.

## Sign-up funnel / abandoned sign-ups

Create a PostHog funnel insight: `sign_up_started` → `sign_up_completed`
(conversion window ~1 hour). Drop-off = people who opened the Clerk modal but never
finished (the modal + Google OAuth steps in between are Clerk-internal and not
individually observable). The anonymous click merges into the identified person
once the new user's first signed-in page load calls `identify`.

**Required Clerk dashboard config** (both dev and prod instances): the webhook
endpoint `/api/webhooks/clerk` must be subscribed to `user.created` in addition to
`user.deleted`.

## Separating QA/internal traffic from genuine traffic

1. **Filter every insight to `environment = production`.** This removes all local
   dev-server and preview-deployment traffic (the bulk of QA volume).
2. **Create a cohort "Internal / QA"**: persons where `email` is any of the QA test
   accounts or founder accounts (the emails live in 1Password /
   `.qa_test_emails.json`; they are deliberately not listed in this public repo).
   Exclude the cohort from dashboards. This catches QA runs against production.
3. **Historical events (before this instrumentation)** are anonymous and cannot be
   retro-identified. To triage a past traffic spike, break `$pageview` down by
   `$host`: `localhost:3000` and `*.vercel.app` volume is QA by definition; only
   the production-domain remainder is potentially genuine.

## Implementation notes

- Server capture is fire-and-forget: `captureServerEvent()` no-ops when
  `NEXT_PUBLIC_POSTHOG_KEY`/`_HOST` are unset and flushes via Next's `after()` so
  serverless responses aren't delayed and events aren't dropped.
- MCP instrumentation wraps `server.registerTool` once (see `/api/mcp/route.ts`),
  so newly added tools are instrumented automatically.
- Video plays: Descript embeds implement the player.js (Embedly) protocol and
  also post a bare `descript:embed:played` string to the parent window on
  play (verified empirically 2026-08). `TrackedVideoEmbed` listens for either,
  scoped per-iframe via `event.source`, and captures `video_played` once per
  mount. New demo videos must use `TrackedVideoEmbed`, not a raw `<iframe>`.
- The proxy records `proxy_key_id` (the row's UUID) — never the `sk_proxy_` secret.
