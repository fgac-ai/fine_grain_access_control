# Profiles can no longer be created mailbox-less — v1

Branch: `claude/profile-mailbox-required` · Found during PR #185 preview QA (2026-10-05)

## Problem

The dashboard's "+ New profile" dialog (`src/app/dashboard/KeyControls.tsx`) rendered every
mailbox checkbox **unticked**, and `createProxyKey` (`src/app/dashboard/actions.ts`) accepted
an empty `emails` list. A user who typed a label and pressed "Create Key" got a proxy key with
no `key_email_access` row:

- every REST proxy call returns 403 "This API key does not have access to '<account>'";
- the MCP endpoint for that profile can reach no mailbox;
- the profile page's "Gmail Account Access" card says "This profile has no mailbox access" and
  "Mailboxes are chosen when a profile is created" — there was no way to repair it short of
  creating another profile.

Separately, success was reported with a native `window.alert` carrying the full key followed by
a `window.confirm` offering the Service Account JSON. Native dialogs are inert in the Claude
desktop pane (see the native-confirm memory) and a modal alert is a poor place to show a secret.

## Decision

Do all three — each closes a different hole:

1. **Default + require at creation.** The user's own mailbox is pre-ticked when it is linked
   (`hasCompleteGoogleAccess !== false`); if it is not, the first delegated mailbox is pre-ticked
   instead. "Create Key" is disabled until at least one box is ticked, and the dialog says why.
   `createProxyKey` refuses an empty list server-side (returned as a value, telemetry reason
   `no_mailbox`) so a crafted form post cannot recreate the dead key.
2. **Repair on the profile page.** The "Gmail Account Access" card lists mailboxes the user can
   reach but the profile does not have, each with an **Add** button, backed by a new server
   action `addMailboxToProfile(keyId, email)`. Same authorization as creation: own address, or an
   ACTIVE delegation (recorded on the row so revocation tears it down). Ownership of the key and
   non-revoked status are checked; adding an address already present is a no-op. This also
   repairs every dead key that already exists in production. Removal is deliberately out of scope
   (it would reopen the "dead key" state; revoke the profile instead).
3. **In-dialog success panel** replaces alert + confirm: key (masked, reveal/copy), endpoint, and
   a secondary "Download Service Account JSON" button.

Shared resolution of "may this user attach this address" is factored into
`resolveMailboxGrant` in `actions.ts` so creation and repair cannot drift.

## Telemetry

- `agent_profile_create_failed.reason` gains `no_mailbox` (should be ~0 — only a crafted post).
- `account_linked.via` gains `profile_page` (the repair path); `create_key` unchanged.

Docs: `docs/analytics.md` rows updated.

## QA

New capability assertions in `docs/QA_Acceptance_Test/capabilities/07_key_lifecycle.md`:

- **A7** — New-profile dialog pre-ticks a mailbox and refuses zero mailboxes.
- **A8** — A mailbox-less profile can be repaired from the profile page and the key then works.

A8 needs a mailbox-less key; since the UI can no longer create one, the fixture is a key created
before this change (unmeasured in production) or — on a local/preview branch — a profile whose only
mailbox was a delegation that has since been revoked (revocation deletes the rows). Do NOT
insert/delete `key_email_access` rows directly (Database Rule 7).

## Validation log

- **Static**: `tsc --noEmit` and eslint clean on the three changed files.
- **Local** (dev server, isolated Neon branch, Path B Chrome): A7 PASS — own mailbox pre-ticked,
  Create Key disabled with none ticked plus the inline note, "Profile created" panel with zero
  `alert`/`confirm` calls, new key 200 on the ticked mailbox / 403 on the unticked one. A8
  BLOCKED locally: the Path B Chrome profile hit USER_B's Okta wall and then a Google password
  challenge for USER_A (no password typed).
- **Preview** (commit c4b0d65, built-in browser, no Path B): A7 PASS (same evidence). A8 PASS —
  fixture built through the UI (USER_B-only profile → delegation revoked → re-delegated): the
  card showed the "no mailbox access" empty state with Add on both reachable mailboxes. Add on
  each flipped its REST call 403→200 without a reload. Revoking the delegation again after the
  Add flipped it back to 403 and removed the mailbox from the card, which proves the delegation
  id is recorded on the added row. QA profiles revoked and the delegation restored afterwards.
- **PostHog**: two `account_linked` `via: profile_page` events (delegated true/false) at
  2026-10-06 02:25Z, matching the two preview Add clicks.
- **Coverage audit**: findings addressed. The `account_linked` clause was confirmed via PostHog
  above, and the revoke-after-Add attachment came from the Add click. The disabled-Add branch for
  an own mailbox with an incomplete Google grant was not exercised (conditional, no fixture).

## Sizing (PostHog, 90 days to 2026-10-06)

Excluding internal/QA accounts and localhost, one external person created a non-default profile
in 90 days, and it had a mailbox. Every mailbox-less `agent_profile_created` in the window came
from our own accounts (3 profiles, 2 people). The fix is preventive. Keys created before the
event existed, and profiles whose only delegated mailbox was revoked, are not counted here.
