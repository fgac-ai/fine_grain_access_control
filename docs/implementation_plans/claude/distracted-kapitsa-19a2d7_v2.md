# Listings are not refused by read rules — withhold matching snippets (v2 — preview QA)

Branch: `claude/distracted-kapitsa-19a2d7` · 2026-10-16

## Problem
`checkReadRestrictions` (src/lib/gmailRules.ts) states the policy "messages may APPEAR
in listings, but reading content must respect … content read-blacklists", but it ran
on every Gmail GET — listings included. `collectMessageContent` collects `snippet`, and
`threads.list` returns a snippet per thread, so ONE matching snippet refused the whole
listing. Observed once in production: `$mcp_tool_call` outcome `denied_by_policy`,
`raw_api_endpoint` `GET gmail/v1/users/me/threads`, 2026-10-09 ('Block Sign In Alerts',
legacy pattern since repaired). ID-only listings (`messages.list`) were also refused by
a `*` rule through the raw-serialization fallback — QA A5 relied on that.

## Paths audited
| path | listing endpoints reachable | rules applied before | after |
| --- | --- | --- | --- |
| MCP `gmail_list` | `messages.list` (ids only) | none | unchanged (nothing to withhold) |
| MCP `google_api_get` | messages / threads / drafts / history | whole-response refuse | per-entry withhold |
| REST proxy `/api/proxy` | same | whole-response refuse | per-entry withhold |
| MCP `gmail_read`, `gmail_get_attachment`, proxy attachments, thread/message GETs | none (single resources) | refuse | unchanged |
| push notifications (`notifications/process.ts`) | none (per-message metadata) | refuse (filter) | unchanged |

## Decision: (b) withhold the matching entries' content
(a) "don't apply read_blacklist to listings" would hand the agent the snippet — the
first ~200 chars of the message, i.e. the sign-in code the template rule exists to
protect. (b) keeps the stated policy literally: every entry stays (ids, threadIds,
labelIds are not content); an entry the rules would refuse to READ has `snippet`
replaced by `[content withheld by FGAC read rule '<name>']` (and any `payload`/`raw`
dropped — none today, defensive). Label rules use the same per-entry treatment, so a
labelled `history.list` record is no longer a whole-listing refusal either. Entries with
nothing to withhold are not counted (no telemetry inflation from the JSON fallback).

## Changes
- `gmailRules.ts`: `findReadRestriction` (shared core), `isGmailListingPath`,
  `redactListing`, `withheldSnippet`; `checkReadRestrictions` unchanged in behaviour.
- `mcp/route.ts` `google_api_get` + `proxy/[...path]/route.ts` step 9: listing branch.
- Telemetry: `read_restriction_redacted` {via, withheld, rule_names}; MCP prop
  `listing_entries_withheld`.
- Tests: `scripts/test-listing-read-rules.ts` (in `mcp:lint`).
- Docs: analytics.md, user_guide.md, QA capability read blacklist A5 rewritten, A8 added.

## Validation
- Unit: `test-listing-read-rules` green, full `mcp:lint` green, `tsc` clean.
- Preview `fine-grain-access-control-mzvyj2320` (commit f6fdaa7), qa-env-runner scoped to
  read blacklist A1–A8 via hosted MCP + REST proxy: **8/8 pass**, coverage check
  accounts for all in-scope assertions.
- qa-coverage-auditor round 1 challenged A4/A5/A8 on evidence depth; one targeted
  re-test supplied it:
  - A8: threads listing (MCP + REST) identical to a no-rule baseline except the one
    matching entry, whose snippet is withheld; phrase absent; four template rules
    together withheld exactly four entries (the 2026-10-09 production case).
    `messages` listings under the rule: 200, id-only, nothing withheld/counted.
  - Telemetry (PostHog, `environment = preview`): `$mcp_tool_call` outcome `success`
    with `listing_entries_withheld` 1 / 4 / 1 on the rule-matching calls, null on the
    baseline; 5 `read_restriction_redacted` events for 5 rule-matching listing calls.
  - A5 rewritten: `*` → list 200, single GET 403 (rule-named); `ZZZNOMATCH*` → both 200.
- Test messages were placed with `messages.insert` (controls From/body); only the A5
  send-whitelist probes were real sends. All QA rules deleted afterwards.

## Open
- PR not opened by the agent: `api.github.com` presented a self-signed certificate to
  this machine (in and out of the sandbox) on 2026-10-16; open it from the compare URL.
