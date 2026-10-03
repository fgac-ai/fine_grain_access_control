# Drive tree access behind a feature flag — plan v5 (re-check of the fixes; what is still open)

Branch: `claude/google-drive-permissions-ux-427163` · Date: 2026-10-03 · Adds to v4
(preview validation and fixes). v1 (design), v3 (PostHog flag) stand.

## Re-check on the preview (runner, commit `5a072a9`, built-in browser, USER_A)

| v4 fix | result |
| --- | --- |
| rows readable below xl | **confirmed** at 1024×768: every row's name > 0 px wide, none clipped; pill, source and control stack under the name with the 52 px indent |
| three columns from xl | **confirmed** at 1440×900 (288 / 200 / 250 px) |
| search-result paths wrap | **confirmed** ("My Drive › FGAC folder-grant probe 2026-09-17" on two lines, not clipped) |
| `list_accounts.next_steps.drive` | **confirmed**: one `drive` line, no sheets/docs/slides lines, with the owner's token wide and the flag on |
| `data-testid` hooks | **confirmed** |
| source text wrapping | **not enough**: the 2-line clamp still cut "from FGAC folder-grant probe 2026-09-17", and "default: Read everything" needed two lines in the 200 px column |
| scope-lost refusal + re-enable card | **not exercised live**: USER_A's token had not narrowed again (state 1b); code-reviewed only |

Also seen: long names ellipsize in the name column with no tooltip; the
`raw_api` sentence in `list_accounts.next_steps` still said "per-file Drive
access" next to the new folder-scoped `drive` line.

## Fixes in `8abca30`

- Effective-access cell is now pill-above, source-below: the source wraps
  freely (no clamp) in a 220 px column and carries a hover `title`.
- Name buttons/spans carry `title={name}` (hover reveals a truncated name).
- `raw_api` in `list_accounts.next_steps` describes the grant as the whole
  Drive scoped by the profile's settings when the tree model is active, else
  the per-file sentence as before.

Static checks on `8abca30`: `tsc` clean, `eslint` clean, `mcp:lint` exit 0.
Layout re-verified by the orchestrator on the rebuilt preview (FGAC UI only):
see the session hand-back for the measured source-text heights at 1440 px.

## Still open (carried to the train's QA or to Ken)

1. **Flag-off account run** (capability draft 22 A1/A2 with USER_B): blocked
   until USER_B is re-authenticated in the built-in browser (Okta wall) — USER
   ACTION REQUIRED. The engine-inactive branch was exercised with USER_A on a
   narrow token (v4), which is the same code path minus the enable card and the
   404-vs-403 on `/api/drive/*`.
2. **Scope-lost refusal and re-enable card live**: needs USER_A's token to
   narrow again (it did ~28 min after the first enable; it had not within ~25
   min of the second). Re-run the v4 step 1a when it does, or on the next QA
   pass. A clean-sign-in repro of the narrowing with `prompt=consent` is owed
   before any production beta.
3. Pre-existing on previews: denial links point at `https://fgac.ai`;
   Connected Agents shows the DCR client id for a client that sent no name.
