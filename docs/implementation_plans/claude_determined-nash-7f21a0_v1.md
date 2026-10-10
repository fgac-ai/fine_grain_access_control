# Post-mortem: `drive_scope_enabled` has never fired

Branch: `claude/determined-nash-7f21a0` · Date: 2026-10-09 · Investigation only. The
product fix belongs to the separate "Fix drive_scope_enabled event never firing" task.

Every conclusion below is labelled **observed** (seen directly in code, git, plans
or PostHog), **inferred** (follows from observed facts but was not directly seen),
or **unknown**.

## 1. Root cause: the success path cannot run, because of where the card is mounted

**Class: the success path is unreachable on the happy path. It is not a race and not
an identity problem.**

- **Observed (code).** `drive_scope_enabled` is captured only inside the return-leg
  `useEffect` of `EnableDriveAccessCard` (`src/app/dashboard/EnableDriveAccessCard.tsx:43-78`).
  That effect runs only while the card is mounted.
- **Observed (code).** The parent renders the card only when the server-side render
  sees no full `drive` scope: `driveTree?.flagOn && driveTree.hasFullScope ?
  <DriveAccessCard/> : <EnableDriveAccessCard/>`
  (`src/app/dashboard/AgentProfilesView.tsx:230-247`). `hasFullScope` is
  `googleAccess.driveFull`, read from tokeninfo at render time
  (`loadDashboard.ts:182`, `googleAccess.ts:74`).
- **Inferred.** Both the server render and the client poll read the same tokeninfo.
  So when Google really grants `drive`, the return navigation
  (`…?drive_scope=1`) is rendered with the tree card, and `EnableDriveAccessCard`
  never mounts. The only time the card mounts on a return is when the scope is
  *missing*. Then the poll cannot find it either, and the effect ends in
  `drive_scope_enable_incomplete`. `drive_scope_enabled` is reachable only if
  tokeninfo flips from narrow to wide in the ~9 s between the server render and the
  poll, which is effectively never.
- **Observed (PostHog, project 343912, since 2026-09-25).**

  | signal | count |
  | --- | --- |
  | `drive_scope_enable_started` | 30, across production, previews and local |
  | `$pageview` with `drive_scope=1` in the URL (return leg reached the page) | 42 |
  | `drive_scope_enable_returned` (card mounted on return) | 5, all local or preview |
  | `drive_scope_enable_incomplete` | 4 |
  | `drive_scope_enabled` | **0, and the event name is absent from the project taxonomy** |

  Production (`fgac.ai`): 3 starts and 3 return pageviews, but **zero** `returned`
  events. So the card did not mount on any production return. Every `returned` event
  either ended in `incomplete` or (once, on localhost) stopped without a terminal
  event. That one is probably an unmount that cancelled the poll (**inferred**).
- **Observed.** `$mcp_tool_call` with `drive_tree = true`: 1 person in production
  (54 calls from 2026-10-06 02:51Z), 1 on preview (191 calls) and 2 in development.
  So the enable step works. Only the event that should record it does not.
- **Identity ruled out (observed).** The event does not exist under any person or
  distinct id. A mis-attributed capture would still appear in the taxonomy.
- **Secondary race (inferred, minor).** If something refreshes the page while the
  card is mounted and the scope arrives, the card unmounts. The effect's `cancelled`
  flag then returns before the capture. This only matters after the main defect is
  fixed: the fix should not put the capture behind a component that a refresh can
  unmount.

## 2. Which layer should have caught it, and why each missed

| layer | should it have caught this? | why it missed |
| --- | --- | --- |
| Unit / static (`scripts/test-drive-scope-gating.ts`) | Partly | **Observed.** These are source-string checks. Line 99 asserts that the card renders *only* under the flag. It pins the gate that causes the bug, but nothing models the return leg as a render sequence. **Inferred.** A string test cannot catch a "this component isn't mounted when its effect matters" defect. Catching it needs a render test of the return URL, or a live check. |
| Local QA | Yes | **Observed.** `localhost:64707`/`:3000` on 2026-10-05 had 13+2 return pageviews and 3 `returned` events, all failed or abandoned. No local run produced a successful return leg with the event. **Unknown.** Whether any local runner was asked to check the event. No local plan records it. |
| Preview QA (plan `claude_google-drive-permissions-ux-427163_v4.md`, B2) | **Yes, and it watched the bug happen** | **Observed.** B2 is recorded as PASS: "return leg → tree card within ~5 s, legacy cards gone". PostHog for that preview (`…-git-f8890e…`, 2026-10-03 14:08–20:12Z) shows 4 starts and 4 return pageviews, 0 `returned` and 0 `enabled`. Its first `drive_tree` tool call was at 14:27:58Z, inside that QA window. The draft assertion (A3) says the page shows "Confirming Google permissions…" *then* re-renders. The runner saw the tree card appear directly, which was the visible symptom that the card never mounted, and still passed it. **Inferred.** The runner judged UI end state only. A3's event list was never checked against PostHog. |
| Coverage checker / auditor | Yes, if drafts counted | **Observed.** `scripts/qa-coverage-check.ts:55-57` reads only top-level `capabilities/NN_*.md` (non-recursive, `^\d{2}_`). `drafts/22_drive_tree_access.md` is invisible to it. `integration_2026-10-06_v3.md:73` says so outright: "Draft 22 is outside the checker's inventory, so its rows live in this plan only." So no `qa-results.json` row for 22-A3 could exist, and none was required. `qa-results.json` is not committed (no git history), so earlier runs cannot be checked. **Unknown** beyond the plans. No train plan from 2026-10-01 to 10-07 lists draft-22 A3 at all. The trains ran A18, A21–A25 (the newly landed fixes), never the enable flow. |
| Capability 16 (analytics events) | Yes | **Observed.** `16_analytics_events.md` does not list any `drive_scope_*` event. The only lists are `docs/analytics.md:90` (documentation) and draft 22 A3. |
| Post-launch analytics review (`fgac-user-behavior-review`) | Yes, from the first production enable | **Observed.** Its SKILL.md has a "recent releases & impact" step but no rule that a newly shipped event must show up. It contains no mention of `drive_scope_*`. **Inferred.** A funnel with one step permanently at 0 looks like low adoption, not a defect, unless a reviewer expects a non-zero count. |
| Measurement plans | Would have mis-measured | **Observed.** `claude_wizardly-shamir-8304cf_v1.md:438-451` plans to measure the re-widen fix as `drive_scope_enabled {reenable: true}` with no preceding click, and to add a QA capability 18 assertion for that event. **Inferred.** The auto-repair would also return to a page that renders the tree card, so that measurement would have read 0. That would look like "the fix doesn't work" when the instrumentation is the problem. |

**Were event assertions verified against PostHog, or only against code? Observed:
only against code and docs.** The preview plans v4–v6 never cite a PostHog query for
`drive_scope_*`. That contrasts with `integration_2026-10-06_v3.md:56`, where A23
*was* verified with preview PostHog (`drive_tree_auto_granted=true`). The team does
check events in PostHog for some assertions, but draft-22 A3 was never in scope for
any run that did.

## 3. Was the enable flow exercised end-to-end through the return leg?

- **Observed.** Yes, on the preview on 2026-10-03 (v4 B2), and the grant really
  widened (tokeninfo lists `…/auth/drive`, and tree-tagged tool calls followed).
- **Observed.** It was *not* a fresh grant. v4 B2 says "no checkboxes, Google already
  held the grant". USER_A had consented to `drive` earlier, so consent was one screen.
  This did not cause the miss: a fresh grant also returns with the scope, so the
  server render takes the tree branch either way (**inferred**).
- **Observed.** No env override bypassed the flow. Plan v3 moved the flag to PostHog,
  and v4 ran with the PostHog flag on for USER_A. The return was a real Clerk
  reauthorize round trip, which the 4 `drive_scope=1` pageviews confirm.
- **Observed.** On 2026-10-07 (train v3, 18 A17), USER_A got `drive` back through the
  generic reconnect, not through the card. That path never involves this event.

So the flow was exercised. It was the *assertion* (the events) that went unchecked.

## 4. Process changes (proposed, none applied in this branch)

1. **Event assertions need PostHog evidence (auditor rule).** Any assertion whose
   **Expected** names an event passes only with a cited HogQL query and its result
   (host, count ≥ 1, time window), not UI observation. `qa-coverage-auditor` should
   downgrade such passes to `unverified`. This would have failed v4 B2 on the spot.
2. **Drafts are inventoried when their feature has real users.** The moment a
   flag-gated feature's flag includes anyone outside the QA accounts (`drive_tree`
   reached a production user on 2026-10-06), its draft capability must either be
   promoted or be parsed by `qa-coverage-check.ts` (e.g. a `drafts/` pass with
   `--include-drafts`, made the default once a flag has external members). Event
   assertions in a draft must be copied into capability 16 at the same time.
3. **New-event liveness check, 48 h after any deploy that adds a `capture(` name.**
   Diff the event names added since the last production deploy (grep `capture('…'`
   in the diff), then query PostHog for each. Any event at 0 while its upstream event
   (here `drive_scope_enable_started`) is above 0 is a defect, not low adoption. Add
   this to the analytics review routine's "recent releases" step and to
   `/deploy-prod`'s post-deploy checklist.
4. **Terminal-funnel sanity rule.** A funnel whose terminal step reads 0 while the
   downstream *usage* signal (`drive_tree = true` calls) is above 0 is
   contradictory. The review should check every documented funnel in
   `docs/analytics.md` this way.
5. **Design rule for return-leg instrumentation (for the fixing session).** Success
   events of an OAuth round trip must be captured somewhere that renders in *both*
   outcomes. That can be a component mounted outside the conditional, or a server
   capture when the request carries the return marker and the scope is present. It
   must never sit in a component whose own success condition unmounts it. Pin this
   with a render-level test of the return URL in both scope states.
6. **Runner prompts read the Expected literally.** A3 described an intermediate
   state ("Confirming Google permissions…") that never appeared. Runners should
   record any expected step that was skipped as a finding, even when the end state
   looks right.
7. **Measurement plans name a live baseline first.** Before a plan measures a fix
   by an event (wizardly-shamir v1 §Residual), it should cite that event's current
   non-zero count. A plan that measures by an event never seen in production should
   be challenged at review.

## Evidence queries (HogQL, read-only)

```sql
SELECT event, properties.$host AS host, count() n, uniq(person_id) people
FROM events WHERE timestamp >= toDateTime('2026-09-25')
  AND (event LIKE 'drive_scope_enable%' OR event = 'drive_scope_enabled')
GROUP BY event, host;

SELECT properties.$host AS host, count() FROM events
WHERE timestamp >= toDateTime('2026-10-01') AND event = '$pageview'
  AND properties.$current_url LIKE '%drive_scope=1%' GROUP BY host;

SELECT properties.environment, uniq(person_id), count() FROM events
WHERE timestamp >= toDateTime('2026-10-01') AND event = '$mcp_tool_call'
  AND properties.drive_tree = true GROUP BY 1;
```

Backfill note for the fixing session (**inferred**): a successful enable can be
reconstructed after the fact as a `drive_scope=1` return pageview followed by a
first `drive_tree = true` tool call by the same person.
