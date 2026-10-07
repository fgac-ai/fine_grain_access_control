# Capability: Key Lifecycle

> Extracted from `03_multi_email_multi_key.md` §7-9

## Assertions

### A1: Revoked key immediately rejected
- Revoke a key in the dashboard, then attempt any API call with it
- **Expected**: 401 Unauthorized. Other keys unaffected.

### A2: Revoked key shows timestamp in dashboard
- Check the dashboard after revocation
- **Expected**: Key marked as "Revoked" with timestamp for auditing

### A3: Key rolling generates new value atomically
- Roll a key — note old value, get new value
- **Expected**: New key value generated, old key immediately stops working

### A4: Rolled key inherits permissions
- After rolling, verify email access grants and rule assignments transfer
- **Expected**: New key has same email access + rules as old key

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
