# Directory connections stopped 2026-09-27 — status day 7, blocking item (v3)

Supersedes v2 §1 only; v2 §2 (Clerk Application Logs query + decision table)
and §3 (fgac.ai-hosted sign-in/consent option) stand unchanged. Written
2026-10-03 11:35Z after the 10-02 daily review relayed that the gap is
ongoing. Runbook: `docs/monitoring.md` §7.33.

## 1. Status: ongoing, day 7

| day (UTC) | 7.5 ClaudeAI unauth initializes | sign-ups (all) | connector sign-ups | connections |
|---|---|---|---|---|
| 09-26 | 16 | 3 | 1 | 1 |
| 09-27 | 21 | 1 | 0 | 0 |
| 09-28 | 20 | 5 | 0 | 0 |
| 09-29 | 21 | 4 | 0 | 0 |
| 09-30 | 24 | 1 | 1 | 1 |
| 10-01 | 20 | 3 | 1 | 1 |
| 10-02 | 17 | 2 | 0 | 0 |
| 10-03 to 11:30Z | 5 | 0 | 0 | 0 |

- Since 2026-09-26 23:51Z: 6.5 days, 2 connections. Expected at the
  09-17..26 pace of 4.7/day: ~30. **About 28 directory connections lost,
  growing ~4.7/day.** The daily review notes the 10-01 connection was a
  teammate of an existing org caller (account 20 s old at connect), so
  plausibly an invite rather than a directory discovery; the 09-30 one is
  the only clean directory connect in a week.
- Connect attempts (the 7.5 upper bound) are unchanged at 17–24/day, spread
  over 13–17 hours each day: not one stuck client.
- `clerk_auth_redirect` (§7.31, live since 10-01) shows only dashboard
  sign-in walls, nothing on the connector path, as expected: that telemetry
  lives on fgac.ai and the connector's sign-in runs on Clerk's hosts.
- No change on our side explains it (train #174 deployed 10-01 ~01:00Z;
  the 10-01 connection happened after it, the 09-30 one before it).

## 2. The blocking item (Ken)

Every check FGAC can run has passed three times (09-30, 10-01 outside-in and
in a real browser). The next fact lives only in Clerk. Until it is read,
nothing else in this plan can move:

**Clerk Dashboard → production instance → Application Logs
(`https://dashboard.clerk.com/~/application-logs`), date range 2026-09-26
00:00 UTC → now**, event filters `oauth_authorization.*`,
`oauth_token.created`, `oauth_callback.failed`, `oauth_consent.denied`,
`sign_up.*`, `sign_in.*`. Compare 09-27 onward against 09-22..25 and read
the result against the four-row decision table in v2 §2. Ten minutes;
screenshots of the per-day counts are enough for the next step.

Two outcomes lead to work on our side (portal stall → v2 §3; callback or
token failure → Clerk ticket). Two lead to Anthropic (no arrivals; tokens
issued but never used), where the write-up to send is the window, the 7.5
attempt counts, and the listing's failed-connect figure.

Also still pending: delete the DCR test application
`fgac-outage-probe-2026-09-30` (Configure → OAuth applications).

## 3. What not to do meanwhile

Do not ship v2 §3 on speculation: if Clerk shows nobody arriving, hosting
sign-in and consent on fgac.ai changes nothing for this incident. Do not
re-run §7.33 step 3 again without a new hypothesis; three green runs from
the same network and account add no information.
