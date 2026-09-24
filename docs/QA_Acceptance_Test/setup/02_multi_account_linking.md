# Setup: Multi-Account Linking

> Extracted from `03_multi_email_multi_key.md` §1-2

## Prerequisites
- Setup test `01_signup_and_credential.md` passed (USER_A signed in; read its
  "How the dashboard is organised" section first — profiles, slugs, the
  embedded-browser dialog override)
- The browser is signed into both `USER_A_EMAIL` and `USER_B_EMAIL` Google accounts
- Read `.qa_test_emails.json` for the actual email addresses

## How Multi-Email Works

FGAC supports two paths for a profile to access multiple email accounts:

1. **Own email** — The email used to sign up with Clerk. It is always listed under
   **"Accessible Gmail Accounts"** on `/dashboard/accounts` and requires the
   dashboard's "Action Required" banner to be resolved (Google OAuth grant with the
   `gmail.modify` scope).
2. **Delegated email** — Another FGAC user grants you access from **their** Accounts
   page (**"Delegations You've Granted"** → **"Delegate Access"**). USER_B must sign
   up separately, then delegate their email to USER_A. A delegated mailbox is
   attached to the delegate's **`Default Profile` automatically**; custom profiles
   only get it when it is checked at creation time.

> **Note for browser agents:** Multi-email is NOT done by connecting two Google
> accounts in Clerk. It is done via the delegation system — two separate FGAC users
> where one delegates to the other.
>
> Since 2026-09-21 there are three one-click ways to grant it besides the typed-email
> form in Test 3 (capability 04 A9–A10, capability 14 A19): USER_A's **+ Add account**
> dialog (Accounts page) hands out a link that USER_B opens and confirms; a fresh
> sign-in as USER_B right after USER_A used this browser shows USER_B a "was that also
> you?" panel; and USER_A's approval link opened as USER_B offers the same. Any of them
> leaves the baseline in the state Test 4 expects. Because the prompt and the wall test
> both need NO active USER_B → USER_A delegation, run those capability assertions
> BEFORE Test 3, or revoke and re-grant around them.

---

## Test 1: Verify USER_A Google Connection

**Steps (via `/browser-agent`):**
1. Signed in as USER_A, navigate to `http://localhost:3000/dashboard`.
2. Check whether a yellow **"Action Required: …"** banner appears above the tab strip.
3. **If the banner IS visible**: click its button (**"Sign in with Google"** or **"Reconnect Google"**, depending on what is missing). Select the `USER_A_EMAIL` Google account from the chooser. Approve all requested scopes.
4. **If the banner is NOT visible**: Google is already connected — proceed to verification.
5. Navigate to `/dashboard/accounts` and verify the **"Connected Google Account"** card shows `USER_A_EMAIL` with green **`gmail.modify`** and **`drive.file`** badges, and **"Accessible Gmail Accounts"** lists `USER_A_EMAIL` with **"You"** + green **"Active"** (not the red **"Reconnect"** badge).

**Expected Outcome**: `USER_A_EMAIL` is shown as accessible with a green "Active" badge.

---

## Test 2: Sign Up USER_B (Separate Account)

**Steps:**
1. Sign out of FGAC (click the user avatar → **"Sign out"**).
2. Click **"Sign Up"** (nav) or **"Get Started — it's free"** (hero).
3. In the Clerk modal, click **"Continue with Google"**.
4. On the Google account chooser, select `USER_B_EMAIL`.
5. Complete OAuth consent.
6. Verify the dashboard loads at `/dashboard/agents/default-profile` with a **"Default Profile"** tab, and its **"Gmail Account Access"** card lists `USER_B_EMAIL` with a **"You"** badge.
7. If an **"Action Required: …"** banner appears, click its button and re-authorize as `USER_B_EMAIL` (same as Test 1 steps 3–5).
8. If the blue **"You were signed in as … a moment ago — is that also you?"** panel appears, leave it alone or click **"No, that's someone else"** — Test 3 establishes the delegation through the typed-email form.

**Expected Outcome**: USER_B now exists as a separate FGAC user with their own dashboard and Default Profile.

---

## Test 3: USER_B Delegates to USER_A

**Steps:**
1. While signed in as USER_B, navigate to `http://localhost:3000/dashboard/accounts`.
2. Locate the **"Delegations You've Granted"** card. Its subtitle reads: *"Let another FGAC user build agent profiles against {USER_B_EMAIL}."* and its body reads *"You haven't delegated your mailbox to anyone."*
3. Click the **"Delegate Access"** button in the card header. It turns into an inline form: an email input (its placeholder shows an example address), a **"Grant"** button and **"Cancel"**.
4. Type `USER_A_EMAIL` into the input.
5. Click **"Grant"**.
6. Verify a row appears in the card with `USER_A_EMAIL`, a green **"Active"** badge, *"since <today>"*, and a **"Revoke"** link. (An error *"No FGAC account found for …"* means USER_A has not signed up — re-run `01_signup_and_credential.md` Test 1.)

**Expected Outcome**: USER_B has delegated their email access to USER_A.

---

## Test 4: Verify USER_A Sees Delegated Email

**Steps:**
1. Sign out as USER_B (avatar → **"Sign out"**).
2. Sign in as USER_A (via Google SSO).
3. Navigate to `/dashboard/accounts`.
4. Check the **"Accessible Gmail Accounts"** card.
5. Verify it now shows:
   - `USER_A_EMAIL` — **"You"** badge + green **"Active"** badge
   - `USER_B_EMAIL` — blue **"Delegated to you"** badge, *"since <today>"*
6. Open the **"Default Profile"** tab (`/dashboard/agents/default-profile`) and verify its **"Gmail Account Access"** card lists both `USER_A_EMAIL` (**"You"**) and `USER_B_EMAIL` (**"Delegated"**) — delegated inboxes attach to the Default Profile automatically. The `QA First Key` profile from setup 01 still lists only `USER_A_EMAIL`.

**Expected Outcome**: USER_A can see both their own email and the delegated email from USER_B.

---

## Test 5: Create Multiple Profiles with Email Scoping

Three profiles with fixed labels; every capability doc refers to them by these
names (a profile is a proxy key, so "the QA-Agent-A key" means this profile's
bearer token). Apply the embedded-browser dialog override from setup 01 first.

**Steps:**
1. While signed in as USER_A, on any profile page click **"+ New profile"** in the tab strip.
2. In the **"Create API Key"** modal:
   - **Key Label**: `QA-Agent-A`
   - **Email Access**: Check only `USER_A_EMAIL` (the **"You"** row)
   - Click **"Create Key"**
3. Dismiss the alert/confirm if they appear (swallowed by the override in the embedded pane).
4. Click **"+ New profile"** again:
   - **Key Label**: `QA-Agent-B`
   - **Email Access**: Check only `USER_B_EMAIL` (the row with the **"Delegated"** chip)
   - Click **"Create Key"**
5. Click **"+ New profile"** again:
   - **Key Label**: `QA-Power-Agent`
   - **Email Access**: Check **both** `USER_A_EMAIL` and `USER_B_EMAIL`
   - Click **"Create Key"**
6. Verify the tab strip now shows `Default Profile`, `QA First Key`, `QA-Agent-A`, `QA-Agent-B`, `QA-Power-Agent`. Open each new tab (or `/dashboard/agents/qa-agent-a`, `/qa-agent-b`, `/qa-power-agent`) and check its **"Gmail Account Access"** card:
   - `QA-Agent-A` → `USER_A_EMAIL` (**You**) only
   - `QA-Agent-B` → `USER_B_EMAIL` (**Delegated**) only
   - `QA-Power-Agent` → both
7. Record each profile's bearer token (eye icon → **"Reveal Key"** in the **"Connect a new agent via MCP"** card) in the local, gitignored QA state — never in these docs.

**Expected Outcome**: Three distinct profiles exist, each reaching exactly the mailboxes checked at creation, with a distinct bearer token.

> Leftovers from an earlier run: the label check refuses a duplicate slug
> (*"A profile named "QA-Agent-B" already uses the URL slug "qa-agent-b"…"*). Reuse
> the existing profile only if step 6 confirms its mailboxes; otherwise
> **"Revoke key"** → **"Confirm revoke"** on its page and recreate it. Note a fresh
> Neon branch (`npm run db:branch`) resets profiles and rules but not Google-side
> grants.

---

## Verification

- [ ] USER_A's own email shows "You" + "Active" on Accounts
- [ ] USER_B signed up as separate user (own Default Profile)
- [ ] USER_B delegated to USER_A (row with "Active" under "Delegations You've Granted")
- [ ] USER_A sees both emails under "Accessible Gmail Accounts"; USER_B_EMAIL shows "Delegated to you"
- [ ] Three profiles created (QA-Agent-A, QA-Agent-B, QA-Power-Agent) with correct mailbox mappings
- [ ] Screenshot saved as `qa_proof_setup_multi.png`
