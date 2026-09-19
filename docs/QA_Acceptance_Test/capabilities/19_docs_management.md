# Capability: Google Docs Management (Expose, Access, Tools)

## Overview
Covers the Google Docs per-file access lifecycle end to end: the dashboard UX for
exposing a document to a profile (Google Picker `DOCUMENTS` view, sharing the
sheets `drive.file` machinery), the curated MCP tools (`docs_read_document`,
`docs_edit` — which replaced `docs_append_text`/`docs_replace_text` in the
2026-08-23 reshape — and the cross-service `comments_read`/`comments_add`
pair), raw-API enforcement of the `documents`
family (which was unenforced passthrough before this feature), the proxy-route
twin, agent-created-doc auto-grant, and the docs approval/recovery funnel.
Everything here mirrors capability 09/17 semantics for sheets — where behavior
intentionally differs, the assertion says so.

## Pre-requisites
* `/qa-setup` complete; dev server running; USER_A signed in on the dashboard.
* At least one proxy key (Agent Profile) exists with a known bearer token.
* Docs fixtures owned by USER_A (see `setup/03_rules_configuration.md`):
  - one "exposed" Google Doc (picked in the Picker at least once), and
  - one "external" Google Doc that has NEVER been picked (created directly at
    docs.google.com) — the negative-control fixture. Both fixture ids are
    recorded in the setup doc, never inline here.
* UI assertions: built-in browser (Picker iframe caveats identical to
  capability 09's harness note — the app-API seam here is
  `POST /api/rules/grant-docs-access` / the `exposeDocsFromPicker` action).
  API assertions: MCP tools with the profile's connection, or curl with the
  profile's `sk_proxy_` bearer against `/api/proxy/v1/documents/...`.

## Assertions

### A1: "+ Expose a doc" on a profile opens the Google Picker with the Documents view
- On `/dashboard`, select any profile tab and click **+ Expose a doc** in the
  Google Docs Rules card.
- **Expected**: The Google Picker modal opens on this page with the Documents
  tab (not spreadsheets). No navigation, no dead-end. (If the drive.file grant
  is missing, a redirect to Google consent is acceptable — see A2.) As for
  sheets (capability 09 A1): two views — the flat documents list first
  (files at the root without a search), then a "Shared drives" view that lists
  a Workspace account's shared drives with navigable, unselectable folders;
  only documents can be picked.

### A2: Consent round-trip returns kind-scoped — the docs picker reopens, not the sheets one
- Deterministic proxy for the return leg: navigate to
  `/dashboard?autoOpenPicker=true&pickerKind=doc&pickerContext=<profileId>`.
- **Expected**: The URL is cleaned AND the DOCUMENTS-view picker opens. A legacy
  URL without `pickerKind` must open the SHEETS picker (back-compat default) —
  the two picker hook instances on the dashboard must not both fire.

### A3: A doc picked from a profile is scoped to that profile, defaulting to Read Only
- With a doc exposed from profile P's card, check the rules state (dashboard or
  `GET /api/rules/grant-docs-access`).
- **Expected**: The new rule has `service='docs'`, `actionType='doc_read'`, the
  document's `targetResourceId` and `resourceName`, and is assigned to P.
  Re-picking the same doc must not narrow existing global rules (same merge
  semantics as sheets, capability 09 A3).

### A4: Accounts-page "Add Google Doc +" creates a global docs rule
- On `/dashboard/accounts`, click **Add Google Doc +** in the Google Docs
  Access Rules card.
- **Expected**: Picker opens directly (Documents view); a picked doc appears in
  the docs table with its ID shown; the rule is global. The sheets manager
  above it is unchanged.

### A5: get_my_permissions carries the document id for docs rules
- As an agent, call `get_my_permissions`.
- **Expected**: Every docs rule includes `documentId` (the `targetResourceId`)
  and `resourceName`; `defaults.docs` states documents are DENIED unless
  exposed. A docs rule reaching an agent without its document id is a failure.

### A6: Unexposed doc is denied with a docs_expose approval link
- Call `docs_read_document` (and raw `google_api_get` with path
  `v1/documents/<external doc id>`) for a doc with NO docs rule.
- **Expected**: 🚫 denial naming the document id, `denial_code=docs_not_exposed`
  on the tool-call event, and a deterministic, permanent approval link whose
  action is `docs_expose` (same URL on every repeat of the denial, no expiry —
  capability 14 A12/A13). The `documents` family must NOT fall through
  to raw passthrough (pre-docs behavior) — the denial is FGAC's, not Google's.
- Then repeat `docs_read_document` with (a) `<external doc id>/edit` (what an
  agent pastes from a Docs URL), (b) the full
  `https://docs.google.com/document/d/<external doc id>/edit?usp=sharing` URL,
  (c) a junk value such as `not-a-real-id`, and (d) a Sheets URL
  (`https://docs.google.com/spreadsheets/d/<fixture sheet id>/edit`). Run the
  same four through `request_access` with `type=docs_read`.
- **Expected** (drive-file-id hardening, 2026-09-09): (a) and (b) behave
  exactly like the bare id — the same `docs_not_exposed` denial and the SAME
  approval link the bare id produces (`r=<id>`, never `r=<id>%2Fedit`), the
  tool-call event carrying `file_id_input=suffixed` / `url` and
  `file_id=<bare id>`. (c) is 🚫 with `denial_code=file_id_malformed`, the text
  naming the expected shape (20–80 chars of `A-Za-z0-9_-`), and NO link: no
  `approval_link_minted`, no `approval_request_id`, no new `approval_requests`
  row. (d) is 🚫 `file_id_wrong_kind` naming the sheets tools and the extracted
  id, also link-free. `request_access` follows the same matrix — (a)/(b) mint
  the bare-id link, (c)/(d) refuse without minting. A link for a value Google
  can never verify is the dead end this guards against.

### A7: Exposed doc reads succeed through every read surface
- With the exposed fixture doc under a `doc_read` rule: call
  `docs_read_document` (no `fields`), `docs_read_document` with
  `fields=title`, raw `google_api_get` `v1/documents/<id>`, and proxy
  `GET /api/proxy/v1/documents/<id>`.
- **Expected**: All four return the raw Docs API document resource (title/body
  JSON — no FGAC transformation); the `fields` variant returns only the masked
  fields. Responses carry `response_chars`/`response_kb` on their tool-call
  events (capability 16 A8).

### A8: Writes require Read & Write — and use batchUpdate semantics
- With the rule at `doc_read`: call `docs_edit` (any request, e.g. an
  `insertText`) and raw `google_api_modify` `v1/documents/<id>:batchUpdate`.
- **Expected**: Both denied with `denial_code=docs_read_only` and a
  `docs_write` approval link (write-level, never a read-only under-grant —
  same matrix as sheets). After flipping the rule to `doc_read_write`:
  `docs_edit` with an end-of-segment `insertText` appends text (existing
  content untouched), an `insertTable` request inserts a real table, a
  `replaceAllText` request replaces occurrences, raw batchUpdate succeeds,
  and the changes are visible in a follow-up `docs_read_document`.

### A9: doc_block denies everything and never mints a link
- Set the rule to `doc_block` (Blocked in either dashboard select).
- **Expected**: Reads AND writes are denied with
  `denial_code=docs_blocked`; the denial carries NO approval link (weakening a
  deliberate block stays a dashboard act). The underlying Google grant is kept
  (flipping back to Read Only restores access without re-picking).

### A10: Agent-created docs are auto-granted to the creating key
- Call raw `google_api_modify` POST `v1/documents` with body `{"title": "..."}`.
- **Expected**: 200 with a new `documentId`; a `doc_read_write` rule scoped to
  the calling key appears (ruleName `Agent-created: <title>`); an immediate
  `docs_read_document` on the new id succeeds with no approval;
  `agent_doc_created` fires with `auto_granted=true`.

### A11: Proxy route enforces docs rules like MCP does
- With the profile's `sk_proxy_` bearer: `GET /api/proxy/v1/documents/<exposed id>`
  (expect 200), `GET` on the never-picked external doc id (expect 403 naming
  the document), `POST /api/proxy/v1/documents/<exposed id>:batchUpdate` under
  `doc_read` (expect 403 read-only), and a Drive-path probe
  `GET /api/proxy/drive/v3/files/<exposed doc id>` (expect the docs rule to
  authorize it — the Drive per-file guard honors docs rules, not just sheets).

### A12: Docs grant recovery mirrors the sheets funnel
- Create a docs rule for a real-but-never-picked doc id via the app-API seam
  (`POST /api/rules/grant-docs-access`), then:
  1. dashboard docs manager shows the "⚠ Needs Google access — finish setup"
     chip linking to `/dashboard/docs-setup?did=<id>`;
  2. the docs-setup page offers the pick-first recovery (no sheets demo video
     is embedded for docs — intentional until a docs video exists);
  3. an MCP docs call in this stranded state returns the honest post-policy
     ❌ guidance pointing at `/dashboard/docs-setup?did=<id>` (never a bare
     "check the ID") — outcome `failed`, NOT `isError`, per the
     directory-error demotion (capability 17 A7 / 16 A17);
  4. a magic-link approval for this doc lands in the pick-first state
     (`docs-flow-pick-first` testid), and `verify-docs-access?did=<id>`
     reports `missing` → after a Picker pick, `ok` with the title
     (full-fidelity pick via the Playwright CDP path, as in capability 09).

### A13: Comments follow the file's rule (typed pair and raw path)
- On the exposed doc at `doc_read`: `comments_read` (expect 200 — comment
  listing is a read), then `comments_add` with a short comment (expect 🚫
  `docs_read_only` with a `docs_write` approval link). Flip to
  `doc_read_write`: `comments_add` succeeds (new comment id returned);
  `comments_add` again with that `commentId` and `resolve: true` posts a
  resolving reply; `comments_read` shows the comment with `resolved: true`.
- Raw path parity: `google_api_get` on
  `drive/v3/files/<exposed id>/comments?fields=comments(id)` succeeds and
  stamps `raw_api_family='drive_comments'` (never `raw_api_passthrough`);
  the same POST on the never-picked external doc id denies with
  `denial_code=file_not_exposed` and NO approval link (service unknown for
  an unruled bare file id).

### A14: docs_edit deletes are read-back verified; delete-free edits add nothing
- On a Read & Write doc, three `docs_edit` shapes:
  1. **Tier 0 — no delete** (e.g. a single `insertText` append): the response
     is Google's batchUpdate reply ONLY — no `verified`, no `body end` line,
     byte-parity with the pre-verification behavior.
  2. **Tier 1 — deterministic delete** (`deleteContentRange` of a known span,
     optionally with `insertText`/style ops in the same array, no tables in
     range): response carries Google's reply plus the single word `verified`;
     `$mcp_tool_call` stamps `docs_verify_outcome='verified'`.
  3. **Tier 1 mismatch — table-boundary repro**: on a doc containing a table,
     a single `deleteContentRange` spanning from index 1 across the table to
     the body end. If Google partially applies it (the 2026-08-30 incident
     shape), the response's second text block reads
     `body end <after>, expected <expected> — delete may have partially
     applied; read the document back.` and stamps
     `docs_verify_outcome='mismatch'` with `docs_verify_expected/actual`.
     If Google instead rejects the request outright, record the observed
     status verbatim — the semantics are Google's; the assertion is that
     SUCCESS RESPONSES ARE NEVER SILENT about a partial delete. In that case
     report this sub-case as **`blocked`** with reason "upstream: Google
     rejected the cross-table delete instead of partially applying" (README →
     skip vs blocked) — it is upstream-dependent and identical across
     local/preview/prod, so re-running elsewhere does not help. Function-level
     verification of the mismatch branch (warning format + analytics stamps,
     tested against the shipped code) is the accepted fallback evidence; never
     mark the live mismatch sub-case `pass` when the mismatch never fired.
- Tier 2 spot-check: a delete mixed with a non-deterministic op (e.g.
  `replaceAllText`) returns `body end <after> (was <before>)` and stamps
  `docs_verify_outcome='reported'`.

### A15: Google 400s on docs tools surface the hidden cause and the rejected request index (2026-09-18)
- On the exposed doc at **Read & Write**: (a) `docs_read_document` with
  `fields: "content"`; (b) `docs_edit` with requests
  `[{"insertText":{"location":{"index":9999999},"text":"x"}}]`;
  (c) `docs_edit` with two requests — a `replaceAllText` of a string the doc
  does not contain, then `deleteContentRange` with `startIndex: 50,
  endIndex: 10`.
- **Expected**: all three are `isError` (`outcome=error`, `error_status=400`,
  `error_reason=INVALID_ARGUMENT`, no `denial_code`) and start
  `❌ Google API error (400): `. (a) carries `Cannot find matching fields for
  path 'content'` — the cause Google puts only in `fieldViolations` under the
  generic "Request contains an invalid argument" — plus the
  `title,body.content` example; `bad_request_kind=fields_mask`. (b) names
  `requests[0]`, says NONE of the requests were applied, and says to re-read
  with `docs_read_document` before recomputing indexes;
  `bad_request_kind=request_index`, `bad_request_index=0`. (c) names
  `requests[1]` with `bad_request_index=1`, and the document is unchanged
  (batchUpdate is atomic; no `docs_verify_outcome` is stamped because the
  batch never applied). Every text ends with the STOP line
  (`do not retry this call unchanged`). Sheets twin: capability 09 A12.

## Analytics hooks
`docs_grant_verification`, `docs_grant_recovered`, `agent_doc_created`,
`approval_link_minted` with `action=docs_expose|docs_write`, denial codes
`docs_not_exposed|docs_read_only|docs_blocked|file_not_exposed`, grace props
`docs_grace_*`, `docs_verify_outcome` (`verified|mismatch|reported|unavailable`)
with `docs_verify_expected`/`docs_verify_actual` on mismatch,
`raw_api_family='drive_comments'` on raw comment calls,
and universal `response_chars`/`response_kb` (capability 16).
