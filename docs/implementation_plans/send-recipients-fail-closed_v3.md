# Send-recipient parser fails closed — v3

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
  `claude/large-api-payload-options-75c2d2`: this branch introduces the same
  `extractRfc822Recipients` split with the same signature. Trial merge into the
  large-payload branch (2026-10-03, throwaway worktree) conflicts in three places,
  all mechanical:
  1. `googleApiPolicy.ts` — take this branch's side (the parser body).
  2. `mcp/route.ts` — keep the other branch's side (`checkSendWhitelist` moved to
     `src/lib/gmailRules.ts`), and carry this branch's new `recipients_undetermined`
     copy into `gmailRules.ts`.
  3. capability 10 — keep both A16 and A17.
  Plus one non-conflicting edit the merge needs: the proxy's drafts/send
  (`[...path]/route.ts`, the `[...new Set(...)]` union) becomes
  `checkSendWhitelist(applicableRules, draftSendRecipients(draftRaw, draftInfo))`.
  With that, `tsc`, `mcp:lint` and `test-rest-proxy-policy.ts` pass on the merged
  tree. PR #176 alone also conflicts with main on `package.json` / `analytics.md`
  (pre-existing drift, not this branch).

## Docs

- capability 10 **A17** (hidden recipients refuse the send; drafts/send too) —
  A16 is taken by PR #176.
- user guide: "every recipient must be readable".
- Main's REST proxy still parses only `To` with its own code; PR #176 replaces it
  with the shared parser, so this fix reaches the proxy when #176 lands.

## Validation

- [x] 47 new unit cases written first (39 failing on main's parser), all green after the fix
- [x] `npm run mcp:lint`, `tsc --noEmit`, eslint green
- [ ] local MCP: send with a hidden quoted-local-part Bcc → `recipients_undetermined`
- [ ] preview via `/deploy-pr-preview`
