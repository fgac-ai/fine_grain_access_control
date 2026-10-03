# Capability 24: Large File Transfer (streamed downloads, chunked uploads)

Builds on capability 23. Vercel rejects request bodies over 4.5 MB before FGAC code runs
(responses are exempt when streamed), so:
- **downloads** of any size stream through the proxy in one request;
- **uploads** use Google's resumable protocol in ≤ 4 MB chunks, every chunk a normal proxy
  request under the same rules. The proxy rewrites Google's `Location` header to its own host,
  so chunks never bypass FGAC.

Plan: `docs/implementation_plans/large-api-payload-options_v3.md` (steps 4–6).

Fixtures:
- an ~8 MB binary file on the runner's disk (`head -c 8388608 /dev/urandom > qa-out/big.bin`);
- a ~1 MB PNG (binary-integrity regression for the old `.text()` buffering);
- a ~6 MB attachment for Gmail (random bytes, `application/octet-stream`);
- the exposed read-only and read-write QA files from setup, and one unexposed Drive file id;
- `$TMP` minted per capability 23 with `ttl_minutes: 60` (A4 mints its own).

Record SHA-256 and length for every file sent and received.

### A1: Resumable Drive create in chunks, routed through FGAC

`POST upload/drive/v3/files?uploadType=resumable` (metadata only) via the proxy → 200 with a
`Location` header on **FGAC's host** (never `googleapis.com`), carrying `upload_id`. `PUT` the
8 MB file in 4 MB chunks to that location: intermediate chunks 308 with `Range`, the final
chunk 200/201 with the file id. The new file is readable through the proxy with the same key
(the `drive.file` create auto-grant), and its `md5Checksum` matches the local file.

### A2: Streamed download — large and binary, one request

`GET drive/v3/files/<A1 id>?alt=media` via the proxy → one 200 response whose body hashes to
the local 8 MB file (over 4.5 MB, so streamed). Repeat with the 1 MB PNG (upload it the same
way first): byte-identical — the binary-corruption regression.

### A3: Uploads are authorized at initiation and on every chunk

- resumable initiation targeting the read-only-exposed file (`PATCH
  upload/drive/v3/files/<id>?uploadType=resumable`) → 403, no `Location` returned;
- the same against the unexposed file → 403;
- a chunk `PUT` with an `upload_id` that FGAC never issued (taken from a direct Google
  session, or fabricated) → refused, nothing forwarded;
- a chunk `PUT` using a key belonging to a **different** profile than the one that initiated
  → refused.

### A4: Expiry mid-upload is recoverable

Mint with `ttl_minutes: 1`; initiate and send the first 4 MB chunk; wait past expiry; the next
chunk → 401 with the resume guidance. Mint a new key, `PUT` an empty body with
`Content-Range: bytes */<total>` → 308 with the received `Range`; resume from there to
completion. The final hash matches.

### A5: Gmail send with a large attachment

A resumable `upload/gmail/v1/users/me/messages/send` from USER_A to USER_B (whitelisted)
carrying the 6 MB attachment, in 4 MB chunks → final 200. USER_B's copy of the message has the
attachment with matching hash (standing permission to send between the QA accounts).

### A6: Gmail recipients are enforced on the first chunk

Same as A5 but with a non-whitelisted `Cc` (an `@example.com` address) → the **first chunk** is
refused with the send-whitelist text plus the approval link, and no message is sent (USER_B's
mailbox has nothing new). A later chunk for that `upload_id` is refused too. Repeat with `Bcc`.
Then a first chunk that ends before the header block is complete → refused, and the text says
the headers must fit in chunk 1.

### A7: Size limits answer with guidance

- a single (non-resumable) request with `Content-Length` between 4 MB and 4.5 MB → FGAC's own
  413, whose text names resumable chunking and the 4 MB chunk size;
- a 5 MB single request → **on the preview only**: Vercel's 413
  (`FUNCTION_PAYLOAD_TOO_LARGE`), which never reaches FGAC (the documented blind spot).
  Locally: `skip` (the dev server does not enforce Vercel's cap);
- a chunk that is not a multiple of 256 KB (and not the last) → Google's 400 passes through,
  with FGAC's fix text appended.

### A8: Large windowed reads point to the script path, once

`gmail_get_attachment` with `offset: 0` on the 6 MB attachment (base64 well over the hint
threshold) → the first window carries one line naming `create_temporary_api_key` and the
remaining call count. Later windows (`offset > 0`) do not repeat it. Small attachments never
show it.

### A9: An agent moves large files unprompted (code-execution runtimes)

Prompt, with no mention of keys, chunks, or scripts: "Upload `qa-out/big.bin` to my Drive, then
email it to <USER_B> as an attachment." Pass when the agent:
- mints a key;
- uploads in ≤ 4 MB chunks through FGAC (no 413 in the proxy log), with the Drive file hash
  matching;
- recognises that the 8 MB file fits Gmail's 25 MB attachment cap and sends it via a resumable
  Gmail upload (USER_B receives it, hash matching);
- does not echo the key in its final reply.

Record the tool and request counts. Runtimes without code execution: `skip` by design.

### A10: Transfers are measurable end to end

In the run window:
- `proxy_request` rows carry `upload_type` (`resumable_init` / `resumable_chunk` /
  `resumable_status`), `upload_id_hash`, `chunk_bytes`, and `request_bytes`;
- the final chunk carries `upload_complete: true`;
- A2's rows carry `streamed: true` and `response_bytes` > 4.5 MB;
- A4's 401 carries `auth_failure_reason: 'expired'`, followed by a new `temp_api_key_created`
  and the completed upload;
- A7's FGAC 413 carries `oversize_refused: true`;
- A8's first window carries `large_file_hint_shown: true` on `$mcp_tool_call`;
- monitoring §7.34 (3) "stranded uploads" lists A6's refused `upload_id`, and A4's
  upload is not listed.
