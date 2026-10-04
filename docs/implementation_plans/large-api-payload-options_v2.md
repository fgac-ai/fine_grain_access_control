# Large API payloads — options v2 (temporary API key through the existing REST proxy)

Branch: `claude/large-api-payload-options-75c2d2` · 2026-10-03 · supersedes v1's ticket/session-URI design

## Decision (Ken, 2026-10-03)

Add an MCP tool that mints a temporary API key, and let the agent's script call the
existing REST proxy (`/api/proxy/...`) with it. There is one enforcement path, the same one
API-key users already use. v1's separate "transfer ticket" endpoint and its hand-out of Google
session URIs are dropped: a short-lived key bound to the connection's profile *is* the ticket,
and it keeps every proxy protection.

## The constraint the key does not remove

Vercel caps each function **request** body at 4.5 MB (platform-level). Streamed responses are
exempt. So the temporary key fully covers anything under 4.5 MB. Above that, the work is in the
proxy, not the key:

| case | needed in `/api/proxy` |
| --- | --- |
| request < 4.5 MB (most attachments and uploads) | nothing beyond the policy fix |
| download > 4.5 MB (Drive `alt=media`, big attachments) | stream the Google response instead of `.text()` (which also corrupts binary today); Gmail read rules still run against the parent message first |
| Drive upload > 4.5 MB | support Google's resumable protocol: forward the initiation, **rewrite the `Location` header** from `googleapis.com/upload/...&upload_id=` to our own proxy path, then forward each chunk (< 4.5 MB, 256 KB-aligned). Standard Google SDKs already chunk resumable uploads (set chunk size ≤ 4 MB), so scripts look like normal Google code. Without the rewrite, today's passthrough hands the client Google's URL, and the bytes bypass us. |
| Gmail send > 4.5 MB (≤ 35 MB) | same resumable relay; check recipients on the first chunk (headers come first in the MIME message) and remember the verdict per `upload_id` |

## Steps

1. **Prerequisite**: the REST proxy uses `classifyGoogleApiCall` (the `upload/` and batch gaps from v1)
   — in progress in a separate session.
2. MCP tool `create_temporary_api_key {ttl_minutes ≤ 60}`: mints an `sk_proxy_` row bound to the
   calling connection's profile with `expiresAt` set (the column exists). It returns the key, the base
   URL, and a ready `curl` / SDK `rootUrl` snippet. It is labelled on the dashboard so the user can
   see and revoke it. Not "single use" per request: a chunked upload is many requests, so the key is
   short-lived instead.
3. Stream proxy responses (downloads).
4. Resumable relay with the `Location` rewrite (Drive, then Gmail send with the first-chunk recipient check).

## Client reality check (unchanged from v1)

Needs code execution with egress to `fgac.ai`: Claude Code / Cowork / OpenClaw yes;
claude.ai web needs `fgac.ai` on the org's sandbox allowlist; no-code clients keep the windowed
MCP tools.
