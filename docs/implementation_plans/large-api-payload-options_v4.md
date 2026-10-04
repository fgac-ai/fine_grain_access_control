# Large API payloads — v4: temporary API keys, agent guidance, tracking

Branch: `claude/large-api-payload-options-75c2d2` · 2026-10-03 · supersedes v3 (QA section)

## Decisions (Ken, 2026-10-03)

- An MCP tool mints a **temporary API key** that the agent's script uses against the existing REST
  proxy (`/api/proxy/...`). One enforcement path, shared with API-key users.
- **Short-lived, not single-use**: default 15 minutes, and the agent may ask for up to 60. The response
  states what was granted. An expired key never loses an upload: Google keeps a resumable session
  for about a week, so the agent mints a new key, queries the received byte count, and resumes.
- Vercel caps request bodies at 4.5 MB even for streaming functions
  ([limits](https://vercel.com/docs/functions/limitations)). Large **downloads** are streamed
  (responses are exempt). Large **uploads** go through Google's resumable protocol in ≤ 4 MB
  chunks, each one a normal proxy request under the same rules.
- Every agent-facing surface tells agents when and how to switch to this path, and every stage is
  measurable: minted → used → completed, plus the limits hit along the way.

## 1. Temporary keys: data model and enforcement

- `proxy_keys` gains `parent_key_id` (FK to `proxy_keys`, cascade) and `created_via`
  (`dashboard` | `mcp_temporary`). `expires_at` already exists and is already enforced.
- A temporary key **resolves to its parent profile at request time**. It has no copied rule
  assignments or mailbox-access rows, so rule edits apply immediately, and revoking or expiring the
  parent kills every child. The proxy auth step becomes: load key → if it has a parent, load the
  parent → refuse if either is revoked or expired → use the parent id for every rule lookup.
- The key is minted for the **calling MCP connection's** profile (`agent_connections.proxy_key_id`).
  A pending or blocked connection gets the usual approval refusal, not a key.
- Rate guard: at most 10 live temporary keys per connection. Over that, refuse with text telling
  the agent to reuse its current key.
- Dashboard: the profile page lists live temporary keys ("Temporary key for Claude — expires
  14:32") with Revoke. Expired ones drop off the list.
- Prerequisite (separate session, task_655a5be7): the REST proxy runs `classifyGoogleApiCall`.
  **No temporary key ships before that fix lands.**

## 2. Proxy changes

| change | detail |
| --- | --- |
| stream responses | pipe Google's body instead of `.text()` for non-Gmail-JSON responses (Drive `alt=media`, export). Gmail JSON reads keep buffering, because read rules inspect them, and Gmail JSON is never large: attachments come via `attachments.get`, which runs the parent-message check first. This also fixes the binary corruption that `.text()` causes today. |
| resumable uploads | forward `uploadType=resumable` initiation; **rewrite the `Location` header** from `https://www.googleapis.com/upload/...&upload_id=…` to `<app>/api/proxy/upload/...&upload_id=…`, so chunks come back through us. Chunk `PUT`s with an `upload_id` are forwarded with the owner's token. The policy verdict is taken at initiation (which carries the file id / parents / metadata) and re-checked per chunk against the same path. |
| Gmail resumable send | initiation is authorized; the **first chunk** must contain the full MIME header block. All `To`/`Cc`/`Bcc` addresses go through the shared send-whitelist helper, and the verdict is stored per `upload_id` hash. Later chunks for a refused or unknown `upload_id` are refused. |
| refuse oversize early | requests that reach us with `Content-Length` > 4 MB get FGAC's own 413 with chunking guidance. (Above 4.5 MB, Vercel answers 413 before our code runs; see §4.) |

## 3. Agent guidance (where agents learn the path exists)

Agents only use what the text tells them about, and they read the text at the moment of need. So
the guidance goes in five places:

**a. New tool `create_temporary_api_key`** (title "Get a short-lived API key for scripts")

> Mint a short-lived FGAC API key so a script YOU run can move files too large for tool calls
> (uploads, attachments, Drive downloads over ~1 MB, or many calls in a loop). The key has exactly
> this connection's permissions, enforced by the same rules; it is not a Google token. Requires
> code execution with network access to `<app host>`: if you cannot run code, use the windowed
> tools instead. Default lifetime 15 min, max 60 (`ttl_minutes`). If it expires mid-upload,
> call this again and resume — Google keeps the upload session. Never print the key back to the
> user or save it to a file.

Arguments: `ttl_minutes` (1–60, default 15), `purpose` (`upload` | `download` | `send_attachment`
| `bulk_calls` | `other`, used for telemetry and to tailor the snippet), and an optional
`expected_bytes`. The result carries `api_key`, `expires_at`, `base_url`, and a **purpose-specific
recipe**:
- `curl` for downloads (`-o`);
- Python and Node Google-SDK `rootUrl` / `api_endpoint` overrides, with `chunksize = 4 * 1024 * 1024`
  for resumable uploads;
- a raw-curl resumable loop for agents without the SDK;
- the resume-after-expiry step;
- the 4 MB chunk rule stated plainly ("larger chunks are rejected with 413").

**b. Server instructions**: one added sentence:

> For files too large for a tool call (attachments or uploads over ~1 MB), call
> create_temporary_api_key and move the bytes with a script — the same access rules apply.

**c. Existing tool descriptions** (tool-description edits are cheap and land in every client):
- `gmail_get_attachment`: "…over ~1 MB, if you can run code, prefer `create_temporary_api_key`
  and download in one request; otherwise window as below."
- `gmail_send`: "…for attachments over ~1 MB, use `create_temporary_api_key` and Gmail's
  resumable `messages/send` upload."
- `google_api_modify`: a note on the media-upload path and its size ceiling.

**d. Response-time hints**: the first windowed response whose `total_chars` exceeds ~1.5 MB of
base64 appends one line: "This file needs N more calls; if you can run code,
create_temporary_api_key downloads it in one." The hint is shown once per call, never on every window.

**e. Error text**: FGAC's 413 on the proxy, an expired-key 401 ("mint a new one and resume —
the upload is not lost"), and chunk misalignment (Google 400) each name the fix.

## 4. Tracking

### Events and properties (rows added to `docs/analytics.md`)

| event / prop | where | carries |
| --- | --- | --- |
| `temp_api_key_created` (new) | MCP tool | `purpose`, `ttl_requested`, `ttl_granted`, `expected_bytes_bucket` (<1M / 1–4.5M / 4.5–35M / 35M+), `client_name`, `client_id`, `parent_proxy_key_id`, `temp_proxy_key_id`, `live_temp_keys` |
| `temp_api_key_refused` (new) | MCP tool | `reason` (`connection_pending` / `rate_capped` / `parent_revoked`) |
| `proxy_request` +props | proxy | `key_kind` (`standing` / `temporary`), `parent_proxy_key_id`, `request_bytes`, `response_bytes`, `streamed`, `upload_type` (`media` / `multipart` / `resumable_init` / `resumable_chunk` / `resumable_status`), `upload_id_hash`, `upload_complete` (true on the final 200/201), `chunk_bytes`, `auth_failure_reason` (`expired` / `revoked` / `invalid`, which today all collapse into one 401), `oversize_refused` |
| `$mcp_tool_call` +prop | windowed reads | `large_file_hint_shown` when §3d fired |

Mint-to-use is the key join: `temp_proxy_key_id` = `proxy_request.proxy_key_id`.

### Questions it answers (runbook `docs/monitoring.md` §7.34, HogQL in the runbook)

1. **Adoption**: keys minted per week, people, and split by `purpose` and `client_name`.
2. **Minted but never used**: share of temporary keys with zero `proxy_request` rows. The expected
   cause is sandbox egress (claude.ai's default allowlist blocks `fgac.ai`), so split by `client_name`.
   This is the number that says whether claude.ai web users can use the feature at all.
3. **Completion**: resumable uploads with `resumable_init` but no `upload_complete` within 24 h,
   by `upload_type` and size bucket.
4. **Hitting limits**:
   - `oversize_refused` (our 413);
   - `auth_failure_reason = expired` followed by a re-mint (expected) versus not followed (a
     stranded upload, which means TTL guidance is failing);
   - chunk 400s and 504 timeouts on `resumable_chunk`.
5. **Demand we are not converting**: windowed reads with `window_total_chars` > 1.5 MB and
   `large_file_hint_shown`, joined to whether the same person minted a key within 10 minutes.
6. **Abuse / runaway**: `live_temp_keys` at the cap, and temporary-key traffic by key (a loop
   hammering the proxy).

### The blind spot: Vercel's own 413

A request body over 4.5 MB is rejected by Vercel **before our code runs**, so PostHog never
sees it. Two mitigations:
- the guidance says 4 MB, and our own 413 at > 4 MB catches anything that slips under Vercel's cap;
- §7.34 includes a weekly `vercel logs` / Observability check for `FUNCTION_PAYLOAD_TOO_LARGE`
  on `/api/proxy` and `/api/mcp` (read-only CLI, already allowed).

### Daily review

Add one watch line to the analytics-review routine (`fgac-user-behavior-review`): temporary keys
minted, the share never used, and stranded uploads. Edit that task's `SKILL.md` in the same change
that ships the events (global rule: recurring-task changes persist only in the task file).

## 5. QA

Two capabilities, split along the release boundary so release 1 can pass QA without release 2:

| capability | covers | plan steps |
| --- | --- | --- |
| `22_temporary_api_keys.md` (A1–A13) | mint and TTL bounds, parity with the parent profile, no escalation (including the prerequisite `upload/`, Cc/Bcc and batch rows), live rule changes, expiry/revoke/parent cascade, pending-connection and rate-cap refusals, guidance surfaces, an unprompted agent download, mint-to-use telemetry | 2–3 |
| `23_large_file_transfer.md` (A1–A10) | resumable Drive upload with the `Location` rewrite, streamed and binary-intact downloads, per-chunk authorization, resume after expiry, Gmail large send with the first-chunk Cc/Bcc check, size-limit guidance (including the Vercel 413 blind spot, preview only), the large-read hint, an unprompted agent upload+send, transfer telemetry | 4–6 |

All four `agents/` runbooks have sections for both. The "agent finds it unprompted"
assertions (22 A12, 23 A9) are primary in Claude Code MCP, skipped by design in hosted
curl, and conditional on the exec tool in OpenClaw (a minted-but-unreachable key there is a
`fail`: it is the egress finding). Telemetry assertions live in each capability, like 20 A8.

**Merge gating**: the coverage checker requires every `### A<n>` in `capabilities/`, so each
capability file must reach `main` **in the same PR as its implementation**. If this
planning branch merges first, it must drop 22/23 (or they move into the implementation
branches). Otherwise every full QA run on `main` fails coverage for a feature that does not
exist yet.

Production runbooks do not cover these yet (they do not cover capability 20 either);
`/qa-production` stays user-confirmed.

## 6. Sequence

1. Prerequisite policy fix (in flight, task_655a5be7).
2. Schema (`parent_key_id`, `created_via`) + parent-resolving proxy auth + `auth_failure_reason`.
3. `create_temporary_api_key` + guidance edits (§3a–c, e) + `temp_api_key_*` events.
4. Streaming responses + `response_bytes` / `streamed`.
5. Resumable relay (Drive, then Gmail send) + upload props + our 413.
6. Response-time hint (§3d), runbook §7.34, analytics rows, daily-review line, QA capability.

Steps 2–3 alone deliver the under-4.5 MB case and the adoption and egress measurement. That measurement says
whether 4–5 are worth building before we build them.
