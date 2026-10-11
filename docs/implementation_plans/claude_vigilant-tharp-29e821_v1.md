# Why are we losing users? — analysis, 2026-10-06

Question (Ken): *Why are we losing users? Have more competitive tools come out? Did
people decide FGAC.ai wasn't that useful?* Follow-up: *is Claude steering people to
plugins over connectors, so we need to repackage as a plugin?*

Data: PostHog project 343912, production only, internal/QA accounts and
`anonymous-*` distinct ids excluded. Window 2026-08-16 → 2026-10-06 (UTC). Every
number below is a one-off derivation; no governed metric existed. Named people stay out of this file
(public repo). Run the queries in §6 to see them.

## 1. Answer in one paragraph

**We are not losing existing users faster than before. We stopped gaining new ones,
abruptly, on 2026-09-26.** Directory connect starts fell from ~5/day to under 1/day
overnight, but the connects that do start still complete. So the OAuth/Clerk flow is not
broken; far fewer people are reaching the Connect button. The most likely cause is
on Anthropic's side: the new **Claude Marketplace** (launched 2026-09-23, open
submissions 2026-09-25, "shared discovery" rolling out after that) lists 911
connectors in its public sitemap and **FGAC is not one of them**. Competition
(Anthropic's own Gmail/Drive connectors) is real context but cannot explain a
one-day cliff. Its data footprint among existing users is weak and directional.

## 2. Decomposition of the loss

### Weekly cohorts by first tool call

| week (Mon) | active callers | of which new | returning | calls |
|---|---|---|---|---|
| 09-14 | 107 | 23 | 84 | 20.9k |
| 09-21 | 120 | 29 | 91 | 39.3k |
| 09-28 | 108 | **6** | **102** | 31.2k |
| 10-05 (2 days) | 78 | 1 | 77 | 10.9k |

- **Active users, 09-21 → 09-28: −12.** New arrivals fell by 23 (29 → 6) while
  returning users *rose* by 11 (91 → 102). **Acquisition explains all of the
  drop, and more.**
- Retention in week 2 holds at 52–72% across every cohort since launch (08-17
  65%, 08-24 59%, 08-31 61%, 09-07 72%, 09-14 65%, 09-21 52%). It has not changed
  enough to matter.
- **Calls, 09-21 → 09-28: −8.1k (−21%).** Two heavy accounts account for −10.8k
  between them, and both are still active. The missing new cohort accounts for −2.5k.
  The 31 callers who stopped had made only 0.9k calls the week before. The rest of
  the base grew. Weekday volume on 10-05 and 10-06 (5.2k, 5.7k) is back in the range
  of the week before the late-September spike. **The volume drop is mostly two heavy
  users coming down off a spike, not a broad pull-back.**
- Weekday active callers per day: 61–67 since 09-28, against 53–67 the week of
  09-21. **Stable.**

## 3. Acquisition: the 09-26 cliff

### The right connect-start signal (corrects 7.5)

The event sequence around every successful directory connect on 09-24 and 09-25 is:

1. an unauthenticated `initialize` from client `Anthropic` with user agent
   `python-httpx` (Anthropic's backend starting the connect),
2. within 0–2 min, `mcp_connection_created`, and
3. an authenticated `Anthropic/Toolbox` inspection.

That held for 9 of 10 starts. The unauthenticated `Anthropic/ClaudeAI` / `Claude-User`
initializes that 7.5 uses as its "attempts" proxy are **not tied to connects**. They
come from the same recurring egress fingerprints all day, with no connection after
them. They rose from ~10 to ~20/day after 09-26 while connections went to zero. That
is why the earlier reading was "attempts didn't stop, so the flow must be broken."
**That reading is retired.**

| week | connect starts (httpx probe) | completed connections | Toolbox inspections |
|---|---|---|---|
| 08-31 | 45 | 40 | 39 |
| 09-07 | 41 | 37 | 37 |
| 09-14 | 39 | 29 | 31 |
| 09-21 | 27 (all Mon–Fri) | 27 | 28 |
| 09-28 | **6** | 4 | 4 |
| 10-05 (2 d) | 1 | 1 | 1 |

From 09-26 to 10-06 there were 8 connect starts and **6 completed**, against 9 of 10
before. **Conversion is intact. Starts fell by about 85–90% in a single day.**
Sign-ups still trickle in (26 in 11 days), but 23 of those 26 first landed on the
dashboard (the website path), not on an approval link (the connector path), and only
6 connected.

### What changed on 09-26

- **Our deploys:** nothing that touches OAuth or Clerk. The 09-22..09-25 merges were
  #156/#158/#159/#160/#164. #158 changed `src/middleware.ts` for signed-in
  `/dashboard` routes only, and the connect flow never passes through those. #162's
  client-name change (d866e0f) made `mcp_connection_client_identified` fire on every
  name change, which explains its 52 → 2,690 jump. It does not affect
  `mcp_connection_created`, which still fires once per new connection row
  (`src/app/api/mcp/route.ts`). The next prod merges were 09-30 (trains). A one-day
  step with no deploy of ours behind it points outward.
- **Anthropic:** the Claude Marketplace (claude.com/marketplace) launched 2026-09-23
  as one store for connectors **and plugins**, with a "shared discovery experience"
  across Claude and Claude Code rolling out over the following weeks. The directory
  developer portal (claude.ai/directory/manage) opened to all paid users on
  2026-09-25, and new listings default to "Community". Our listing is missing:
  `https://claude.com/sitemap.xml` contains 911 `/marketplace/connectors/<slug>`
  URLs, matching the page's "All connectors — 911", and none of them is FGAC. Every
  plausible slug returns 404, while `/marketplace/connectors/gmail` returns 200.
  Competitors in the same space are listed, including Superhuman Mail, AgentMail and
  Fastmail.
- **Not verified:** whether the *in-app* claude.ai directory still shows FGAC. The
  sitemap covers claude.com only, and claude.ai needs a signed-in session. Nor do we
  know whether the listing was dropped, never migrated, or needs to be re-submitted
  through the new portal. Only the listing owner's portal view can answer that.

### Plugins vs connectors (Ken's follow-up)

The Marketplace has **separate "Top plugins" and "Top connectors" sections**.
Anthropic's publishing docs (claude.com/docs/directory/publish) call a plugin bundle
"the main thing you submit". A plugin can reference a remote MCP server, and the docs
say to submit that server as a connector as well and pair the two listings. Plugins
work in claude.ai web and Desktop under Customize → Plugins. No first-party Google
Workspace plugin exists yet.

So: **yes, package FGAC as a plugin, but as part of getting back into the
Marketplace at all.** The data does not show plugins taking our users. It shows us
missing from the surface where both plugins and connectors are now found. A plugin
(our remote MCP server plus a skill teaching agents the approval-link and multi-account
patterns), paired with the connector listing, is the submission shape the new portal
asks for.

## 4. Churn: activated accounts silent for 7+ days

Activated means ≥5 successful calls; silent means no tool call for 7+ days. There are
64 such accounts since launch.

| bucket | n | how identified |
|---|---|---|
| **Dormant, connector still installed** | 43 | last call succeeded; claude.ai still sends `initialize` in the last 7 days |
| **Removed after friction** | 9 | last call succeeded but the connector stopped initializing ≥7 days ago, and the account had hit the per-file gate (`*_not_exposed`) or a similar denial earlier |
| **Removed, no visible friction** | 4 | same, with no prior denials (2 are one-day users) |
| **Blocked by FGAC at the end** | 8 | last call was `denied_by_policy` (6: per-file gate ×5, send disabled ×1) or `error` (2) |

- **Roughly a quarter (17 of 64) plausibly left because of FGAC friction.** The
  per-file gate shows up in 14 of those 17. About two-thirds (43) are dormant: still
  installed, still opening Claude with FGAC enabled, just not calling it.
- Dead grants and scope loss: 16 of the 64 had a grant event (`google_grant_dead_*`,
  `google_token_fetch_failed`, `google_scope_missing`) at some point, mostly one or two
  events. Their timing relative to the last call was **not checked**. Only one of
  them ended on a grant-type denial (`file_grant_missing_at_google`), so this is not
  a leading driver, but it is unmeasured.

## 5. "Not useful" and competition signals

Activated before 09-22 (n = 145), segmented by usage shape:

| segment | activated | silent 7+ d | silent share | silent but connector live |
|---|---|---|---|---|
| single-mailbox Gmail, read only | 14 | 8 | **57%** | 8 |
| Sheets/Docs-first | 71 | 32 | 45% | 25 |
| single-mailbox Gmail with writes | 23 | 8 | 35% | 6 |
| raw API | 7 | 2 | 29% | 2 |
| **multi-mailbox** | 30 | 6 | **20%** | 5 |

- **Substitution footprint: weak and directional.** The users most likely to go quiet
  are those whose whole use (one mailbox, reads) is now covered by Anthropic's
  first-party Gmail connector, which added send/reply on 2026-08-18. The users who
  stay are the multi-mailbox ones, where FGAC has no first-party equivalent. With
  n = 14 this is a hint, not a finding. All 8 still have FGAC installed, which fits
  Claude choosing another connector for the task, but it also fits plain dormancy.
  Our data cannot tell the two apart.
- **The per-file gate is the loudest friction, but it does not predict silence.**
  Among Sheets/Docs-first users, gate-hitters went silent at 39% (21 of 54) against
  65% (11 of 17) for those who never hit it. Hitting the gate correlates with heavier
  use. It still appears in 14 of the 17 friction exits above, so it is worth fixing,
  but it does not explain the drop.
- **One-shot and never-activated users:** early retention is unchanged (§2), so there
  is no sign that the recent cohorts found it less useful than the launch cohort.
- **Competition** (research 2026-10-06; sources in the session): Anthropic Gmail
  send/reply and Drive management (08-18); live Docs/Sheets/Slides editing and the
  Claude for Workspace add-on (dates unverified); Google Workspace MCP developer
  previews (Gmail etc. from 05-01, Sheets from 07-13, with additions 10-01, all
  requiring the user's own OAuth client); Composio, Zapier and Pipedream (no dated
  Aug–Oct launch found). **None of these launched on or near 09-26, and none needs
  FGAC to be missing from a store in order to win.** They are the backdrop, not the
  cause.

## 6. Ranked causes

| # | cause | share of loss | confidence |
|---|---|---|---|
| 1 | **Acquisition cliff on 09-26: FGAC missing from the new Claude Marketplace / discovery surface** | all of the active-user drop; ~30% of the call drop; ~85–90% of new connects | high that discovery collapsed (starts fell, conversion held); medium on the exact mechanism (sitemap absence verified, in-app directory not) |
| 2 | Heavy-user intensity swing (2 accounts coming down off a spike) | more than the net call drop (−10.8k against −8.1k net) | high; both accounts are still active |
| 3 | FGAC friction exits (per-file gate, denials) | ~17 of 64 silent activated accounts since launch; steady background, not new | medium |
| 4 | Dormancy and possible first-party substitution for simple single-mailbox Gmail | ~43 of 64 silent are dormant; substitution is directional only | low |

## 7. Unknowns and how to settle them

1. **Listing status.** Ken: open claude.ai/directory/manage and check FGAC's listing
   state (Community / verified / unmigrated / delisted), and whether the
   listing-dashboard figure for "accounts that sent any message" dropped on 09-26.
   This one look settles cause #1.
2. **In-app directory visibility.** Ken, signed in to claude.ai: search "FGAC" and
   "Gmail" in Connectors and note FGAC's position. Compare against a screenshot from
   before 09-23 if one exists.
3. **Substitution.** We cannot see which connector Claude chose when it didn't call
   FGAC. A short in-product question to the 43 dormant accounts would answer it, but
   the no-repeat-email rule means one message, sent by Ken.
4. **The Clerk Application Logs read is no longer needed for this question.** The
   flow converts. It stays useful for the 2 of 8 post-cliff starts that did not
   complete.

## 8. Recommendations

1. **(Ken only, today; addresses cause #1) Restore the Marketplace listing, and submit
   a plugin paired with the connector.** Check the portal first. If the listing is
   missing or unmigrated, re-submit through the new portal as a **plugin bundle (the
   remote MCP server plus a skill) paired with the connector listing**. That is the
   shape the new docs ask for, and it also answers the plugin question. Success
   measure: weekly connect starts (the httpx probe, §3 query) back toward the 39–45
   baseline.
2. **(Orchestrator; addresses the misread that hid #1 for 10 days) Fix the
   monitoring.** Make 7.5's acquisition proxy the `Anthropic` / `python-httpx`
   unauthenticated initialize plus `Anthropic/Toolbox` inspections, not the
   claude.ai unauthenticated initializes. Add a PostHog alert for zero connect
   starts in 48 h. The cliff ran for 10 days under a proxy that kept saying
   "attempts are fine". Done in this branch: `docs/monitoring.md` §7.5 note.
3. **(MCP surface, nudge first; addresses cause #3) Widen `drive_tree` beyond the
   handful of flagged users.** The per-file gate appears in 14 of 17 friction exits
   and in the loudest qualitative complaint. Measure with 7.17b
   activated-then-silent ending on `*_not_exposed`, against the 8-of-64 figure above.

## 9. Queries used

Connect-start / completion series (weekly; swap `toStartOfWeek` for `toDate` to
get daily):

```sql
SELECT toStartOfWeek(timestamp,1) AS wk,
  countIf(event='connector_install_started' AND properties.client_name='Anthropic') AS connect_starts,
  countIf(event='mcp_connection_created') AS conns,
  countIf(event='mcp_client_initialize' AND properties.client_name='Anthropic/Toolbox') AS toolbox
FROM events
WHERE properties.environment='production'
  AND timestamp >= now() - INTERVAL 8 WEEK
  AND ((event='connector_install_started' AND properties.touchpoint='mcp_401'
        AND properties.reason='no_token' AND properties.client_name='Anthropic')
    OR event='mcp_connection_created'
    OR (event='mcp_client_initialize' AND properties.client_name='Anthropic/Toolbox'))
  AND coalesce(person.properties.email,'') NOT IN (/* §7 internal list */)
GROUP BY wk ORDER BY wk
```

The cohort matrix (§2), the silent-activated list (§4) and the segment table (§5) are
in the session transcript. They are person-level and stay out of the repo.
