# Drive tree access behind a feature flag — plan v6 (flag-off path validated; PR #177)

Branch: `claude/google-drive-permissions-ux-427163` · Date: 2026-10-03 · Review PR:
https://github.com/fgac-ai/fine_grain_access_control/pull/177 (supersedes #152's plan).
Adds to v4/v5; v1 (design), v3 (PostHog flag) stand.

## Flag-off path (USER_B, PostHog flag off) — PASS on the preview (commit ec03fcb)

Ken re-authenticated USER_B in the built-in browser; the runner signed the
preview in as USER_B through Clerk's Google chooser (consent: both boxes
re-ticked; no password/Okta prompt).

| check | result |
| --- | --- |
| Default Profile page | the three legacy cards, Gmail Rules, Connected Agents, Gmail Account Access, Connect a new agent via MCP, Create a rule — production order; no Drive card, no enable card, no `drive_tree` text; `[data-testid=…]` hooks absent |
| Drive routes | `/api/drive/flag` 200 `{flagOn:false}`; `/api/drive/children` and `/api/drive/search` 404 |
| `get_my_permissions` | per-kind `sheets`/`docs`/`slides` defaults lines, no `drive` key |
| `list_accounts` | `next_steps` `sheets`/`docs`/`slides` per-file lines, no `drive` key; `raw_api` says "ONLY Gmail plus per-file Drive access" |
| `sheets_read_range` on a never-exposed sheet | 🚫 `sheets_not_exposed` with ONE `sheets_expose` link, the signed-in-as line and the IMPORTANT block, identical to production except the relay line below |
| console | no app-originated errors (the only 404s were the runner's own route probes) |

**The one deliberate, non-gated difference**, now stated in capability draft 22
A1: the "Suggested wording to relay" line reads "FGAC needs your approval for
spreadsheet <id> before I can continue: <link> — …" for every account (commit
`a31168d`, from the 2026-10-01 customer evidence that the user cannot tell which
file an approval is for). With the tree engine the same line names the file by
title in quotes. Everything else the flag-off account sees is byte-identical to
`origin/main` by diff (the per-kind and `raw_api` strings moved verbatim into
flag-conditional helpers).

## Status of every validation item

| item | state |
| --- | --- |
| new path, flag on (USER_A): consent, tree card, settings, proxy + MCP enforcement | PASS (v4) |
| layout fixes (1024 px names, three columns, wrapping, tooltips) | PASS (v5 + orchestrator DOM check on ec03fcb at 1440 px: 54 named rows with titles, no clipped source text, two-line "from <folder>" sources readable) |
| `list_accounts` copy for the tree model | PASS (v5) |
| flag-off path (USER_B) | PASS (this version) |
| scope-lost refusal + re-enable card, live | not yet observed — needs USER_A's token to narrow again; code-reviewed; a clean-sign-in repro with `prompt=consent` is owed before a production beta |
| Google verification (CASA) of the restricted scope | user action, prerequisite for a production beta beyond listed test users |

## State left on the preview
Built-in pane signed in to the preview as USER_B (Google session restored by
Ken); USER_A's grant widened; Default Profile of USER_A: Read everything, 0
overrides. Two QA DCR clients are connected agents on the two Default
Profiles (preview DB only).
