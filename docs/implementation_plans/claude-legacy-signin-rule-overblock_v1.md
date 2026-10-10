# Legacy "Block Sign In Alerts" over-blocking — v1

## Question
Is the legacy `Sign In` read_blacklist template rule over-blocking real business
mail for production users, and what is the fix?

## Findings (labelled observed / inferred / unknown)
1. **Observed** — both reported accounts (user A, user B) hold the template rule
   with the legacy spaced pattern `Sign In`, created 08-24 and 09-01, before the
   tightened `sign-in` seed shipped (PR #114, 09-04). Matching is case-insensitive
   (`compileRulePattern` default flag `i`), so `Sign In` matches "sign in".
2. **Observed** — 14 legacy rows / 13 accounts / 12 live (one is QA USER_A). 7 rows
   hold `sign-in`. No other variants exist. List via a read-only query on
   `access_rules where regex_pattern = 'Sign In'`.
3. **Observed** — 6 of 7 external accounts ever blocked by the rule are legacy
   holders. Blocks/week: ≤5 through 09-20, 17 (wk 09-27), 16 (wk 10-04).
4. **Observed** — user B, 10-05: one sweep of 14 distinct full-format reads, 8
   refused by this rule (message-id hashes in `$mcp_tool_call`). User A: daily
   ~15:53Z metadata sweep, ~1 refusal per run.
5. **Inferred** — the refused mail is business mail, not alerts. FGAC records no
   subject or sender; reading the mail through the users' grants was ruled out
   (a user's grant is for their agent, never FGAC-initiated reads). The inference
   rests on the refusal share (57% of an inbox sweep) and on the pattern matching
   generic "sign in to …" prose.
6. **Unknown** — whether the one `sign-in` holder's 3 blocks (wk 09-27) were real
   alerts. `sign-in` can still match "sign-in sheet"/"sign-in link"; not tightened
   further here (no evidence either way).

## Directions considered
- **Repair migration — SHIPPED.** `0023_tighten_legacy_sign_in_template_rule.sql`
  rewrites rows matching exact name + exact legacy pattern + created < 2026-09-05
  to the current seed. Renamed or re-patterned rules are untouched. Idempotent.
- **Word-boundary / alert-phrase matching — REJECTED for now.** `sign-in` already
  separates the alert idiom from prose; an alternation list is a product decision
  with no false-positive data behind it. Revisit if `sign-in` holders show blocks.
- **Legacy-rule nudge in denial text — REJECTED.** After the migration no stored
  row carries the template name with the legacy pattern, so the nudge would have
  no audience. The denial already names the rule and links the dashboard.

## Validation
- `npx tsx scripts/test-rule-patterns.ts` + `npm run mcp:lint`: pass. New cases pin
  the migration target to the template seed and show legacy-vs-seed behaviour.
- `npm run db:migrate` on Neon branch `claude-legacy-signin-rule-overblock` (copy of
  main): 0022 ran; template rows went 14 `Sign In` + 7 `sign-in` → 21 `sign-in`.
- Preview (commit 74c4761): build log shows `0023_tighten_legacy_sign_in_template_rule.sql complete` against the `preview/` branch; dashboard loads with no console errors. The UI cannot show the rewrite: previews use dev Clerk, so USER_A there is a different user row from the production-copy row holding the legacy rule.

## After-measure
PostHog `read_restriction_enforced` where restriction contains
`Block Sign In Alerts`, weekly. Before: 16–17/week (weeks of 09-27, 10-04). Expect
near zero for legacy holders after the production deploy.
