# Setup: Rules Configuration

> Extracted from `02_gmail_fine_grain_control.md` and `03_multi_email_multi_key.md`

## Prerequisites
- Setup tests `01_signup_and_credential.md` and `02_multi_account_linking.md` passed
- Profiles `QA-Agent-A`, `QA-Agent-B`, `QA-Power-Agent` exist (plus the automatic `Default Profile` and `QA First Key`)
- Both test email accounts connected (own + delegated)
- Signed in as USER_A

## How Rules Work

Rules belong to the **account** and are reusable across profiles. A rule with no
profile assignment is **global** (applies to every profile, badge **"Global"**);
a rule assigned to one or more profiles applies only there. Each profile page's
**"Gmail Rules"** card lists the rules in force for that profile — global rules
plus its own assignments. Each row shows the rule name, a type badge
(**"Read Blacklist"**, **"Send Whitelist"**, or the raw action type such as
`delete_whitelist` for the other kinds), the **"Global"** badge when applicable,
the match pattern, *"All accessible mailboxes"* or *"Scoped to <email>"*, and the
controls **"Edit"**, **"Detach"** (assigned rules only) and **"Delete"**.

There are three ways to put a rule on a profile:

1. **Quick Add** — the **"+ Quick Add 2FA Block"** button in the **"Create a rule"**
   card at the bottom of every profile page. One click seeds four **global**
   read-blacklist rules (`Block 2FA Codes`, `Block Password Resets`,
   `Block Sign In Alerts`, `Block Verification Codes`). Once the account has any
   read-blacklist rule the button is disabled and reads **"✓ 2FA Block Applied"**.
   (The "Enable sensitive-mail shield" button in the recent-connections banner
   seeds the same set.)
2. **Custom rule** — **"Create Custom Rule"** in the same **"Create a rule"** card,
   or **"+ Apply a rule"** → **"+ Create a new rule…"** from the Gmail Rules card
   header. Both open the **"Create Custom Rule"** modal with these fields:
   - **Rule Name**: Descriptive label
   - **Service**: Gmail (only option currently)
   - **Action Type**: One of `Read Blacklist (Inbound Regex)`, `Send Whitelist (Outbound To:)`, `Delete Whitelist (From:)`, `Label Blacklist (Block Email via Label)`, `Label Whitelist (Allow Only via Required Label)`
   - **Match Pattern**: A glob — `*` is the wildcard (`*@competitor.com` covers every address at that domain; `|` alternation also works). For the two label types this field becomes a **Select Label** dropdown.
   - **Apply to Email**: `All accessible emails` or a specific email
   - **Assign to Specific Keys**: One checkbox per active profile, listed by label (checkbox values are the profile/key ids). Leave all unchecked for a global rule.
   - **"Save Rule"** submits; a rejected pattern keeps the modal open with an error.
3. **Apply an existing rule** — **"+ Apply a rule"** in the Gmail Rules card header
   opens the **"Apply an existing rule"** popover: a search box, one checkbox per
   non-global rule not yet on this profile, and **"Apply"**. Global rules never
   appear there (they already apply everywhere).

> **Default Profile only:** its Gmail Rules card also shows **"Enable sending to
> anyone"**, which creates a `Send to Anyone` send-whitelist rule with pattern `*`
> assigned to the Default Profile. Do **not** click it during setup — it would make
> every send-whitelist denial assertion (capability 01) pass trivially on that
> profile. Delete the rule if a previous run left it behind.

> **Detach warning:** detaching a rule from its last profile makes it **global**
> (widens it). The inline confirm says so; cancel unless that is intended
> (see memory "QA Detach Makes Global Rule").

---

## Test 1: Apply Quick-Add 2FA Block

**Steps (via `/browser-agent`):**
1. Navigate to `http://localhost:3000/dashboard` (lands on the Default Profile page).
2. Scroll to the **"Create a rule"** card at the bottom.
3. Click the **"+ Quick Add 2FA Block"** button.
4. Wait for the page to revalidate; the button now reads **"✓ 2FA Block Applied"** and is disabled.
5. Verify the **"Gmail Rules"** card lists `Block 2FA Codes`, `Block Password Resets`, `Block Sign In Alerts` and `Block Verification Codes`, each with a **"Read Blacklist"** badge and a **"Global"** badge. Open the `QA-Agent-B` tab and confirm the same four rows appear there too.

**Expected Outcome**: Four global read_blacklist rules blocking 2FA/security content, visible on every profile.

---

## Test 2: Configure Send Whitelist

**Steps:**
1. In the **"Create a rule"** card, click **"Create Custom Rule"** to open the modal.
2. Fill in:
   - **Rule Name**: `Allow Send to Test Account`
   - **Service**: Gmail
   - **Action Type**: Select `Send Whitelist (Outbound To:)`
   - **Match Pattern**: Enter `USER_B_EMAIL` (the actual address from `.qa_test_emails.json`)
   - **Apply to Email**: All accessible emails
   - **Assign to Specific Keys**: Leave all unchecked (global)
3. Click **"Save Rule"**.
4. Verify the rule appears in the **"Gmail Rules"** card with a **"Send Whitelist"** badge, the **"Global"** badge and the correct pattern.

5. Create another send whitelist rule:
   - **Rule Name**: `Allow Send to Example`
   - **Action Type**: `Send Whitelist (Outbound To:)`
   - **Match Pattern**: `allowed@example.com`
   - Leave other fields as defaults.
6. Click **"Save Rule"**.

**Expected Outcome**: Two global send whitelist rules visible in the Gmail Rules card of every profile.

---

## Test 3: Configure Read Blacklist (Profile-Specific)

**Steps:**
1. Open the `QA-Agent-B` tab (`/dashboard/agents/qa-agent-b`) and click **"Create Custom Rule"** (or **"+ Apply a rule"** → **"+ Create a new rule…"** — same modal).
2. Fill in:
   - **Rule Name**: `Block Competitor Emails`
   - **Action Type**: `Read Blacklist (Inbound Regex)`
   - **Match Pattern**: `*@competitor.com`
   - **Apply to Email**: All accessible emails
   - **Assign to Specific Keys**: Check only **QA-Agent-B**
3. Click **"Save Rule"**.
4. Verify on the `QA-Agent-B` page: the rule row shows the **"Read Blacklist"** badge, the pattern, **no "Global" badge**, and a **"Detach"** control.
5. Open the `QA-Power-Agent` tab: the rule is **absent** from its Gmail Rules card. Click **"+ Apply a rule"** — `Block Competitor Emails` is listed as a candidate — then **"Cancel"** without applying.

**Expected Outcome**: A profile-specific read blacklist rule, in force on `QA-Agent-B` only.

---

## Test 4: Configure Global vs Profile-Specific Rules

**Steps:**
1. Create a **global rule** (no profile assignment):
   - Click **"Create Custom Rule"**
   - **Rule Name**: `Global Block Password Reset`
   - **Action Type**: `Read Blacklist (Inbound Regex)`
   - **Match Pattern**: `Password Reset|Reset your password`
   - **Assign to Specific Keys**: Leave all unchecked
   - Click **"Save Rule"**
2. Verify the rule row carries the **"Global"** badge and has **no "Detach"** control, on every profile's Gmail Rules card.
3. Compare with the rule from Test 3, which has no **"Global"** badge, shows **"Detach"**, and appears only on `QA-Agent-B`.

**Expected Outcome**: Both global and profile-scoped rules visible with distinct scope indicators.

---

## Test 5: Configure Deletion Controls

**Steps:**
1. Click **"Create Custom Rule"**.
2. Fill in:
   - **Rule Name**: `Allow Delete Spam`
   - **Action Type**: Select `Delete Whitelist (From:)`
   - **Match Pattern**: `*@spam-newsletter.com`
   - **Apply to Email**: All accessible emails
   - **Assign to Specific Keys**: Leave all unchecked (global)
3. Click **"Save Rule"**.
4. Verify the rule appears with a `delete_whitelist` badge (the card names only read/send types) and the **"Global"** badge.

**Expected Outcome**: Deletion whitelist rule configured. Only emails matching the pattern can be deleted.

---

## Verification

- [ ] Quick-add: "✓ 2FA Block Applied" shown; four global Read Blacklist rules listed
- [ ] Two global Send Whitelist rules visible (test account + example)
- [ ] Profile-specific Read Blacklist rule on `QA-Agent-B` only (no "Global" badge, "Detach" present)
- [ ] Global Read Blacklist rule visible with "Global" badge on every profile
- [ ] Delete whitelist rule visible (global)
- [ ] No `Send to Anyone` rule on any profile
- [ ] Screenshot saved as `qa_proof_setup_rules.png`

---

## Per-File Fixtures (Sheets, Docs & Slides)

Capabilities 09/17 (sheets), 19 (docs), and 21 (slides) need per-file fixtures owned by
USER_A. Record the actual ids in the local, gitignored QA state
(`test/qa-envs/*/state.json` or the run notes) — **never in these public
docs**:

- **Exposed spreadsheet**: a sheet picked at least once through the FGAC
  Google Picker (the standing QA fixture sheet qualifies). On a profile page,
  **"+ Expose a sheet"** in the **"Google Sheets Rules"** card opens the Picker
  directly.
- **Exposed document**: a Google Doc picked at least once through the FGAC
  Picker (Documents view). Create one at docs.google.com as USER_A if none
  exists, give it a title and a line of content, then pick it via
  `/dashboard/accounts` → "Add Google Doc +" (or **"+ Expose a doc"** on a
  profile page).
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
  via `/dashboard/accounts` → "Add Google Slides +" (or **"+ Expose a
  presentation"** on a profile page).
- **External (never-picked) presentation**: a Google Slides deck created
  directly at slides.google.com and NEVER picked — the negative-control fixture
  for capability 21 A6/A11/A12. Same lag caveat as the external doc.
- A fresh Neon branch resets FGAC rules but NOT Google-side drive.file
  grants — "exposed" fixtures stay granted across branches; the external doc
  and presentation must simply never be picked.
