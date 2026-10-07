# gmail_send hard line-wrapping — plan v2 (hypothesis revised, design changed)

Branch: `claude/xenodochial-meitner-8b1f5b` · 2026-10-05 · own PR (not a train)
Supersedes v1 (`…_v1.md`), which proposed quoted-printable text only.

## What changed since v1

v1's hypothesis was that Gmail folds *unencoded* `text/plain` and that a
`quoted-printable` body would pass through untouched. A measurement from the
originating session (2026-10-05 22:20 ET, Ken's fgac.ai mailbox → a personal
Gmail address, the same pair as the bug report) disproved the second half:

- A hand-built `multipart/alternative` was sent through `google_api_modify`
  (`gmail/v1/users/me/messages/send`) with a quoted-printable `text/plain`
  part (soft breaks at 76 columns, decoded paragraph = one 609-char line) and
  a quoted-printable `text/html` part.
- The DELIVERED copy (`?format=raw`) shows Gmail rewrote the message on the
  way out: its own boundary (`000000000000…`); the `text/plain` part came out
  as `Content-Type: text/plain; charset="UTF-8"` with NO
  `Content-Transfer-Encoding` and the paragraph hard-wrapped at word
  boundaries around 72 columns. **Quoted-printable on the text part did not
  survive** — Gmail decoded it and re-serialised the plain text with its own
  folding. The first (bare `text/plain`) send had wrapped the same way.
- The `text/html` part was preserved intact, still quoted-printable. Gmail's
  mobile clients render the HTML alternative, so the phone view reflows — this
  is the path that fixes the user-visible symptom.
- Control: the message sent through the claude.ai Gmail connector arrived with
  a ONE-LINE `text/plain` part whose links were rewritten to
  `google.com/url?q=…` — Gmail generated that text part itself from an
  HTML-only submission and did not fold it.

So the relay does not fold "unencoded" text — it re-serialises **every**
`text/plain` part with its own folding, and the only part that arrives as
submitted is HTML. A quoted-printable-only fix would have shipped the same
ragged paragraphs.

## Fix (as shipped)

`src/lib/mimeText.ts`, used by `gmail_send`, `approvalEmailRaw` and
`salesLeadEmailRaw`:

- `buildTextMessage` emits `multipart/alternative`: the plain text the caller
  wrote, then `textToHtml(body)` — one `<p>` per paragraph (blank-line
  separated), `<br>` for line breaks inside a paragraph, leading indentation
  as `&nbsp;`, bare URLs wrapped in `<a href>` (trailing punctuation left
  outside, parentheses balanced), everything else escaped, no styling. Both
  parts `charset=utf-8` + `Content-Transfer-Encoding: quoted-printable`
  (RFC 2045: ≤ 76 columns per encoded line, `=XX` never split, CRLF). The
  boundary is `fgac-` + 20 random hex digits (injectable for tests) so the
  `Content-Type` header stays under 78 columns.
- Header hygiene (`headerValue`: CR/LF → space, control chars dropped) on
  every header — `gmail_send` had none before. Subject RFC 2047 in ≤ 75-char
  words split only between code points (`encodeHeaderWord`, moved here from
  `approvalNotifyCopy.ts` and re-exported there).
- `parseTextMessage` splits a built or delivered message into decoded parts —
  the tests and the QA runbook use it.
- Tool descriptions: `gmail_send` says FGAC adds an HTML alternative and why;
  `google_api_modify` says Gmail re-folds `text/plain` at ~72 columns whatever
  its encoding, add a `text/html` alternative when layout matters. Both under
  the 1500-char lint cap (`google_api_modify` was at 1483; four clauses were
  tightened to make room).

The plain part is kept as written (Gmail will re-fold it regardless): clients
that prefer plain text see what they saw before; everything else renders the
HTML.

## Tests

- `scripts/test-mime-text.ts` (in `npm run mcp:lint`): quoted-printable
  round trips through an independent decoder, 76-column limit, unicode /
  trailing whitespace / line endings / `=XX` straddling the boundary / 300
  seeded random bodies; `textToHtml` escaping, paragraphs, `<br>`, `&nbsp;`,
  links with trailing punctuation and parentheses, `&` in query strings, URL
  markup injection; message shape — header order, two quoted-printable parts,
  plain part decodes to the input, HTML part decodes to `textToHtml(body)`
  and holds the 609-char paragraph as one `<p>`, no encoded line over 76, no
  header line over 78, boundary absent from both parts, header injection via
  every field, extra-header validation, base64url round trip.
- `scripts/test-approval-notify-copy.ts`: raw notice is `multipart/alternative`
  with the two quoted-printable parts, the text part equals the body, the HTML
  part equals its rendering with the approval link clickable, no encoded line
  over 76, folded RFC 2047 subject decodes back. `test-email-bounces.ts` and
  `test-google-grant-notify-copy.ts` (From/Reply-To/Cc/notice header) pass
  unchanged.
- QA capability `01_send_whitelist.md` A6 (+ A6 step in all four runbooks):
  the DELIVERED copy is `multipart/alternative` with a `text/html` part whose
  decoded content holds the ≥ 300-char paragraph in one `<p>`; Gmail's
  re-folding of the `text/plain` part is explicitly not a failure; the Sent
  copy is not evidence.

## Verification record

Static (all clean): `npx tsc --noEmit`; `npm run mcp:lint` (41 scripts
including the new one); `eslint` on every changed file. `npm run lint`
(= `mcp:lint` + `eslint .`) fails on this branch exactly as it does on `main`:
33 pre-existing errors in files this PR does not touch (`public/skills/
claude-code-cli/scripts/*.js` `require()` imports, `useGooglePicker.ts`,
`ApprovedSettling.tsx`, `test/testclaw/qa-claude-code-mcp.js`,
`scripts/qa-dcr-setup.ts`).

Live, QA accounts, local dev server (port 52330, isolated Neon branch
`claude-xenodochial-meitner-8b1f5b`, dev Clerk keys, `env:check` consistent):
**not completed in this session.** The `qa-setup-driver` runner minted and
verified a USER_A bearer (built-in browser, trusted clicks; `tools/list` 21
tools, `list_accounts` OK) but hit two environment blockers, each tried once:

1. The send-whitelist rule for USER_A ("Enable sending to anyone" / custom
   rule) needs the dashboard at `localhost:52330`, and the built-in browser
   pane refuses every localhost navigation in this environment (the `seed`
   tab from `preview_start` reports "last page load failed"); the Path B
   fallback (Playwright CLI on the CDP Chrome profile) was denied to the
   runner by the session's auto-mode classifier. Without the rule every
   `gmail_send` is refused, so no send happened.
2. The "USER_B" sign-in on dev Clerk resolved to USER_A's Clerk user (same
   `sub`, same primary email at `/oauth/userinfo`; FGAC bound it as a second
   connection on USER_A's Default Profile). No distinct USER_B identity could
   be minted, so the delivered copy could not have been read even after a
   send. The delegated umich mailbox on USER_A's key is unusable on a fresh
   branch (`owner_not_found`: the delegation's owner row carries a production
   Clerk id).

No password, passkey, Okta or 2FA prompt appeared. State left on the local
branch: two DCR clients and two auto-approved agent connections on USER_A's
Default Profile; nothing sent; no source, schema or config touched by the
runner.

The controlled-experiment script is ready in the session scratchpad
(`experiment.mjs`: bare / 8bit / quoted-printable / base64 / format=flowed /
HTML-only / multipart text+HTML through `google_api_modify`, plus the fixed
`gmail_send`; `read` mode fetches each delivered copy raw and tabulates
part type, encoding, longest line and whether the paragraph is intact). It
needs exactly one dashboard click (send rule on USER_A's Default Profile) and
a USER_B bearer to run; capability 01 A6 in the next QA run covers the same
ground.

The design therefore rests on the originating session's delivered-copy
measurement above (direct, on the affected mailbox pair) rather than on a
QA-account repeat of it. The HTML-alternative path is also what the claude.ai
connector uses, and its messages are the ones that arrived unbroken.

## Impact (hand-back)

Before: every email any user's agent sent through FGAC's typed tool reached
the recipient folded at ~72 columns — on a phone, a ragged, badly pasted
text file. After: the recipient's client renders the HTML alternative and
sees the paragraph the agent wrote; the owner notices FGAC sends (approval
reminders, dead-grant, scope-missing, account-refusal, sales confirmation)
stop wrapping too. Caveat: measured on Gmail-to-Gmail delivery; other
receiving providers that strip HTML would show Gmail's folded plain part,
which is no worse than today.
