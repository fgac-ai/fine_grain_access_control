# Placeholder `account` values: say so, and never email the owner about one — v1

> Branch: `claude/goofy-khorana-7b992f`, off `main` at 6645aa9 (PR #156 merged).
> From the daily product-analytics review of 2026-09-23. No schema change.

## 1. What was measured (PostHog, production, re-run 2026-09-24)

`$mcp_tool_call` rows with `denial_code = 'account_not_permitted'`, grouped by
the domain of `account_requested`, trailing 60 days:

| domain class | rows | owners | window |
| --- | --- | --- | --- |
| `example.com` (RFC 2606 reserved) | 140 | 1 | 2026-09-21 13:47Z → 09-23 20:06Z, still running |
| (empty — before the property existed, 09-09 → 09-16) | 65 | 7 | — |
| real domains (gmail.com and three business domains) | 51 | 6 | — |

No other reserved or template domain (`.test`, `.invalid`, `domain.com`,
`test@test.com`, …) appears in 60 days. The pattern is **one owner**, on
Claude.ai (`Anthropic/Toolbox`; two `claude-code` rows in the whole window
are unrelated real addresses), but it is the largest single refusal source
in the window and had not stopped at the time of the query — it kept going
after PR #156 v4 shipped, so the episode guard alone did not touch it.

The per-hour sequence for that owner settles the "is the text read"
question: the two invented values (`ufficio@example.com`,
`direzione@example.com` — the local parts of the mailboxes the agent wanted,
with a made-up domain) are sent **in the same second, every burst**, and
repeated verbatim across eight bursts on four days (5+5, 25+20, 5+5, 5+5,
5+5, 17+14, 11+9). The value never varies after a denial. This is either a
project/system prompt that carries the placeholders or an agent that fills
them in from memory each turn; the denial text is not being acted on.

Owner emails: `account_refusal_notified` has fired **four times ever**
(2026-09-17 → 09-21, two owners). Two of the four — 09-21 13:47:53Z and
13:47:54Z, one second apart, one per invented value — told this owner their
task passes an `example.com` address. The 09-20 21:06Z email about the real
mailbox worked (delegation 10 minutes later, first successful call at
21:16Z). So half of all refusal notices sent to date were about values that
cannot exist.

## 2. Decisions

1. **Placeholder-specific denial copy** (`accountNotPermittedByCaller`
   gains a third argument). Still 🚫 — the key's account list is policy and
   the refusal is deterministic — but the text now says the value is a
   placeholder / not an address, says "do not guess or invent addresses",
   lists the only usable accounts, tells the agent to **ask the user** which
   one they mean rather than try another value, and drops the generic "only
   the user can add an account" fix, which is exactly the wrong reading for
   a fictional value. Accepted: the evidence says this agent does not read
   the text, but the generic copy is misleading for every future agent that
   does, and the change is free.
2. **Placeholder values never reach the ledger or the owner email.**
   `notifyOwnerOfAccountRefusal` returns `skipped_placeholder` before
   `recordAccountRefusal`. The ledger exists to tell an owner which real
   account to add; a row for `ufficio@example.com` carries no diagnosis a
   human can act on, and (before v4) opened an episode that then suppressed
   the email a real value would have earned. Accepted: an email naming an
   invented address is the one outcome the notice must never produce.
3. **Retry pressure (7.22) still counts them.** The calls were made; the new
   `account_requested_placeholder` property (`reserved_domain` / `synthetic`
   / `malformed`) lets 7.22 and 7.26d split them out instead of hiding them.
4. **Detector is deliberately narrow** (`src/lib/placeholderEmail.ts`): RFC
   2606/6761 names, a short list of documentation-template domains and local
   parts, and values that are not an address. A false positive costs an owner
   one email about a value their agent genuinely meant (the refusal itself is
   unchanged); real providers that sound generic (`mail.com`, `email.com`,
   a `test@` local part on gmail.com) are pinned as pass-through in the tests.
5. **Not built**: episode/cadence logic (PR #156 v4 owns it); a "did you mean
   <the listed address with the same local-part prefix>" fuzzy hint (the
   prefix match is suggestive for this one case, but a wrong suggestion would
   be a new way to mislead, and the usable list already names the real
   address in full).

## 3. Changes

| file | change |
| --- | --- |
| `src/lib/placeholderEmail.ts` | new: `classifyPlaceholderEmail` → `reserved_domain` / `synthetic` / `malformed` / null; `isPlaceholderEmail` |
| `src/lib/denialCopy.ts` | `accountNotPermittedByCaller(target, usable, placeholder?)`; new placeholder form, 🚫 kept |
| `src/lib/approvalNotifyCopy.ts` | `NotifyStatus` gains `skipped_placeholder` (no 📧 line) |
| `src/lib/approvalNotify.ts` | `notifyOwnerOfAccountRefusal` returns `skipped_placeholder` before touching the ledger |
| `src/app/api/mcp/route.ts` | classifies once; passes the kind to the copy; stamps `account_requested_placeholder` |
| `scripts/test-placeholder-email.ts` (+ `mcp:lint`) | 60 checks: both production values, RFC names, templates, markers, 17 real-looking pass-throughs, the copy invariants, the empty denial line |
| `docs/analytics.md` | `$mcp_tool_call` gains `account_requested_placeholder`; `skipped_placeholder` documented on both rows |
| `docs/monitoring.md` 7.22, 7.26d | placeholder watch query; 7.26d selects the kind |
| `docs/QA_Acceptance_Test/capabilities/14_magic_link_approvals.md` A17 | placeholder step: 🚫 placeholder copy, no 📧, `skipped_placeholder`, no ledger row |

## 4. Validation

- `npx tsx scripts/test-placeholder-email.ts` — 60/60; `test-denial-copy` and
  `test-approval-notify-copy` unchanged and green; `tsc --noEmit` and eslint
  clean on the changed files.
- The ledger-skip path runs inside `notifyOwnerOfAccountRefusal`, which
  imports the database-backed proxy route, so it is covered by the new A17
  step in capability 14 rather than a pure test; that step was not run on
  this branch (same standing as PR #156 v4's A17 change).
- Preview: `/deploy-pr-preview` — see the PR for the URL and the check log.
- After deploy, the confirming read is 7.22's placeholder query: the same
  owner's bursts should now carry `notify_status = 'skipped_placeholder'`
  and `account_requested_placeholder = 'reserved_domain'`, and
  `account_refusal_notified` must stay at zero rows for placeholder values.
