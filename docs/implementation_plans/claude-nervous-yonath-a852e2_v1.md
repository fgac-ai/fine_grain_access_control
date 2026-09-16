# Cross-mailbox 404s: name the account, list the others — v1

Branch: `claude/nervous-yonath-a852e2` · 2026-09-15

## Problem (measured)

`$mcp_tool_call`, production, 2026-09-12 → 09-13: one operator whose mailbox
work is entirely delegated ran 183 successful `GET gmail/v1/users/me/threads/{id}`
reads against the delegated mailbox and 20 failing ones (404) against their own
mailbox, same endpoint, same hours. The failing calls omitted `account`, so they
resolved to the primary (own) mailbox; the ids had come from listings on the
delegated one. The 404 text named no account and did not mention that the key
reaches others, so the agent retried the same ids.

A 30-day, direction-agnostic query (docs/monitoring.md 7.23) found the same shape
for five people / 52 events, the largest on the typed `gmail_read` tool (26), so
the typed path shares the gap.

## Established from the code

1. `resolveAccountAndToken` (route.ts): `targetEmail = account || conn.user.email`
   — omitting `account` always means the key owner's own mailbox. It already
   fetches every reachable mailbox (`getAccessibleEmails`) for the permission check.
2. `googleFetch` receives `targetEmail` and `describeGoogleError` already has it at
   the point the 404 sentence is built; it was simply not used in that branch.
3. `classifyToolOutcome` reads the first characters of `content[0].text`; every
   change here appends text, so outcome classes are unchanged (raw gmail 404 stays
   `error`, typed gmail 404 stays `failed`, passthrough `{id}` 404 stays
   `denied_by_policy`).

## Change

- `src/lib/denialCopy.ts`: `googleNotFoundMessage(detail, targetEmail)` names the
  account the call ran against; `crossMailboxHint(otherAccounts)` returns `''` for
  single-mailbox keys and otherwise lists the other mailboxes, states that ids are
  mailbox-specific, and gives the fix as `account: '<address>'` with a one-retry
  bound.
- `route.ts`: `ResolvedAccount.otherAccounts` (filled in `resolveAccountAndToken`);
  `withMailboxContext(text, status, resolved)` appends the hint on 404 only and
  stamps `cross_mailbox_hint: true`. Applied at the three sites where an
  id-addressed 404 becomes a result: the raw gmail-family tail of
  `executeRawGoogleCall`, `gmailNotFoundResult('message', …)` (now names the
  mailbox), and `passthroughErrorResult` (Drive). The rate-limit 403 text also
  names the account. The `account` parameter description on `gmail_read`,
  `gmail_get_attachment`, `google_api_get`, `google_api_modify` says ids are
  mailbox-specific.
- `scripts/test-denial-copy.ts` pins both builders (prefix class, account named,
  empty hint for single-mailbox keys, exact fix wording, plural form).
- `docs/monitoring.md` 7.23: the measurement query + baseline.
  `docs/analytics.md`: the new property.

## Rejected

- Structured error payload (`structuredContent`): the MCP SDK (1.26) passes it
  through untouched when no `outputSchema` is declared, and it would not affect
  emoji-sniffed classification — but the spec lets clients prefer
  `structuredContent` over the text block, which would drop the "do not retry"
  prose the whole change exists to deliver. Revisit if 7.23 shows agents still
  looping after reading the hint.
- Changing the default account resolution (e.g. inferring the mailbox from the
  id): ids are opaque; guessing would misattribute reads across mailboxes.

## Validation

- `npx tsx scripts/test-denial-copy.ts`, `npm run mcp:lint`, `tsc --noEmit`.
- Preview: `/deploy-pr-preview`; a runner mints a bearer on the preview and calls
  `google_api_get gmail/v1/users/me/threads/<bogus>` and `gmail_read` on a key
  that reaches two mailboxes, checking the 404 text names the account and lists
  the other mailbox, and that a single-mailbox key gets no hint.
