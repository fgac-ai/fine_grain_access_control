-- Move the pre-2026-09-04 "Block Sign In Alerts" template rows onto the
-- tightened pattern new template clicks already seed (applyRecommendedSecurityRules).
--
-- The old seed was the spaced phrase 'Sign In', compiled case-insensitively,
-- so it matched any mail that said "sign in" — portal invitations, timesheet
-- reminders, newsletter footers — rather than the alerts the rule is named
-- for, which say "sign-in" ("New sign-in on Mac", "Unusual sign-in activity").
-- Once enforcement started reading decoded bodies (docs/bug_reports/
-- gmail_content_rules_match_encoded_payload_not_content.md) that broad match
-- grew into weekly business-mail denials: in one inbox sweep, 8 of 14 distinct
-- messages were refused by this rule alone. Only the template seeded new rows
-- with 'sign-in'; stored rows kept 'Sign In'.
--
-- Scoped to rows the old template wrote: exact rule name, exact legacy pattern,
-- created before the tightened seed shipped. A rule its owner renamed or
-- re-patterned is left alone. Idempotent; migrations re-run on every build.
UPDATE "access_rules"
SET "regex_pattern" = 'sign-in', "updated_at" = now()
WHERE "service" = 'gmail'
  AND "action_type" = 'read_blacklist'
  AND "rule_name" = 'Block Sign In Alerts'
  AND "regex_pattern" = 'Sign In'
  AND "created_at" < '2026-09-05';
