# Approval context after the sign-in wall — v4

Branch: `claude/stoic-goldberg-0a916f`, PR #157. Supersedes v3 with one
correction the scoped preview re-test caught. Everything else in v3 stands.

## What changed since v3

- **F5 (preview QA re-test 2, commit ada1a06): `/dashboard` returned 500 for
  an owner with an opened wall-hit row.** The v3 read selected
  `coalesce(last_opened_at, opened_at)` as a raw SQL expression, which
  bypasses Drizzle's timestamp decoder and hands the router a string; the
  routing rule's `.getTime()` threw inside the page render. Fixed by
  selecting both columns as plain columns and coalescing in code
  (`lastOpenedAt ?? openedAt`), and by wrapping the whole route decision:
  a failure now reports `approval_wall_route_skipped {reason:
  'lookup_failed'}` and the profile page renders. Routing is a repair,
  never a gate.
- Lesson for the ledger helpers: never return a raw `sql` timestamp
  expression to a caller that treats it as a `Date`; a generic on
  `sql<Date>` only changes the TypeScript type.

## Verification (this revision)

Scoped preview re-run of the v3 controls on commit 1cc8f96: a request
opened again after its wall hit must NOT route (`opened_since: 1`); an
unopened one must still route, then `routed_already: 1`. Results in the PR.
