# Capability: Read Blacklist Enforcement

> Extracted from `02_gmail_fine_grain_control.md` §2-3

## Assertions

### A1: Read blacklisted sender domain blocked
- Attempt to read an email from a blacklisted domain (e.g., `sales@competitor.com`)
- **Expected**: Read is blocked with a rule-named, FGAC-attributed restriction message
  (*"🚫 FGAC read rule '<name>' blocked this message: its content matches the rule's blocked pattern."*, ending with the dashboard link)
- **Mechanism note** (2026-09-03 revision): there is no separate sender-domain
  matcher — `read_blacklist` rules are one regex tested against the DECODED
  message content corpus (header lines, snippet, attachment filenames, decoded
  text bodies — `collectMessageContent` in `src/lib/gmailRules.ts`), so a
  domain pattern matches the From header line via the same generic content
  path as A2, and the denial wording is the generic rule-named message, not a
  domain-specific one

### A2: Read blacklisted content pattern blocked
- Attempt to read an email containing blacklisted content (e.g., "CONFIDENTIAL_PROJECT_X")
- **Expected**: Proxy blocks with error including rule name: *"FGAC read rule 'Block Project X' blocked this message: its content matches the rule's blocked pattern."*

### A3: Quick-add security template blocks account lifecycle emails
- Apply the recommended template ("Quick Add 2FA Block"), then read emails containing
  "2FA Code", "Password Reset", "Verification Code", and a security alert containing
  "sign-in" (the template pattern is hyphenated `sign-in` — the security-alert idiom —
  NOT conversational "sign in", revised 2026-09-03)
- **Expected**: Each read is blocked with the SPECIFIC template rule named (e.g.
  *"FGAC read rule 'Block Verification Codes' blocked this message …"*)

### A4: Non-blacklisted emails read successfully
- Attempt to read a normal email not matching any blacklist
- **Expected**: Proxy passes the request, email content returned

### A5: Wildcard (`*`) patterns are expanded before matching
Patterns are globs — `*` means "anything" and every enforcement site expands it
to `.*` before compiling. This asserts the expansion actually happens at
enforcement time, in BOTH directions. A one-directional check is not enough: a
pattern that fails to compile is silently skipped, which looks identical to
"did not match".

Drive the REST proxy directly with a profile's `sk_proxy_` key (this needs only
the local dev server — no preview deploy, no MCP client):

1. Create a `read_blacklist` rule with pattern `*`, assigned to that profile.
   `GET /api/proxy/gmail/v1/users/me/messages?maxResults=1`
   → **403** `FGAC read rule '<name>' blocked this message: its content matches the rule's blocked pattern. …`
   A broken expansion yields **200** here, because an uncompilable pattern is
   skipped rather than enforced.
2. Edit the same rule's pattern to `ZZZNOMATCH*` and repeat the request
   → **200**, with a real message list.

Both outcomes are required. Step 1 alone would also pass if the matcher blocked
everything unconditionally; step 2 alone would also pass if the pattern never
compiled.

**Send side**: assert both directions from ONE rule, so a non-compiling
pattern cannot pass. With `send_whitelist` = `*@umich.edu` (matching
`USER_B_EMAIL`) on the profile:

- send to `USER_B_EMAIL` → **200**, response carries a Gmail message `id` and
  `labelIds: ["SENT"]`. This delivers real mail to the QA account, which is
  expected and permitted.
- send to `blocked@example.net` → **403** *"...add 'blocked@example.net'
  to the sending whitelist."*

The wording matters: the zero-rules branch ends *"Default access is DENIED."*
instead, so only the first phrasing proves a rule was actually evaluated.

### A6: Content patterns match base64-encoded bodies (decoded-corpus enforcement)
Send a QA email whose blocked phrase appears ONLY in the message body (multipart —
Gmail returns the body base64url-encoded in `format=full`), NOT in the subject or
snippet-visible opening text. Then read it.

- Via `gmail_read` (format=full, and again with `offset`/`limit`), via `google_api_get`
  `gmail/v1/users/me/messages/{id}?format=full`, and via the REST proxy
- **Expected**: ALL paths block with the rule named. Before 2026-09-03 the pattern was
  tested against the raw JSON serialization, so a phrase living only in an encoded body
  was invisible to content rules — enforcement looked format- and size-dependent
  (support case). A phrase visible in the snippet must still block (regression guard).

### A7: REST proxy enforces read rules on thread reads
- With a matching `read_blacklist` rule active, `GET /api/proxy/gmail/v1/users/me/threads/{id}`
  for a thread containing the blocked message
- **Expected**: **403** with the rule-named error — thread reads previously bypassed
  read rules on the REST proxy (the gate matched only `messages` paths) while the MCP
  path checked them; the gate now covers every Gmail GET.
