# Owner-notice emails: serialize the per-owner claims, fix the refusal copy — v1

> Branch: `fix/notify-cap-race-and-refusal-copy`. Two findings from the daily
> analytics review of 2026-09-24, grouped because they live in one module
> (`src/lib/approvalNotify.ts` and its three ledgers) and share fixtures.
> Standing rule (Ken, 2026-09-21): ONE email per event, never a repeat
> cadence, every trigger capped at 3 per recipient per rolling 24 h with a
> global breaker.

## 1. What the review found

**Same-instant duplicate emails.** Two owners each received two owner-notice
emails from FGAC's support mailbox within one second: link reminders 108 ms
apart on 2026-09-17, account-refusal notices 271 ms apart on 2026-09-21. A
third owner received three emails in 10.3 h — the daily cap exactly.

**Unreadable refusal copy.** Ken ran the account-refusal flow on a local
build and got the email as a user would. His verdict, quoted: "The email is
gibberish… Please include a link to the email delegation video… Is the
random string just a test or hash of some indecipherable part of our
system… Please make sure this is being sent from a Fgac email not the users
own email." The email named the agent by a 16-character id, signed off with
the QA account's own address, and linked `localhost`.

## 2. What is actually happening (verified)

### 2.1 The claims race across rows, not within one

Read-only production check (2026-09-24, every stamp on all three ledgers):

| fact | value |
| --- | --- |
| owner-notice stamps ever | 25, across 17 owners |
| worst rolling-24 h count for any owner | 3 |
| rolling-24 h windows above the cap | 0 |
| same-second stamp pairs | 2 (the two cases above) |

So the cap has never been breached. Both duplicate pairs are **two ledger
rows of one owner claimed at the same instant with headroom under the cap**:

- 2026-09-17: two `approval_requests` rows (two spreadsheets requested in
  one agent turn, both re-minted 44 minutes later in one turn). Each claim
  was legitimately due; nothing said "one email per turn".
- 2026-09-21: three `account_refusals` rows on ONE key with three different
  refused values; rows two and three were stamped 271 ms apart. This predates
  the per-owner episode guard (PR #156, merged 09-23) — but that guard is an
  `EXISTS` over the owner's other rows, evaluated in each statement's own
  snapshot, so two concurrent claims still both see "no episode" and both
  send. The same shape holds for the daily cap and the dead-grant global
  breaker.

Mechanism: under READ COMMITTED every statement takes its snapshot when it
starts. The per-row `notified_at IS NULL` flip is atomic (Postgres re-checks
the row under its lock), but the subqueries over OTHER rows are not — there
is no lock on "the owner". The header comment in `approvalNotify.ts` claimed
otherwise; it was wrong.

Established locally (`scripts/test-notify-claim-race.ts`, branch DB): two
concurrent UPDATEs of the pre-fix shape, with `pg_sleep` widening the window,
both claim under a cap of 1 and both pass the episode guard.

### 2.2 The copy

- **The "random string"** is the agent label: the connection's nickname, else
  its client name. A connection created before its MCP client sends
  `initialize` stores its opaque OAuth client_id as the client name; the
  heuristic meant to catch id-shaped names ("no vowel pair") let
  `JkGUAFOdt9Ib0Q7J` through on "UA". Nothing about the profile was shown.
- **The sender** is `SUPPORT_SENDER_EMAIL` — set in Production (checked by
  name via `vercel env ls`; value not read). Local QA stands the QA account in
  for it, which is why Ken's copy came "from" that account. The signature
  line rendered the configured sender, so on a dev build it read like the
  user's own address.
- **localhost** came from `DASHBOARD_URL`'s fallback, which is only reached
  when neither `NEXT_PUBLIC_APP_URL` nor Vercel's production URL is set.
  Production has `NEXT_PUBLIC_APP_URL`. Nothing prevented a mis-set
  production environment from emailing a localhost link.
- **The delegation video** exists: the "Multiple Gmail accounts" walkthrough
  (Descript embed) on the home page and on
  `/use-cases/multiple-gmail-accounts`.

## 3. Decisions

### 3.1 Serialize per-owner claims with an advisory lock (option a)

Every claim now runs as one transaction: `pg_advisory_xact_lock(ns,
hashtext(user_id))`, then the UPDATE. A claim that waited takes a fresh
snapshot for its UPDATE and sees the earlier claim's stamp. The dead-grant
claim also takes a global lock (after the owner lock — fixed order, no
deadlock) so the hourly breaker across owners is exact too.

The neon-http driver has no interactive transactions; its `db.batch` form
runs the statements inside one transaction in one round trip. Verified on the
branch: two concurrent batches on the same lock finished 1 s apart with a 1 s
sleep inside; `txid_current()` matched within a batch.

Rejected: (b) a per-owner ledger with a unique day-bucket key — a rolling
window has no bucket, and it adds a table for a problem one statement solves.

### 3.2 One link reminder per owner per agent turn (option c, claim-side only)

`claimApprovalNotification` refuses when ANOTHER request of the same owner
was emailed within `NOTIFY_MIN_GAP_MS` (5 min — already the definition of
"same agent turn" for re-mints). The refused row keeps `notified_at` NULL, so
it stays eligible if the agent asks again in a later turn; the refusal
stamps `notify_status: 'skipped_burst'` on the mint. Under this rule the
09-17 pair sends one email. This does NOT batch links at mint time — PR #152's
plan (Design A) owns that; when a batch becomes one request row, this rule is
simply never hit for it.

### 3.3 Copy

- Agent label = nickname, else "your <client> agent", else "your AI agent",
  plus "on the <profile label>". The client id is compared to the stored
  client name, not guessed at. Pure module `src/lib/agentLabel.ts`, pinned in
  the copy test.
- Signature: `— FGAC support (support@fgac.ai)` from a constant, never the
  configured sender. Reply-To stays the real sender, so replies still route.
- `notifyBaseUrl`: when `VERCEL_ENV=production` and the dashboard base is a
  localhost / loopback URL, the email uses `https://fgac.ai`. Tested; the
  copy tests also assert no body ever contains `localhost` with a production
  base.
- Option 2 of the refusal email links the delegation walkthrough:
  `<base>/use-cases/multiple-gmail-accounts` (the site page hosting the video,
  so the `video_played` event still fires and the URL is ours).

## 4. Changes

| file | change |
| --- | --- |
| `src/lib/notifyClaimLock.ts` (new) | `claimSerialized(userId, claim, {global})`: owner (+ global) advisory lock, then the claim, in one `db.batch` transaction |
| `src/lib/approvalRequests.ts` | claim runs serialized; new `burst` refusal (another request of the owner emailed within `NOTIFY_MIN_GAP_MS`) |
| `src/lib/accountRefusals.ts`, `src/lib/googleGrantFailures.ts` | claims run serialized (dead-grant also under the global lock) |
| `src/lib/approvalNotify.ts` | header corrected; `skipped_burst`; base URL through `notifyBaseUrl` |
| `src/lib/approvalNotifyCopy.ts`, `src/lib/googleGrantNotifyCopy.ts` | `SUPPORT_CONTACT_ADDRESS`, `DELEGATION_HOWTO_PATH`, `notifyBaseUrl`; signature; video link; label at sentence start capitalised |
| `src/lib/agentLabel.ts` (new), `src/app/api/mcp/route.ts` | human agent label from nickname / client / profile; `clientId` and `profileLabel` carried on the approved connection |
| `scripts/test-approval-notify-copy.ts`, `scripts/test-google-grant-notify-copy.ts` | pin the new copy, the label, the base URL |
| `scripts/test-notify-claim-race.ts` (new, DB-backed) | establishes the race on the pre-fix statement shape and proves the serialized claims hold under concurrency; run manually against a branch |
| `docs/analytics.md`, `docs/monitoring.md`, capability 14 A16/A17, capability 18 A13 | new status value, expected copy |

No schema change.

## 5. Verification

- `npm run mcp:lint` (copy tests included).
- `npx tsx scripts/test-notify-claim-race.ts` on the branch DB.
- Preview deploy; capability 14 A17 reads the new copy.
- After deploy: runbook 7.30d (spam watch) should show no recipient with two
  emails in a day from a same-instant pair; `approval_link_minted` gains
  `notify_status = 'skipped_burst'` rows on multi-file turns.
