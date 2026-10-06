# gmail_send hard line-wrapping — plan v1

Branch: `claude/xenodochial-meitner-8b1f5b` · 2026-10-05 · own PR (not a train)

## Problem

A plain-text email sent through FGAC's typed `gmail_send` MCP tool arrives with
a real CRLF inserted after every ~70 characters. On a phone every paragraph
renders ragged: each wrapped line at the sender's width, the leftover word or
two stranded underneath. Every user whose agent sends mail through FGAC today
is affected, on every message with a paragraph longer than one line.

Evidence gathered in Ken's session (Ken's fgac.ai mailbox → a personal Gmail address,
2026-10-05):

- The sender's **Sent** copy (`messages/{id}?format=raw`) holds the paragraph
  as ONE line of 609 characters and carries no `Content-Transfer-Encoding`.
  Headers were exactly `To`, `Subject`, `Content-Type: text/plain;
  charset=utf-8`, plus the Gmail-added `Date`, `Message-Id`, `From`.
- The **delivered** copy has the same text with hard CRLFs every ≤ 72 columns.
- The same text sent through the claude.ai Gmail connector (a different sender
  implementation) arrived as one unbroken paragraph.

## Hypothesis

Gmail's outbound relay folds unencoded `text/plain` lines longer than the
RFC 5322 recommended 78 characters by inserting real line breaks, because the
message declares no transfer encoding that would let it soft-wrap. A message
whose body is `quoted-printable` (or `base64`) is wrapped at the encoding
layer and unwrapped by the recipient's client, so the paragraph survives.

Confirmed rather than assumed — see §Verification for the controlled sends
between the two QA accounts (one message per encoding variant, delivered
copies fetched with `format=raw` and compared line by line). Results are
recorded in plan v2.

## Where the code was

| builder | file | declared encoding | long lines? |
| --- | --- | --- | --- |
| typed `gmail_send` | `src/app/api/mcp/route.ts` (≈3352) | none | yes — every agent paragraph |
| owner notices (`approvalEmailRaw`) | `src/lib/approvalNotifyCopy.ts` | `8bit` | yes — the notice sentences run 150–250 chars |
| sales-lead mail (`salesLeadEmailRaw`) | `src/lib/salesLead.ts` | `8bit` | borderline (the thank-you line is 83 chars) |
| `google_api_modify` | passes the agent's raw MIME through | agent's choice | agent's problem — now told in the tool description |

`8bit` is still "unencoded" to the relay: it only promises bytes above 0x7F, it
does not promise short lines, so the notices wrapped the same way.

## Fix

One shared builder, `src/lib/mimeText.ts`, used by all three:

- `encodeQuotedPrintable(text)` — RFC 2045 §6.7: UTF-8 bytes, `=XX` for `=`,
  non-printable and non-ASCII bytes and for trailing whitespace, soft breaks
  (`=` + CRLF) so no encoded line exceeds 76 columns, an `=XX` token never
  split across a break, input line endings (CRLF / CR / LF) normalised to CRLF.
  `decodeQuotedPrintable` is the inverse, for tests and delivered-copy checks.
- `headerValue(v)` — CR/LF become a space (a CRLF in `to` or `subject` would
  otherwise start a new header: Bcc injection), other control characters
  dropped. `gmail_send` had no header hygiene at all before this.
- `encodeHeaderWord(v)` (moved here from `approvalNotifyCopy.ts`, re-exported
  there) — RFC 2047 `=?UTF-8?B?…?=` for non-ASCII subjects, now in words of
  ≤ 75 characters split only between code points and folded onto
  continuation lines, as the RFC requires; `decodeHeaderWord` for tests.
- `buildTextMessage({from?, replyTo?, to, cc?, subject, body, extra?})` —
  addressing headers, Subject, extra headers (the `X-FGAC-Notice` DSN tag),
  then `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`,
  `Content-Transfer-Encoding: quoted-printable`, blank line, encoded body.
  `buildTextMessageRaw` base64url-encodes it for Gmail's `raw` field.

No `multipart/alternative` HTML part: the task said simpler is better unless
plain quoted-printable is not enough on Gmail mobile. Plan v2 records what the
delivered copy looked like; the HTML part stays out unless that measurement
says otherwise.

`gmail_send`'s tool description now says the body is sent quoted-printable so
long paragraphs arrive as written; `google_api_modify`'s says to declare a
transfer encoding on raw text parts and why.

## Tests

- `scripts/test-mime-text.ts` (wired into `npm run mcp:lint`): the 609-char
  production fixture round-trips through an INDEPENDENT RFC 2045 decoder, no
  encoded line exceeds 76 columns, output is printable ASCII (tabs allowed),
  unicode / `=` / trailing whitespace / mixed line endings / empty body /
  75- and 76-column edges / `=XX` tokens straddling the 76th column, 300
  seeded random bodies, header hygiene for every header field, RFC 2047
  folding that never splits a code point, header order, base64url round trip.
- `scripts/test-approval-notify-copy.ts` updated: the raw message now declares
  `quoted-printable`, the body decodes to the plain text given, no line over
  76, and the (possibly folded) encoded-word subject decodes back.
- QA capability `01_send_whitelist.md` A6 (+ the A6 step in all four agent
  runbooks): a ≥ 300-char paragraph sent through `gmail_send` arrives in
  USER_B's mailbox with `Content-Transfer-Encoding: quoted-printable`, no
  encoded line over 76, and the decoded paragraph identical to what was
  sent. The sender's Sent copy is explicitly NOT evidence.

## Verification plan

Static: `npx tsc --noEmit`, `npm run lint`, `npm run mcp:lint`.

Live, local dev server on an isolated Neon branch (`npm run db:branch`,
`preview_start fgac-dev`): the QA setup driver mints an MCP bearer for USER_A
and one for USER_B (DCR + PKCE against dev Clerk, sign-in through Google's
account chooser in the built-in browser) and enables sending on USER_A's
Default Profile. Then, from the orchestrator with curl against `/api/mcp`:

1. Controlled experiment, USER_A → USER_B via `google_api_modify`
   `gmail/v1/users/me/messages/send`, same 609-char paragraph, four variants:
   (a) bare `text/plain` with no `Content-Transfer-Encoding` — the shipped
   builder's shape; (b) `8bit` — the notices' shape; (c) `quoted-printable`;
   (d) `base64`. Fetch each DELIVERED copy with USER_B's bearer
   (`messages/{id}?format=raw`), decode, record the declared encoding, the
   longest line and whether the paragraph is one line after decoding.
2. The fixed tool: `gmail_send` USER_A → USER_B with the same paragraph; same
   fetch and comparison (this is capability 01 A6).
3. Which browser path each step used is recorded in v2 (the orchestrator
   drives no third-party surface; the setup driver reports its own path).

Preview validation via `/deploy-pr-preview` repeats step 2 against the
preview URL if the PR preview is built before hand-back.

## Impact (to be stated in the hand-back)

Every email any user's agent sends through FGAC's typed tool today reaches
the recipient with hard breaks at ~72 columns, so on phones it looks like a
badly pasted text file. After the fix the recipient sees the paragraph the
agent wrote. The owner notices FGAC itself sends (approval reminders, dead
grant, scope-missing, account-refusal, sales confirmation) stop wrapping too.
