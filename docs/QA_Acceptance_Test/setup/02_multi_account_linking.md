# Setup: Multi-Account Linking

> Extracted from `03_multi_email_multi_key.md` §1-2

## Prerequisites
- Setup test `01_signup_and_credential.md` passed (USER_A signed in)
- Browser agent signed into both `USER_A_EMAIL` and `USER_B_EMAIL` Google accounts
- Read `.qa_test_emails.json` for the actual email addresses

## How Multi-Email Works

FGAC supports two paths for a key to access multiple email accounts:

1. **Own email** — The email used to sign up with Clerk. This is always present in the "Accessible Gmail Accounts" section. It requires the `ConnectGoogleWarning` banner to be resolved (Google OAuth grant with `gmail.modify` scope).
2. **Delegated email** — Another FGAC user grants you access via "Delegation Management". USER_B must sign up separately, then delegate their email to USER_A.

> **Note for browser agents:** Multi-email is NOT done by connecting two Google accounts in Clerk. It is done via the delegation system — two separate FGAC users where one delegates to the other.
>
> Since 2026-09-21 there are three one-click ways to grant it besides the typed-email form in Test 3 (capability 04 A9–A10, capability 14 A19): USER_A's **+ Add account** dialog hands out a link that USER_B opens and confirms; a fresh sign-in as USER_B right after USER_A used this browser shows USER_B a "was that also you?" prompt; and USER_A's approval link opened as USER_B offers the same. Any of them leaves the baseline in the state Test 4 expects. Because the prompt and the wall test both need NO active USER_B → USER_A delegation, run those capability assertions BEFORE Test 3, or revoke and re-grant around them.

---

## Test 1: Verify USER_A Google Connection

**Steps (via `/browser-agent`):**
1. Navigate to `http://localhost:3000/dashboard`.
2. Check if a yellow "Action Required: Connect Google Account" warning banner appears at the top.
3. **If the banner IS visible**: Click the **"Sign in with Google"** button inside the banner. Select the `USER_A_EMAIL` Google account from the chooser. Approve all requested scopes.
4. **If the banner is NOT visible**: Google is already connected — proceed to verification.
5. Verify the "Accessible Gmail Accounts" section shows `USER_A_EMAIL` with a green dot and "You" badge (not grayed out / struck through).

**Expected Outcome**: `USER_A_EMAIL` is shown as accessible with a green indicator.

---

## Test 2: Sign Up USER_B (Separate Account)

**Steps:**
1. Sign out of FGAC (click user avatar menu → Sign Out).
2. Click "Sign Up" or "Get Started".
3. On the Clerk sign-up modal, click **"Sign in with Google Continue with Google"**.
4. On the Google Account chooser, select `USER_B_EMAIL`.
5. Complete OAuth consent.
6. Verify the dashboard loads showing `USER_B_EMAIL` in "Accessible Gmail Accounts".
7. If the "Connect Google Account" warning banner appears, click **"Sign in with Google"** and re-authorize.

**Expected Outcome**: USER_B now exists as a separate FGAC user with their own dashboard.

---

## Test 3: USER_B Delegates to USER_A

**Steps:**
1. While signed in as USER_B, locate the **"Delegation Management"** section.
2. It shows: *"Grant other users permission to create API keys for your Gmail ({USER_B_EMAIL})."*
3. Click the **"Delegate Access"** button.
4. In the dialog, enter `USER_A_EMAIL` as the delegate.
5. Confirm the delegation.
6. Verify the delegation appears in the list with status "Active".

**Expected Outcome**: USER_B has delegated their email access to USER_A.

---

## Test 4: Verify USER_A Sees Delegated Email

**Steps:**
1. Sign out as USER_B.
2. Sign in as USER_A (via Google SSO).
3. Navigate to the dashboard.
4. Check the **"Accessible Gmail Accounts"** section.
5. Verify it now shows:
   - `USER_A_EMAIL` — green dot, "You" badge
   - `USER_B_EMAIL` — teal dot, "Delegated" badge

**Expected Outcome**: USER_A can see both their own email and the delegated email from USER_B.

---

## Test 5: Create Multiple API Keys with Email Scoping

**Steps:**
1. While signed in as USER_A, in the **"API Keys"** section, click **"Create New Key"**.
2. In the modal:
   - **Key Label**: `QA-Agent-A`
   - **Email Access**: Check only `USER_A_EMAIL`
   - Click **"Create Key"**
3. Dismiss the alert showing the key value and endpoint.
4. Click **"Create New Key"** again:
   - **Key Label**: `QA-Agent-B`
   - **Email Access**: Check only `USER_B_EMAIL`
   - Click **"Create Key"**
5. Click **"Create New Key"** again:
   - **Key Label**: `QA-Power-Agent`
   - **Email Access**: Check **both** `USER_A_EMAIL` and `USER_B_EMAIL`
   - Click **"Create Key"**

**Expected Outcome**: Three distinct proxy keys exist, each with different email access grants visible under the key label.

---

## Verification

- [ ] USER_A's own email shows green dot and "You" badge
- [ ] USER_B signed up as separate user
- [ ] USER_B delegated to USER_A (visible in Delegation Management)
- [ ] USER_A sees both emails in "Accessible Gmail Accounts"
- [ ] Three proxy keys created with correct email mappings
- [ ] Screenshot saved as `qa_proof_setup_multi.png`
