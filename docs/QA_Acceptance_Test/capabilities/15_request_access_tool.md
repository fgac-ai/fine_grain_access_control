# Capability: request_access Tool

> Phase D of `connector-growth_v1.md`. The agent negotiates permission
> upgrades conversationally: `request_access(capability)` mints a magic
> approval link (same machinery and security as capability 14); the human
> approves; the agent retries and succeeds. The tool grants nothing by
> itself, so it is annotated read-only.

## Assertions

### A1: Tool is listed with correct annotations
- Call `tools/list`
- **Expected**: `request_access` present with a `title`,
  `readOnlyHint: true` (it only mints a request a human must approve), and a
  factual description; `mcp-tool-lint` passes with it in the registry

### A2: Requesting send access mints a link but grants nothing
- On a profile with no send whitelist, call
  `request_access` for sending to `USER_B_EMAIL`
- **Expected**: Returns an approval URL plus a human-readable summary of
  exactly what is being requested; an immediate `gmail_send` to that address
  still fails — nothing was granted by the request itself

### A3: Approval completes the loop
- Approve the A2 link as the owning user, then have the agent retry
  `gmail_send` to `USER_B_EMAIL`
- **Expected**: Send succeeds; `get_my_permissions` now shows the whitelist
  rule scoped to this profile

### A4: Sheets write upgrade via request_access
- On a spreadsheet exposed Read-only, `request_access` for write access;
  approve choosing Read & Write; retry `sheets_append_rows`
- **Expected**: The request link names the spreadsheet; after approval the
  append succeeds; before approval it was denied

### A7: Docs access via request_access mirrors the sheets flows
- `request_access` with `type=docs_read` and a `documentId` (and again with
  `type=docs_write` on a Read-only doc)
- **Expected**: Mints a `docs_expose` / `docs_write` link naming
  the document; nothing is granted until the owner approves;
  after approval the corresponding docs call succeeds. Omitting `documentId`
  is refused with the requestable-permissions explanation.

### A9: Slides access via request_access mirrors the sheets and docs flows
- `request_access` with `type=slides_read` and a `presentationId` (and again
  with `type=slides_write` on a Read-only presentation)
- **Expected**: Mints a `slides_expose` / `slides_write` link naming the
  presentation; nothing is granted until the owner approves; after approval
  the corresponding slides call succeeds. Omitting `presentationId` is refused
  with the requestable-permissions explanation, which now names presentations.

### A5: Unsupported capabilities are refused without a link
- Call `request_access` for an unsupported grant (e.g. deleting mail, or a
  non-Gmail/Sheets/Docs Google API)
- **Expected**: Refused with an explanation of what is requestable; no
  approval link is minted

### A6: request_access links obey magic-link security
- Repeat capability 14's A5 (wrong user) and A7 (tampered link) checks
  against a link minted by `request_access`
- **Expected**: Identical behavior — same signing and owner-session
  requirements. A link minted for one user is never approvable by another,
  and altering any parameter invalidates the signature

### A8: request_access can name the file, and the approval page shows it
- On a spreadsheet with no rule and no Google grant, call `request_access`
  with `type: "sheets_read"`, the spreadsheet id, and `resourceName: "QA Budget
  Sheet"`; open the link as the owning user
- **Expected**: The tool's `summary` names the spreadsheet as
  `"QA Budget Sheet" (<id>)` and its `note` does NOT ask the agent to relay the
  name (it already has one). The approve page heading and the pick-first
  panel show **"QA Budget Sheet"** instead of the raw id, and the hint under
  the pick button says to look for it by that name. Calling `request_access`
  again for the same file WITHOUT `resourceName` returns the same URL, its
  `summary`/`note` still use the stored title, and the page still shows the
  name (first non-empty title wins — `mint_count` increments,
  `approval_requests.resource_name` is unchanged; the mint event carries
  `has_resource_name: true, resource_name_supplied: false`). A title over
  200 characters is truncated; a whitespace-only title is treated as absent
  and the `note` then tells the agent to relay the file's name
- **Regression**: until 2026-09-08 no path could name a file Google does not
  share with FGAC yet — the page showed the Google id, and Google's Picker
  lists files by name (capability 17 A12)
