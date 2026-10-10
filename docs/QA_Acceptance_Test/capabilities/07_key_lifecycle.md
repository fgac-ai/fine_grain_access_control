# Capability: Key Lifecycle

> Extracted from `03_multi_email_multi_key.md` §7-9

## Assertions

### A1: Revoked key immediately rejected
- Revoke a key in the dashboard, then attempt any API call with it
- **Expected**: 401 Unauthorized. Other keys unaffected.

### A2: Revoked key shows timestamp in dashboard
- Check the dashboard after revocation
- **Expected**: Key marked as "Revoked" with timestamp for auditing

### A3: Key rotation issues a new value atomically
- On a THROWAWAY profile (never the profile bound to the stored QA bearer — `npx tsx scripts/qa-mcp-token.ts check` names it), click "Rotate key" → "Confirm rotate" in the profile header. Note the old key value first (from its creation panel), and the new one from the "Key rotated" panel
- **Expected**: The panel shows the new masked key (reveal/copy work) and, for a profile with a credentials keypair, a "Download Service Account JSON" button. A REST proxy call with the OLD key (`GET /gmail/v1/users/<mailbox>/profile`) is refused 401; the same call with the new key returns 200. A temporary key minted under the profile before the rotation is refused afterwards. No native `alert`/`confirm` fires

### A4: Rotated key keeps the profile intact
- After A3, reload the profile page
- **Expected**: Same tab, same slug URL, same mailboxes, rules, and Drive setting as before; no new profile tab and no "revoked profile" entry appear (rotation updates the profile in place — it does not create a profile and revoke the old one)

### A5: Cross-user key isolation
- User B obtains/guesses User A's proxy key value
- **Expected**: Key authenticates as User A's agent, but User B cannot modify User A's rules or dashboard. Keys are opaque bearer tokens tied to the issuing user.

### A6: Cross-user dashboard isolation
- Log in as a different user
- **Expected**: No visibility into other users' keys, emails, or rules

### A7: New profile always carries at least one mailbox
- As USER_A, dashboard → "+ New profile". Without touching the checkboxes, note which mailbox is ticked; then untick it
- **Expected**: The dialog opens with USER_A's own mailbox pre-ticked (or, if that mailbox shows "Action Required: Connect Google", the first delegated mailbox). With every box unticked, "Create Key" is disabled and the dialog says to select at least one mailbox. Re-tick and create: the dialog switches to a "Profile created" panel showing the masked key (reveal/copy work), the endpoint, and a "Download Service Account JSON" button — no native `alert`/`confirm` fires. The new profile's "Gmail Account Access" card lists the ticked mailbox, and a REST proxy call with the new key against that mailbox (`GET /gmail/v1/users/<mailbox>/profile`) returns 200, not 403 "does not have access".. (The server also refuses an empty list — `agent_profile_create_failed` `reason: no_mailbox` — as a backstop the UI cannot reach; not a runner step)

### A8: A mailbox-less profile is repaired from the profile page
- Fixture (UI only — never edit `key_email_access` directly): USER_B delegates their mailbox to USER_A; USER_A creates a profile with ONLY USER_B's mailbox ticked; USER_B revokes the delegation. USER_A's profile now has no mailbox. USER_B re-delegates. (Production keys created before this assertion existed are the other real-world source of this state)
- Open that profile as USER_A
- **Expected**: The "Gmail Account Access" card says the profile has no mailbox access and lists every mailbox USER_A can reach with an **Add** button (an own mailbox with an incomplete Google grant shows the button disabled). Clicking Add attaches it without a reload: the row moves into the attached list, and the key's REST proxy call against that mailbox flips from 403 to 200. Adding a delegated mailbox records the delegation on the row — revoking that delegation again removes it from the profile (403 returns). `account_linked` fires with `via: profile_page`

### A9: Connections survive a rotation
- Fixture: a throwaway MCP connection (a fresh DCR client — NOT the stored QA bearer's connection) approved onto the A3 throwaway profile, with one successful `list_accounts` call before rotating
- Rotate the profile's key (A3), then call `list_accounts` again with that connection's unchanged bearer, and open the profile's "Connected Agents" card
- **Expected**: The call succeeds with the same accounts as before — no re-approval, no `profile_revoked` / "re-attach" state. The connection is still listed under the same profile tab. (2026-10-10 regression: rolling created a new key row and revoked the old one, so every connection on the profile was refused until re-attached. Unit coverage: `scripts/test-key-rotation.ts`)

