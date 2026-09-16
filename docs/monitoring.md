# Auth & MCP Endpoint Monitoring

Monitoring stack for the `/api/mcp` auth path, introduced alongside the JWKS
singleton + strategy-memo optimizations (see
`docs/implementation_plans/claude/mcp-auth-cache-monitoring_v1.md`).

Guiding principle: **an auth regression looks like silence, not errors** — MCP
clients that receive 401s stop calling. Monitoring therefore watches volume
floors as much as error rates.

## 1. Instrumentation: `mcp_auth_attempt` (PostHog, server-side)

Captured in `verifyMcpAuth` (`src/app/api/mcp/route.ts`):

| property | meaning |
| --- | --- |
| `outcome` | `ok` \| `invalid_token` \| `no_token` |
| `client_id` | OAuth client registration id — opaque, per client registration, never a user identifier. Verified value on `ok`; the unverified token claim on failures (present so a 401 storm can be attributed to a client). Same property already carried by `$mcp_tool_call` and `mcp_connection_created`, so the three join on it |
| `strategy_used` | `clerk` \| `direct` \| `none` |
| `memo_hit` | whether the per-client strategy memo routed this request |
| `optimizations_enabled` | kill-switch state at capture time |
| `error_class` | Clerk auth() error name, when it threw |
| `kid` | signing-key id from the (unverified) token header, on `invalid_token` only |
| `method` | HTTP verb (`POST`; a `GET` is a client opening the optional SSE stream and taking the stateless 405 — rare in production, one per process start for a locally run CLI) |
| `connection_resolve` | what the auth layer's eager `resolveConnection` did on this request: `ran` (four Neon round trips), `skipped` (touched within the last 5 minutes by the same user+client — `src/lib/connectionTouchMemo.ts`), `error`. Added 2026-09-08 |
| `connection_resolve_ms` | wall time of that eager resolve when it ran; the per-request DB cost of a handshake (see 7.16) |
| `user_agent`, `client_name` | who failed: the request's UA and, when the unauthenticated request was an MCP `initialize`, its self-reported `clientInfo.name`. Added 2026-09-10 so a 401 spike is diagnosable from this event alone (the registry-launch spike had to be attributed by joining `connector_install_started` by minute) |
| `client_class`, `client_class_signal` | `claude` \| `internal` \| `scanner` \| `direct`, and the rule that decided it (`ua:SmitheryBot/`, `name:glama`, `keyword:probe`, `ua:self-link`). `scanner` = MCP registry crawlers, directory health probes, "MCP security" scanners, SEO bots — classified from **both** fields because about a third of them run on a stock `node` / `undici` / `Go-http-client` / `python-httpx` UA and only identify themselves in `clientInfo.name`. `classifyMcpClient` in `src/lib/mcpClientSignals.ts`; also stamped on `connector_install_started`. Since 2026-09-12 a `direct` row can carry `client_class_signal = 'ua:stock-runtime-no-name'`: a bare HTTP runtime UA (`Bun/`, `Python/… aiohttp/`, `Go-http-client/`, `node`, `undici`, `python-httpx/`) with no `clientInfo` at all — unnamed automation, still `direct` because the real SDKs run on the same runtimes, but not a client that broke (every SDK's first request is an `initialize` that names itself). A measurement label only: nothing is blocked or rate-limited on it, and a 401 is the correct answer to every probe. Added 2026-09-10; see 7.21 |

Volume control: failures always capture; successes are sampled **1 in 20 per
request** (`success_sample_rate` carries the factor). Multiply `outcome=ok`
counts by 20 to estimate true success volume — this is valid **only from the
2026-08-25 fix onward** (see below).

Sampling mechanics (`src/lib/authSampling.ts`, guarded by
`scripts/test-auth-sampling.ts` in `npm run mcp:lint`): each request draws
independently, `Math.random() * 20 < 1`. The draw is deliberately independent
of the token, the user, and the client — that independence is what makes
`ok * 20` an unbiased estimator. A retried request draws again and may be
counted twice; that is correct for a volume estimate and is the price of
unbiasedness.

**Do not make this gate a function of the bearer token.** Two shipped versions
did, and both were biased:

| shipped | mechanism | defect |
| --- | --- | --- |
| 2026-08-23 (launch) | hash of the token's first 64 chars | those chars sit inside the per-instance-constant Clerk JWT header, so every production token hashed identically and the modulus resolved to *never*: **zero** `ok` rows against ~900 successful tool calls |
| 2026-08-24 (PR #81) | hash of the token's signature segment | fixed the constant-hash defect, but still decided **once per token**. A token was always-sampled or never-sampled for life, so a heavy client could contribute zero events regardless of volume. With ~50 active users the token population is small, making this a biased sample over a few tokens rather than a 1-in-20 sample of requests |

The tell for the second defect was clumping: on 2026-08-24, `ok` was zero for
13 consecutive hours (06:00–18:00Z) across a day of continuous traffic
(678 external tool calls), then 40 in the single hour 19:00Z, then clumps and
gaps on 8/25 — while unsampled `no_token` fired every hour throughout,
confirming the endpoint was serving the whole time.

### Historical `ok` counts are not volume — do not multiply them by 20

Any figure derived by multiplying pre-2026-08-25 `ok` counts by 20 is wrong,
and several reports quoted such figures. Correct handling by era:

| era | what `ok` means | how to get volume |
| --- | --- | --- |
| before 2026-08-24T18:10Z | nothing — no `ok` rows exist | use `$mcp_tool_call`, or `no_token` as an activity floor |
| 2026-08-24T18:10Z – 2026-08-25 fix | a near-complete census of a few tokens, plus nothing at all from everyone else | use `$mcp_tool_call`; `ok * 20` overstates by ~20x for the tokens it saw |
| after the 2026-08-25 fix | an unbiased 1-in-20 sample of successful requests | `ok * 20`, ±~2% at daily volumes |

The middle row is the counter-intuitive one and is worth understanding before
reading any report from that window. Because the gate was deterministic on the
token, a token that hashed in was captured on **every single request** — not
one in twenty. So `ok` was not a thinned sample of all traffic; it was an
essentially complete count of a handful of users' requests, and silence from
everyone else. Two measurements from production confirm this:

- **2026-08-24, post-deploy**: 63 `ok` events against 55 `$mcp_tool_call`
  events. `ok` *exceeding* tool calls is impossible under real 1-in-20
  sampling, and is exactly what full capture of a subset predicts.
- **2026-08-25**: only **5 of 17** users who made tool calls produced any `ok`
  event. The other 12 were invisible regardless of how much they called.

Hence `ok * 20` inflated the visible users' traffic roughly twentyfold while
scoring the rest at zero, and the net error swung with who happened to hash in
— about 1.7x too high on 8/24 (63 x 20 = 1,260 against 763 tool calls) and
about 5x on 8/25 (61 x 20 = 1,220 against 247). Treat any number from this
window as unusable rather than merely imprecise.

`strategy_used` and `memo_hit` carry the same era caveat: they were only ever
recorded on whichever tokens the old gate happened to admit, so mixes read
before the 2026-08-25 fix are not representative.

The unsampled events (`no_token`, `invalid_token`) were correct throughout and
are the trustworthy series for any historical question.

## 2–3. PostHog alerts (hourly evaluation, email to Ken)

| alert | insight | threshold | rationale |
| --- | --- | --- | --- |
| MCP tool-call volume floor | [MFYwjsQU](https://us.posthog.com/project/343912/insights/MFYwjsQU) | completed day < 50 tool calls | observed daily range 168–1,203 post-launch; near-zero = clients silently locked out |
| MCP invalid_token spike | [mGzUClRs](https://us.posthog.com/project/343912/insights/mGzUClRs) | day (incl. today) > 50 invalid_token failures, **excluding `kid = 'probe'` and `client_class IN ('scanner', 'internal')`** | real-user baseline is **0–2/day**; a spike means verification broke or a rejection storm |

**The invalid_token alert must exclude our own synthetic probes.** Every
`invalid_token` event carrying `kid = 'probe'` comes from
`scripts/mcp-auth-probe.ts`, whose garbage token is minted with
`kid: 'probe'` / `client_id: 'auth-probe'` — see the constant in that file.
`.github/workflows/auth-probe.yml` schedules it every 15 min (96/day nominal;
GitHub throttles scheduled runs, so observed volume is lower). Measured
2026-08-25, probe share of `invalid_token`:

| day | invalid_token | of which `kid='probe'` |
| --- | --- | --- |
| 8/23 | 10 | 10 |
| 8/24 | 39 | 38 |
| 8/25 (partial) | 18 | 18 |

Without the filter the alert pages on its own monitoring — 38/day against a
threshold of 50, with the only headroom being GitHub's throttling.

**Real user invalid-token volume is 0/day.** The single non-probe event in
three days (8/24 13:00Z) carried `kid='ins_fake'` — a manual test during the
PR #81 work, not a user. The documented "0–5/day baseline" predates the probes
and was never a user-traffic figure. With the probe filter applied a threshold
of 50/day is therefore very loose: treat any sustained non-probe
invalid_token traffic as worth investigating well below it.

Caveat, deliberately recorded: `kid` and `client_id` are read from the
**unverified** token header/payload, so the exclusion filter is spoofable — a
caller could set `kid='probe'` to keep its own 401 storm out of this alert.
That is acceptable here because the alert is a monitoring signal, not an access
control (nothing is authorized on these values; see `unverifiedTokenClaims`).
The compensating control is the tool-call **volume floor** alert, which is
driven by authenticated traffic and cannot be suppressed this way. If probe
contamination ever needs a non-spoofable fix, give the probe its own path or a
dedicated environment rather than trusting a token claim.

**The stored insight did not carry the probe filter (found 2026-09-10).**
Read back through the API that day, insight 11264607's definition held only
`environment = production` and `outcome = invalid_token` — the `kid != 'probe'`
exclusion this section describes was never on it, so the alert has been
counting our own probe all along and stayed quiet only because GitHub
throttles the schedule (4–10 probe rows/day). The fix is two property filters
on the insight, and **it is a user action** — the automation key has
`query:read` only (`insight:write` denied):

1. `kid` **is not** `probe`
2. `client_class` **is not** `scanner`, `internal`

PostHog's *is not* matches events that lack the property, so rows from before
the 2026-09-10 deploy stay counted (they carry no class) and no history is
lost. The threshold stays at 50: with both exclusions the real-user rate is
0–2/day (7.21), and the 09-10 crawler wave — 28 junk-bearer rows from one
`python-httpx2/…` client in nine hours, on pace for ~75/day — is exactly the
traffic the second filter removes.

**Why a second exclusion.** The MCP Registry listing (2026-09-10) brought a
population of registry crawlers, health probes and security scanners that
send no token or a junk bearer. `no_token` went 35/day → 216 in the first
eleven hours; every non-probe `invalid_token` that day came from a single
scanner. Their 401s are correct behaviour, not a regression, and they must
not read as one: `client_class` (section 1) is the label, 7.21 is the
reading. Like `kid`, the class is derived from caller-controlled strings and
is spoofable in both directions; the same compensating control applies (the
tool-call volume floor is driven by authenticated traffic).

Threshold review: revisit both after 2 weeks of `mcp_auth_attempt` history.

## 4. Synthetic probe

- `scripts/mcp-auth-probe.ts` — no-secret probes: 401+`WWW-Authenticate` on
  bare POST, 401 on garbage token (pinned-issuer path), 200 on OAuth resource
  metadata. Optional `PROBE_PROXY_KEY` (QA `sk_proxy_` key) adds an
  authenticated `/api/proxy` leg.
- `.github/workflows/auth-probe.yml` — every 15 min against https://fgac.ai;
  a failing run is the alert (GitHub notifies on workflow failure).
- Run manually against any environment:
  `PROBE_BASE_URL=https://<preview-url> npx tsx scripts/mcp-auth-probe.ts`
- **Known gap**: no synthetic covers the fully-authenticated MCP OAuth path
  (needs a live Clerk OAuth client token). The proxy leg covers DB + key auth +
  Google token retrieval; real-user coverage of the OAuth path comes from the
  volume-floor alert.

## 5. Vercel Observability baseline (pre-optimization)

Production, last 12h, read 2026-08-23 (project → Observability → Functions):

| metric | value |
| --- | --- |
| `/api/mcp` invocations share | 74% of all function invocations |
| Active CPU per `/api/mcp` request | ~68 ms |
| P75 Active CPU (all routes) | 153 ms |
| `/api/mcp` error rate | 0% |
| Cold start rate | 6.7% |
| CPU throttle P75 (Hobby) | 15.4% |

(The baseline above was read while the team was on the Vercel Hobby plan; the
team upgraded to Pro in September 2026, so the throttle row is a Hobby-era
artifact. Pro has no per-metric caps — usage draws from a $20/month included
credit and then bills on-demand, so budget questions are cost-pace questions,
not exhaustion questions. The Neon org moved to the Launch plan at the same
time: pay-as-you-go compute/storage, 10 included branches then
$1.50/branch-month, no service pause on overage.)

After the production deploy, re-read the same view and compare Active CPU per
request and error rate. Expected: CPU down 30–50%; error rate unchanged at ~0%.

## 6. Rollout / rollback

- Kill switch: set `MCP_AUTH_OPTIMIZATIONS=disabled` in Vercel env and
  redeploy — restores legacy auth behavior (fresh JWKS per request, fixed
  clerk→direct order) without a code revert.
- Rollout order: preview validation (`/deploy-pr-preview` + probe script
  against the preview URL) → user-gated production deploy (`/deploy-prod`) →
  Observability + `mcp_auth_attempt` comparison after 24h.

## 7. Routine checks (named queries)

Run these against PostHog project 343912. Each names the result that means
"healthy" — do not leave a check as "look at PostHog".

**7.1 — Success volume (the corrected estimate).** Valid only for windows
after the 2026-08-25 sampling fix; see the era table in section 1.

```sql
SELECT toStartOfHour(timestamp) AS hour,
       countIf(properties.outcome = 'ok') * 20 AS est_successes,
       countIf(properties.outcome = 'no_token') AS no_token
FROM events
WHERE event = 'mcp_auth_attempt' AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour ORDER BY hour
```

Healthy: `est_successes` is non-zero in every hour that carries traffic, and
rises and falls together with `$mcp_tool_call`. Do **not** expect the two to
match: this counts authenticated *requests*, and every MCP request
authenticates (`initialize`, `tools/list`, `ping`, each tool call), so
`est_successes` should sit comfortably **above** tool-call volume. The ratio is
a per-client property of how chatty its MCP session is — establish the normal
ratio empirically before treating a change in it as signal.
**Zero `ok` across several consecutive active hours is the exact signature of
the sampling bias returning** — check `src/lib/authSampling.ts` before
concluding the endpoint is down.

**7.2 — Strategy mix and memo hit rate, per client.** This is the check that
`client_id` was missing for; it could not be evaluated per client before
2026-08-25.

```sql
SELECT properties.client_id AS client,
       countIf(properties.memo_hit) / count() AS memo_hit_rate,
       count() AS sampled_attempts
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.outcome = 'ok'
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY client HAVING sampled_attempts > 5 ORDER BY sampled_attempts DESC
```

Healthy: repeat clients show `memo_hit_rate` near 1.0. A client stuck near 0
is either newly registered every request or missing the memo — investigate
`strategy_used` for that client. Note counts here are 1-in-20 sampled, so give
a client a few hundred real calls before reading its rate.

**7.3 — Auth failures attributed to a client.** The "clients went silent after
401s" failure mode this instrumentation exists for.

```sql
SELECT properties.client_id AS client, properties.outcome, properties.error_class,
       count() AS n
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.outcome != 'ok'
  AND properties.kid != 'probe'
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY client, properties.outcome, properties.error_class ORDER BY n DESC
```

Healthy: no `invalid_token` from a real client (`kid != 'probe'`) — real-user
invalid-token volume is 0/day. `no_token` is expected and benign: it is the
pre-OAuth discovery handshake, not a failure.

**7.4 — Identity-drift self-heal.** Watches the drifted population from
`4b551018` shrink to zero.

```sql
SELECT toDate(timestamp) AS day, count() AS fallbacks, uniq(person_id) AS users
FROM events
WHERE event = 'google_token_identity_fallback' AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

Healthy: **zero**, which is where it starts. Measured 2026-08-25: the fallback
branch has not fired once in production since `4b551018` deployed — the
`google_token_identity_fallback` tool-call property appears on 0 calls and is
absent from the project taxonomy entirely, and `google_token_fetch_failed` went
7 events / 2 identities on 8/24 to 0 on 8/25. The drifted population appears to
have already self-healed through the dashboard re-sync path.

So this counter is **forward-looking, not retrospective**. It cannot recover how
many users the fallback rescued before it existed; that window has closed. What
it does is make new drift visible: a **rising** count means drift is being
created again, which would be a regression in `clerkPrimaryEmail` /
`resolveDbUser` rather than a self-heal, and is worth investigating at the first
non-zero day. The event is unsampled and independent of `$mcp_tool_call`, so
these counts are exact.

**Deploy-lag caveat (2026-08-27):** the standalone event shipped in `2ed046b`
(main, 2026-08-25) but production ran older code past that date — prod emits
only the `google_token_identity_fallback` **property** on `$mcp_tool_call`.
Until the deploy carrying `2ed046b` is confirmed live, this watch item must
query the property, not the event:

```sql
SELECT toDate(timestamp) AS day, count() AS fallbacks, uniq(person_id) AS users
FROM events
WHERE event = '$mcp_tool_call' AND properties.google_token_identity_fallback = 'true'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

Measured 2026-08-27 via that property query: **28 fallbacks in the trailing
week** — no longer the zero measured on 2026-08-25. Per this runbook's own
rule, a rising count means drift is being *created* again (a
`clerkPrimaryEmail` / `resolveDbUser` regression), and is open for
investigation.

**Resolved 2026-08-31.** The non-zero count was one user, not new drift: a
pre-`4b551018` split (`users.email` synced to a changed Clerk primary before
the access-row re-point existed) that could never self-heal, because the
2026-08-25 "healed through the dashboard re-sync path" assumption does not
hold for **MCP-only connector users** — the MCP request path runs
`resolveDbUser` only when auto-creating a missing row, so an existing drifted
row is never re-synced there, and a user who never loads the dashboard stays
drifted forever (this user fired the fallback on every call across 6 days,
all rescued successfully). Fixed by healing inside the fallback branch
itself: when `checkOwnClerkEmail` confirms the target address belongs to the
key owner and the Clerk primary differs from `users.email`, the route now
runs the same `resolveDbUser` heal the dashboard uses, so the next call takes
the happy path.

**Reading this counter after the self-heal fix:** any one person should fire
the fallback for at most one call (or one short burst, if the heal races
concurrent calls) before going quiet. Watch `uniq(person_id)`:

- occasional single-person, single-burst blips = drift created and
  immediately healed — log-worthy, not alarming;
- the **same person recurring across days** = the heal is not landing for
  them (regression, or a genuinely multi-address account routinely calling a
  verified non-primary address — a supported state the heal deliberately
  leaves alone because the Clerk primary already equals `users.email`);
- **growing `uniq(person_id)`** = drift is being created faster than a
  one-shot heal event per user, i.e. a `clerkPrimaryEmail`/`resolveDbUser`
  regression. Investigate.

**7.5 — Install attempts (top of the acquisition funnel).** Raw
`connector_install_started{mcp_401}` counts are per-request identical to
`mcp_auth_attempt` failures (same code path) — they measure 401/retry volume,
not people. `install_fingerprint` (salted ip+user-agent hash, deployed
2026-08-27) was meant to be the uniqueness key, but **for claude.ai traffic
it is useless: every claude.ai request arrives from Anthropic's shared egress
proxy, so one fingerprint is one Anthropic IP serving many users** (measured
2026-09-08: 22 fingerprints for `Anthropic/ClaudeAI` over three weeks, 16 of
them recurring across days, against 55 completed connections). Fingerprints
still de-duplicate direct clients (claude-code, curl), but never divide
sign-ups by them for a claude.ai conversion rate — and since 2026-09-10 they
must also exclude `client_class IN ('scanner', 'internal')`: the MCP Registry
listing took `direct_client_fingerprints` from 11–17/day to 96 in its first
nine hours on crawler traffic alone (7.21). Rows before that deploy carry no
class; on those days the column is contaminated by whatever crawlers were
active (a handful/day before the listing).

The usable proxy for "clicked Connect in the directory" is the count of
unauthenticated claude.ai `initialize` requests: one per install attempt, plus
retries, so it is an **upper bound on attempts** (2026-08-28 → 09-08: 91
requests for 55 Clerk accounts created through the connector, i.e. roughly 1.6
requests per completed account). The exact denominator lives only on
Anthropic's side (the listing dashboard's "accounts that sent any message").

```sql
SELECT toDate(timestamp) AS day,
       countIf(properties.client_name = 'Anthropic/ClaudeAI') AS claudeai_unauth_initializes,
       countIf(properties.client_name = 'claude-code')        AS claude_code_unauth_initializes,
       uniqIf(properties.install_fingerprint,
              properties.user_agent NOT IN ('Claude-User')
              AND coalesce(properties.client_class, '') NOT IN ('scanner', 'internal'))
                                                              AS direct_client_fingerprints,
       countIf(properties.client_class = 'scanner')           AS scanner_401s,
       count()                                                AS raw_401_volume
FROM events
WHERE event = 'connector_install_started'
  AND properties.touchpoint = 'mcp_401'
  AND properties.reason = 'no_token' AND properties.method = 'POST'
  AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 14 DAY
GROUP BY day ORDER BY day
```

Compare `claudeai_unauth_initializes` against the same day's Clerk accounts
created through the connector (`npm run funnel:scopes -- --prod`, or
`sign_up_completed` persons whose `signup_source` is not `website`). A large
`raw_401_volume` over the initialize count is retry pressure from established
clients, the artifact that previously read as a conversion collapse. A never-
authenticated connector does NOT keep pinging: unauthenticated initializes
stay at 5–11/day while authenticated ones run 200–450/day, so "connected but
never signed in to Clerk" is not a recurring population on our side.

**7.6 — Gmail-scope lockouts.** Users whose Google grant lacks the Gmail scope
(Gmail checkbox unchecked on Google's consent screen) 403 on every Gmail call
while the rest of their traffic works — measured 2026-08-28 as repeated
per-user `gmail_list` 403s (9.5% tool-error rate on the entry-point tool).
Since 2026-08-28 the MCP path pre-flight-denies these calls
(`denial_code` = `failure_reason` = `'gmail_scope_missing'`; outcome
`denied_by_policy` since 2026-09-03, `failed` before that) and fires the
unsampled standalone event:

```sql
SELECT toDate(timestamp) AS day, count() AS calls, uniq(person_id) AS users
FROM events
WHERE event = 'google_scope_missing' AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

`uniq(person_id)` is the size of the locked-out population. Since 2026-08-29
the event carries a `scope` prop (`gmail` / `drive_file`): the `drive_file`
variant fires from the raw google_api_* path when the token lacks `drive.file`
(the cause behind the 2026-08 `POST v4/spreadsheets` 403s) — group by `scope`
to separate the two populations. Healthy: zero.
Non-zero is not a code regression — it is users needing the reconnect nudge the
tool error now delivers; watch whether the same person persists across days
(nudge not working) or disappears (reconnected). Cross-check that gmail 403s
with `error_reason` in (`insufficientPermissions`,
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`) trend to zero on `$mcp_tool_call` — the
pre-flight should absorb them before Google is called.

**Quiet-probe caveat (2026-08-30):** `list_accounts` now probes every
accessible account's token to report per-account scope state
(`account_details`). Those probes run `getGoogleToken` in **quiet mode** —
they fire NO `google_token_identity_fallback` / `google_token_fetch_failed`
events and stamp no `google_token_error`/`token_ms` tool-call props — so the
§7.4 and §7.6-adjacent counts above keep meaning "a real tool call hit this",
not "someone listed accounts". `google_scope_missing` itself never fired from
list_accounts (it comes from the denial pre-flights, which list_accounts does
not run).

**7.7 — Wrong-account reconnect opens.** A reconnect link is bound to the
account it repairs (`?reconnect=1&for=<email>`, 2026-08-30); opened by a
different signed-in FGAC user, the Accounts page suppresses the auto-fire and
warns instead. Suppression also removed the old forensic signature (the wrong
user's `google_reconnect_started` seconds after another user's
`google_scope_missing`), so the card fires this client event to keep the
population countable:

```sql
SELECT toDate(timestamp) AS day, count() AS opens, uniq(person_id) AS users,
       uniq(properties.intended_for) AS intended_accounts
FROM events
WHERE event = 'google_reconnect_wrong_account'
  AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

Verified end-to-end 2026-08-31 (pre-merge): QA opens from the preview and local
dev environments landed with `intended_for` populated, one event per open —
which is why the environment filter above matters for this event in particular.

Recovery check: for each `intended_for`, look for a later
`google_reconnect_started` by the person whose identity matches that address —
present means the right user eventually ran the repair; absent means the
affected account is still stranded and worth proactive outreach.

**7.8 — Reconnect round-trips that never come back.** The reconnect funnel is
`google_reconnect_started` → `google_reconnect_returned` (the Accounts page
processed `?reconnected=1`) → `google_reconnect_verified` or
`google_reconnect_incomplete` (2026-09-03; before `returned`/`verified`
existed, silence after `started` was unreadable). A start with no `returned`
within the session means the user either abandoned Google's consent screen or
— the case that motivated this — completed consent but lost their session
during the round-trip and landed on the sign-in page believing the reconnect
failed. In production the `redirect_url` chain survives re-sign-in, so a
recovered user still fires `returned` late; a user who walked away never does.

```sql
SELECT s.day, s.started, r.returned,
       s.started - r.returned AS never_returned
FROM
  (SELECT toDate(timestamp) AS day, count() AS started FROM events
   WHERE event = 'google_reconnect_started'
     AND properties.environment = 'production'
     AND timestamp > now() - INTERVAL 30 DAY GROUP BY day) s
LEFT JOIN
  (SELECT toDate(timestamp) AS day, count() AS returned FROM events
   WHERE event = 'google_reconnect_returned'
     AND properties.environment = 'production'
     AND timestamp > now() - INTERVAL 30 DAY GROUP BY day) r
  ON s.day = r.day
ORDER BY s.day
```

Investigate any sustained `never_returned` > 0: per person, a `started` with
no `returned` within ~15 minutes is the alertable unit. Pair with
`google_reconnect_incomplete` (returned, but scopes still missing — Google
granted without fresh consent) to separate the two repair paths. ClickHouse
LEFT JOIN note: missing right-side rows fill 0, not NULL, so the subtraction
is safe.

**7.9 — Transport-layer rejections (`mcp_transport_rejected`).** Added
2026-09-03 after a support case in which a client's calls were refused by the
MCP transport (HTTP 400) at human cadence for an hour and produced no event at
all — the SDK writes its own 4xx before any tool callback runs. Every such
rejection is now captured on the caller's person with the JSON-RPC error
message, the request's RPC method(s)/tool, and the `MCP-Protocol-Version`
header. Our own `reason='parse_error'` 400 replaces what used to be a hang:
`mcp-handler` awaits `req.json()` unguarded, so a malformed/empty JSON body
never got a response until the function timeout.

**Read `reason` first — the same "Unsupported protocol version" message means
opposite things depending on the RPC method.** Corrected 2026-09-04, when the
first day of data was 100% claude.ai clients on MCP 2026-07-28 and the
original reading ("that user is silently broken") was wrong for all of them:

- `discover_probe` — **expected, nobody is locked out.** MCP 2026-07-28
  replaced `initialize` with a `server/discover` probe that a dual-era client
  sends first, under `MCP-Protocol-Version: 2026-07-28`. Our SDK 1.x server
  answers the header check with the 400 the transport spec mandates, and the
  2026-07-28 spec's fallback rule tells the client to read a 400 *without* a
  modern error body as "legacy server" and retry with `initialize`
  ([versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
  [Streamable HTTP → Backward Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).
  Measured on the first day: every probe was followed by a successful
  `initialize` from the same `client_id` within seconds; probes recur about
  every 15 minutes per client (the client caches the legacy verdict), so they
  accompany roughly one initialize in ten. One extra small round trip per
  client per quarter hour — not a cost worth an SDK migration on its own.
- `unsupported_protocol_version` — the same message on any *other* method
  (`tools/list`, `tools/call`, …): a client that shipped a version the
  deployed SDK refuses **and never sends the legacy handshake**. That user IS
  refused until the SDK is bumped (the supported list is printed in the
  message). This is the row the event exists for; it has never fired in
  production as of 2026-09-04. (`initialize` can never produce it: SDK 1.x
  skips the header check on initialization requests and negotiates the
  version down instead — verified on the PR #116 preview, an `initialize`
  under the 2026-07-28 header answers 200 with `2025-11-25`.)
- `sdk` — everything else. "Only one initialization request is allowed" is a
  batching client; 406 is a missing `Accept`.
- `parse_error` — our own 400 for a non-JSON body.

```sql
SELECT properties.status AS status, properties.reason AS reason,
       properties.rpc_method AS rpc_method, properties.message AS message,
       properties.protocol_version_header AS pv,
       uniq(properties.client_id) AS clients, uniq(distinct_id) AS users, count() AS n
FROM events
WHERE event = 'mcp_transport_rejected' AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY status, reason, rpc_method, message, pv ORDER BY n DESC
```

Registry crawlers never appear here: this wrapper runs inside the auth
layer, so an unauthenticated request is answered 401 before it (verified
2026-09-10, the first registry-crawler day: every `mcp_transport_rejected`
row carried a real person, none `anonymous-mcp`).

Healthy: `discover_probe` rows at roughly 10% of `mcp_client_initialize`
volume, a steady low `sdk`/`parse_error` trickle, and **zero**
`unsupported_protocol_version` rows. Any `unsupported_protocol_version` row on
a real person is a refused user: correlate with `$mcp_tool_call` for the same
`client_id` — rejections WITHOUT successes is a fully locked-out client.

**Probes by protocol version, 7 days.** The day a NEW version string appears
here is the day a client moved ahead of the deployed SDK — that is the early
warning, weeks before any client drops its legacy fallback:

```sql
SELECT toDate(timestamp) AS day, properties.protocol_version_header AS pv,
       properties.reason AS reason, properties.rpc_method AS rpc_method,
       count() AS n, uniq(properties.client_id) AS clients
FROM events
WHERE event = 'mcp_transport_rejected' AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY day, pv, reason, rpc_method ORDER BY day, n DESC
```

**Lockout alarm: clients that probed and never initialized (24 h).** A
modern-only client (SDK v2 `versionNegotiation: { pin: '2026-07-28' }`, no
fallback) would show up here — probes, no `initialize`, no tool calls. This
is the trigger for the `mcp-handler` 2.x / SDK v2 migration (plan:
`docs/implementation_plans/claude-laughing-ardinghelli-8c32dd_v1.md`); the
other trigger is `discover_probe` share of initializes climbing well past 10%
(a client that stopped caching the legacy verdict). Expected value: 0.

```sql
SELECT uniq(cid) AS locked_out_clients, sum(probes) AS probes
FROM (SELECT properties.client_id AS cid,
             countIf(event = 'mcp_transport_rejected') AS probes,
             countIf(event = 'mcp_client_initialize') AS inits,
             countIf(event = '$mcp_tool_call') AS calls
      FROM events
      WHERE event IN ('mcp_transport_rejected', 'mcp_client_initialize', '$mcp_tool_call')
        AND properties.environment = 'production'
        AND timestamp > now() - INTERVAL 24 HOUR
      GROUP BY cid HAVING probes > 0 AND inits = 0 AND calls = 0)
```

**7.10 — Tool calls the SDK refused before our code ran
(`mcp_input_validation_failed`).** Zod argument validation and unknown-tool
lookups happen inside the SDK, which answers with an `isError` tool result
that never reaches `withToolAnalytics` — a client passing `offset: "0"`
(string) or `format: "FULL"` failed invisibly. Detected from a tee of the
POST response after it is sent (never delays the client; GET/SSE is never
buffered).

```sql
SELECT properties.tool AS tool, properties.kind AS kind,
       properties.client_id AS client, uniq(distinct_id) AS users, count() AS n,
       any(properties.message) AS example
FROM events
WHERE event = 'mcp_input_validation_failed' AND timestamp > now() - INTERVAL 7 DAY
GROUP BY tool, kind, client ORDER BY n DESC
```

Healthy: near zero. A single user repeating the same `invalid_arguments` on
one tool is an agent stuck on a schema misunderstanding — the tool's
description is the fix, not the user. `unknown_tool` bursts after a release
mean a client cached an old tool list.

**7.11 — Support lookup: "gmail_read fails on message X".** `$mcp_tool_call`
now carries a request fingerprint (`message_id_hash` on `gmail_read` /
`gmail_get_attachment`, `resource_id_hash` on raw Gmail `google_api_get`
calls — both `sha256(id).slice(0, 16)`, unsalted so an operator can compute
it from a reported id), `format`, `windowed`, and the parser's view of the
message (`parsed_body_chars`, `parsed_body_truncated`, `parsed_attachments`,
`parsed_html_fallback`). Compute the hash locally
(`node -e "console.log(require('crypto').createHash('sha256').update('<id>').digest('hex').slice(0,16))"`)
and query:

```sql
SELECT timestamp, properties.$mcp_tool_name AS tool, properties.outcome AS outcome,
       properties.format AS format, properties.windowed AS windowed,
       properties.response_chars AS chars, properties.parsed_body_chars AS body_chars,
       properties.parsed_attachments AS attachments, properties.parsed_html_fallback AS html
FROM events
WHERE event = '$mcp_tool_call' AND timestamp > now() - INTERVAL 14 DAY
  AND (properties.message_id_hash = '<hash>' OR properties.resource_id_hash = '<hash>')
ORDER BY timestamp
```

Read together with 7.9/7.10 for the same person and window: a report of
"fails" with successful rows here and nothing in 7.9/7.10 is a client-side
failure (result dropped or not shown); rows in 7.9 are transport refusals;
rows in 7.10 are the agent's request shape; no rows anywhere means the call
was never sent.

**7.12 — Google sign-ins that narrow the grant (`sign_in_completed`).** Clerk
keeps one Google external account per user and rewrites its scope record — and
the stored token — with the scope set of whatever OAuth request last completed.
A plain Google sign-in requests the dashboard-configured set (`openid email
profile gmail.modify`), never `drive.file`, so every sign-in strips the Drive
permission a user granted through the Picker — from the ACCESS TOKEN for about
an hour at least, and from Clerk's scope record for good. When the sign-in
leaves Clerk holding its older, wider refresh token, the first refresh after
expiry serves a token that carries `drive.file` again while `approved_scopes`
still says it is gone (measured 2026-09-04, dev instance, USER_A); when Clerk
holds a narrow refresh token the outage is permanent until a reconnect (same
day, USER_B — the difference is not established). Measured the same day with
`npm run google:scope-sweep -- --prod` (read-only, counts only): of 213
production grants, 0 of the 77 carrying `drive.file` had last been written by a
sign-in, versus 75 of the 136 without it; with `--tokens`, 8 of those 136 served
a token that DID carry `drive.file` (4 of the 6 Sheets/Docs users among them),
120 served a narrow token, 8 could not be refreshed. Until 2026-09-04 the MCP
pre-flight denied on the record alone, so those 8 were locked out of Sheets/Docs
indefinitely (the 33-user `google_scope_missing` population of the trailing
14 days). Since 2026-09-04 the dashboard emits one `sign_in_completed` per
sign-in with the scope state it measured on arrival:

```sql
SELECT toDate(timestamp) AS day,
       count() AS sign_ins,
       countIf(properties.needs_drive_file) AS sheets_docs_users,
       countIf(properties.drive_file_narrowed) AS arrived_without_drive_file,
       uniqIf(person_id, properties.drive_file_narrowed) AS people_narrowed
FROM events
WHERE event = 'sign_in_completed' AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

`arrived_without_drive_file` is the population the post-sign-in auto-repair
targets: the dashboard card starts the reconnect itself for those users
(`google_reconnect_started` with `source = 'sign_in_auto'`), returning to the
Accounts page so §7.8's `returned`/`verified` funnel closes it. Healthy: every
`sign_in_auto` start is followed by a `google_reconnect_verified` within
minutes. A `sign_in_auto` start with no `returned` is a user who abandoned
Google's consent screen right after signing in — if that grows, the extra
screen is costing more than the broken Sheets calls it prevents, and the
alternative (adding `drive.file` to the Clerk dashboard's sign-in scope set,
rejected in `docs/implementation_plans/google-sign-in-scope-narrowing_v1.md`
because Google re-prompts every sign-in until the scope is granted) should be
re-weighed. The MCP pre-flight no longer over-denies on the stale record:
`$mcp_tool_call` rows with `clerk_scope_cache_stale = true` count the calls
that Clerk metadata alone would have refused.

**7.12a — Records that overstate the token (`clerk_scope_record_overstates`).**
The reverse failure (measured 2026-09-05, USER_B): once `drive.file` is in the
Clerk sign-in scope list, a sign-in over an account whose refresh token is
narrow bounces without consent, Clerk records drive.file, and every token
after the first refresh lacks it. The MCP pre-flight now lets tokeninfo decide
in both directions and stamps the disagreement:

```sql
SELECT toDate(timestamp) AS day,
       countIf(properties.clerk_scope_cache_stale) AS record_narrower_than_token,
       countIf(properties.clerk_scope_record_overstates) AS record_wider_than_token,
       uniqIf(person_id, properties.clerk_scope_record_overstates) AS people_needing_consent
FROM events
WHERE event = '$mcp_tool_call' AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day
```

`people_needing_consent` is the population whose only repair is a consent pass
(the denial's reconnect link, or the dashboard card's button); expect it to
drain as those users reconnect, and expect `record_narrower_than_token` to
drain once the production sign-in scope list carries `drive.file`.

**7.13 — Clerk token-fetch retry (the daily delegated-mailbox race).**
Measured 2026-09-04 over 30 days of production: every MCP-path
`google_token_fetch_failed` was `reason='clerk_error'`, one per day came
from a single healthy delegated mailbox, and the per-call sequence showed a
race — the agent fires two calls on that mailbox within ~100 ms on its first
touch of the day, one fails at Clerk in ~80-120 ms (`token_ms`), the other
succeeds, and every later call succeeds. Since 2026-09-04 the route retries
an unknown Clerk error once (300 ms) and stamps the result on the tool call:

```sql
SELECT toDate(timestamp) AS day, properties.google_token_retry AS retry,
       properties.account_delegated AS delegated, count() AS calls, uniq(person_id) AS users
FROM events
WHERE event = '$mcp_tool_call' AND properties.google_token_retry IS NOT NULL
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day, retry, delegated ORDER BY day
```

Healthy: `recovered` rows at roughly the pre-deploy daily failure rate (≈1/day
from the one account) and **zero** `retry_failed`. `google_token_fetch_failed`
fires only on FINAL failure, so a `clerk_error` there now means the retry did
not help — pair it with the new `clerk_status` / `clerk_code` props before
deciding whether it is a Clerk incident (many users, one window) or a broken
grant (one user, every call). Since the same date the event also fires for
`no_token`, a Clerk 404 for the owner's stored user id classifies
`owner_not_found` (deterministic — a deleted owner account, or a row from a
different Clerk instance, which is exactly what a preview against a copy of
production data produces for every delegated mailbox), and the tool result
for `no_token` / `refresh_failed` / `owner_not_found` is a 🚫
refusal (`denial_code: 'google_token_unavailable'`, outcome
`denied_by_policy`) that names who must reconnect; `clerk_error` / `timeout`
stay ❌ `failed` with retry-first text. A rising `retry_failed` count, or a
`recovered` count far above the old failure rate, means Clerk is degrading
rather than racing.

**7.13a — Revoked grants (`grant_revoked`, Clerk 400
`oauth_token_retrieval_error`).** Re-measured 2026-09-09: the retry above had
recovered ZERO calls since it shipped (`recovered` = 0 every day 09-03 → 09-09),
and every `retry_failed` row (23, three own-mailbox accounts, 09-08/09) was
Clerk's 400 `oauth_token_retrieval_error` — "Failed to retrieve a new access
token from the OAuth provider". Probed read-only against the production
Backend API, all three carried Google's `invalid_grant "Token has been expired
or revoked."`, every external account was still `verified` in Clerk, and no
account produced a single own-mailbox success after its first failure. That is
a dead grant, not a race: the user revoked FGAC in their Google account,
changed their Google password (Google revokes Gmail-scoped grants on a
password change), or the grant aged out. The same code was already on record as
a dead QA grant on 2026-08-06. Since 2026-09-09 it classifies `grant_revoked`
on all three paths (MCP, proxy, grant check): no retry, a 🚫
`google_token_unavailable` refusal with the owner-bound reconnect link, and
`list_accounts` mints `reconnect_url` for it plus a top-level
`next_steps.reconnect` nudge (the affected agents called list_accounts right
after their first failure and got no instruction). The reconnect works because
Google no longer holds the grant, so the consent screen shows again and a new
refresh token is issued. Note the SDK drops Clerk's `meta.provider_error`, so
the code alone decides; a Google token-endpoint outage would land here too —
tell them apart by shape (many accounts in one window = incident; one account,
every call, forever = revoked):

```sql
SELECT toDate(timestamp) AS day, properties.reason AS reason,
       properties.clerk_status AS clerk_status, properties.clerk_code AS clerk_code,
       properties.via AS via, count() AS failures, uniq(person_id) AS accounts
FROM events
WHERE event = 'google_token_fetch_failed' AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 30 DAY
GROUP BY day, reason, clerk_status, clerk_code, via ORDER BY day, failures DESC
```

Healthy: `oauth_token_retrieval_error` rows carry `reason = 'grant_revoked'`
(never `clerk_error`), a handful of accounts per week, and each account's
`$mcp_tool_call` rows after the first failure are `denied_by_policy` with
`google_token_error = 'grant_revoked'` — not a run of `failed`. Whether the
reconnect link converts is §7.8's `google_reconnect_*` funnel for that person.
The per-tool split the directory table needs is now a property, no join:

```sql
SELECT properties.$mcp_tool_name AS tool, properties.outcome AS outcome,
       properties.google_token_error AS token_error,
       properties.google_token_clerk_code AS clerk_code, count() AS calls, uniq(person_id) AS users
FROM events
WHERE event = '$mcp_tool_call' AND properties.environment = 'production'
  AND properties.failure_reason = 'google_token_unavailable'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY tool, outcome, token_error, clerk_code ORDER BY calls DESC
```

Before the fix (7 d to 2026-09-09) this table put 16 of `sheets_get_spreadsheet`'s
35 error-or-failed rows (of 242 calls, 14.5%) on this one class; after it those
rows are `denied_by_policy` and leave the published rate.

**7.14 — Approval-link conversion, per request (never per event).** The
approve page's file-grant button shipped without a pending guard; until the
2026-09-05 fix a rage-click on a slow sheets/docs approval re-ran the server
action per click, and each run re-fired `approval_link_approved` and inserted a
duplicate rule (one production link: 14 approve events, 11 rules for one sheet
in 12 s). Raw event counts therefore overstate conversion for 2026-08-25 →
2026-09-05 (71% raw vs 37% per link in the last pre-fix week). Count links:

```sql
SELECT properties.action AS action,
       uniqIf(properties.request_id, event = 'approval_link_minted')   AS minted_links,
       uniqIf(properties.request_id, event = 'approval_link_approved') AS approved_links,
       countIf(event = 'approval_link_approved')                        AS approve_events,
       countIf(event = 'approval_link_replayed')                        AS replays,
       round(100 * uniqIf(properties.request_id, event = 'approval_link_approved')
                 / greatest(uniqIf(properties.request_id, event = 'approval_link_minted'), 1), 1) AS pct
FROM events
WHERE event IN ('approval_link_minted', 'approval_link_approved', 'approval_link_replayed')
  AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY action ORDER BY minted_links DESC
```

Healthy after the fix: `approve_events = approved_links` for every action (any
excess is a server-side dedupe gap — the client guard alone cannot make that
equality hold, a slow network can still land two POSTs), and `replays` small
relative to `approved_links`; `replays` is the duplicate-submit rate, split it
by `properties.path` (`picked` vs `grant_active`) when it climbs. Pair with
`$rageclick` on `$pathname = '/dashboard/approve'` — the pre-fix signature was
one rage-clicking user per day, every one of them on a file grant.

**7.15 — Picker cancel → recovery, per user.** A file Google does not share
with FGAC yet cannot be resolved by title, so a denial-minted approval link
shows Google's opaque file id while Google's Picker lists files by NAME.
Measured 2026-09-03 → 09-07, 13 of 33 Picker opens (approve page + dashboard)
ended in a cancel, and the two users who cancelled on the approve page never
approved. Since 2026-09-08 a cancel renders a recovery panel with an in-place
Try again, `picker_opened`/`picker_cancelled` carry `attempt`, and
`request_access` can pass the file's title (`has_resource_name` on the mint).
Per user, did a cancel lead to a retry, and did the retry pick?

```sql
SELECT cityHash64(person.properties.email) % 100000 AS u,
       countIf(event = 'picker_opened')                              AS opens,
       countIf(event = 'picker_cancelled')                           AS cancels,
       countIf(event = 'picker_opened' AND properties.attempt > 1)   AS retries,
       countIf(event = 'picker_picked')                              AS picks,
       round(avgIf(properties.elapsed_ms, event = 'picker_cancelled') / 1000, 1) AS avg_cancel_s,
       groupUniqArray(properties.$pathname)                          AS pages
FROM events
WHERE event IN ('picker_opened', 'picker_cancelled', 'picker_picked')
  AND properties.environment = 'production'
  AND person.properties.email NOT IN (/* internal + QA accounts: the exclusion list in the daily review task */)
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY u HAVING cancels > 0 ORDER BY cancels DESC
```

Healthy: most rows with `cancels > 0` also have `retries > 0` and `picks > 0`
(the panel got them back in and they found the file); `avg_cancel_s` under ~10 s
with no retry is a user who could not tell which file to pick — check
`has_resource_name` on their `approval_link_minted` rows (0 = the agent never
passed a title; the protocol text asks it to). Pair with the post-pick loop:
`sheets_grant_verification{via = 'magic_link', result = 'missing'}` per
`request_id` — more than 2 per link is the 8-second retry loop, and the
remedy is on the Google-propagation side, not the page.

Two readings added 2026-09-09, after a week in which three accounts opened a
sheets link, ran the `link_open` verification, and never approved:

*The picker events are client-side and ad blockers drop them.* 8 of the 65
people who opened an approval link in 30 days sent **no client-side event at
all** — for them "no `picker_opened`" means nothing. `picker_token_requested`
(server, one row per pick-button click) is the row to read instead: a person
with `link_open` verifications and no `picker_token_requested` did not click;
one with `picker_token_requested` and no `picker_opened` is telemetry-blind,
not stuck. `has_drive_file_scope = false` on it is the reconnect leg (dead or
narrowed grant), `result = 'no_token'` is a Google account that was never
connected.

```sql
-- Per person: server-side clicks vs client-side picker events, 7 d.
SELECT cityHash64(person.properties.email) % 100000 AS u,
       countIf(event = 'picker_token_requested')                                   AS clicks_server,
       countIf(event = 'picker_token_requested' AND properties.has_drive_file_scope = false) AS clicks_no_scope,
       countIf(event = 'picker_opened')                                            AS opens_client,
       countIf(event IN ('sheets_grant_verification','docs_grant_verification') AND properties.via = 'link_open') AS link_opens,
       countIf(event = 'approval_link_approved')                                   AS approved
FROM events
WHERE event IN ('picker_token_requested','picker_opened','sheets_grant_verification','docs_grant_verification','approval_link_approved')
  AND properties.environment = 'production'
  AND person.properties.email NOT IN (/* internal + QA accounts */)
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY u HAVING link_opens > 0 ORDER BY approved, clicks_server
```

*"Opened, never approved" includes agents that built a substitute.* Two of
the three accounts above had their agent create a NEW spreadsheet
(`google_api_modify` → `agent_sheet_created {auto_granted: true}`) within two
minutes of the link open and were productive on it the same day; the original
sheet stayed unexposed and kept minting. Before treating such a link as a
stuck user, check:

```sql
-- Gate-hit persons: denied ids vs ids they later used successfully, 7 d.
SELECT cityHash64(person.properties.email) % 100000 AS u,
       groupUniqArrayIf(cityHash64(toString(properties.file_id)) % 10000,
         event = '$mcp_tool_call' AND properties.denial_code IN ('sheets_not_exposed','docs_not_exposed')) AS denied_ids,
       groupUniqArrayIf(cityHash64(toString(properties.file_id)) % 10000,
         event = '$mcp_tool_call' AND properties.outcome = 'success'
         AND (properties.$mcp_tool_name LIKE 'sheets%' OR properties.$mcp_tool_name LIKE 'docs%')) AS ok_ids,
       countIf(event IN ('agent_sheet_created','agent_doc_created')) AS agent_created,
       countIf(event = 'approval_link_opened')   AS opened,
       countIf(event = 'approval_link_approved') AS approved
FROM events
WHERE properties.environment = 'production'
  AND person.properties.email NOT IN (/* internal + QA accounts */)
  AND timestamp > now() - INTERVAL 7 DAY
  AND (event IN ('approval_link_opened','approval_link_approved','agent_sheet_created','agent_doc_created')
       OR (event = '$mcp_tool_call' AND (properties.$mcp_tool_name LIKE 'sheets%' OR properties.$mcp_tool_name LIKE 'docs%')))
GROUP BY u HAVING length(denied_ids) > 0
ORDER BY approved, agent_created DESC
```

A row with `approved = 0`, `agent_created > 0` and `ok_ids` disjoint from
`denied_ids` is a substitute, not a leak — the product question there is why
the user's own file was not pickable (other Google account, shared drive,
Workspace policy), which the approve page's connected-account line now
addresses for the first case.

**7.16 — Handshake loops (`mcp_client_initialize` vs `$mcp_tool_call`).**
Added 2026-09-08. Two Claude Code users ran automation that spawned a fresh
`claude` process every ~30 s (one, 18 h a day; the other every ~2 min) — each
spawn re-runs the MCP handshake (`initialize`, `notifications/initialized`,
`tools/list`; three authenticated POSTs, no GET) and ends without a tool
call. Result: claude-code initializes went from ~6 to ~37 per person per day
while tool-call volume stayed flat, and `mcp_client_initialize` became ~50%
of all events in the project. The pattern is the Agent SDK / headless-loop
shape (each `query()` or `claude -p` is a new process; subagents share the
parent's connection; the two interleaving `client_version`s from one
`client_id` are a bundled SDK CLI next to an auto-updating global install —
OAuth registrations live in the Keychain and are shared machine-wide). It is
**not** a server-side reconnect. A local Claude Code 2.1.263 start-up
(measured 2026-09-09 with a static-header config) is one probe (`400`),
`initialize`, `notifications/initialized`, one SSE `GET` that takes the
stateless `405` quietly with no retry, then `tools/list` — and the process
ends. The production loop clients show no authenticated GETs at all and only
the cached ~1 probe per 15 minutes, so their cycle is the three POSTs.

What the server does about it (PR for `claude/adoring-snyder-eea430`): the
auth layer's eager `resolveConnection` (four sequential Neon round trips per
authenticated request, result unused for authorization) is skipped when the
same user+client was touched within 5 minutes on this instance. Kill switch
`MCP_CONNECTION_TOUCH_MEMO=disabled`. The initialize event itself is **not**
sampled or coalesced (decision 2026-09-09): its per-event timestamps and
versions are what exposed the pattern, the volume is ~6% of the plan, and a
user building automation on FGAC is a signal worth keeping at full grain.
Nothing is rate-limited or rejected — these are paying users whose tool calls
succeed.

```sql
-- Clients whose handshakes dwarf their tool calls, 24 h.
SELECT cityHash64(properties.client_id) % 100000 AS client_hash,
       arrayStringConcat(groupUniqArrayIf(properties.client_name, event = 'mcp_client_initialize'), ',') AS client_names,
       countIf(event = 'mcp_client_initialize') AS inits,
       countIf(event = '$mcp_tool_call') AS calls,
       uniq(distinct_id) AS users
FROM events
WHERE event IN ('mcp_client_initialize', '$mcp_tool_call')
  AND properties.environment = 'production'
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY client_hash
HAVING inits > 200
ORDER BY inits DESC
```

Reading it: a row with `inits > 200` and `calls < inits / 20` is a handshake
loop — **informational, not an incident**. Report it as "N loop clients, M
initializes" and keep those clients out of per-request health ratios
(auth-failure rate, discover-probe share, initializes-per-person), which they
otherwise dominate. It becomes actionable only if (a) a loop client's tool
calls start failing (then it is a stuck client, not a loop), or (b) the
`connection_resolve = 'skipped'` share on `mcp_auth_attempt` for that client
is low despite the loop (memo not absorbing it — instance churn or the kill
switch), or (c) `mcp_client_initialize` alone approaches ~300k rows/month
(30% of the 1M free tier), which is when coalescing the event becomes worth
its cost in lost per-event grain.

```sql
-- Is the memo absorbing the loop? Share of authenticated requests that
-- skipped the eager DB touch, and the cost of the ones that ran (24 h).
SELECT properties.connection_resolve AS resolve,
       count() AS sampled_requests,
       quantile(0.5)(toFloat(properties.connection_resolve_ms)) AS p50_ms,
       quantile(0.95)(toFloat(properties.connection_resolve_ms)) AS p95_ms
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.environment = 'production'
  AND properties.outcome = 'ok' AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY resolve
```

Healthy after the deploy: `skipped` is the majority of sampled `ok` rows
(loop clients alone are ~85% of authenticated requests), `ran` p50 sits at
Neon-from-iad1 latency (tens of ms for four round trips), and `error` is zero.
PostHog volume from handshakes is not a plan problem today (~6% of the free
tier's 1M events/month); the threshold that would make it one is (c) above.

**7.17 — Directory disconnect rate: what it is and our proxy for it.** The
listing dashboard's health badge (Healthy ≤ 5%) is, per
[Managing your listing](https://claude.com/docs/connectors/building/managing-your-listing):
*denominator* = every distinct Claude account that sent the server ANY MCP
message in the last 30 days (`initialize` counts, and so do connection
attempts that never authenticated); *numerator* = those accounts that **chose
to disconnect** during the window. We never see the click. Our proxy is a
person whose connections stop sending `mcp_client_initialize`/`$mcp_tool_call`
for 7+ days — claude.ai pings every connected connector each session (~2–3
initializes per person per day), so silence is either a dormant Claude user
or a removal.

Established 2026-09-08 (listing live since 2026-08-16):
- Every account that had made even one tool call was still messaging; the
  silent population was **100% never-called accounts**, 13 of 19 from launch
  week. Denials (`sheets_not_exposed`, scope missing, Google 401/403) did NOT
  predict silence — those users have the highest call volumes.
- The steady climb through early September was window mechanics: until day
  30 after listing (~2026-09-15) the window covered the whole listed life, so
  the numerator was cumulative disconnects while new accounts slowed from
  ~50/day to ~5/day. Expect a peak mid-September and a decline as both the
  launch accounts and their disconnects age out together.
- Not causes: `discover_probe` 400s (7.9), `invalid_token` rows (the `probe`
  kid), duplicate same-minute connection rows at install time.
- Registry crawlers (7.21) cannot enter this model or 7.16: they never
  authenticate, so they never produce `mcp_client_initialize`,
  `$mcp_tool_call` or a connection row (verified 2026-09-10: no scanner
  `client_name` on any authenticated event; the only names there are
  `claude-code`, `Anthropic/ClaudeAI`, `Anthropic/Toolbox`, `sheet-add-in`,
  `claude-ai`). Anthropic's denominator counts *Claude accounts* that sent a
  message, which a tokenless crawler is not.

```sql
-- Never-called accounts that have gone quiet, by week of first connection.
-- Person-level (Anthropic counts accounts); internal accounts excluded.
WITH per AS (
  SELECT person_id,
         toDate(minIf(timestamp, event = 'mcp_connection_created')) AS first_conn,
         maxIf(timestamp, event IN ('mcp_client_initialize', '$mcp_tool_call')) AS last_msg,
         countIf(event = '$mcp_tool_call') AS calls,
         countIf(event = '$mcp_tool_call' AND properties.outcome = 'success') AS ok_calls
  FROM events
  WHERE event IN ('mcp_connection_created', 'mcp_client_initialize', '$mcp_tool_call')
    AND properties.environment = 'production'
    AND timestamp > now() - INTERVAL 6 WEEK
    AND person.properties.email NOT IN (/* internal + QA accounts: the same list every query in §7 uses, plus the demo account */)
  GROUP BY person_id
  HAVING first_conn > toDate('2000-01-01')
)
SELECT toStartOfWeek(first_conn, 1) AS connect_week,
       count()                                                          AS people,
       countIf(calls > 0)                                               AS ever_called,
       countIf(calls = 0 AND last_msg <  now() - INTERVAL 7 DAY)        AS never_called_silent_7d,
       countIf(calls = 0 AND last_msg >= now() - INTERVAL 7 DAY)        AS never_called_still_pinging,
       countIf(calls > 0 AND last_msg <  now() - INTERVAL 7 DAY)        AS called_then_silent_7d
FROM per GROUP BY connect_week ORDER BY connect_week
```

Healthy: `called_then_silent_7d` ≈ 0 (a non-zero value here is a real
regression — someone who used the tools and left) and
`never_called_silent_7d` concentrated in old cohorts. The pool to work on is
`never_called_still_pinging`: Claude loads the connector in their sessions and
it never gets used (the 2026-09-08 baseline was 39 people, most never having
opened the dashboard — see 7.18 for the split). Watch this weekly; a rising
never-called share in NEW cohorts is the only thing that would push the
published rate back up once the launch window has aged out.

**7.18 — Acquisition funnel, per person.** Stages: (1) Connect click →
7.5 upper bound; (2) Clerk account created → `sign_up_completed`
(`user.created` webhook; `signup_source` = `claude_connector` when the
account was born from a connection, `website` for dashboard sign-ups, unset
for accounts created mid-OAuth that never connected); (3) Claude finished
OAuth → `mcp_connection_created`; (3b) Google scope actually granted → Clerk,
via `npm run funnel:scopes -- --prod` (Gmail is a checkbox at sign-in consent;
drive.file arrives later through the Picker, so its share reads much lower and
that is not a defect); (4) first successful `$mcp_tool_call`, split Gmail vs
Sheets/Docs. Baseline 2026-09-08 (182 connected since launch): Gmail scope
74% of connected, Gmail tried 41%, Gmail succeeded 32%; Sheets/Docs tried
53%, succeeded 37%, and 29 people tried Sheets and never succeeded (the
Sheets equivalent of the unchecked Gmail box — most never opened the
approval link). The recent cohort is Sheets-first.

```sql
WITH per AS (
  SELECT person_id,
         min(timestamp) AS first_ev,
         any(person.properties.signup_source) AS src,
         countIf(event = 'sign_up_completed')      AS signed_up,
         countIf(event = 'mcp_connection_created') AS conns,
         countIf(event = '$pageview' AND properties.$current_url LIKE '%/dashboard%') AS dash_views,
         countIf(event = 'google_scope_missing' AND properties.scope = 'gmail') AS gmail_scope_denied,
         countIf(event = '$mcp_tool_call' AND properties.$mcp_tool_name LIKE 'gmail_%') AS gmail_tried,
         countIf(event = '$mcp_tool_call' AND properties.$mcp_tool_name LIKE 'gmail_%' AND properties.outcome = 'success') AS gmail_ok,
         countIf(event = '$mcp_tool_call' AND (properties.$mcp_tool_name LIKE 'sheets_%' OR properties.$mcp_tool_name LIKE 'docs_%')) AS sd_tried,
         countIf(event = '$mcp_tool_call' AND properties.denial_code IN ('sheets_not_exposed', 'docs_not_exposed')) AS sd_not_exposed,
         countIf(event = 'approval_link_opened')   AS link_opened,
         countIf(event = 'approval_link_approved') AS link_approved,
         countIf(event = 'picker_picked')          AS picked,
         countIf(event = '$mcp_tool_call' AND (properties.$mcp_tool_name LIKE 'sheets_%' OR properties.$mcp_tool_name LIKE 'docs_%') AND properties.outcome = 'success') AS sd_ok,
         countIf(event = '$mcp_tool_call' AND properties.outcome = 'success') AS any_ok
  FROM events
  WHERE properties.environment = 'production'
    AND timestamp > now() - INTERVAL 6 WEEK
    AND person.properties.email NOT IN (/* internal + QA accounts: the same list every query in §7 uses, plus the demo account */)
  GROUP BY person_id
)
SELECT toStartOfWeek(first_ev, 1) AS cohort_week,
       countIf(signed_up > 0 AND coalesce(src, '') != 'website') AS clerk_accounts_via_connector,
       countIf(conns > 0)                     AS connected,
       countIf(conns > 0 AND dash_views > 0)  AS connected_opened_dashboard,
       countIf(conns > 0 AND any_ok > 0)      AS any_tool_success,
       countIf(conns > 0 AND gmail_tried > 0) AS gmail_tried,
       countIf(conns > 0 AND gmail_ok > 0)    AS gmail_success,
       countIf(conns > 0 AND gmail_scope_denied > 0) AS gmail_scope_denied,
       countIf(conns > 0 AND sd_tried > 0)    AS sheets_docs_tried,
       countIf(conns > 0 AND sd_not_exposed > 0) AS sheets_docs_hit_gate,
       countIf(conns > 0 AND link_opened > 0) AS opened_approval_link,
       countIf(conns > 0 AND (link_approved > 0 OR picked > 0)) AS approved_or_picked,
       countIf(conns > 0 AND sd_ok > 0)       AS sheets_docs_success,
       countIf(conns > 0 AND sd_tried > 0 AND sd_ok = 0) AS sheets_docs_tried_never_succeeded
FROM per
WHERE conns > 0 OR signed_up > 0
GROUP BY cohort_week ORDER BY cohort_week
```

Read it with 7.17: the gap between `connected` and `any_tool_success` is the
disconnect pool; the gap between `sheets_docs_hit_gate` and
`opened_approval_link` is link delivery (the nudge lives in the denial text,
`policyDenialWithLink` in `src/app/api/mcp/route.ts`); `gmail_scope_denied`
only counts people who tried Gmail — the scope share itself comes from the
Clerk script. `connected_opened_dashboard` is a browser-SDK count and
undercounts ad-blocked visitors.

**7.19 — Approval funnel per action, per link (minted → opened → approved).**
Locates a conversion loss before anyone names a fix: an action whose links are
minted but not *opened* is losing users between the agent's reply and the
click (the agent paraphrased the link away, or the user never asked for that
file); an action whose links are opened but not approved is losing them on the
approve page (Picker cancel, verification loop, wrong account). Measured
2026-09-08 (7 d): `docs_expose` 13 minted / 1 opened / 0 approved — an
open-step leak — against `sheets_expose` 36 / 24 / 17. Read
`analytics.md` → "Read the funnel per action" for the two joins this depends
on (denial code ≠ link action; approvals are recorded at the effective level).

```sql
WITH minted AS (
  SELECT properties.request_id AS rid, any(properties.action) AS action
  FROM events
  WHERE event = 'approval_link_minted' AND properties.environment = 'production'
    AND timestamp > now() - INTERVAL 7 DAY
    AND person.properties.email NOT IN (/* internal / QA accounts — .qa_test_emails.json + founder addresses, never inline them here */)
  GROUP BY rid),
opened AS (SELECT DISTINCT properties.request_id AS rid FROM events
  WHERE event = 'approval_link_opened' AND timestamp > now() - INTERVAL 30 DAY),
appr AS (SELECT DISTINCT properties.request_id AS rid FROM events
  WHERE event = 'approval_link_approved' AND timestamp > now() - INTERVAL 30 DAY)
SELECT m.action,
       count()                 AS links,
       countIf(o.rid != '')    AS opened,
       countIf(a.rid != '')    AS approved
FROM minted m
LEFT JOIN opened o ON o.rid = m.rid
LEFT JOIN appr   a ON a.rid = m.rid
GROUP BY m.action ORDER BY m.action
```

ClickHouse LEFT JOIN fills unmatched String columns with `''` (and DateTimes
with the 1970 epoch), so test `!= ''`, never `IS NOT NULL`. Healthy: `opened /
links` above ~60% for file actions and `approved / opened` above ~70%. An
open rate far below the sibling action (docs vs sheets) with a normal
approve-given-open rate is not a page problem — look at what minted the links
(`$mcp_tool_call` rows carrying `approval_request_id`: which tool, in what
burst, after what) before changing the approve page.

**7.20 — Domain concentration (organizations clustering).** Answers "are
several people from the same company or university showing up, and how is
that organization using FGAC?" — the daily review's DOMAIN CONCENTRATION
section. Two lenses, because the organization can appear in either:

- **Sign-up lens (7.20a)** — `person.properties.email` on
  `sign_up_completed`, the Google address the account was created with.
- **Mailbox lens (7.20b)** — `properties.account_email` on `$mcp_tool_call`,
  the mailbox actually being read or written. This is the lens that catches an
  organization whose operator signed up with a gmail.com address, or an
  operator at one company reading a sister company's mailbox: the
  `accessor_domains` column shows the pairing.

Both roll domains up to a **family key** — the first DNS label with hyphens
stripped — so `example.co`, `example.co.uk` and `example-co.com` read as one
organization (measured 2026-09-10: one customer spanned three variants and
would otherwise have looked like three two-person domains). The key is a
heuristic: an academic subdomain such as `alumni.<university>.edu` keeps the
subdomain label, so always read the `domains` array next to it. Consumer
mailbox providers are excluded by the list inside the query — extend it when
a new one shows up, never shrink it. Universities and schools (`.edu`,
`.ac.*`, `.sch.*`, `.edu.<cc>`) are **not** consumer domains and are the
clusters most worth highlighting.

The shapes an organization takes (name which one each family is in):

| shape | signature | reading |
| --- | --- | --- |
| delegation rollout | `signed_up ≈ delegators + 1`, `connected = 1`, `callers = 1`, `delegated_calls` high | one operator's agent, teammates who signed up only to grant delegation — the org-adoption shape the delegation model produces. The teammates never connected an agent, so they must **not** be counted in the never-called disconnect pool (7.17) or the churn buckets |
| team of connectors | `connected ≥ 2`, `callers ≥ 2` | several people each running their own agent |
| stalled rollout | `delegators ≥ 1`, `callers = 0` | delegations granted, no operator ever called — the nudge belongs on the delegation-accepted surface |
| cross-domain operator | 7.20b `accessor_domains` ≠ `mailbox_domains` | a consultant / assistant reading a company mailbox; the company is the customer even though no company address signed up |
| single power user | one person, sustained volume | expansion candidate, not concentration |

```sql
-- 7.20a — sign-up lens, rolled up by domain family (90 d)
SELECT replaceAll(splitByChar('.', domain)[1], '-', '') AS family,
       groupUniqArray(domain)                               AS domains,
       uniq(person_id)                                      AS persons,
       uniqIf(person_id, timestamp >= now() - INTERVAL 7 DAY)  AS new_7d,
       uniqIf(person_id, timestamp >= now() - INTERVAL 14 DAY
                     AND timestamp <  now() - INTERVAL 7 DAY)  AS new_prev_7d,
       min(toDate(timestamp)) AS first_signup,
       max(toDate(timestamp)) AS last_signup
FROM (
  SELECT person_id, timestamp,
         splitByChar('@', lower(coalesce(person.properties.email, '')))[2] AS domain
  FROM events
  WHERE event = 'sign_up_completed'
    AND timestamp >= now() - INTERVAL 90 DAY
    AND person.properties.email NOT IN (/* internal + QA accounts — the same list every §7 query uses, never inline them here */)
)
WHERE domain != ''
  AND domain NOT IN (  -- consumer providers: extend, never shrink
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.com.au','yahoo.ca',
    'hotmail.com','hotmail.co.uk','hotmail.fr','outlook.com','live.com','live.co.uk','msn.com',
    'icloud.com','me.com','mac.com','aol.com','protonmail.com','proton.me','pm.me','ymail.com',
    'qq.com','163.com','126.com','gmx.com','gmx.de','gmx.net','web.de','mail.ru','yandex.ru',
    'yandex.com','zoho.com','hey.com','fastmail.com','mail.com','duck.com','tutanota.com')
GROUP BY family
HAVING persons >= 2 OR new_7d >= 1
ORDER BY new_7d DESC, persons DESC
```

```sql
-- 7.20b — mailbox lens: whose mailboxes are being accessed, by whom (30 d)
SELECT replaceAll(splitByChar('.', mailbox_domain)[1], '-', '') AS family,
       groupUniqArray(mailbox_domain)      AS mailbox_domains,
       uniq(properties.account_email)      AS mailboxes,
       uniq(person_id)                     AS accessors,
       groupUniqArray(person_domain)       AS accessor_domains,
       count()                                                     AS calls,
       countIf(properties.outcome = 'success')                     AS ok,
       countIf(toString(properties.account_delegated) = 'true')    AS delegated_calls,
       uniqIf(properties.account_email, timestamp >= now() - INTERVAL 7 DAY)  AS mailboxes_7d,
       uniqIf(properties.account_email, timestamp >= now() - INTERVAL 14 DAY
                                    AND timestamp <  now() - INTERVAL 7 DAY)  AS mailboxes_prev_7d,
       min(toDate(timestamp)) AS first_call,
       max(toDate(timestamp)) AS last_call
FROM (
  SELECT person_id, timestamp, properties,
         splitByChar('@', lower(coalesce(properties.account_email, '')))[2] AS mailbox_domain,
         splitByChar('@', lower(coalesce(person.properties.email, '')))[2]  AS person_domain
  FROM events
  WHERE event IN ('$mcp_tool_call', 'mcp_tool_call')
    AND properties.environment = 'production'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND distinct_id NOT IN ('anonymous-proxy', 'anonymous-mcp')
    AND person.properties.email NOT IN (/* internal + QA accounts */)
    AND lower(properties.account_email) NOT IN (/* internal + QA accounts */)
)
WHERE mailbox_domain != ''
  AND mailbox_domain NOT IN (/* the same consumer-provider list as 7.20a */)
GROUP BY family
HAVING mailboxes >= 2 OR delegated_calls > 0
ORDER BY mailboxes DESC, calls DESC
```

```sql
-- 7.20c — one organization's profile: funnel + how they use it (30 d).
-- Matches on EITHER lens so a gmail-address operator reading company
-- mailboxes is attributed to the company.
SELECT uniqIf(person_id, event = 'sign_up_completed')      AS signed_up,
       uniqIf(person_id, event = 'mcp_connection_created') AS connected,
       uniqIf(person_id, event = 'delegation_created')     AS delegators,
       uniqIf(person_id, event = 'account_linked')         AS linkers,
       uniqIf(person_id, event = '$pageview'
                     AND properties.$current_url LIKE '%/dashboard%') AS dashboard_viewers,
       uniqIf(person_id, is_call)                          AS callers,
       groupUniqArrayIf(person_domain, is_call)            AS caller_domains,
       uniqIf(properties.account_email, is_call)           AS mailboxes,
       countIf(is_call)                                                        AS calls,
       countIf(is_call AND properties.outcome = 'success')                     AS ok,
       countIf(is_call AND properties.outcome = 'denied_by_policy')            AS denied,
       countIf(is_call AND properties.outcome IN ('failed','error','exception')) AS errors,
       countIf(is_call AND toString(properties.account_delegated) = 'true')    AS delegated_calls,
       countIf(is_call AND tool LIKE 'gmail_%')                                AS gmail_calls,
       countIf(is_call AND (tool LIKE 'sheets_%' OR tool LIKE 'docs_%'))       AS sheets_docs_calls,
       countIf(is_call AND tool LIKE 'google_api_%')                           AS raw_api_calls,
       countIf(is_call AND tool IN ('gmail_send','sheets_update_range','sheets_append_rows',
                                    'sheets_edit','docs_edit','google_api_modify')) AS write_calls,
       uniqIf(toDate(timestamp), is_call) AS active_days,
       minIf(toDate(timestamp), is_call)  AS first_call,
       maxIf(toDate(timestamp), is_call)  AS last_call
FROM (
  SELECT person_id, event, timestamp, properties,
         splitByChar('@', lower(coalesce(person.properties.email, '')))[2] AS person_domain,
         replaceAll(splitByChar('.', splitByChar('@', lower(coalesce(person.properties.email, '')))[2])[1], '-', '')     AS person_family,
         replaceAll(splitByChar('.', splitByChar('@', lower(coalesce(properties.account_email, '')))[2])[1], '-', '')    AS mailbox_family,
         event IN ('$mcp_tool_call', 'mcp_tool_call')            AS is_call,
         coalesce(properties.$mcp_tool_name, properties.tool)     AS tool
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND (properties.environment = 'production' OR event = '$pageview')
    AND distinct_id NOT IN ('anonymous-proxy', 'anonymous-mcp')
    AND person.properties.email NOT IN (/* internal + QA accounts */)
)
WHERE person_family = '<family>' OR mailbox_family = '<family>'
```

```sql
-- 7.20d — weekly trend: how much of sign-up growth is organizational (8 wk)
SELECT toStartOfWeek(timestamp, 1) AS week,
       uniq(person_id) AS signups,
       uniqIf(person_id, domain NOT IN (/* consumer list */) AND domain != '') AS org_signups,
       uniqIf(domain,    domain NOT IN (/* consumer list */) AND domain != '') AS org_domains
FROM (
  SELECT person_id, timestamp,
         splitByChar('@', lower(coalesce(person.properties.email, '')))[2] AS domain
  FROM events
  WHERE event = 'sign_up_completed'
    AND timestamp >= now() - INTERVAL 8 WEEK
    AND person.properties.email NOT IN (/* internal + QA accounts */)
)
GROUP BY week ORDER BY week
```

Read 7.20a and 7.20b together: a family that is large in (a) but absent from
(b) is a stalled rollout; one that is large in (b) but absent from (a) is a
cross-domain operator. Run 7.20c only for the families that clear the bar
(≥ 2 persons or mailboxes, or a first appearance this week) and describe each
in one sentence: read vs write mix, delegated share, active days, whether
`mailboxes_7d` is growing against `mailboxes_prev_7d`. Baseline 2026-09-10:
org-domain sign-ups were roughly a quarter to a third of weekly sign-ups
until the week of 2026-09-07, when a single ten-account delegation rollout
lifted the share above half; the largest family before that spanned five
accounts across three domain variants. A sudden `new_7d` spike at one family
is the signal Ken wants surfaced, not the raw share.

**7.21 — Registry probe volume (`client_class`).** Added 2026-09-10, the
day after the MCP Registry listing (`ai.fgac/fgac`, `docs/growth-channels.md`).
From 02:00Z that day a population of registry crawlers, health probes and
"MCP security" scanners began hitting `POST /api/mcp` without a token or with
a junk bearer — a launch burst, then a recurring floor of health checks.
Measured, production:

| | 09-07 | 09-08 | 09-09 | 09-10 (to 11:20Z) |
| --- | --- | --- | --- | --- |
| `no_token` | 34 | 36 | 35 | 216 |
| `invalid_token` (of which `kid='probe'`) | 9 (7) | 7 (7) | 8 (8) | 32 (4) |
| unauthenticated `initialize` with a client_name | 18 | 21 | 24 | 158 |
| bare POST / GET / HEAD, no token | 16 | 15 | 11 | 58 |
| distinct fingerprints, non-claude.ai POST | 12 | 10 | 16 | 96 |

Hourly `no_token` on 09-10: 02Z 11 · 03Z 55 · 04Z 33 · 05Z 18 · 06Z 23 ·
07Z 18 · 08Z 20 · 09Z 24 · 10Z 10 — the floor after the burst is
health-check cadence (glama alone re-probed 23 times from one address in
seven hours), not one-off crawls. **Re-verify the floor over 48 h before
moving any threshold**; the figures above are eleven hours of data.

What the 09-10 population looked like (~60 distinct sources in nine hours):

- Self-describing UAs: `SmitheryBot/1.0 (+https://smithery.ai)`,
  `ProofBench/0.1 (…MCP registry health probe)`, `mcpscan/0.1 (…non-intrusive
  security scan)`, `MCPWatch/0.1.0 (…longitudinal MCP security research)`,
  `exaforce-mcprep/0.1 (MCP server reputation scanner)`, `mcp-observatory`,
  `mcp-infra-census`, `agentprobe`, `MCPMeter`, `MJ12bot`, …
- Stock UAs identifiable only by `client_name`: `node` → `glama`, `undici` →
  `glama-mcp-inspector` / `span-pipeline` / `fig-catalog-sync`,
  `Go-http-client/2.0` → `verifymcp-probe`, `Deno/… SupabaseEdgeRuntime` →
  `MCP-Marketplace-Scanner` / `-Enricher`, `python-httpx/0.28.1` →
  `ox-pkg-scanner-probe`, `GuzzleHttp/7` → `frndOS`. This is why the class is
  computed from both fields; either alone misses about a third.
- `python-httpx2/2.12.0` (not the real httpx UA) with `client_name = 'mcp'`
  (the Python MCP SDK's default, so the name alone is not a tell): sends a
  non-JWT bearer, then an `initialize`, in pairs — **all 28 non-probe
  `invalid_token` rows that day**, from 4 addresses. Classified on the UA
  prefix.
- Pre-existing, not from the registry: `ado-p5-health/1` (GET, ~16/day since
  before 08-27), `mcp-reputation-scanner`, `tedix-mcp-scanner`, search-engine
  bots on GET. And a `python-httpx/0.28.1` client that self-reports
  `client_name = 'Anthropic'`, ~6 tokenless initializes/day from 4–8
  addresses since at least 2026-08-28, never authenticated — plausibly the
  Connector Directory's own health check, or API `mcp_servers` calls made
  without a token; **left `direct`** until that is established (it is a
  constant, not part of the 09-10 delta).

**The `direct` remainder, three days in (2026-09-12).** The daily review
found `direct` growing (30 → 65 → 111 `no_token` rows on 09-10/11/12) and
7.21b showed it was crawler traffic, not people. Established before changing
anything: none of the UAs or names below appeared on any authenticated event
(`mcp_auth_attempt` ok, `mcp_client_initialize`, `$mcp_tool_call`) in the
14 days to 09-12 — since the classifier deployed (09-10 12:28Z) every
authenticated request has carried a `Claude-User` or `claude-code/` UA.

| shape | rows 09-10→12 | what it was | rule since 2026-09-12 |
| --- | --- | --- | --- |
| `Python/3.11 aiohttp/3.14.3`, no clientInfo, POST | 75 (all on 09-12, 15 h) | bare tokenless POSTs from one runtime, no `initialize` | `direct` + `ua:stock-runtime-no-name` |
| `Bun/1.1.45`, GET | 40 (23 distinct hours) | hourly GET health check | `direct` + `ua:stock-runtime-no-name` |
| `python-httpx/0.28.1`, GET, no name | 21 | same shape | `direct` + `ua:stock-runtime-no-name` |
| `Go-http-client/2.0` · bare `node` / HEAD, no name | 6 | daily crons | `direct` + `ua:stock-runtime-no-name` |
| `MCPScoringEngine/1.0` / name `MCPScoringEngine` | 11 | a scoring service; slipped through because `keywordHit` saw one opaque token | `scanner` (`keyword:scoring` — CamelCase is now split) |
| `python-httpx/0.28.1` / name `AgentPulse` | 9 | a monitor | `scanner` (`keyword:pulse`) |
| `SaSame-MCP-Audit/0.1` | 6 | an audit crawler | `scanner` (`keyword:audit`) |
| `schema-study/0.1`, `mcp-inventory/0.1` + `mcp-inventory-canary`, `node` + `rpg-connect-check` | 5 | named probes | `scanner` (`keyword:study` / `keyword:inventory` / `name:rpg-connect-check`) |
| `python-httpx/0.28.1` / `Anthropic` (12), `undici` / `obolo-gateway` (11), `python-httpx` / `mcp` (3), `node` / `otter` (2), `curl` (3), one junk browser row | 32 | named but unidentified, or a person | **stay `direct`, unlabelled** — `gateway` and the SDK default name `mcp` are deliberately not tells |

The rule for the stock-runtime rows is a *signal*, not a class, on purpose:
a runtime UA is what the Python and TypeScript MCP SDKs send too, so it is
not evidence of a crawler, and the review reads `direct` as "possible real
client broke" — precision there matters more than recall. What makes the
rows readable as automation is the *absence* of `clientInfo`: an SDK install
flow always begins with an `initialize` that names the client. Replayed over
the three days, the change moves 34 rows to `scanner` and labels 143 of the
remaining 176 `direct` rows, leaving 12 / 17 / 4 unlabelled per day — the
named-but-unknown set above — and reclassifies zero authenticated pairs
(`scripts/test-mcp-client-class.ts` pins every string in the table).

```sql
-- 7.21a — daily auth failures by class (14 d). `direct` is the unclassified
-- remainder: a jump there is either a crawler the classifier misses (add it
-- to src/lib/mcpClientSignals.ts) or a real client that broke — split by
-- 7.21e (unnamed stock runtime vs the rest) and then 7.21b before deciding.
SELECT toDate(timestamp) AS day,
       coalesce(properties.client_class, 'pre-deploy') AS class,
       countIf(properties.outcome = 'no_token')      AS no_token,
       countIf(properties.outcome = 'invalid_token') AS invalid_token,
       uniq(properties.user_agent)                   AS user_agents,
       uniq(properties.client_name)                  AS client_names
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.environment = 'production'
  AND properties.outcome != 'ok'
  AND timestamp > now() - INTERVAL 14 DAY
GROUP BY day, class ORDER BY day, class
```

```sql
-- 7.21b — who is behind the failures (48 h): one row per UA × client_name
-- with the rule that classified it. Read `direct` rows top-down; a source
-- that recurs daily with the same fingerprint count is a health check.
SELECT properties.client_class AS class, properties.client_class_signal AS signal,
       properties.user_agent AS ua, properties.client_name AS client_name,
       count() AS failures, uniq(toStartOfHour(timestamp)) AS active_hours
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.environment = 'production'
  AND properties.outcome != 'ok'
  AND timestamp > now() - INTERVAL 48 HOUR
GROUP BY class, signal, ua, client_name
ORDER BY class, failures DESC
LIMIT 80
```

```sql
-- 7.21c — the hourly floor (48 h), scanner vs everything else.
SELECT toStartOfHour(timestamp) AS hour,
       countIf(properties.client_class = 'scanner')                       AS scanner,
       countIf(coalesce(properties.client_class, '') NOT IN ('scanner', 'internal')) AS other
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.environment = 'production'
  AND properties.outcome != 'ok'
  AND timestamp > now() - INTERVAL 48 HOUR
GROUP BY hour ORDER BY hour
```

```sql
-- 7.21d — the alarm condition: a scanner that authenticated (should be 0).
SELECT properties.client_name, properties.user_agent, count()
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.environment = 'production'
  AND properties.outcome = 'ok' AND properties.client_class = 'scanner'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY 1, 2
```

```sql
-- 7.21e — the `direct` remainder, split (14 d). `ua:stock-runtime-no-name`
-- is unnamed automation on a bare runtime (a health check or a crawler that
-- never sends initialize); `unlabelled` is what the review actually has to
-- read — a named client the classifier does not know, or a person on curl /
-- a browser. Only the unlabelled column can contain a real client that broke.
SELECT toDate(timestamp) AS day,
       countIf(properties.client_class_signal = 'ua:stock-runtime-no-name') AS stock_runtime_no_name,
       countIf(coalesce(properties.client_class_signal, '') = '')            AS unlabelled,
       uniqIf(properties.user_agent,
              coalesce(properties.client_class_signal, '') = '')              AS unlabelled_uas,
       groupUniqArrayIf(properties.client_name,
              coalesce(properties.client_class_signal, '') = '')              AS unlabelled_names
FROM events
WHERE event = 'mcp_auth_attempt' AND properties.environment = 'production'
  AND properties.outcome != 'ok' AND properties.client_class = 'direct'
  AND timestamp > now() - INTERVAL 14 DAY
GROUP BY day ORDER BY day
```

Reading it, in the daily review: one line of *traffic* — "registry probes:
N/day from M sources, floor ~K/h" — never an auth finding. Do not block or
rate-limit any of it: several sources are the registry's own health checks
and a 401 is what keeps the listing healthy. It becomes a flag only when
7.21d is non-empty, or when the *unlabelled* half of `direct` (7.21e) jumps
and 7.21b shows a real client behind it — the `ua:stock-runtime-no-name`
half is unnamed automation and moves with the crawler population. Our own probe is `internal` by its `fgac-auth-probe`
UA (since 2026-09-10; before that its `no_token` rows sat under `node`,
indistinguishable from glama on the same runtime) and its `invalid_token`
rows still carry `kid = 'probe'` — keep both exclusions.

**7.22 — Retry pressure per person and per request.** Added 2026-09-11 with
the denial-copy change (`src/lib/denialCopy.ts`). Two reads, taken together:
a request minted many times AND a single `target_hash` is one call being
repeated; many distinct targets in the same minutes is a batch the agent
emitted in one turn, which no denial text can recall.

```sql
-- denial bursts: same person + denial code inside a 5-minute bucket
SELECT person.properties.email AS who,
       toStartOfFiveMinutes(timestamp) AS t5,
       properties.denial_code AS code,
       properties.client_name AS client,
       count() AS n
FROM events
WHERE event = '$mcp_tool_call'
  AND properties.environment = 'production'
  AND properties.outcome = 'denied_by_policy'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND person.properties.email NOT IN (/* internal + QA accounts: the same list every query in §7 uses */)
GROUP BY who, t5, code, client
HAVING n >= 3
ORDER BY n DESC
```

```sql
-- mint pressure per request: how many times one deterministic link was re-emitted,
-- and over how many targets (1 = the same call repeated; many = a batch)
SELECT person.properties.email AS who,
       properties.action AS action,
       properties.request_id AS rid,
       max(toInt(properties.mint_count)) AS mints,
       min(timestamp) AS first_mint,
       max(timestamp) AS last_mint
FROM events
WHERE event = 'approval_link_minted'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY who, action, rid
HAVING mints >= 3
ORDER BY mints DESC
```

Baseline for 2026-09-04 → 09-11: 183 requests minted, 139 once, 22 twice,
22 three times or more; the top of the tail was a 15-mint `sheets_expose`
spread over four days of separate sessions, a 12-mint `send_all` that was a
twelve-recipient batch, and a 9-mint `sheets_write` from a user stuck on the
pre-2026-09-09 Picker page. `analytics.md` (the approval funnel section) has
the reading; the change is judged working if same-target mints stop
climbing while distinct-target batches are unaffected.

