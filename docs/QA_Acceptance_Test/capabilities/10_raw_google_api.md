# Capability: Raw Google API Pair (Allow-by-Default)

> Covers the `google_api_get` / `google_api_modify` MCP tools that replaced
> `raw_google_api_call` for Anthropic Connectors Directory compliance
> (no single tool may mix safe and unsafe HTTP methods). Classification lives
> in `src/app/api/mcp/googleApiPolicy.ts`; enforcement must be identical to
> the dedicated tools. Hosted-MCP interface only (the REST proxy at
> `/api/proxy` is a separate surface).
>
> Posture (2026-08-30): Gmail writes are ALLOW-BY-DEFAULT — anything the
> gmail.modify grant can do is forwarded and stamped for analytics. The gates
> that remain: sending rides the recipient whitelist (messages/send AND
> drafts/send), settings writes are refused with an honest missing-scope
> reason, and permanent deletion (batchDelete) is never available.

## Assertions

### A1: Raw pair is annotated; legacy tool is gone; descriptions state the real access model
- Call `tools/list` on the hosted MCP endpoint
- **Expected**: `google_api_get` present with `readOnlyHint: true`;
  `google_api_modify` present with `destructiveHint: true`; every listed tool
  has a `title`; `raw_google_api_call` is absent; `google_api_modify`'s input
  schema offers only POST/PUT/PATCH (no DELETE, no GET)
- **Also expected** (description accuracy, 2026-08-15 tester finding):
  `google_api_get` and `gmail_read` descriptions state that Gmail reads are
  allowed by default and filtered by read-block rules (not that every
  response is rule-gated), and `gmail_get_attachment`'s description states
  the returned data is base64url-encoded (URL-safe alphabet, padded — a
  15,326-byte fixture ends in exactly one "=", verified 2026-08-16; the
  description must match the actual output, per the tester finding)
- **Also expected** (2026-08-23 discoverability change): the raw-pair
  descriptions state the REAL access model — unknown-family passthrough
  bounded by OAuth scopes, Docs/Sheets `:batchUpdate` on Read & Write files,
  creation via POST `v1/documents` / `v4/spreadsheets` with auto-grant, batch
  denied, DELETE never. They must NOT claim "other Google APIs are denied"
  (stale pre-2026-08-19 posture), and — since the 2026-08-30 allow-by-default
  change — must NOT claim "the only supported Gmail write is messages/send":
  `google_api_modify`'s description must say Gmail mailbox writes (labels,
  drafts, modify, trash/untrash, batchModify, insert/import) are allowed by
  default, that BOTH messages/send and drafts/send ride the send whitelist,
  and that settings writes and permanent deletion are the exceptions.

### A2: Raw Gmail read succeeds
- `google_api_get` with path `gmail/v1/users/me/messages?maxResults=2`
- **Expected**: Real Gmail message list JSON (ids), no error

### A3: Unknown Google API passes through with classification
- `google_api_get` with path `drive/v3/files`
- **Expected**: The call is forwarded to Google with the account's token
  (2026-08-19 posture change: classify, not block — Google's OAuth scopes are
  the backstop). With the standard grant, drive.file limits results to
  picked/app-created files. The `$mcp_tool_call` event carries
  `raw_api_passthrough: true` and `raw_api_family: 'drive/v3'`.
- **Analytics note**: since the raw-api-classification change, EVERY raw call
  (not just passthroughs) stamps `raw_api_kind` / `raw_api_family` /
  `raw_api_endpoint` / `raw_api_mutating` — the event-side assertions live in
  capability 16 A9.
- **No longer passthrough**: the `documents` family graduated to enforced
  per-document rules when Google Docs support landed — a raw
  `v1/documents/<id>` call must be FGAC-classified (capability 19 A6), never
  `raw_api_passthrough`. Sheets and Docs are both enforced families now.
- **Slides enforced (2026-09-17)**: `slides/v1/presentations/<id>` and the
  bare `v1/presentations/<id>` spelling classify as an enforced per-file call
  (`raw_api_family='presentations'`, `file_service='slides'`; capability 21
  A6) — no longer `raw_api_passthrough` with family `slides`. An id-less
  `POST v1/presentations` is a create, auto-granted like sheets/docs
  (capability 21 A10).
- **Comments carve-out (2026-08-23)**: `drive/v3/files/<id>/comments` (and
  `/replies`) classify as `file_comments` and inherit the file's per-file
  rule — a comment write on a read-only or blocked doc/sheet is denied, and
  the event carries `raw_api_family: 'drive_comments'`, never
  `raw_api_passthrough`. Bare `drive/v3/files` (listing, no id) remains
  passthrough as asserted above; since 2026-09-16 any `drive/v3/files/<id>…`
  call classifies `drive_file` and follows the file's rule — see A14.
- **Bare Drive spelling (2026-08-31)**: `v3/files/…` without the `drive/`
  prefix canonicalizes to `drive/v3/…` before classification and routing
  (mirroring the accepted `v4/spreadsheets` / `v1/documents` /
  `v1/presentations` spellings) — so `v3/files/<id>/comments` classifies as
  `file_comments`, is enforced per-file, and reaches
  `www.googleapis.com/drive/v3/…` instead of 404ing on a nonexistent path.
  The stamped `raw_api_endpoint` shows the canonical spelling.

### A4: Non-send Gmail mailbox writes are allowed by default
- `google_api_modify` POST to `gmail/v1/users/me/messages/<real-id>/modify`
  with body `{"removeLabelIds":["UNREAD"]}` (use a real id from `gmail_list`);
  then POST `gmail/v1/users/me/labels` with body
  `{"name":"QA allow-by-default"}`; then POST
  `gmail/v1/users/me/messages/batchModify` with body
  `{"ids":["<real-id>"],"addLabelIds":["<new-label-id>"]}`
- **Expected** (2026-08-30 posture change — empower, don't block): all three
  succeed with real Gmail JSON — the message is marked read, the label
  exists, batchModify applies it (`batchModify` is a bulk-label endpoint,
  NOT an HTTP batch multiplexer, and must not hit the batch denial). Each
  call's `$mcp_tool_call` event carries `raw_api_kind: 'gmail_write'`,
  `raw_api_family: 'gmail'`, `raw_api_mutating: true`, and an id-stripped
  `raw_api_endpoint` (e.g. `POST gmail/v1/users/me/messages/{id}/modify`,
  `POST gmail/v1/users/me/messages/batchModify`). Clean up: delete the QA
  label via the Gmail UI or leave it (harmless); `messages/<id>/trash` +
  `untrash` may be used as an extra reversible-write probe.

### A5: Raw send to non-whitelisted recipient is denied
- `google_api_modify` to `gmail/v1/users/me/messages/send` with a base64url
  RFC 2822 `raw` body addressed to `blocked@untrusted.com`
- **Expected**: Unauthorized-recipient denial (recipient parsed out of the
  raw message); nothing is sent

### A6: Raw send to whitelisted recipient succeeds
- `google_api_modify` to `gmail/v1/users/me/messages/send` with a `raw` body
  addressed to a whitelisted address (e.g. `USER_B_EMAIL`)
- **Expected**: Gmail returns a real message id; the mail is actually sent

### A7: Raw send with unparseable recipients is denied
- `google_api_modify` to `gmail/v1/users/me/messages/send` with a body that
  has no parseable To/Cc/Bcc (e.g. `{"raw": "!!!"}` or a missing `raw`)
- **Expected**: Denied with a could-not-determine-recipients message (deny on
  parse failure, never forward blind)

### A8: Raw Sheets write honors per-spreadsheet rules
- `google_api_modify` PUT to
  `v4/spreadsheets/<exposed-id>/values/<range>?valueInputOption=USER_ENTERED`
- **Expected**: Succeeds when the spreadsheet's rule is Read & Write; denied
  with the read-only message when the rule is Read Only (toggle via dashboard
  UI, as in capability 09 A8)

### A9: Batch is denied (and monitored); sheet creation is allowed and auto-granted
- `google_api_modify` with path `batch/gmail/v1`; and `google_api_modify`
  POST with path `v4/spreadsheets` with body `{"properties":{"title":"QA created sheet"}}`
- **Expected**: Batch is denied (it could smuggle sub-requests past the send
  whitelist and read restrictions) and the attempt is stamped
  `denial_code: 'raw_api_batch_unsupported'` for demand monitoring. The
  spreadsheet creation SUCCEEDS (2026-08-19 posture change), returns the new
  spreadsheet JSON, auto-creates a read & write rule for the new id scoped to
  the calling key (visible in dashboard rules as "Agent-created: …"), and a
  follow-up `sheets_read_range` on the new id succeeds without any approval
  link. An `agent_sheet_created` event fires with `auto_granted: true`.

### A10: Raw fallback is discoverable at every decision point
- Call `initialize` and `tools/list` on the hosted MCP endpoint; then a
  successful `sheets_update_range` on a Read & Write fixture.
- **Expected**: the `initialize` result carries a server `instructions` block
  naming `google_api_get` / `google_api_modify` as the full-surface fallback,
  the `docs_edit`/`sheets_edit` batchUpdate tools, the comments pair, and the
  denial → approval-link pattern. Every convenience tool with a superset
  names its fallback in its description (`gmail_list`/`gmail_read` →
  `google_api_get`; `gmail_send` → `google_api_modify`;
  `sheets_update_range`/`sheets_append_rows` → `sheets_edit`;
  `docs_read_document` → `docs_edit`; `docs_edit`/`sheets_edit` →
  `google_api_modify`), lint-enforced by `scripts/mcp-tool-lint.ts`. The
  sheets values write success carries an `fgac_hint` pointing at
  `sheets_edit`. `docs_append_text` and `docs_replace_text` are ABSENT from
  `tools/list` (removed 2026-08-23; `docs_edit` replaces them). Rationale:
  2026-08-23 field failure — an agent shipped a pipe-character text table
  because nothing at its decision point referenced the raw fallback.

### A11: drafts/send rides the send whitelist via server-side recipient resolution
- Create a draft addressed to `blocked@untrusted.com`:
  `google_api_modify` POST `gmail/v1/users/me/drafts` with body
  `{"message":{"raw":"<base64url RFC 2822 to blocked@untrusted.com>"}}`
  (the create itself must SUCCEED — drafting is a plain mailbox write).
  Then `google_api_modify` POST `gmail/v1/users/me/drafts/send` with body
  `{"id":"<draftId>"}`.
- **Expected**: the send is DENIED with the unauthorized-recipient message
  and approval links — the recipients came from the STORED draft (they are
  not in the drafts/send request body), proving server-side resolution.
  Nothing is sent. Repeat with a draft addressed to a whitelisted recipient
  (e.g. `USER_B_EMAIL`): drafts/send SUCCEEDS and the mail arrives.
  A drafts/send with a missing or bogus draft id is denied with an FGAC
  message saying the draft/its recipients could not be determined and
  nothing was sent (for a bogus id the message may quote Google's 404 as the
  fetch-failure detail, but it must read as a refused send, not a bare
  passthrough error) — deny on unresolvable recipients, never forward
  blind. Resolution-failure denials carry NO approval link (the remedy is
  the draft id, not a whitelist grant).

### A12: The two remaining Gmail write refusals are honest about their cause
- `google_api_modify` PATCH `gmail/v1/users/me/settings/sendAs/<any>` with
  body `{"displayName":"QA"}`; and `google_api_modify` POST
  `gmail/v1/users/me/messages/batchDelete` with body `{"ids":["x"]}`
- **Expected**: the settings write is refused with a message naming the REAL
  cause — Google `gmail.settings.*` scopes FGAC's grant does not include, "a
  Google scope limit, not an FGAC rule" — stamped
  `denial_code: 'gmail_settings_unsupported'`; it must NOT read as an FGAC
  policy denial and must NOT mint an approval link. batchDelete is refused
  as permanent deletion with trash named as the reversible alternative,
  stamped `denial_code: 'gmail_write_unsupported'` (that code now means ONLY
  permanent deletion). Settings READS (GET `settings/sendAs`) still succeed.

### A13: Drive-side creates are auto-granted; copies are gated on the source
- With an exposed, Read & Write sheet S (e.g. the A9 created sheet):
  `google_api_modify` POST `drive/v3/files/<S>/copy` with body
  `{"name":"QA copy"}`; then `sheets_update_range` on the returned `id`.
  Then set S to Read Only in the dashboard and copy it again. Then
  `google_api_modify` POST `drive/v3/files/<unexposed-or-blocked-id>/copy`.
  Then `google_api_modify` POST `drive/v3/files` with body
  `{"name":"QA drive-created","mimeType":"application/vnd.google-apps.spreadsheet"}`
  and, separately, with `{"name":"QA note","mimeType":"text/plain"}`.
- **Expected** (2026-09-16 — before this, copies were scope-only passthrough:
  Google allowed them because `drive.file` treats an app-made copy as
  app-created, no FGAC rule was written, and the agent could rename/share/
  trash the copy through Drive while every Sheets write on it denied
  `sheets_not_exposed`): the first copy SUCCEEDS, returns the Drive File JSON,
  and the copy is IMMEDIATELY writable — `sheets_update_range` on the new id
  succeeds with no approval link, a rule "Agent-created: QA copy" (Read &
  Write, scoped to the key) appears in the dashboard, and an
  `agent_sheet_created` event fires with `auto_granted: true, origin: 'copy'`
  (the `$mcp_tool_call` carries `raw_api_kind: 'drive_copy'`,
  `file_created_origin: 'copy'`, `file_created_kind: 'sheet'`). The Read Only
  copy also succeeds (a copy is a read of the source) and its copy is
  Read & Write. The unexposed/blocked source is DENIED with the not-exposed /
  blocked message and NO passthrough to Google. The Drive-created spreadsheet
  is auto-granted the same way (`raw_api_kind: 'drive_create'`,
  `origin: 'drive_create'`); the `text/plain` create succeeds, is stamped
  `file_created_kind: 'other'`, and writes no rule. `PATCH drive/v3/files/<id>`
  and `POST …/permissions` are gated per file since 2026-09-16 — see A14.

### A14: Id-addressed Drive metadata writes follow the file's rule; DELETE is refused at every layer
- Setup: an exposed sheet S with a Read & Write rule for the key (the A9 or
  A13 created sheet works), a sheet R whose rule is Read Only, a sheet B whose
  rule is Blocked, and a sheet U the user owns that has NO FGAC rule (never
  picked, never agent-created — one Google has never granted to FGAC).
- Calls, all via `google_api_modify` unless noted:
  1. `PATCH drive/v3/files/<S>` body `{"name":"QA renamed"}`, then
     `PATCH drive/v3/files/<S>` body `{"trashed":true}`, then `{"trashed":false}`.
  2. `POST drive/v3/files/<S>/permissions` body
     `{"role":"reader","type":"user","emailAddress":"<USER_B>"}`.
  3. `google_api_get` `drive/v3/files/<R>?fields=name,mimeType` and
     `drive/v3/files/<R>/export?mimeType=text/csv`; then `PATCH drive/v3/files/<R>`
     body `{"trashed":true}`.
  4. `PATCH drive/v3/files/<B>` body `{"trashed":true}`; `google_api_get`
     `drive/v3/files/<B>`.
  5. `PATCH drive/v3/files/<U>` body `{"trashed":true}`; `google_api_get`
     `drive/v3/files/<U>`.
  6. `google_api_get` `drive/v3/files?pageSize=5` and
     `drive/v3/files/generateIds?count=2`.
  7. `tools/call google_api_modify` with `method: "DELETE"` and path
     `drive/v3/files/<S>` (raw JSON-RPC via curl — the schema must reject it);
     and `method: "DELETE"` path `drive/v3/files/trash`.
- **Expected** (2026-09-16 — before this every call in 1–5 was
  `raw_api_passthrough` and a Blocked spreadsheet could be trashed through
  the MCP route, verified locally the same day):
  - 1 and 2 SUCCEED (Read & Write rule); events carry
    `raw_api_kind: 'drive_file'`, `raw_api_family: 'drive/v3'`,
    `drive_file_gate: 'rule'`, `file_service: 'sheets'`, and NO
    `raw_api_passthrough`.
  - 3: both reads SUCCEED (any rule allows reads — metadata and export return
    real data); the trash PATCH is DENIED `sheets_read_only` with a
    `sheets_write` approval link, and Google is NOT called.
  - 4: both DENIED `sheets_blocked`, no approval link, Google not called.
  - 5: the PATCH is DENIED as not exposed with a `sheets_write` approval link
    and the GET is DENIED as not exposed with a `sheets_expose` link —
    `drive_file_gate: 'mime_gated'`, `denial_code: 'sheets_not_exposed'`.
    (If Google has never granted U to FGAC the metadata lookup 404s instead:
    then the answer is the 🚫 `file_grant_missing_at_google` invisible-file
    text with `drive_file_gate: 'invisible'` — also a denial, never a
    passthrough success. Record which of the two the run produced.)
  - 6: both SUCCEED as `passthrough` (`raw_api_passthrough: true`) — discovery
    is never gated.
  - 7: both calls fail at the MCP layer with an input-validation error
    (`isError: true`, text naming `method`), no `$mcp_tool_call` denial row,
    and nothing reaches Google; `tools/list` still shows the `method` enum as
    exactly POST/PUT/PATCH; `get_my_permissions.defaults.deletion` says DELETE
    is rejected by the schema and again server-side.
- **Also expected**: `npx tsx scripts/test-raw-method-guard.ts` passes (part of
  `npm run mcp:lint`) — it drives the registered schema through the real MCP
  SDK, and pins the classifier + executor refusal for DELETE.
- **Cleanup**: untrash S if the run left it trashed. Remove the USER_B
  permission on S in Google Drive's share dialog as the user — permission
  removal is DELETE-only and therefore unavailable through FGAC by design.

### A15: Agent-created files stay fully under the agent's control, trash included
- Create one file through EACH creation path, all via `google_api_modify` as
  the same connection: (S1) POST `v4/spreadsheets`; (D1) POST `v1/documents`;
  (S2) POST `drive/v3/files` with the Sheets mimeType; (C1) POST
  `drive/v3/files/<S1>/copy`; (T1) POST `drive/v3/files` with
  `{"name":"QA note","mimeType":"text/plain"}`. For each, run the cycle:
  write content (`sheets_update_range` / `docs_edit`; skip for T1), `PATCH
  drive/v3/files/<id>` `{"trashed":true}`, `google_api_get`
  `drive/v3/files/<id>?fields=trashed`, `PATCH` `{"trashed":false}`, `PATCH`
  `{"name":"<label> renamed"}`, and (S1) write content again.
- **Expected** (2026-09-16, run on the PR #147 preview, 30/30): every step
  SUCCEEDS with no approval link and no dashboard action. S1, D1, S2 and C1
  carry an "Agent-created: …" Read & Write rule in `get_my_permissions`
  (`sheet_read_write` / `doc_read_write`) — that rule is what the A14 guard
  consults, so trash and rename are allowed exactly like a cell or text edit
  (`drive_file_gate: 'rule'`). T1 has NO rule (FGAC has no rule type for
  non-Sheets/Docs files): the guard finds no rule, resolves the mimeType, and
  forwards under the drive.file grant, which treats an app-created file as
  writable (`drive_file_gate: 'mime_other'`, `raw_api_passthrough: true`).
  The metadata GET after each trash returns `{"trashed": true}`. Permanent
  deletion remains unavailable on all five (A14 step 7).
- **Why this matters**: A14 proves the guard DENIES what it should; this
  proves it does not over-block the agent's own output — the failure mode
  PR #143 was written for (copies the agent could manage through Drive but
  not write through Sheets) must not reappear in the opposite direction.
- **Cleanup**: trash all five (reversible; leave them trashed).

