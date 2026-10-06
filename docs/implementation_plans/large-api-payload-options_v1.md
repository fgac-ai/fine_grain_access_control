# Large API payloads (uploads, attachments) — options investigation v1

Branch: `claude/large-api-payload-options-75c2d2` · 2026-10-03 · status: investigation, nothing built

## The problem

Every byte an agent sends or receives today has to fit in two pipes:

| pipe | limit | where it bites |
| --- | --- | --- |
| MCP tool arguments / results | client context budget; FGAC windows results at 200k chars (`RESPONSE_WINDOW_MAX_CHARS`, ≈150 KB decoded per call) | a 10 MB attachment is ~70 windowed `gmail_get_attachment` calls; uploading a file means base64 in a tool argument |
| Vercel function body | **4.5 MB request AND response, platform-level, not configurable**; streaming *responses* are exempt, request bodies are not | both `/api/mcp` and `/api/proxy` |

Goal (Ken): FGAC stays a pass-through — authorize, then get out of the way. No caching or
storing user files.

## What already exists

- **REST proxy** `src/app/api/proxy/[...path]/route.ts` — the "Prong 1" SDK-override path from
  `architecture_and_strategy.md`, authenticated by `sk_proxy_…` keys that already support
  `expiresAt` and `revokedAt`. A script can already call it, so "temporary API key" is mostly a
  minting and scoping question, not a new endpoint.
- But it **buffers** both directions (`request.clone().arrayBuffer()`, `googleResponse.text()`),
  so it inherits the 4.5 MB cap in both directions, and `.text()` mangles binary
  `alt=media` downloads.

## Prerequisite: the REST proxy does not classify `upload/` paths (security)

Found while reading the code for this investigation. **I read the code but did not run it.** The MCP
classifier strips a leading `upload/` segment (`googleApiPolicy.ts:218-222`, the comment notes it
once let `upload/gmail/.../messages/send` skip the whitelist). The REST proxy never got that fix:

1. `PATCH upload/drive/v3/files/{id}?uploadType=media` does not match the Drive per-file guard
   (`^drive\/v[23]\/files\/`, anchored) and has no Sheets/Docs/Slides segment, so it falls into the
   Gmail branch. That branch checks only that the key can reach the owner's mailbox, then forwards
   with the owner's Google token. The result is a **content overwrite of any reachable Drive file,
   with no per-file rule check.**
2. `POST upload/gmail/v1/users/me/messages/send?uploadType=media` with a raw RFC 822 body:
   `request.clone().json()` fails, `toAddress` stays null, and the whitelist block is skipped
   entirely. The result is a **send to any recipient**. The JSON `raw` form also checks only the
   first `To:` line, so Cc and Bcc are unchecked too.
3. `batch/...` multiplex endpoints are not refused on the REST path (MCP refuses them).

Any design that gives scripts a key to the REST proxy must first route the proxy through
`classifyGoogleApiCall`, so that both surfaces share one policy. This holds whether the key is
temporary or not.

## Options

### A. Delegated Google upload session (the "signed URL" option) — recommended for Drive uploads

Google's resumable upload is already a two-step protocol: an authorized `POST` with the
**metadata** (name, parents, mimeType, or target file id) returns a session URI
(`…?uploadType=resumable&upload_id=…`). The bytes then go to that URI in `PUT` chunks
(multiples of 256 KB, up to 5 TB, session valid about a week).

- A new MCP tool, `drive_upload_begin {name, parents | fileId, mimeType, size}`, runs the existing
  Drive policy (folder rules, `drive.file` create auto-grant, approval link on deny). FGAC makes
  the initiation call itself and returns the session URI plus a ready `curl -T file "<uri>"` line.
- The agent's script PUTs bytes **directly to Google**. FGAC never sees them, and nothing is
  stored. This is the closest match to "pass-through" and to how people already use Google APIs.
- The URI is scoped to one file, so leaking it exposes one upload slot, never the Google token.
- **Unverified, spike first:** whether Drive's session URI accepts `PUT` *without* an
  `Authorization` header. GCS documents that it does (the URI is the credential). For Drive it is
  widely relied on for browser uploads but not stated in the docs. Do a five-minute measurement with
  a QA account in a runner. If an auth header is required, option A falls back to B.
- Telemetry: we see begin, not completion. Add a `drive_upload_finish {fileId}` or reconcile on
  the next `files.get`.

### B. Chunk relay through FGAC with a single-use transfer ticket — recommended for Gmail send

Gmail send cannot use option A. The recipients live *inside* the uploaded RFC 822 bytes, so handing
the agent a raw Gmail session URI would bypass the send whitelist.

- `gmail_send_begin {to, cc, bcc, subject, size}` checks the whitelist (and mints approval links)
  up front. FGAC opens the Gmail resumable session and returns a **transfer ticket**: an opaque,
  hashed-at-rest token, TTL of about 15 minutes, bound to one operation and one session, with a
  byte cap of `size`.
- The script `PUT`s chunks (each < 4.5 MB, 256 KB-aligned) to `fgac.ai/api/transfer/{ticket}`.
  FGAC **parses the MIME headers from chunk 1**, refuses the ticket if they don't match the
  declared recipients, then streams each chunk to Google and keeps nothing.
- Gmail's own cap is 35 MB per message (25 MB of attachments), so this is at most about 9 chunks.
- The same relay also covers Drive if the option A spike fails, and it keeps a single egress domain
  (`fgac.ai`) for sandboxed clients.

### C. Short-lived general proxy keys (Ken's first idea, as stated)

Mint an `sk_proxy_…` with `expiresAt` = 15 minutes that inherits the MCP connection's profile.
This is cheap, because the column exists. However:
- it is a **general** key: it can call anything the profile allows, for 15 minutes, from a
  script the model wrote. Tickets (B) bind it to one operation, which is easier to explain on the
  dashboard and safer if leaked into a transcript.
- it still hits the 4.5 MB request cap, so on its own it does not solve uploads. It needs A or B
  behind it.
- Worth keeping as the general "do many medium calls from a script" escape hatch, *after* the
  prerequisite fix and with single-use / op-scoped variants.

### D. Large downloads — stream the response

Google has no signed-URL equivalent for private Drive content or Gmail attachments, so downloads
must go through FGAC. Streaming responses are exempt from the 4.5 MB cap. A ticketed
`GET /api/transfer/{ticket}` (minted by `gmail_get_attachment` / Drive `files.get` once rules pass)
that pipes `alt=media` / decoded attachment bytes to the client would replace ~70 windowed calls
with one `curl -o`. Read rules are evaluated against the parent message *before* the stream starts,
as MCP does today.

### Rejected

- **Return the Google access token**: it is full-scope for the account, which defeats FGAC.
- **Stage files in Vercel Blob / S3**: violates "don't cache their information" and adds retention
  and compliance burden.
- **Bigger MCP payloads**: the 4.5 MB request cap is not configurable, and base64 in context is the cost we want to
  avoid anyway.

## Client reality check

Script-based transfer only helps agents that can run code with network egress:
- Claude Code / Cowork / OpenClaw: yes, egress is open.
- claude.ai code execution: egress is limited by an org allowlist (default "package managers
  only"), so the user must allow `fgac.ai`, and `googleapis.com` too for option A. Option B and D
  need only `fgac.ai`. Measure before promising claude.ai web users anything.
- Clients with no code execution: no change; the windowed MCP tools remain their path.

## Proposed sequence

1. Fix the REST proxy policy gap (separate PR; independent of everything below).
2. Spike: Drive session URI `PUT` without auth (runner, QA account, local build).
3. Ticket table + `/api/transfer/{ticket}` relay (B) + streaming download (D).
4. Drive upload via A (or B if the spike fails); Gmail send-with-attachments via B.
5. Optional: op-scoped short-lived proxy keys (C) for multi-call scripts.

## Open questions for Ken

- Is A's trade-off acceptable, given that FGAC authorizes the metadata but never sees the bytes? It means
  no content rules on uploads, ever. (None exist for Drive today.)
- Do tickets show on the dashboard (an "active transfers" list, revocable), or are they invisible
  given the 15-minute TTL?
