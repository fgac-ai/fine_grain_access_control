# Setup: Sign Up and Credential Workflow

## Prerequisites
- Dev server running at `http://localhost:3000` (or preview/production URL)
- Clerk integration configured and active
- `.qa_test_emails.json` populated (via `npm run qa:secrets`)
- The browser is signed into the Google account for `USER_A_EMAIL`

## Dependencies
- This test must be run before all other QA tests. It establishes the baseline user and validates the core sign-up flow.

## How the dashboard is organised (read before clicking)

The dashboard is built around **agent profiles**. There is no "API Keys" list any
more — **a profile IS a proxy key**. Every profile has its own page at
`/dashboard/agents/<slug>`, where `<slug>` is the profile label lower-cased with
runs of punctuation/spaces replaced by `-` (`QA-Agent-A` → `qa-agent-a`,
`Default Profile` → `default-profile`). `/dashboard` itself just redirects to the
default profile's page.

- **Every new account gets a `Default Profile` automatically** at sign-up, with
  the account's own mailbox attached. You never create it by hand.
- The **tab strip** at the top of the profiles page lists every active profile;
  the **`+ New profile`** button on its right creates one.
- Each profile page has, left column: `Google Sheets Rules`, `Google Docs
  Rules`, `Google Slides Rules`, `Gmail Rules`; right column: `Connected
  Agents`, `Gmail Account Access`, `Connect a new agent via MCP`; and a
  `Create a rule` card at the very bottom.
- The nav shows **`Agent Profiles`** (`/dashboard`) and **`Accounts`**
  (`/dashboard/accounts`) when signed in, plus the Clerk avatar. Google
  connection status and delegation live on the Accounts page.

> **Embedded-browser note:** profile creation ends in a native `window.alert`
> (key + endpoint) followed by a native `window.confirm` (offer to download a
> Service Account JSON). Native dialogs are inert in the embedded pane
> (CLAUDE.md → "Native `confirm()` in embedded pane"). Before submitting the
> create form, run once per page load via `javascript_tool`:
>
> ```js
> window.alert = () => {}; window.confirm = () => false;
> ```
>
> The profile is created server-side before either dialog fires, so a swallowed
> dialog never loses the key — the page revalidates and the new tab appears.

---

## Test 1: User Sign Up via Google SSO

**Objective**: Validate that a new user can sign up through the Web UI via Google OAuth.

**Steps (via `/browser-agent`):**
1. Navigate to `http://localhost:3000`.
2. Click **"Get Started — it's free"** (hero) or **"Sign Up"** (nav bar). Both open the Clerk sign-up modal.
3. In the Clerk modal, click **"Continue with Google"**.
4. On the Google account chooser, select the `USER_A_EMAIL` account.
5. If a Clerk OAuth consent screen appears (asking to access Fine-Grain-Access-Control on behalf of USER_A), click **"Allow"**.
6. Verify the redirect lands on `/dashboard`, which forwards to `/dashboard/agents/default-profile`. The nav bar now shows **"Agent Profiles"**, **"Accounts"**, and the user avatar; the profile header reads **"Default Profile"** with an **"● Active"** badge.

**Expected Outcome**: User is signed in, the nav shows the authenticated state, and a `Default Profile` tab already exists.

---

## Test 2: Connect Google Account for Gmail Access

**Objective**: Ensure the Google OAuth token has the required `gmail.modify` scope (and `drive.file`, which the same grant carries).

**Steps:**
1. Navigate to `http://localhost:3000/dashboard` (any profile page shows the same banner).
2. Check for the yellow **"Action Required: …"** banner above the tab strip. Its exact title names what is missing:
   - **"Action Required: Connect Google Account"** with a **"Sign in with Google"** button — no usable grant at all;
   - **"Action Required: Grant Gmail access"** or **"Action Required: Grant Google Drive file access"** with a **"Reconnect Google"** button — one scope missing.
3. **If a banner IS visible**:
   - Click its button (**"Sign in with Google"** or **"Reconnect Google"**).
   - Select the `USER_A_EMAIL` Google account.
   - Approve every requested scope on the Google consent screen (leave the Gmail and Drive checkboxes checked — both are pre-approved for the QA accounts).
   - After the redirect, verify the banner is gone.
4. **If no banner is visible**: Google access is already properly linked.
5. Navigate to `http://localhost:3000/dashboard/accounts` and verify:
   - The **"Connected Google Account"** card shows `USER_A_EMAIL` with green **`gmail.modify`** and **`drive.file`** badges (a red "… missing" badge means step 3 did not complete).
   - The **"Accessible Gmail Accounts"** card lists `USER_A_EMAIL` with a **"You"** badge and a green **"Active"** badge (not the red **"Reconnect"** badge).
6. Back on the Default Profile page, the **"Gmail Account Access"** card lists `USER_A_EMAIL` with a green **"You"** badge (a red **"Reconnect"** badge there means the grant is incomplete).

**Expected Outcome**: `USER_A_EMAIL` appears as accessible with full Google access.

---

## Test 3: Create First Profile (Proxy Key)

**Objective**: Validate profile creation and the credential display flow.

**Steps:**
1. On any profile page, apply the embedded-browser dialog override (see the note above).
2. In the tab strip, click **"+ New profile"**.
3. In the modal (headed **"Create API Key"** — a profile is a key):
   - **Key Label**: Enter `QA First Key`
   - **Email Access**: Check `USER_A_EMAIL` (it carries a green **"You"** chip; a greyed-out, struck-through row with **"Action Required: Connect Google"** means Test 2 is incomplete)
   - Click **"Create Key"**
4. In a normal browser an alert shows the proxy key value (`sk_proxy_...`), the endpoint URL (`https://gmail.fgac.ai`) and Python/Node/cURL configuration snippets, then a confirm offers a Service Account JSON download — dismiss both. In the embedded pane the override swallows them.
5. Verify a **"QA First Key"** tab now appears in the tab strip. Click it (or open `/dashboard/agents/qa-first-key`) and verify the profile page shows:
   - Header: **"QA First Key"**, **"● Active"** badge, "Created <today>", and a **"Revoke key"** button
   - **"Gmail Account Access"** card: `USER_A_EMAIL` with a **"You"** badge
   - **"Connect a new agent via MCP"** card with three rows: **"MCP endpoint for this profile"** (`…/api/mcp/qa-first-key`), **"Claude Code — run in your project directory"** (a `claude mcp add …` command), and **"Bearer token for this profile"** showing the masked key `sk_proxy_••••••••••••••••••••••••` with an eye icon (tooltip **"Reveal Key"**) and a copy icon (tooltip **"Copy to clipboard"**)
   - **"Gmail Rules"** card: *"No Gmail rules on this profile. With no rules, access is denied by default."*

**Expected Outcome**: Profile created, its key masked by default, with reveal/copy controls and mailbox access visible on the profile page.

> Labels are immutable and must produce a unique slug per account. If a
> `QA First Key` profile survives from an earlier run, the modal refuses with
> *"A profile named "QA First Key" already uses the URL slug "qa-first-key"…"* —
> reuse the existing profile after verifying its mailbox in step 5, or revoke it
> (**"Revoke key"** → **"Confirm revoke"**) and recreate.

---

## Test 4: Verify Key Obfuscation

**Steps (on the `QA First Key` profile page, "Connect a new agent via MCP" card):**
1. Confirm the **"Bearer token for this profile"** row displays `sk_proxy_••••••••••••••••••••••••` (masked).
2. Click the eye icon (**"Reveal Key"**).
3. Verify the full key is now visible (starts with `sk_proxy_`).
4. Click the eye icon again (**"Hide Key"**) to re-hide.
5. Click the copy icon (**"Copy to clipboard"**); it briefly turns into a check mark.
6. Verify the clipboard contains the full key (paste into a text field to confirm — e.g. the rule-search box behind **"+ Apply a rule"**, then cancel).

**Expected Outcome**: Key is obfuscated by default and can be toggled/copied. (There is no "Roll" control on the profile page; rotation is out of scope for setup.)

---

## Test 5: Multi-Tenant Data Isolation

**Objective**: Validate that users can only see their own data.

**Steps:**
1. Note USER_A's profile tabs (`Default Profile`, `QA First Key`) and any rules on them.
2. Sign out of the application (click the user avatar → **"Sign out"**).
3. Sign up as `USER_B_EMAIL` (via Google SSO, same flow as Test 1).
4. Navigate to the dashboard (`/dashboard` → `/dashboard/agents/default-profile`).
5. Verify:
   - The tab strip shows only USER_B's own **`Default Profile`** — no `QA First Key` tab.
   - The **"Gmail Rules"** card reads *"No Gmail rules on this profile. With no rules, access is denied by default."* and the **"Create a rule"** card's quick-add button still reads **"+ Quick Add 2FA Block"** (not "✓ 2FA Block Applied").
   - The **"Gmail Account Access"** card lists only `USER_B_EMAIL`.
   - `/dashboard/accounts` → **"Accessible Gmail Accounts"** lists only `USER_B_EMAIL`, and **"Delegations You've Granted"** reads *"You haven't delegated your mailbox to anyone."*
6. A blue **"You were signed in as … a moment ago — is that also you?"** panel may appear because USER_A just used this browser (capability 04 A10 tests it). Do **not** click **"Yes, attach …"** here — delegation is established deliberately in `02_multi_account_linking.md`. Ignore it, or click **"No, that's someone else"** (this only retires the prompt for this switch).
7. *(Optional API test)*: Use a tool like `curl` to hit `/api/rules` with USER_B's session, attempting to pass USER_A's identifiers → should return 403 or 404.

**Expected Outcome**: USER_B sees a clean slate. No cross-tenant data leakage.

---

## Verification

- [ ] USER_A signed up via Google SSO; nav shows "Agent Profiles" / "Accounts"
- [ ] Google account connected (yellow banner resolved; `gmail.modify` + `drive.file` badges green on Accounts)
- [ ] `QA First Key` profile created; its bearer token masked by default
- [ ] Reveal/copy controls work
- [ ] Multi-tenant isolation verified (USER_B sees only their own Default Profile)
- [ ] Screenshot saved as `qa_proof_setup_signup.png`
