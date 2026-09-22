# Capability: Google Slides Management (Expose, Access, Tools)

## Overview
Covers the Google Slides per-file access lifecycle end to end: the dashboard UX
for exposing a presentation to a profile (Google Picker `PRESENTATIONS` view,
sharing the sheets/docs `drive.file` machinery), the curated MCP tools
(`slides_get_presentation`, `slides_edit`, plus the cross-service
`comments_read`/`comments_add` pair), raw-API enforcement of the
`presentations` family (which was scope-backstop passthrough — and 403
`SERVICE_DISABLED` at Google — before this feature), the proxy-route twin,
agent-created-presentation auto-grant, and the slides approval/recovery funnel.
Everything here mirrors capability 19 (docs) and 09/17 (sheets) semantics —
where behavior intentionally differs, the assertion says so. Slides was the
acceptance test of the kind-descriptor abstraction (`src/lib/driveFileKinds.ts`):
nothing here relies on a Slides-specific branch in shared code.

## Pre-requisites
* `/qa-setup` complete; dev server running; USER_A signed in on the dashboard.
* At least one proxy key (Agent Profile) exists with a known bearer token.
* Slides fixtures owned by USER_A (see `setup/03_rules_configuration.md`):
  - one "exposed" presentation (picked in the Picker at least once, or created
    by the agent through FGAC), and
  - one "external" presentation that has NEVER been picked (created directly
    at slides.google.com) — the negative-control fixture. Both fixture ids are
    recorded in the local QA state, never inline here.
* **Google Slides API enabled on the GCP project behind the environment's
  OAuth client.** Dev (627660126377) has it enabled; production (727876597677)
  needs a console action by the owner. A 403 whose `error_reason` is
  `SERVICE_DISABLED` is that blocker, not a rule or grant failure (A14).
* UI assertions: built-in browser (Picker iframe caveats identical to
  capability 09's harness note — the app-API seam here is
  `POST /api/rules/grant-slides-access` / the `exposeFilesOfKindFromPicker`
  action). API assertions: MCP tools with the profile's connection, or curl
  with the profile's `sk_proxy_` bearer against `/api/proxy/v1/presentations/...`.

## Assertions

### A1: "+ Expose a presentation" on a profile opens the Google Picker with the Presentations view
- On `/dashboard`, select any profile tab and click **+ Expose a presentation**
  in the Google Slides Rules card (rendered below the Sheets and Docs cards,
  amber tone).
- **Expected**: The Google Picker modal opens on this page with the
  Presentations tab (not spreadsheets, not documents). No navigation, no
  dead-end. (If the drive.file grant is missing, a redirect to Google consent
  is acceptable — see A2.) Two views, as for sheets/docs: the flat
  presentations list first, then a "Shared drives" view; only presentations
  can be picked.

### A2: Consent round-trip returns kind-scoped — the slides picker reopens, not the sheets or docs one
- Deterministic proxy for the return leg: navigate to
  `/dashboard?autoOpenPicker=true&pickerKind=slide&pickerContext=<profileId>`.
- **Expected**: The URL is cleaned AND the PRESENTATIONS-view picker opens.
  `pickerKind=doc` opens the Documents picker and a legacy URL without
  `pickerKind` opens the SHEETS picker — the three picker hook instances on
  the dashboard must not fire together.

### A3: A presentation picked from a profile is scoped to that profile, defaulting to Read Only
- With a presentation exposed from profile P's card, check the rules state
  (dashboard or `GET /api/rules/grant-slides-access`).
- **Expected**: The new rule has `service='slides'`, `actionType='slide_read'`,
  the presentation's `targetResourceId` and `resourceName`, and is assigned to
  P (`slidesRules` key in the API response). Re-picking the same presentation
  must not narrow existing global rules (same merge semantics as sheets/docs).

### A4: Accounts-page "Add Google Slides +" creates a global slides rule
- On `/dashboard/accounts`, click **Add Google Slides +** in the Google Slides
  Access Rules card (third manager, below Sheets and Docs).
- **Expected**: Picker opens directly (Presentations view); a picked
  presentation appears in the slides table with its ID shown under
  "Presentation ID"; the rule is global. The sheets and docs managers above it
  are unchanged.

### A5: get_my_permissions carries the presentation id for slides rules
- As an agent, call `get_my_permissions`.
- **Expected**: Every slides rule includes `presentationId` (the
  `targetResourceId`) and `resourceName`; `defaults.slides` states
  presentations are DENIED unless exposed; `defaults.rawApi` names
  `POST v1/presentations` among the auto-granted creates and no longer says
  Slides is "forwarded under drive.file". `list_accounts.next_steps.slides`
  names `slides_get_presentation` and `presentationId`.

### A6: Unexposed presentation is denied with a slides_expose approval link
- Call `slides_get_presentation` (and raw `google_api_get` with path
  `v1/presentations/<external presentation id>` AND
  `slides/v1/presentations/<external presentation id>`) for a presentation
  with NO slides rule.
- **Expected**: 🚫 denial naming the presentation id,
  `denial_code=slides_not_exposed`, `file_service=slides`, and
  `raw_api_family='presentations'` on the raw calls' tool-call events, and a
  deterministic, permanent approval link whose action is `slides_expose`
  (same URL on every repeat, no expiry — capability 14 A12/A13). The
  `presentations` family must NOT fall through to raw passthrough (the
  pre-feature behavior, `raw_api_family='slides'`) — the denial is FGAC's,
  not Google's.
- Then repeat `slides_get_presentation` with (a) `<external id>/edit`, (b)
  the full `https://docs.google.com/presentation/d/<external id>/edit#slide=id.p`
  URL, (c) a junk value such as `not-a-real-id`, and (d) a Docs URL
  (`https://docs.google.com/document/d/<fixture doc id>/edit`). Run the same
  four through `request_access` with `type=slides_read`.
- **Expected** (drive-file-id hardening, as capability 19 A6): (a) and (b)
  behave exactly like the bare id — same `slides_not_exposed` denial, the
  SAME approval link (`r=<id>`), `file_id_input=suffixed` / `url`. (c) is 🚫
  `file_id_malformed` with NO link. (d) is 🚫 `file_id_wrong_kind` naming
  `docs_read_document` / `docs_edit` and `documentId`, also link-free.
  Conversely a Slides URL passed to `docs_read_document` is refused as
  `file_id_wrong_kind` naming `slides_get_presentation` and `presentationId`.

### A7: Exposed presentation reads succeed through every read surface
- With the exposed fixture presentation under a `slide_read` rule: call
  `slides_get_presentation` (no `fields`), `slides_get_presentation` with
  `fields=title`, `slides_get_presentation` with `offset=0&limit=2000`, raw
  `google_api_get` `v1/presentations/<id>` and `slides/v1/presentations/<id>`,
  and proxy `GET /api/proxy/v1/presentations/<id>`.
- **Expected**: All return the raw Slides API presentation resource (title,
  slides, pageElements JSON — no FGAC transformation); the `fields` variant
  returns only the masked fields; the windowed variant returns the envelope
  (`total_chars`, `next_offset`, `presentationId`). Events carry
  `response_chars`/`response_kb` (capability 16 A8) and `file_service=slides`.

### A8: Writes require Read & Write — and use batchUpdate semantics
- With the rule at `slide_read`: call `slides_edit` (any request, e.g. a
  `createSlide`) and raw `google_api_modify` `v1/presentations/<id>:batchUpdate`.
- **Expected**: Both denied with `denial_code=slides_read_only` and a
  `slides_write` approval link (write-level, never a read-only under-grant —
  same matrix as sheets/docs). After flipping the rule to `slide_read_write`:
  `slides_edit` with `createSlide` (BLANK layout) adds a slide,
  `createShape` + `insertText` on that slide adds a text box with text,
  `replaceAllText` replaces occurrences, raw batchUpdate succeeds, and the
  changes are visible in a follow-up `slides_get_presentation` (the new
  slide's `objectId` appears in `slides[]`). The response is Google's
  batchUpdate reply only — no verification line (Slides has no body-index
  model; the docs_edit delete verification is docs-specific by design).

### A9: slide_block denies everything and never mints a link
- Set the rule to `slide_block` (Blocked in either dashboard select).
- **Expected**: Reads AND writes are denied with
  `denial_code=slides_blocked`; the denial carries NO approval link
  (weakening a deliberate block stays a dashboard act). The underlying Google
  grant is kept (flipping back to Read Only restores access without
  re-picking).

### A10: Agent-created presentations are auto-granted to the creating key
- Call raw `google_api_modify` POST `v1/presentations` with body
  `{"title": "..."}`; separately, POST `drive/v3/files` with
  `{"name": "...", "mimeType": "application/vnd.google-apps.presentation"}`.
- **Expected**: Both return 200 with a new id; a `slide_read_write` rule
  scoped to the calling key appears for each (ruleName `Agent-created:
  <title>`); an immediate `slides_get_presentation` on each new id succeeds
  with no approval; `agent_slide_created` fires with `auto_granted=true` and
  `origin=create` / `origin=drive_create`; the Drive-side create's tool-call
  event stamps `file_created_kind='slide'` (it was `'other'` while Slides was
  stubbed).

### A11: Proxy route enforces slides rules like MCP does
- With the profile's `sk_proxy_` bearer: `GET /api/proxy/v1/presentations/<exposed id>`
  (expect 200), `GET` on the never-picked external presentation id (expect 403
  naming the presentation), `POST /api/proxy/v1/presentations/<exposed id>:batchUpdate`
  under `slide_read` (expect 403 read-only), and a Drive-path probe
  `GET /api/proxy/drive/v3/files/<exposed presentation id>` (expect the slides
  rule to authorize it — the Drive per-file guard honors every kind's rules).
  `proxy_request` events for these carry `service='slides'`.

### A12: Slides grant recovery mirrors the sheets/docs funnel
- Create a slides rule for a real-but-never-picked presentation id via the
  app-API seam (`POST /api/rules/grant-slides-access`), then:
  1. dashboard slides manager and the profile card show the "⚠ Needs Google
     access — finish setup" chip linking to `/dashboard/slides-setup?pid=<id>`;
  2. the slides-setup page offers the pick-first recovery (no sheets demo
     video is embedded for slides — intentional until a slides video exists);
  3. an MCP slides call in this stranded state returns the honest post-policy
     🚫 guidance pointing at `/dashboard/slides-setup?pid=<id>` (never a bare
     "check the ID"), `denial_code=file_grant_missing_at_google`;
  4. a magic-link approval for this presentation lands in the pick-first
     state (`slides-flow-pick-first` testid), and `verify-slides-access?pid=<id>`
     reports `missing` → after a Picker pick, `ok` with the title.

### A13: Comments follow the file's rule (typed pair and raw path)
- On the exposed presentation at `slide_read`: `comments_read` (expect 200),
  then `comments_add` with a short comment (expect 🚫 `slides_read_only` with
  a `slides_write` approval link). Flip to `slide_read_write`: `comments_add`
  succeeds; a reply with `commentId` and `resolve: true` posts a resolving
  reply; `comments_read` shows `resolved: true`.
- Raw path parity: `google_api_get` on
  `drive/v3/files/<exposed id>/comments?fields=comments(id)` succeeds and
  stamps `raw_api_family='drive_comments'`; the same POST on the never-picked
  external presentation id denies with `denial_code=file_not_exposed` and NO
  approval link.

### A14: A disabled Slides API is reported as the console blocker, never as a rule or grant failure
- On an environment whose GCP project has the Slides API disabled (production
  until the owner enables it on 727876597677), call `slides_get_presentation`
  on an exposed, Google-verified presentation.
- **Expected**: The tool-call event carries `error_status=403` and
  `error_reason=SERVICE_DISABLED`; the runner records the capability as
  **`blocked`** with the project number from Google's error body
  (`activationUrl`), and does NOT mark A7/A8/A10 as failures. On dev (Slides
  API enabled) this assertion is `skip` with reason "API enabled on this
  project". `docs/monitoring.md` 7.27 is the standing query.

## Analytics hooks
`slides_grant_verification`, `slides_grant_recovered`, `agent_slide_created`,
`approval_link_minted` with `action=slides_expose|slides_write`, denial codes
`slides_not_exposed|slides_read_only|slides_blocked|file_not_exposed|file_grant_missing_at_google`,
grace props `slides_grace_*`, `file_service='slides'`,
`raw_api_family='presentations'` on raw Slides calls (pre-feature rows carry
`'slides'`), `raw_api_family='drive_comments'` on raw comment calls,
`file_created_kind='slide'` on Drive-side creates, `proxy_request.service='slides'`,
and universal `response_chars`/`response_kb` (capability 16).
