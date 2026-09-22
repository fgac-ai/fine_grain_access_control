# Setup: Rules Configuration

> Extracted from `02_gmail_fine_grain_control.md` and `03_multi_email_multi_key.md`

## Prerequisites
- Setup tests `01_signup_and_credential.md` and `02_multi_account_linking.md` passed
- Three proxy keys created (QA-Agent-A, QA-Agent-B, QA-Power-Agent)
- Both test email accounts connected (own + delegated)
- Signed in as USER_A

## How Rules Work

All rules are managed from the **"Access Rules"** section at the bottom of the dashboard. There are two ways to create rules:

1. **Quick Add** — Click `+ Quick Add 2FA Block` to apply a preset that blocks security-related emails (2FA codes, password resets, etc.)
2. **Custom Rule** — Click `Create Custom Rule` to open a modal with these fields:
   - **Rule Name**: Descriptive label
   - **Service**: Gmail (only option currently)
   - **Action Type**: One of `Read Blacklist`, `Send Whitelist`, `Delete Whitelist`, `Label Blacklist`, `Label Whitelist`
   - **Regex Pattern**: The pattern to match (or label selector for label-based rules)
   - **Apply to Email**: All emails or a specific email
   - **Assign to Specific Keys**: Check specific keys, or leave all unchecked for global

---

## Test 1: Apply Quick-Add 2FA Block

**Steps (via `/browser-agent`):**
1. Navigate to `http://localhost:3000/dashboard`.
2. Scroll to the **"Access Rules"** section.
3. Click the **"+ Quick Add 2FA Block"** button.
4. Wait for the page to reload.
5. Verify new rules appear in the Access Rules table with type "Read Blacklist".

**Expected Outcome**: One or more read_blacklist rules appear in the table blocking 2FA/security content.

---

## Test 2: Configure Send Whitelist

**Steps:**
1. Click **"Create Custom Rule"** to open the modal.
2. Fill in:
   - **Rule Name**: `Allow Send to Test Account`
   - **Service**: Gmail
   - **Action Type**: Select `Send Whitelist (Outbound To:)`
   - **Regex Pattern**: Enter `USER_B_EMAIL` (the actual email from `.qa_test_emails.json`)
   - **Apply to Email**: All accessible emails
   - **Assign to Specific Keys**: Leave all unchecked (global)
3. Click **"Save Rule"**.
4. Verify the rule appears in the table with type "Send Whitelist" and the correct pattern.

5. Create another send whitelist rule:
   - **Rule Name**: `Allow Send to Example`
   - **Regex Pattern**: `allowed@example.com`
   - Leave other fields as defaults.
6. Click **"Save Rule"**.

**Expected Outcome**: Two send whitelist rules visible in the Access Rules table.

---

## Test 3: Configure Read Blacklist (Custom)

**Steps:**
1. Click **"Create Custom Rule"**.
2. Fill in:
   - **Rule Name**: `Block Competitor Emails`
   - **Action Type**: `Read Blacklist (Inbound Regex)`
   - **Regex Pattern**: `.*@competitor\.com`
   - **Apply to Email**: All accessible emails
   - **Assign to Specific Keys**: Check only **QA-Agent-B**
3. Click **"Save Rule"**.
4. Verify the rule appears showing "Read Blacklist" type, the regex, and "🔑 1 key" in the Scope column.

**Expected Outcome**: A key-specific read blacklist rule visible with correct scope indicator.

---

## Test 4: Configure Global vs Key-Specific Rules

**Steps:**
1. Create a **global rule** (no key assignment):
   - Click **"Create Custom Rule"**
   - **Rule Name**: `Global Block Password Reset`
   - **Action Type**: `Read Blacklist (Inbound Regex)`
   - **Regex Pattern**: `Password Reset|Reset your password`
   - **Assign to Specific Keys**: Leave all unchecked
   - Click **"Save Rule"**
2. Verify the rule shows "Global (all keys)" in the Scope column.
3. Compare with the key-specific rule from Test 3 which shows "🔑 1 key".

**Expected Outcome**: Both global and key-scoped rules visible with distinct scope indicators.

---

## Test 5: Configure Deletion Controls

**Steps:**
1. Click **"Create Custom Rule"**.
2. Fill in:
   - **Rule Name**: `Allow Delete Spam`
   - **Action Type**: Select `Delete Whitelist (From:)`
   - **Regex Pattern**: `.*@spam-newsletter\.com`
   - **Apply to Email**: All accessible emails
   - **Assign to Specific Keys**: Leave all unchecked (global)
3. Click **"Save Rule"**.
4. Verify the rule appears with type "Delete Whitelist".

**Expected Outcome**: Deletion whitelist rule configured. Only emails matching the pattern can be deleted.

---

## Verification

- [ ] Quick-add 2FA block rule(s) visible in table
- [ ] Two send whitelist rules visible (test account + example)
- [ ] Key-specific read blacklist rule visible with "🔑 1 key" scope
- [ ] Global read blacklist rule visible with "Global (all keys)" scope
- [ ] Delete whitelist rule visible
- [ ] Screenshot saved as `qa_proof_setup_rules.png`

---

## Per-File Fixtures (Sheets, Docs & Slides)

Capabilities 09/17 (sheets), 19 (docs), and 21 (slides) need per-file fixtures owned by
USER_A. Record the actual ids in the local, gitignored QA state
(`test/qa-envs/*/state.json` or the run notes) — **never in these public
docs**:

- **Exposed spreadsheet**: a sheet picked at least once through the FGAC
  Google Picker (the standing QA fixture sheet qualifies).
- **Exposed document**: a Google Doc picked at least once through the FGAC
  Picker (Documents view). Create one at docs.google.com as USER_A if none
  exists, give it a title and a line of content, then pick it via
  `/dashboard/accounts` → "Add Google Doc +".
- **External (never-picked) document**: a Google Doc created directly at
  docs.google.com and NEVER picked — the negative-control fixture for
  capability 19 A6/A11/A12. If a run consumes it (by picking it), create a
  fresh one; note Google's Picker/Drive search can lag minutes behind on
  brand-new files, so create fixtures ahead of the run.
- **Exposed presentation**: a Google Slides deck picked at least once through
  the FGAC Picker (Presentations view), or created by the agent through FGAC
  (`POST drive/v3/files` with the presentation mimeType, or `POST
  v1/presentations`) — app-created files are covered by drive.file without a
  pick. Create one at slides.google.com as USER_A if none exists and pick it
  via `/dashboard/accounts` → "Add Google Slides +".
- **External (never-picked) presentation**: a Google Slides deck created
  directly at slides.google.com and NEVER picked — the negative-control fixture
  for capability 21 A6/A11/A12. Same lag caveat as the external doc.
- A fresh Neon branch resets FGAC rules but NOT Google-side drive.file
  grants — "exposed" fixtures stay granted across branches; the external doc
  and presentation must simply never be picked.
