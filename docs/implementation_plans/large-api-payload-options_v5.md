# Large API payloads — v5: as built

Branch: `claude/large-api-payload-options-75c2d2` · 2026-10-03 · supersedes v4 (design changes
below). The decisions from v3/v4 stand: temporary API keys through the existing REST proxy,
15-minute default and 60-minute maximum, streamed downloads, resumable uploads in ≤ 4 MB
chunks, guidance on every surface an agent reads, and tracking from mint to completion.

## What changed from v4, and why

| v4 said | built | why |
| --- | --- | --- |
| `parent_key_id` + `created_via` columns on `proxy_keys` | separate **`temporary_api_keys`** table (SHA-256 of the key, last 4, parent, connection, purpose, expiry, revoked) | 18 readers treat every `proxy_keys` row as a profile: dashboard tabs, `/api/auth/*token`, notifications, partner provisioning, default-profile lookup. A temporary row there would surface as a profile in all of them. The proxy maps an `sk_proxy_tmp_` key to its parent at authentication; nothing else changes. |
| rewrite Google's `Location` to our host, keeping `upload_id` | the caller gets **FGAC's own opaque `upload_id`**; Google's session URL is stored server-side (`resumable_uploads.google_session_url`) | Google may accept chunks for an open session without an auth header (still unmeasured, v1 spike). With Google's `upload_id` visible, an agent could send a Gmail chunk straight to Google and skip the first-chunk recipient check. |
| policy re-checked per chunk | per chunk: the key is valid, the session belongs to the **same profile**, and (Gmail) the recipient verdict is enforced. The file rule is checked at initiation. | Chunks carry no file id; the session row does the binding. A profile whose rules change mid-upload can still finish the bytes of a write it was allowed to start (at most one file, within the session's week). |
| — | Gmail **attachments** on the REST proxy: read rules run on the parent message, then the attachment is piped | Matches MCP `gmail_get_attachment`. Before, the REST proxy ran read rules on the attachment JSON (base64 data, no labels), so a label rule on the parent never applied. Piping is also what lets a 25 MB attachment (≈ 33 MB of JSON) through. |
| — | `proxy_request.service` strips `upload/` | `upload/drive/…` was counted as `gmail`. |
| — | PR #176 (REST proxy shared policy) merged into this branch, resolved against main's Drive tree engine (PR #177) | Prerequisite. The resolution keeps #176's classifier dispatch. The tree engine is wired into drive_file, comments, copy, the per-kind handlers and listings. The #176 session was told (commit 5c2ba86). |
| capabilities 22 + 23 | **23** (temporary keys) + **24** (large transfer) | Main's Drive tree draft is capability 22 (`capabilities/drafts/`). |

## Built

- `src/db/schema.ts`: `temporary_api_keys`, `resumable_uploads` (migrations 0020, 0021).
- `src/lib/temporaryApiKeys.ts`: key generation and hashing, TTL clamp, size buckets, the
  request-origin helper, and per-purpose recipes.
- MCP (`src/app/api/mcp/route.ts`, `toolDefs.ts`):
  - the `create_temporary_api_key` tool (10 live keys per connection; `base_url` is the
    host that served the MCP request, carried as `authInfo.extra.requestOrigin`);
  - a large-file sentence in the server instructions;
  - pointers in the `gmail_get_attachment`, `gmail_send` and `google_api_modify` descriptions;
  - a one-time `large_file_hint` on windowed reads ≥ 1.5 M chars.
- Proxy (`src/app/api/proxy/[...path]/route.ts`):
  - temporary-key authentication with parent resolution, and `auth_failure_reason`;
  - FGAC's own 413 above 4.25 MiB;
  - `streamFromGoogle` for Drive, Sheets/Docs/Slides and Gmail attachments;
  - adoption of resumable sessions, and `handleResumableChunk` with the Gmail byte-0
    recipient check (all To/Cc/Bcc via the shared `checkSendWhitelist`);
  - telemetry props.
- Dashboard: a Temporary keys card on the profile page (live keys only, Revoke →
  `temp_api_key_revoked`).
- Tests: `scripts/test-temporary-api-keys.ts` (38 checks, in `mcp:lint`).
- Docs:
  - `docs/analytics.md`: the three events, plus the `proxy_request` and `$mcp_tool_call` props;
  - `docs/monitoring.md` §7.34 (six queries plus the Vercel 413 log check);
  - QA capabilities 23/24 with sections in all four agent runbooks;
  - `architecture_and_strategy.md` §5.

## Known limits

- **Function time**: a streamed download or a single chunk must finish within ~55 s
  (`maxDuration` 60). The recipe tells agents to use HTTP Range requests for very large
  downloads.
- **Sandbox egress**: scripts need network access to the serving host. claude.ai's code
  execution allows only allow-listed domains. §7.34 (2) measures how many keys are minted but
  never used, per client.
- **Vercel's own 413** (> 4.5 MB) never reaches FGAC. It is covered by the weekly log check in
  §7.34 (4).
- The Drive tree engine (flag-gated) is not consulted for chunks. It decides at initiation,
  like the per-file rules.

## Validation

To be filled in during validation (v6): local (dev server + QA runners on capabilities 23/24
+ capability 10 A16 for the merged #176 policy) and preview (`/deploy-pr-preview`).
