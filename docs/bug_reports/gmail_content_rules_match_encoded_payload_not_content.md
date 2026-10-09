# Gmail content read-rules match the encoded payload, not the message content

**Reported:** 2026-09-03, support email ("Token Lookup Problem" thread — reporter details
in the operator mailbox, not this repo). **Status:** fix in progress.

## Symptom (as reported)

A user reading a delegated mailbox reported that `gmail_read` with `format=full` failed
on two large attachment-bearing messages with an error reading "No approval received"
(naming no rule), while the same messages read fine via `google_api_get`
(`gmail/v1/users/me/messages/{id}?format=full`), `gmail_read format=metadata` worked on
both, and `gmail_read format=full` worked on a smaller message. The user's two explicit
complaints: the error names no rule, and the two read paths appear to disagree on
enforcement.

## What the evidence showed

Full timeline in the support case notes (operator-local). Key findings from production
analytics and the production database (read-only):

1. **Every request that reached the FGAC server succeeded or was correctly denied.**
   The user's `gmail_read format=full` calls on both "failing" messages returned parsed
   content (attachment-heavy messages parse small: ~7.0 KB and ~2.6 KB responses),
   recorded `outcome=success`, with the windowed envelope behaving exactly as designed.
   The one real denial in the window was via `google_api_get` and its text **did** name
   the governing rule.
2. **The failing attempts never reached FGAC.** In the ~50-minute window where the
   failures were experienced there are zero `$mcp_tool_call` events, zero MCP 401s
   attributable to the user, and zero server exceptions. The literal string
   "No approval received" appears nowhere in this codebase — it came from the MCP
   *client* layer (a hosted-agent tool-approval flow), not from FGAC. FGAC cannot emit
   it and cannot observe the client declining to send a call.
3. **The user's rules came from our own "Recommended Security Rules" one-click
   template** (`applyRecommendedSecurityRules`): four global `read_blacklist` content
   rules with broad patterns (`Sign In`, `Verification Code`, `2FA Code`,
   `Password Reset`).

## The actual defects (what this fix addresses)

While the reported failure was client-side, the investigation surfaced real
enforcement defects that produce exactly the "rules behave inconsistently by message
size/path" experience the user described:

1. **Content rules are tested against `JSON.stringify(raw Gmail payload)`.** In Gmail's
   `format=full` JSON, body text is base64url-encoded. A content pattern therefore:
   - **cannot match the message body** — the one place users expect a content rule to
     look — for any multipart message (the pattern only ever matches the plaintext
     fields: snippet, headers, attachment *filenames*, label ids);
   - matches differently depending on `format` (`metadata` has no parts → fewer fields
     to match) and on message structure (small single-part vs large multipart), which
     reads as size-dependent, path-dependent enforcement;
   - can in principle false-positive on base64/id gibberish for space-free patterns.
2. **Denial texts do not identify FGAC as the decision-maker** and offer no remediation
   link, so a client-side failure message is indistinguishable from an FGAC policy
   denial to the end user — this is how a client-layer "No approval received" got
   attributed to FGAC rules. Label-rule denials also did not name the governing rule
   (only the label id, or nothing for whitelist misses).
3. **The recommended template's patterns are too broad** for post-fix semantics: once
   content rules can actually see body text, `Sign In` would block any email whose body
   invites the reader to sign in to a portal.

## Fix

1. `checkReadRestrictions` (shared by `gmail_read`, `google_api_get` gmail reads,
   `gmail_get_attachment` parent checks, and the push-notification filter) now builds a
   **decoded content corpus** — subject/from/to/cc headers, snippet, attachment
   filenames, and *decoded* text bodies (text/plain, tag-stripped text/html) across
   every message nested in the response (threads and lists included) — and tests
   content rules against that, instead of the raw JSON string. Unrecognized shapes fall
   back to the raw serialization so nothing silently un-enforces.
2. Every read-rule denial now names the governing rule, states that FGAC made the
   decision, and links the rules dashboard.
3. The recommended-template patterns are tightened to target security emails
   (sign-in alerts, verification codes) rather than any mention of signing in.

Existing user rules keep their stored patterns; only enforcement semantics (what text
the pattern is tested against) and denial copy change.

## Follow-up: what the runtime logs added, and the detectability gap

Vercel runtime logs for the reporter's window (retained ~1 day on Pro) showed
`POST /api/mcp` → **HTTP 400** at human cadence throughout the hour in which the
failures were experienced, and a 400 one second before each of the first
successful calls afterwards (a client retrying after a rejection). No 5xx. A 400 is
written by the MCP transport before any tool callback runs, so it never became a
PostHog event — "zero server traces" was true of our *analytics*, not of the
server. Attribution is not possible from the request log, and the 400 body was not
recorded anywhere, so whether those were the reporter's calls — and why they were
refused — remains unproven. Locally, the only client behaviours that produce a 400
on this build are an unsupported `MCP-Protocol-Version` header and a batch that
carries `initialize` alongside other requests.

Three classes of failure were confirmed to be invisible to analytics:

1. **Transport-layer 4xx** (400/406/415 written by the SDK): no event.
2. **Argument validation / unknown tool**: the SDK answers with an `isError` tool
   result *before* `withToolAnalytics` runs — verified locally: malformed
   `gmail_read` arguments (`offset: "0"`, `format: "FULL"`) produced no event.
3. **No request fingerprint**: `$mcp_tool_call` carried no (hashed) message id,
   format, or window flag, so a reported message id could not be matched to its
   calls; the match above was inferred from response sizes.

Plus one bug: a malformed or empty JSON POST body makes `/api/mcp` hang to the
function timeout (mcp-handler awaits `req.json()` unguarded) instead of answering
`400 Parse error`.

**Instrumentation shipped (same PR):** `mcp_transport_rejected` (our own parse-error
400 plus every SDK 4xx, with the JSON-RPC message, RPC method/tool, protocol-version
header, client id), `mcp_input_validation_failed` (from a post-send tee of POST
responses; GET/SSE never buffered), and request/response-shape props on
`$mcp_tool_call` (`message_id_hash`/`resource_id_hash` = `sha256(id).slice(0,16)`,
`format`, `windowed`, `parsed_body_chars`, `parsed_body_truncated`,
`parsed_attachments`, `parsed_html_fallback`). Named queries: `docs/monitoring.md`
§7.9–7.11.

## Verification

- Unit-style reproduction against a local build with the QA accounts: a pattern present
  only in a base64-encoded body (previously invisible) now blocks, with the rule named,
  identically via `gmail_read` and `google_api_get`; a large multi-attachment message
  with no matching content reads fine via both paths in full/metadata/windowed forms.
- Preview validation via `/deploy-pr-preview` before hand-off.

## Follow-up (2026-10-09): stored legacy `Sign In` rows over-blocked business mail

"Existing user rules keep their stored patterns" (above) turned out to be the gap.
The tightened `sign-in` seed only reached NEW template clicks; 14 rows across 13
accounts (12 live) kept the spaced `Sign In`, which compiles case-insensitively and,
against decoded bodies, matches any "sign in to …" prose.

Evidence (production, read-only):

- 6 of the 7 external accounts ever blocked by this rule hold the legacy pattern.
  Weekly blocks by the rule rose from 1–3 (September) to 16–17 (weeks of 09-27 and
  10-04), almost entirely two legacy holders (user A, user B).
- User B's agent read 14 distinct messages in one inbox sweep (format=full); 8 were
  refused by this rule. An inbox is not 57% sign-in alerts — the blocked mail is
  inferred (not observed: FGAC logs no subject or sender) to be ordinary business
  mail carrying "sign in" in a body or footer.
- User A's daily scheduled run (format=metadata, so headers + snippet only) loses
  about one message per run to the rule.

Fix: migration `0022_tighten_legacy_sign_in_template_rule.sql` rewrites the legacy
template rows (exact rule name + exact pattern + created before the tightened seed
shipped) to the current seed. `scripts/test-rule-patterns.ts` pins the migration's
target to the template seed so the two cannot drift.
