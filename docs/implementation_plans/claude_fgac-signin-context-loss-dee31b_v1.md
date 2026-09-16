# Approval context lost at sign-in — v1

Branch: `claude/fgac-signin-context-loss-dee31b` · 2026-09-16

## The problem, mechanically

1. An agent denial (or `request_access`) hands the person a deterministic
   approval link, `/dashboard/approve?a=…&k=…&r=…&s=…`.
2. In the Claude desktop app a link click opens the **in-app browser pane**,
   which holds no FGAC session.
3. `/dashboard(.*)` is Clerk-protected, so middleware redirects the pane to
   Clerk's hosted sign-in, `accounts.fgac.ai/sign-in?redirect_url=<the approve
   URL>` (verified against production 2026-09-15).
4. The person is already signed in in their *real* browser, so they copy the
   pane's URL there. Clerk's hosted sign-in, visited by a signed-in user, goes
   to the instance **Home URL** (per Clerk's SignIn docs; not yet reproduced
   in a controlled test — see Open items), which is `/dashboard`, which
   redirects to the default profile. The `redirect_url` never gets applied.
5. Nothing on the dashboard knows a request was pending. The person has to go
   back to the chat and click again — from the pane, which repeats step 2.

### Size (PostHog, since the `client` label shipped 2026-09-09; measured 2026-09-15)

| | count |
| --- | --- |
| Approval requests minted | 188 |
| Never opened by a human | 110 |
| Never opened, owner signed in within the hour | 15 |
| …of which the sign-in came from Claude desktop's browser | 8 |
| Landing page of those sign-ins | `/dashboard/agents/default-profile`, every one |

Opens that *do* happen in the Claude desktop pane convert at 71% vs 86% in a
regular browser (17 vs 50 opened requests — small numbers, same direction).

The hop in step 3 had no analytics row at all: `approval_link_opened` fires
from the page, and the page never renders. The 110 "never opened" hid the
whole class.

## Shipped in this branch: telemetry for the hop

- **`approval_sign_in_wall`** (new, edge middleware): a signed-out visit to an
  approval link records `action`, `proxy_key_id`, `target_hash` (the same HMAC
  `approval_link_minted` carries — the join key, since pre-auth there is no
  user to derive `request_id` from), the approve-page client class
  (`browser` / `claude_desktop` / `agent`), and `navigation` (document
  navigation = Clerk redirects; otherwise Clerk 404s — agents probing the
  link). Sent with a dependency-free POST from the edge runtime
  (`src/lib/posthogEdge.ts`); `posthog-node` and `after()` are unavailable in
  middleware.
- **Marker cookie `fgac_approval_wall`** (30 min, `a=<action>&h=<hash>&t=<unix>`)
  set on the sign-in redirect. Middleware deletes it when a signed-in visit
  reaches the approve page (context preserved — nothing to attribute).
- **`sign_in_completed`** gains `client`, `landing_path`, `after_approval_wall`
  and the wall's action / hash / age. The component mounts on dashboard pages
  only, never on `/dashboard/approve`, so `after_approval_wall: true` **is**
  the lost-context sign-in, one row each. The cookie is retired after one read.
- Docs: `analytics.md` rows, `monitoring.md` §7.25 (the two queries), QA
  capability 16 A22. Unit test `scripts/test-approval-wall.ts` in `mcp:lint`.

What the two signals cover: same-browser loss (wall → sign-in → dashboard) is
exact via the cookie; cross-browser loss (wall in the pane, already signed in
elsewhere, so no sign-in ever fires) shows as a wall request with no later
open. Together they are the size of the problem; the pending-approvals
surface below is judged by them.

Dev-instance caveat: on localhost the first cookie-less visit is answered by
Clerk's dev-browser handshake *before* the middleware handler runs, so the
wall event fires on the post-handshake request. Production has no such hop.

## Proposal A — pending approvals on the dashboard (the durable fix)

Every entry path ends on the dashboard eventually: the pane, a phone, a link
pasted a day later, a Home-URL redirect. So the dashboard itself must know
what is waiting. No new step for the user; it removes one.

### Data

`approval_requests` already has one row per request with `action`,
`proxy_key_id`, `resource_name`, `mint_count`, `first/last_minted_at`,
`opened_at`, `approved_at`. It lacks the **raw target** (only `target_hash`),
so the deterministic URL cannot be rebuilt from it. Add:

| column | why |
| --- | --- |
| `target text` | recipient / spreadsheet id / document id — the same values `access_rules` already stores in the clear; needed to re-mint the signed URL server-side |
| `resolved_at timestamp`, `resolution text` | `approved` · `substituted` · `granted_elsewhere` · `superseded` · `dismissed` · `key_revoked` — one place that says why a request stopped being pending, so the banner query is a single predicate and analytics can count each exit |
| `auto_routed_at timestamp` | post-sign-in redirect fires once per request (below) |

Backfill: none for `target` (rows minted before the column stay non-routable
and simply age out under the TTL); `resolution = 'approved'` where
`approved_at` is set.

### What counts as pending

```
approved_at IS NULL AND resolved_at IS NULL
AND last_minted_at > now() - 7 days
AND proxy key not revoked
AND no live grant for (key, action, target)   -- grantActiveForApproval, at render
```

`last_minted_at` (not `first_minted_at`) drives the TTL on purpose: a live
agent loop re-mints the same deterministic link and keeps its request
visible; a dead one ages out in a week.

### Clearing rules — how a request that can never be approved stops hanging

This is the concern raised on 2026-09-16: an agent asks for a sheet by an id
that is wrong (misread, hallucinated, a different tab's id), the person adds
the sheet they *meant*, and the request for the wrong id would sit in the
banner forever. Each exit below is a concrete, testable rule; there is no
"it will probably clear".

| exit | when it fires | already exists? |
| --- | --- | --- |
| `approved` | the approve page grants exactly this target | yes (`approved_at`) |
| `substituted` | the approve page's Picker returns a *different* file than requested and the person confirms it. `applyFileGrantApproval` already stamps the original request approved in this case (`substituted: true` on the event); this just names it | yes, unnamed |
| `granted_elsewhere` | at banner render, `grantActiveForApproval` finds an active rule for the same key + action + target — the person granted it through the dashboard Picker manager or the grant API. Stamp and hide | render-time check exists on the approve page; the stamp is new |
| `superseded` | a *later* request for the same key and same action **kind** (sheets/docs read or write) is approved after this one was minted. This is the wrong-id case exactly: the agent re-requests with the corrected id, the person approves that, the stale one closes. Stamped inside the approval action, one extra UPDATE | new |
| `dismissed` | the banner's "Not needed" button. Explicit, per request, reversible only by a fresh mint (which resets `resolved_at` — a re-request is new intent) | new |
| `key_revoked` | the profile the request is scoped to is revoked | new (cheap join) |
| TTL | `last_minted_at` older than 7 days — the request is not pending, it is history. It stays queryable | new |

Not proposed: guessing that an unrelated same-service grant "probably" handled
it. If the person grants sheet B while the agent asked for sheet A and never
re-asks, the request for A shows until they dismiss it or it ages out. That
is the honest state — A was never granted.

Validity at mint time is already enforced (`resolveDriveFileId` refuses
malformed ids before a link is minted), so "invalid id" in practice means a
well-formed id for the wrong file — the `substituted` / `superseded` exits are
the ones that carry it.

### Surface

- **Banner** on every dashboard page (top of `AgentProfilesView`, above the
  existing pending-connections banner, same visual weight): "1 approval
  waiting — read-only access to spreadsheet *Budget Q3* for profile
  *Default*. Requested 12 min ago." Buttons: **Review** (the re-minted
  approve URL) · **Not needed**. Several requests: a list, newest first,
  capped at 5 with "and N more".
- **Post-sign-in routing**: `/dashboard`'s server redirect, when exactly one
  request is pending, was minted in the last 24 h, and has no
  `auto_routed_at`, goes to that request's approve URL instead of the profile
  page, stamping `auto_routed_at`. Once per request, so a person who backs
  out is not trapped; the banner still shows it. This removes the step the
  redirect lost, for the common single-request case.
- **Agent copy**: `request_access` and the denial footer add one sentence —
  "If the link opens a sign-in page, sign in and the request will be waiting
  on your dashboard." No behaviour change for agents.

### Telemetry for A

`approval_request_resolved {resolution, request_id, age_s}` on every exit
except TTL; `approval_banner_shown {pending_count}`; `approval_auto_routed
{request_id}`. Success = §7.25's `pct_recovered` rises and lost-context
sign-ins stop mattering (banner picks the request up), and
`approval_link_approved` per minted request rises from the 09-09 → 09-15
baseline.

## Proposal B — keep the approve URL as the URL (embedded sign-in)

Accepted condition (2026-09-16): no extra step. The version that adds none:

- Make `/dashboard/approve` **public** in middleware (the page already does
  its own `auth()` and refuses everything it cannot verify; nothing is
  granted without the owner's session plus a signed link plus a live
  ownership check).
- When signed out, the page renders a one-line summary derivable without a
  user — the action kind from `a` (`"An agent is asking for read-only access
  to a spreadsheet"`) — and Clerk's `<SignIn />` component **inline**, with
  `forceRedirectUrl` set to the page's own URL. Same click count as the hosted
  page (one "Continue with Google"), but:
  - the pane's address bar stays on the approve link, so the URL a person
    copies into their real browser is the approve link, which renders the
    approval directly for a signed-in browser — no Clerk hop, no Home URL;
  - the sign-in that does happen returns to the same URL by construction,
    with no dependence on Clerk's `redirect_url` handling.
- Clerk's `<SignIn />` on a page needs the app's `NEXT_PUBLIC_CLERK_SIGN_IN_URL`
  left unset (the component works standalone; the hosted portal keeps serving
  every other protected route).

The telemetry shipped here keeps working under B: the wall event moves from
middleware into the page's signed-out branch, and `after_approval_wall` keeps
its meaning.

## On "nudging Claude to open the link in the default browser"

FGAC cannot choose the browser; the Claude desktop app decides per click. The
person has two options today — Cmd-click (macOS) / Ctrl-click (Windows) opens
the system browser, and the click chooser offers "Default browser" — and a
permanent setting is an open request
(anthropics/claude-code#81515). Two things are in FGAC's hands:

1. The text the agent relays. The `request_access` note and the denial footer
   can say "opens best in your normal browser (Cmd-click on Mac)". Cheap; not
   changed in this branch.
2. Under Proposal B, an "Open in your browser" control on the signed-out
   approve page. Electron in-app panes commonly route `target="_blank"` to the
   system browser; needs one measurement in the pane before relying on it.

Proposal A makes the browser choice stop mattering, which is the better
outcome than steering it.

## Order

1. This branch: telemetry (done) → PR → preview.
2. Proposal A: migration + ledger writes (`target`, `resolution`) first, so
   data accrues; then the banner; then auto-route.
3. Proposal B: after A, measured against §7.25.

## Open items

- Clerk's signed-in behaviour on `accounts.*/sign-in?redirect_url=…` (Home
  URL vs `redirect_url`) is from Clerk's component docs and the observed
  symptom, not a controlled run. The QA runner could not test it on
  2026-09-15 because the built-in browser held no production Clerk session.
  A local check needs a signed-in pane and a fresh `accounts.dev` sign-in URL
  with `redirect_url` — cheap to add to the next QA pass.
- Whether `target="_blank"` escapes the Claude desktop pane (Proposal B item 2).
