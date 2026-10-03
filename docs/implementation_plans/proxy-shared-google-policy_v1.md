# REST proxy: one Google API policy with the MCP surface — v1

Branch `claude/proxy-shared-google-policy`. Prerequisite named in
`large-api-payload-options_v1.md` (branch `claude/large-api-payload-options-75c2d2`):
before any design hands scripts a key to the REST proxy, the proxy must
classify paths the way the MCP raw tools do.

## Problem (found by code reading, reproduced by test 2026-10-03)

`src/app/api/proxy/[...path]/route.ts` dispatched on its own regexes: an
anchored Drive per-file guard (`^drive/v[23]/files/`), a Sheets/Docs/Slides
collection check, and **everything else into the Gmail branch**, which only
checks key ↔ owner-mailbox access and forwards with the owner's Google token.

`scripts/test-rest-proxy-policy.ts` (stubbed `db.select` + `fetch`, real route
handlers) reproduced 16 bypasses — every one forwarded to Google with 200:

| # | request | gap |
|---|---|---|
| 1 | `PATCH upload/drive/v3/files/{id}?uploadType=media` | missed the anchored Drive guard → overwrite any reachable file, no rule, or a Read Only rule |
| 2 | `POST upload/gmail/v1/…/messages/send` with RFC 822 body | JSON parse failed → no recipient → whitelist skipped |
| 2c/d | JSON `{raw}` send with a non-whitelisted Cc/Bcc | only the first `To:` was checked |
| 2e/f | send with no parseable recipient | forwarded blind |
| 3 | `batch/gmail/v1`, `batch/drive/v3` | multiplexers forwarded |
| 4 | calendar, people, `oauth2/v2/userinfo` | non-Gmail families forwarded with the token |
| 5 | `DELETE` on a Gmail message / Drive file (even under Read & Write) | **permanent deletion** forwarded — violates the product guarantee |
| 6 | `drafts/send` of a draft addressed outside the whitelist | stored-draft recipients never checked |

Found while fixing: the classifier's Drive regexes matched `drive/v3` only, so
`drive/v2/files/{id}` (still served by Google) was scope-only passthrough on
MCP — and would have become a REST loophole under the discovery allowance.

## Change

1. **Route classifies every call with `classifyGoogleApiCall`** after key
   auth. `denied` → 403 `{error, code}` (MCP emoji stripped), nothing sent.
   Dispatch is now on the class, not on path regexes:
   - `file` / `file_create` → existing Sheets/Docs/Slides per-file handler
     (creates still answer 400, as before — REST never supported them).
   - `drive_file` / `file_comments` / `drive_copy` → existing Drive per-file
     guard (fileId from the classifier, so `upload/` and v2 are covered; copy
     still needs Read & Write, as before), then forwarded on the owner's token.
   - `drive_create` and Drive discovery reads (`passthrough` with family
     `drive/*`, GET only) → forwarded on the owner's token.
   - any other `passthrough` → **denied** (`raw_api_family_unsupported`).
     MCP classify-and-passes unknown families; REST is deny-by-default as
     requested — it never deliberately supported them.
   - Gmail classes only reach the Gmail branch; a defensive assert denies
     anything else so a future `RawCallClass` kind cannot fall in by default.
2. **Send whitelist shared**: `checkSendWhitelist` moved from the MCP route to
   `src/lib/gmailRules.ts`; REST uses it on every To/Cc/Bcc, with recipients
   from JSON `{raw}` or (upload media form) the RFC 822 body itself
   (`extractRfc822Recipients`, new in googleApiPolicy.ts). Multipart and
   resumable uploads → recipients undetermined → refused. REST keeps its own
   denial wording (the MCP copy points at approval links REST does not mint).
3. **drafts/send** resolves the stored draft (format=raw) like MCP and
   unions with inline `message.raw`; unresolvable → refused.
4. REST rule loading uses the shared `loadApplicableRules` (identical query).
5. Classifier Drive regexes widened to `drive/v[23]` (MCP benefits too).
6. `proxy_request` gains `denial_code` (docs/analytics.md).

## Behavior changes callers could notice

- `DELETE` on any path → 403 (was forwarded). No in-repo or skill caller uses it.
- Multipart `upload/…/messages/send` → 403 recipients undetermined. The shipped
  skill (`public/skills/*/scripts/gmail.js`) sends JSON `{raw}` — unaffected.
- Calendar/People/other families → 403 (were forwarded; Google would 403 most
  anyway since FGAC holds no such scopes).
- Drive calls no longer require a key ↔ owner-mailbox row (they were routed
  through the Gmail branch); they follow per-file rules on the owner's token,
  exactly like the Sheets/Docs/Slides handler always did.
- **Cc on FGAC's own notice emails**: the dead-grant notice (Cc delegate) and
  sales-lead confirmation (Cc sales inbox) send through this route with the
  support key. Cc is now checked against the support profile's whitelist.
  Since To is an arbitrary user address, that whitelist must already match
  any address — **pre-deploy check (read-only): confirm the support
  profile's `send_whitelist` pattern is a catch-all**, or those notices
  would start failing as `recipient_not_whitelisted`.

## Validation

- Red first: commit `026d12b` — 16 failures, 10 controls passing.
- `npm run mcp:lint` (now includes `test-rest-proxy-policy.ts`): all green,
  27 REST checks incl. Drive v2; `test-google-api-policy.ts` gains v2 cases.
- `tsc --noEmit` and eslint clean on touched files.
- Preview: capability 10 A16 (REST curl parity) — results appended in v2.
