# Spike — does `include_granted_scopes=true` keep the full Drive scope through a plain Google sign-in?

Branch: `claude/wizardly-shamir-8304cf`. Date: 2026-10-03/04. Environment: local dev
server (`fgac-dev-drive-tree` launch config, Drive tree flag on for everyone), dev
Clerk instance, dev Google OAuth client (project 627660126377), QA accounts USER_A /
USER_B. Browser work by `qa-setup-driver` runners; Clerk-record and tokeninfo
readings by the read-only `scripts/google-scope-probe.ts` (new in this branch).

Prior reasoning this spike tests: `google-sign-in-scope-narrowing_v1.md` dismissed
`include_granted_scopes=true` as "not exposed by Clerk's Google connection or
`reauthorize()`" — a reading of Clerk's API surface, not a measurement of what
happens when the parameter is on the request. `_v2.md`–`_v4.md` hold the tokeninfo
measurements of the narrowing itself.

## The problem in one paragraph

Clerk keeps one Google external account per user and rewrites its stored grant
(`approved_scopes` and the served access token) with the scope set of whichever
OAuth request last completed. A plain "Continue with Google" sign-in requests only
the instance-level scope list (prod: openid/email/profile + gmail.modify +
drive.file). A user on the Drive tree flag who granted the full
`https://www.googleapis.com/auth/drive` scope through the "Enable full Drive
access" card (`src/app/dashboard/EnableDriveAccessCard.tsx`) therefore loses it on
their next sign-in and sees the "needs re-enabling" card. Adding `drive` to the
sign-in list is not acceptable (unverified-app warning + 100-user cap in front of
every sign-up until the restricted-scope verification completes; reviewers push
back on a restricted scope at sign-in).

## Part 1 — where the sign-in leg's Google URL comes from, and who can touch it

### Sign-in leg (Clerk prebuilt modal)

- Every sign-up/sign-in CTA is `src/app/SignUpCta.tsx`: Clerk's
  `<SignUpButton mode="modal">` (nav, hero, bottom CTA, pricing). The modal is
  Clerk's prebuilt UI, loaded as clerk-js from Clerk's CDN by `@clerk/nextjs`
  7.3.3 (`src/app/layout.tsx` mounts `<ClerkProvider>` and nothing else of
  Clerk's). There is no custom `authenticateWithRedirect` flow anywhere in
  `src/`.
- "Continue with Google" in that modal runs clerk-js
  `SignIn.authenticateWithRedirect` (or the newer `SignIn.sso()`), which POSTs
  `/v1/client/sign_ins` `{strategy: 'oauth_google', redirect_url,
  action_complete_redirect_url}` to Clerk's Frontend API and then navigates the
  browser to `first_factor_verification.external_verification_redirect_url` via
  `SignIn.clerk.__internal_windowNavigate(url)` (clerk-js
  `core/resources/SignIn.ts`; both the legacy and the `sso()` path end in that
  one call). Clerk builds the Google URL server-side; the browser goes Frontend
  API → Google → Clerk's `/v1/oauth_callback` → the app. `src/middleware.ts`
  never sees the Google hop (it only sees the final return to `/dashboard`).
- Pass-through parameters Clerk accepts on that request (FAPI spec
  `fapi/2026-05-12.yml`, `createSignIn`): `oidc_prompt` and `oidc_login_hint`
  only. There is no generic "extra authorization parameters" field, so
  `include_granted_scopes` cannot be carried through the documented API.
- Clerk Dashboard, Google social connection with "Use custom credentials": the
  documented fields are Client ID, Client Secret, the Clerk-provided Authorized
  Redirect URI, Scopes, the enable-for-sign-up/sign-in toggle and "Block email
  subaddresses". No field for additional authorization parameters, `prompt`,
  `access_type` or `include_granted_scopes` is documented (not verified in the
  dashboard UI during this spike — a read-only look by the owner would settle it;
  nothing there was changed).

### Reauthorize leg (FGAC code)

`src/app/dashboard/googleReconnect.ts` gets the Google URL back from Clerk
(`reauthorize()` / `createExternalAccount()` →
`verification.externalVerificationRedirectURL.href`) and returns it; every
caller (`EnableDriveAccessCard`, `ConnectGoogleWarning`, `useGooglePicker`,
`ReconnectGoogleButton`) does `window.location.href = url`. The URL is in FGAC's
hands for one statement, so appending a query parameter is trivial there. (Today
the leg does not rewrite the URL — the `prompt=consent` it uses goes through
Clerk's `oidcPrompt` option; the "rewritten URL" in the project notes was a
QA-time manual repair.)

### Can FGAC intercept the sign-in leg?

| option | how | cost |
|---|---|---|
| A. Custom Google button | `useSignIn().signIn.create({strategy:'oauth_google', redirectUrl, actionCompleteRedirectUrl})`, read `firstFactorVerification.externalVerificationRedirectURL`, append the parameter, navigate; return handled by `<AuthenticateWithRedirectCallback>` / `Clerk.handleRedirectCallback`. Clerk's documented custom OAuth flow. | Replaces the modal's Google button with FGAC's own (the modal is Google-only today, so the CTA would open FGAC's button or go straight to Google); `sign_up_started` instrumentation unchanged. |
| B. Wrap the navigate hook | A client component under `<ClerkProvider>` sets `clerk.__internal_windowNavigate` to a wrapper that appends the parameter when the target host is Google. Prebuilt modal untouched. | Relies on an underscore-prefixed clerk-js property (not semver-protected). Fine for a spike (the runners use it), not for production. |
| C. Clerk-side | Dashboard / FAPI | No carrier exists today; would need a Clerk feature request. |

Two facts shape any production change: (1) at sign-in time nobody is signed in,
so a sign-in-leg parameter cannot be scoped to flagged users — it applies to
every sign-in; (2) the parameter only ever returns scopes the user already
granted to this OAuth client, so for a non-flagged user (who was never asked for
`drive`) the union equals the sign-in set, with one caveat: a user who once
granted a scope FGAC no longer requests (e.g. the legacy `https://mail.google.com/`)
would get it back on the token.

## Part 2 — measurements

Probe log: scratchpad `probe-log.txt` (copied below as it fills). Times UTC.

### T0 baseline (01:16Z, before any action)

| account | record `approved_scopes` | tokeninfo | agree |
|---|---|---|---|
| USER_A | base + gmail.modify + drive.file + **drive** (written 20:12Z, 3 min after a 20:09Z sign-in — the card grant) | same, fresh refresh (3599 s left) | yes — refresh token is wide |
| USER_B | base + gmail.modify + drive.file (written at its 16:52Z sign-in) | same | yes — this is what a dev sign-in requests: base + gmail.modify + drive.file |

(`base` = openid email profile userinfo.email userinfo.profile.)

### Arm 1 — USER_A, plain sign-in WITH `include_granted_scopes=true` (01:32Z)

Runner: `qa-setup-driver`, Path B (Playwright CLI on the CDP Chrome; the built-in
pane refused every `navigate` to localhost). Hook: wrapped
`Clerk.__internal_windowNavigate` on the signed-out home page, then clicked the
nav "Sign Up" → Clerk's "Create your account" modal → "Continue with Google".

Authorization URL Clerk generated (`accounts.google.com/o/oauth2/auth`):
`scope = openid userinfo.email userinfo.profile gmail.modify drive.file`,
`prompt=select_account`, `access_type=offline`, `response_type=code`, no
`include_granted_scopes`. Sent: identical plus `include_granted_scopes=true`.
Google showed the plain account chooser only — no consent screen. Return path:
Google → `<slug>.accounts.dev/sign-up/sso-callback` → `/dashboard/agents/default-profile`,
signed in as USER_A.

| reading (01:33Z, 60 s after the callback) | value |
|---|---|
| record `approved_scopes` (updated_at 01:32:39Z = this callback) | base + gmail.modify + drive.file + **drive** |
| Clerk token endpoint `scopes` | same |
| tokeninfo | same, `expires_in` 3542 s (a token minted by this sign-in) |
| Accounts page | gmail.modify + drive.file badges green, no "missing" |
| dashboard | no "Action Required" banner, no "Enable full Drive access" card (it renders only when the token lacks `drive`) |

So Clerk writes `approved_scopes` from what Google returned (the token
response's `scope`, i.e. the union), not from what it requested — the record
and the token both kept `drive` through a sign-in that did not ask for it.

Confound noted by the runner: another session was driving the same CDP Chrome and
took USER_A through a Google consent page (`prompt=consent select_account`, the
sign-in scope set) on a different localhost port at ~01:27Z; Clerk
`last_sign_in_at` reads 01:28:48Z. PostHog for USER_A over the window (scratchpad
query, read-only): no `google_reconnect_started`, no `drive_scope_enable_*`, only
`sign_in_completed` at 01:29Z (port 3000, `drive_file_scope=true`), then an
`mcp_connection_created` at 01:40Z — i.e. a Clerk sign-in through the hosted
OAuth-server route (an MCP connect), which `_v4.md` recorded as the one sign-in
path that shows Google's consent screens and therefore issues a NEW refresh token
scoped to the sign-in set. The arm-1 reading itself is unambiguous (the record's
`updated_at` is this sign-in's callback), and the confound turns the post-expiry
reading into the decisive one: if the first refreshed token still carries
`drive`, the `include_granted_scopes` pass widened (or replaced) the refresh
token too; if it comes back without `drive` while the record lists it, the
parameter fixes the access token and the record for an hour but not a narrow
refresh token (the `recordOverstates` case `reconcileScopes` already handles).

Instance facts read from the dev Frontend API `/v1/environment` (public):
`single_session_mode = true`, and the Google social connection exposes only
`enabled / required / authenticatable / block_email_subaddresses / strategy /
name` — no authorization-parameter setting. Single-session mode also means a
USER_B sign-in in the shared CDP Chrome would sign the other sessions' USER_A
out everywhere, so the control arm runs on USER_A too (crossover), after the
post-expiry reading.

### Arm 1, first refresh (watch every 5 min, 01:45Z–02:30Z)

Disturbed: another session signed USER_A in at 01:45:06Z and its callback rewrote
the record at 01:45:37Z (so the token the watch tracked from 01:50Z was minted by
that pass, not by arm 1). PostHog names the pass: `drive_scope_enable_started`
(`reenable=false`) at 01:45:15Z on a Vercel preview deployment, which serves the
same dev Clerk instance — the "Enable full Drive access" card's consent pass,
which asks for `drive` with `prompt=consent` and therefore issued a fresh WIDE
refresh token. The wide refresh observed at 02:30Z is that pass's doing; whether
arm 1's own pass touched the refresh token is not knowable from it. Two readings
survive:

| | value |
|---|---|
| record after the 01:45Z pass | still base + gmail.modify + drive.file + **drive** |
| first refreshed token (02:30:32Z, `expires_in` 3598) | base + gmail.modify + drive.file + **drive** — the stored refresh token is wide |
| Clerk refresh timing | refreshed with ~15 min left on the old token (1206 s at 02:25Z → 3598 s at 02:30Z): the "post-expiry" token arrives ~45 min after a mint, not 60 |

### Arms M2 / M1r / M3 — USER_A, same Google request as a sign-in, via the reauthorize leg

Why the reauthorize leg: the instance is single-session and the only browser
that can reach localhost (the shared CDP Chrome) also carries the other
sessions' USER_A tabs, so a sign-out + sign-in cycle (or any USER_B sign-in)
would log them out. `externalAccount.reauthorize({additionalScopes:
[gmail.modify], oidcPrompt})` asks Google for exactly the configured sign-in
scope set with the same `prompt`, through Clerk's own callback — identical on
Google's side, and no session churn. Arm 1 already proved the real sign-in leg
behaves the same way (Clerk records the union Google returns).

Each pass asked Google for `scope = openid userinfo.email userinfo.profile
gmail.modify drive.file` (five scopes, no `drive`), `access_type=offline`,
`response_type=code`, plus a `login_hint` Clerk adds on this leg (so the chooser
lists only USER_A). Probes within 25 s of each callback.

| pass (02:3x Z) | Google request | Google screens | record `approved_scopes` after | tokeninfo after |
|---|---|---|---|---|
| **control, by another session** — a plain sign-in on a Vercel preview at 02:34:19Z (not ours, but exactly the production path) | sign-in set, no parameter | — | base + gmail.modify + drive.file — **`drive` gone** | same — **`drive` gone** |
| **M2** narrow reauthorize, `prompt=select_account`, no parameter (02:37:06Z) | sign-in set | chooser only | stays narrow | stays narrow |
| **M1r** same + `include_granted_scopes=true` (02:38:29Z) | sign-in set + parameter | chooser only, no consent | base + gmail.modify + drive.file + **`drive` back** | **`drive` back** (`expires_in` 3576 — a token minted by this pass) |
| **M3** `prompt=consent` + `include_granted_scopes=true` (02:39:31Z–02:40:55Z) | sign-in set + parameter | unverified-app warning → "You're signing back in" → consent "accounts.dev already has some access — see the 6 services" (no checkboxes; the dialog listed full Drive, drive.file, Gmail, profile, email, association) | callback failed: Clerk `/v1/oauth_callback?err_code=authorization_invalid` → external account **unverified, scopes empty, no token** | token unavailable |

What this settles:

- **Google never narrowed anything.** The M3 disclosure listed "See, edit, create,
  and delete all of your Google Drive files" as already granted while Clerk's
  record and token lacked it — the narrowing lives entirely in what Clerk requests
  and stores, exactly as `_v2.md` concluded.
- **The parameter restores as well as preserves.** From a narrowed record (the
  02:34Z sign-in), one chooser-only pass with `include_granted_scopes=true`
  returned a token carrying the union and Clerk wrote the union to
  `approved_scopes`. The same pass without the parameter changes nothing.
- **Clerk's record follows Google's `scope` response**, not Clerk's request.
- Dashboard consequences observed live: after the narrowing, the profile page
  showed the "Google Drive access / Enable full Drive access" card (this build
  shows the first-time wording, not "needs re-enabling", because the profile had
  no tree setting saved); after M1r the card was gone. The Accounts page badge
  row only ever shows `gmail.modify` and `drive.file`, never `drive`.
- **M3's failure is a harness hazard, not a parameter effect** (M1r and arm 1
  carried the same parameter and completed), and PostHog pins the mechanism:
  `reauthorize()` reports the external account as `unverified` for as long as
  the pass is pending (M2/M1r returned that status too; they completed in ~30 s).
  M3 took 85 s across three Google screens. In that window another session's
  preview dashboard loaded for USER_A, `checkGoogleAccess` saw no *verified*
  Google account and rendered "Action Required: Connect Google Account", and
  that session's runner clicked its button — `google_reconnect_started
  {source: card}` at 02:40:55.3Z, the same second our consent pass returned to
  Clerk. That click runs `startGoogleReconnect`'s not-verified branch: destroy
  the external account and create a new one. Our code arrived for an account
  that no longer existed → `authorization_invalid`; the probe's
  `unverified / scopes empty` at 02:41Z was the OTHER session's new pending
  account, which its consent pass completed at 02:43:25Z. Two product notes
  fall out of this, for a follow-up rather than this spike: (a) a pending
  reauthorize makes a healthy grant look dead on every other open dashboard
  for its duration, and (b) the card's destroy-and-recreate branch fires on
  that transient state — a second tab or device can break a user's grant
  mid-consent. Clerk trace id in the probe log for the Application Logs.
- **Repaired by another session at 02:43:25Z** before our repair runner acted (it
  checked first and stopped — the account was `verified` again). The repair was a
  standard consent reconnect without the parameter: record and token came back as
  base + gmail.modify + drive.file, no `drive`, and a consent pass issues a new
  refresh token, so from 02:43Z USER_A holds a NARROW refresh token while Google
  still holds `drive`. That is the fixture for the decisive reading below (M5).

### M5 — chooser-only pass with the parameter over a NARROW refresh token (03:02:33Z)

Fixture confirmed twice over: after the 02:43Z repair, yet another session ran a
consent pass on USER_A at 02:55:46Z–02:56:50Z (the runner saw Google's
consentview in the shared Chrome's console log; record rewritten 02:56:50Z, still
without `drive`). So immediately before M5 the stored refresh token was at most
six minutes old and scoped to the sign-in set; Google's grant still held `drive`.

Pass: in-place `reauthorize` (verified branch), `additionalScopes: [gmail.modify]`,
`prompt=select_account`, URL sent with `include_granted_scopes=true`
(request `scope` = the same five sign-in scopes, no `drive`). Google: account
chooser only, one row, no consent. Round trip 03:02:23Z → 03:02:37Z.

| reading | value |
|---|---|
| pre-M5 (02:52:57Z) record = token endpoint = tokeninfo | base + gmail.modify + drive.file (no `drive`) |
| post-M5 (03:02:39Z, record `updated_at` 03:02:33.6Z) record = token endpoint = tokeninfo | base + gmail.modify + drive.file + **drive**, `expires_in` 3593 |
| +60 s | unchanged |
| dashboard | Drive tree card ("Read everything · 0 overrides") renders; the "Enable full Drive access" card is gone |
| Accounts page | badges `gmail.modify`, `drive.file` only — the card never renders a `drive` badge, even with it on the record (the Drive tree card on the profile page is where the scope is surfaced) |

First refresh after this mint: see "Post-expiry readings".

Harness note: the runner's first attempt never reached Google — its chooser click
landed on a background tab (another session's new preview tab had taken the
foreground; `visibilityState` "hidden"), and the probe it ran meanwhile read the
other session's in-flight consent (02:55:46Z `unverified`). It restarted from a
fresh transaction; the 02:56:03Z entry in the probe log is that artefact, not a
measurement.

### Shipped change, validated end to end on the local build (03:26Z–03:29Z)

Fixture: USER_A narrow again after another session's 03:17Z sign-in (record,
token endpoint and tokeninfo all without `drive`). Action: the real Accounts page
"Reconnect Google" button on the dev server running this branch (requests
gmail.modify + drive.file, `prompt=consent`).

| check | result |
|---|---|
| first Google URL after the click | `accounts.google.com/o/oauth2/auth` with `include_granted_scopes=true` at top level; `scope` = the five sign-in scopes (drive.file, not `drive`); `prompt=consent`; `access_type=offline` |
| Google screens | unverified-app warning → "You're signing back in" → consent "accounts.dev already has some access — see the 6 services", no checkboxes → Continue (03:27:13Z) |
| landing | `/dashboard/accounts?reconnected=1` → "Confirming Google permissions…" → **"✓ Google reconnected — gmail.modify and drive.file confirmed."** |
| probe 35 s later (record `updated_at` 03:27:14Z) | record = token endpoint = tokeninfo = base + gmail.modify + drive.file + **drive** (`expires_in` 3559) |
| +60 s | unchanged |
| profile page | Drive tree card ("Read everything · 0 overrides"), no "Enable full Drive access" card |

So a reconnect that asks for `drive.file` no longer strips `drive`; it restores it.
Capability 18 A17 passes locally. (Preview result recorded below when available.)

### Post-expiry readings (first refreshed token after each mint) — NOT OBTAINED

Two attempts, both overwritten by other sessions before the token under test
reached its first refresh (Clerk refreshes ~45 min after a mint):

| token under test | minted | disturbed by | at |
|---|---|---|---|
| arm 1 (modal sign-in + parameter) | 01:32Z | another session's "Enable full Drive access" consent pass on a preview | 01:45Z |
| M5 (chooser-only + parameter over a narrow refresh token) | 03:02Z | another session's plain sign-in on a preview (record narrowed again) | 03:17Z |

Across the window the shared dev USER_A was written by other sessions at 01:28,
01:45, 02:34, 02:43, 02:56 and 03:17Z — roughly every 20 minutes — so a clean
45-minute reading was not available tonight. The experiment is fully specified
and cheap to rerun when the account is quiet (or on a quiet flagged account):

1. Fixture: a consent pass WITHOUT the parameter that requests only the sign-in
   set (any Accounts "Reconnect Google" click on the pre-PR build, or Clerk's
   hosted-route sign-in) → Clerk holds a refresh token scoped to that set, while
   Google still holds `drive`.
2. Pass under test: `reauthorize({additionalScopes: [gmail.modify], oidcPrompt:
   'select_account'})` with `include_granted_scopes=true` appended → probe shows
   the union immediately (measured three times).
3. `scratchpad/watch-refresh.sh USER_A <expires_in> 70 "<note>"` (5-min probes)
   until `expires_in` climbs → the refreshed token either carries `drive` (Google
   issued a union refresh token on the chooser-only pass) or does not (the
   stored narrow refresh token survived; the record now overstates the token,
   the `recordOverstates` branch of `reconcileScopes` denies, and the card's
   consent pass is the durable repair).
4. Same watch after a CONSENT pass with the parameter (the shipped Accounts
   button) answers whether consent-with-parameter refresh tokens are
   union-scoped. Google's documentation and the IETF incremental-authorization
   draft describe the new *grant* as including the previously granted scopes,
   which is what a consent-issued refresh token is minted against — expected
   yes, unmeasured here.

**Design assumption used until measured (the conservative one):** a chooser-only
pass never changes the stored refresh token (Google's documented rule: refresh
tokens come from consent or the first authorization; `_v2.md`–`_v4.md` measured
exactly that for Clerk's own passes). So the parameter on a chooser-only pass
buys the current access token and the record, which is the whole first-hour
outage and the whole "record narrower than token" class; a narrow refresh token
still needs one consent pass, and with the parameter on that pass the consent is
Google's "already has some access" summary rather than a new permission request.

What is NOT in doubt from the measurements above: every pass that carried the
parameter returned the union on the access token and on Clerk's record (arm 1,
M1r, M5), every pass without it stayed narrow (M2, and the four plain sign-ins by
other sessions), and Google never showed a consent screen for the chooser-only
passes.

## Part 3 — go / no-go

**Go — the hypothesis holds where it matters.** On Google's side the parameter does
exactly what its documentation says: a request for the sign-in scope set with
`include_granted_scopes=true` returns a token for everything USER_A ever granted
this client, including `drive`, with no consent screen (chooser only), and Clerk
stores that union as `approved_scopes`. The v1 plan's dismissal was about Clerk's
API surface, which is still true — Clerk offers no carrier for the parameter — but
the URL Clerk hands the browser is Google's own, and FGAC holds it on every leg it
starts itself.

What the parameter cannot do: change the stored refresh token on a chooser-only
pass (Google issues refresh tokens on consent only), or reach the one sign-in
path FGAC does not render — Clerk's hosted OAuth-server sign-in used by MCP
connector connects, which shows consent and issues a refresh token scoped to the
sign-in set. Those bound the residual, sized by the post-expiry readings below.

### Smallest change (recommended)

Two pieces, both on legs FGAC already owns, no Clerk internals, nothing added to
any sign-in scope list, nothing changed in the Clerk dashboard:

1. **`startGoogleReconnect` returns the Google URL with `include_granted_scopes=true`**
   (`src/app/dashboard/googleReconnect.ts`, one `URL.searchParams.set` on the
   URL it already returns, both branches; unit test asserting the parameter and
   that nothing else in the URL changes). Every FGAC reconnect pass — Picker
   detour, Accounts "Reconnect Google", `ConnectGoogleWarning` manual and
   post-sign-in auto-repair, the Drive card — then returns Google's full grant
   instead of narrowing it. Today a flagged user who hits any of those legs
   loses `drive` (they request `drive.file`); with the parameter they keep it.
   For non-flagged users the union equals the requested set — they were never
   asked for `drive` — with one knowable exception: an account that once granted
   the legacy `https://mail.google.com/` scope gets it back on the token (FGAC
   treats it as the same Gmail capability; the Google-side grant already holds
   it either way).
2. **Post-sign-in auto re-widen for flagged users only**, mirroring the existing
   `ConnectGoogleWarning` auto-repair: when `EnableDriveAccessCard` renders in
   its `reenable` state (flag on, profile saved a tree setting, token lacks
   `drive`) within a few minutes of a sign-in, it starts the reauthorize itself
   with `prompt=select_account` instead of `consent` (the parameter makes the
   consent unnecessary: Google already holds the scope, so the pass is one
   chooser click and no unverified-app warning), returns to the same page, and
   the existing `?drive_scope=1` poll verifies it. Same guards as the Gmail
   auto-repair: verified external account only, once per `lastSignInAt`, never
   on an OAuth return leg. The first-time grant (card not in `reenable` state)
   keeps the explicit click and `prompt=consent`. Non-flagged users never render
   the card, so nothing changes for them; the flag check stays server-side
   (`/api/drive/flag`, `driveTreeFlagOn`).

Why not rewrite the sign-in leg itself: the modal's Google URL is only reachable
through `Clerk.__internal_windowNavigate` (an underscore-internal clerk-js
property — fine for this spike's runners, not for production) or by replacing the
Clerk modal's Google button with a custom `signIn.create` flow (a sign-up UX
change). Either would also apply the union to every sign-in for every user,
because nobody is signed in when the parameter would be added — the flag cannot
gate it. The two pieces above keep the change inside flag-gated, FGAC-owned code
and cost the affected user one chooser click right after a narrowing sign-in.

Not implemented in this spike beyond piece 1 (the one-line parameter plus its
test); piece 2 is a follow-up PR with QA capability 18 assertions for the
re-widen (chooser-only, `drive` back on tokeninfo, card gone, `drive_scope_enabled`
with `reenable: true`).

### Residual and what to measure after shipping

- Sizing in production: `npm run google:scope-sweep -- --prod --tokens` counts
  narrow served tokens; the Drive-tree cohort is the flag's PostHog membership.
  The before-figure for the beta cohort is `drive_scope_enable_started` with
  `reenable: true` (each one is a user who lost the scope and had to click
  through three Google screens); after the change those should become
  `drive_scope_enabled {reenable: true}` with no preceding click, and the only
  remaining `reenable` clicks should follow an MCP-connector connect.
