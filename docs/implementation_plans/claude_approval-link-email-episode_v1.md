# Approval-link reminder email: one per owner per 14-day episode — v1

Branch: `claude/approval-link-email-episode` · 2026-10-06

## Problem

The repeat-mint reminder (`approval_link_notified`, trigger `repeat_mint`) was
guarded per LINK (`approval_requests.notified_at`), plus a 3-per-24 h cap per
person. There was no per-owner episode guard, unlike the account-refusal
(2026-09-22) and dead-grant/scope triggers. Ken's rule (2026-09-21): one
FGAC-initiated email per event, no reminder cadences.

**Before figure: owner A got 5 reminder emails in 5 days** (10-01 → 10-06; 7 in
14 days, 3 inside 24 h with the cap holding exactly). Their agent kept asking
for new Docs/Sheets (26 distinct targets in 14 d, request_access bursts of up to
17 links in 40 s). They opened one link and approved none we could see.

## Evidence (PostHog, production, external accounts, 14 d to 2026-10-06)

| | value |
|---|---|
| reminder emails / recipients | 34 / 24 |
| recipients with > 1 email | 5 (one with 7, four with 2) |
| first emails → email-sourced open of the emailed link | 24 → 5 |
| 2nd-or-later emails → email-sourced open | 10 → 1, and that one was a pair sent 13 s apart counting the same open twice |

Later emails added no conversions, so the list-every-pending-link variant
was rejected and the change is a plain one-per-episode rule.

Drive tree access (flag `drive_tree`, PR #177): owner A's agent asks for many
single files, so a folder-level setting would probably end their loop. None
of their events carry `$feature/drive_tree`, so we can't tell whether they
are targeted. Flag targeting is Ken's call. Not changed.

## Change

- `src/lib/approvalRequests.ts`: `claimApprovalNotification` refuses while any
  OTHER request of the owner has `notified_at` inside
  `APPROVAL_LINK_EPISODE_GAP_MS` (14 d). New reason `episode`. Same
  statement, same per-owner advisory lock (`claimSerialized`). The `burst`
  diagnosis still wins inside the 5-minute window.
- `src/lib/approvalNotify.ts`: `episode` → `skipped_episode`. The denial text
  and chat link are unchanged (`notifyDenialLine` returns '' for it).
- `src/lib/approvalNotifyCopy.ts`: the constant, and one body line saying this
  is the only such reminder for 14 days.
- The refusal and dead-grant episodes are separate events and do not block a
  link reminder (tested).

## Validation

- `scripts/test-notify-claim-race.ts` (branch DB): new 2b block. A link 3 d
  after another was emailed → `episode`. A 15 d quiet gap → emailed. A
  refusal email does not block. All existing checks pass.
- `scripts/test-approval-notify-copy.ts`: body line. `npm run mcp:lint` passes.
- Capability 14 (magic-link approvals) assertion text updated for
  `skipped_episode`. Re-run it on the preview.

## Measuring after

monitoring.md 7.26f. Expect zero people with more than one
`approval_link_notified` in 14 d for sends after the deploy. Compare against
34 emails / 24 recipients / 5 multi-recipients in the before window.
