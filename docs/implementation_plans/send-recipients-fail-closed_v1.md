# Send-recipient parser fails closed — v1

Branch: `claude/send-recipients-fail-closed` (from main 9b55482). Source: adversarial
review 2026-10-03 (code reading only).

## Problem

Every Gmail send path decides "who is this mail going to" with one parser
(`extractSendRecipients` on main; split into `extractSendRecipients` →
`extractRfc822Recipients` by PR #176, which `claude/large-api-payload-options-75c2d2`
has merged). It scans `To/Cc/Bcc` header lines with
`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` and keeps what matches. Anything the
regex does not recognise is **dropped, not refused**:

| form | example (all example.com) | before |
| --- | --- | --- |
| quoted local part | `"a b"@example.com` | dropped |
| domain literal | `user@[192.0.2.1]` | dropped |
| UTF-8 / IDN address | `用户@例子.example` | dropped |
| partial match | `ü-x@example.com` parsed as `-x@example.com` | wrong address checked |
| obsolete header syntax | `Bcc : evil@example.com` | header not scanned |
| leading whitespace on first header | ` Bcc: …` | header not scanned |
| bare-CR line break | `Subject: hi\rBcc: evil@…` | header not scanned |
| Resent-To/Cc/Bcc | | not scanned |
| RFC 2047 encoded-word hiding an address | `=?utf-8?b?…?=` | dropped |
| duplicate JSON `raw` key | `{"raw":benign,"raw":evil}` | JSON.parse takes last; Google may take first |

When at least one ordinary, whitelisted address is also present, the list is non-null
and the whitelist passes — the hidden recipient gets the mail.

drafts/send has a second instance: recipients = stored draft ∪ inline `message.raw`,
with `?? []` on each side, so an unparseable side is silently ignored.

## Fix (fail closed)

`extractRfc822Recipients` keeps parsing ordinary addresses, but returns `null`
(→ `recipients_undetermined`) when any recipient header holds an `@` (or a
full-width/small at-sign) that is not inside a cleanly delimited parsed address:

1. header section = up to the first `\r?\n\r?\n` (the longest plausible span);
   inside it, lines split on `\r\n|\r|\n` (the finest plausible split) — scanning
   more than Gmail does can only add recipients, never hide one.
2. header names matched as `^\s*(resent-)?(to|cc|bcc)\s*:` case-insensitively.
3. an address counts only when bounded by whitespace / `<>,;:()` / `"` or the ends
   of the value; after removing the counted addresses, any remaining at-sign → null.
4. encoded-words in a recipient header are decoded (B and Q) and an at-sign in the
   decoded text → null.
5. `extractSendRecipients` refuses a JSON string body with more than one `raw` key
   (keys compared after JSON unescaping).

drafts/send: new shared helper `draftSendRecipients(draftRaw, info)` — null when the
stored draft is unparseable, or when an inline message is present but unparseable.
The MCP route uses it; the REST proxy on #176 / the large-payload branch should swap
its line-1278 union for the same helper when it merges this.

`checkSendWhitelist` semantics unchanged (null/empty → `recipients_undetermined`).

Cost: UTF-8 addresses and domain literals can no longer be sent through FGAC at all
(previously they were sent unchecked). Accepted — fail closed is the point.

## Tests

`scripts/test-google-api-policy.ts` — one case per form above, written first and
committed failing; plus regressions for display names, groups (`undisclosed-recipients:;`),
comments, and an `@` inside a quoted display name (still parsed and checked).

## Merge coordination

- PR #176 (`claude/proxy-shared-google-policy`) and
  `claude/large-api-payload-options-75c2d2`: conflict expected only in the body of
  `extractRfc822Recipients` (this branch introduces the same split with the same
  signature). Take this branch's body; swap proxy drafts/send union for
  `draftSendRecipients`.

## Validation

- [ ] `npm run mcp:lint` green
- [ ] local MCP: send with a hidden quoted-local-part Bcc → `recipients_undetermined`
- [ ] preview via `/deploy-pr-preview`
