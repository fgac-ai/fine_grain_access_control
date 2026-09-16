# SecureAgent User Guide

Give your AI agents access to Gmail while keeping full control over what they can read, send, and delete.

---

## How It Works

SecureAgent sits between your AI agent and the Gmail API. Instead of handing your agent a real Google token (which gives it full access), you configure the agent to talk to SecureAgent's proxy endpoint using a **proxy key**. SecureAgent validates every request against your access rules, then fetches the real Google token behind the scenes.

```
┌────────────┐       Proxy Key        ┌──────────────┐    Real Google Token    ┌──────────────┐
│  AI Agent   │ ─────────────────────► │  SecureAgent  │ ─────────────────────► │  Gmail API   │
│ (Claude,    │   GET /gmail/v1/...    │    Proxy      │   GET /gmail/v1/...    │              │
│  GPT, etc.) │ ◄───────────────────── │               │ ◄───────────────────── │              │
└────────────┘   Filtered Response     └──────────────┘   Full Response         └──────────────┘
```

Your agent never sees or touches your real Google credentials.

---

## Quick Start (5 minutes)

### Step 1: Create Your Account

1. Go to **[fgac.ai]** (e.g., `https://fgac.ai`).
2. Click **"Get Started"**.
3. Sign in with the **Google account** whose Gmail you want agents to access.
   - This grants SecureAgent permission to read/manage Gmail on your behalf via Clerk's OAuth integration.
   - Your Google tokens are managed by Clerk — SecureAgent never stores them.

### Step 2: Create an API Key

1. From the **Dashboard**, click **"Create New Key"**.
2. Enter a descriptive label (e.g., `Claude Personal Agent`, `GPT Work Assistant`).
3. Under **Email Access**, check the email(s) this key should access:
   - Your own email is always available (green **"You"** badge).
   - Delegated emails appear with an indigo **"Delegated"** badge (see [Delegation](#delegation-access-to-other-peoples-email) below).
4. Click **"Create Key"**.
5. **Copy the key** — it looks like `sk_proxy_YOUR_KEY_HERE`.

> [!IMPORTANT]
> Save your key somewhere secure. It will be visible on the dashboard, but treat it like a password.

### Step 3: Configure Your AI Agent

Point your agent at the SecureAgent proxy instead of `googleapis.com`. Replace the base URL and use your proxy key as the Bearer token.

> **Note:** Each Google SDK uses a different parameter name to override the API base URL. Python uses `api_endpoint` (which replaces `rootUrl + servicePath`, so you must include `/gmail/v1`). Node.js uses `rootUrl` (which only replaces the domain — the SDK appends `/gmail/v1/` automatically).

#### Python (Google API Client)

```python
from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials

# Your SecureAgent proxy key (NOT a Google token)
PROXY_KEY = "sk_proxy_YOUR_KEY_HERE"

# Create a credential object with your proxy key
creds = Credentials(token=PROXY_KEY)

# Build the Gmail service, pointing at SecureAgent instead of Google.
# api_endpoint replaces rootUrl + servicePath, so include "/gmail/v1".
service = build(
    "gmail",
    "v1",
    credentials=creds,
    client_options={"api_endpoint": "https://gmail.fgac.ai/gmail/v1"}
)

# Use the Gmail API normally
results = service.users().messages().list(userId="me", maxResults=5).execute()
messages = results.get("messages", [])
for msg in messages:
    print(f"Message ID: {msg['id']}")
```

#### Node.js (Google APIs)

```javascript
const { google } = require("googleapis");

const PROXY_KEY = "sk_proxy_YOUR_KEY_HERE";

const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: PROXY_KEY });

// rootUrl replaces only the domain. The SDK appends /gmail/v1/ automatically.
const gmail = google.gmail({
  version: "v1",
  auth,
  rootUrl: "https://gmail.fgac.ai/",
});

const res = await gmail.users.messages.list({ userId: "me", maxResults: 5 });
console.log(res.data.messages);
```

#### cURL / Any HTTP Client

```bash
curl -H "Authorization: Bearer sk_proxy_YOUR_KEY_HERE" \
  "https://gmail.fgac.ai/gmail/v1/users/me/messages?maxResults=5"
```

#### Claude / LLM Tool Use

If your LLM supports tool use or function calling, configure the Gmail tool to use:
- **Base URL**: `https://gmail.fgac.ai/gmail/v1`
- **Auth Header**: `Authorization: Bearer sk_proxy_...`
- **Gmail user**: `me` (resolves to your email) or a specific email address

#### Ready-Made Agent Skills
We provide specific skill definitions for popular AI agents to handle configuration automatically. Download these from `https://fgac.ai/setup`.
- **Claude Code**: Workspace tool instructions. Place in `.claude/skills/fgac/SKILL.md`.
- **Claude Cowork**: Load directly into Claude Desktop.
- **Open Claw**: Add to your `skills/fgac/` folder with the `openclaw.json` configuration.

---

## Access Rules

Access rules let you control what your agent can do. Create them in the **"Access Rules"** section of the dashboard.

### Rule Types

| Rule Type | What It Does | Example |
|-----------|-------------|---------|
| **Read Blacklist** | Blocks agent from reading emails matching a pattern | `*2FA*` blocks all emails containing "2FA" |
| **Send Whitelist** | Only allows sending to addresses matching a pattern | `*@yourcompany.com` limits sending to company emails |
| **Label Blacklist** | Blocks agent from reading emails that have specific Gmail labels | `Highly-Confidential` blocks reading tagged emails |
| **Label Whitelist** | Only allows reading emails that have specific Gmail labels | `AI-Allowed` restricts reading to tagged emails only |
| **Sheets access** | Per-spreadsheet Read Only / Read & Write / Blocked, granted by picking the sheet in the Google Picker | Expose one budget spreadsheet, keep the rest of Drive invisible |
| **Docs access** | Per-document Read Only / Read & Write / Blocked, granted by picking the doc in the Google Picker. Read & Write on a doc permits full-document editing (the Docs API has no finer write granularity) | Let an agent append meeting notes to one running doc |

### Built-In Safeguards

These are always active — no configuration needed:

- **Permanent deletion is blocked**: `DELETE` requests to trash/emptyTrash endpoints are denied.
- **Send requires a whitelist**: If any `send_whitelist` rules exist, sending is only allowed to matching addresses. If no send rules exist, **all sending is denied by default**.
- **Don't want to whitelist one address at a time?** The Default Profile's Gmail Rules card offers a one-click **"Enable sending to anyone"** button, which creates a `Send to Anyone` rule (pattern `*`). Send denials also include a one-click approval link for the same grant, alongside the per-recipient link. Delete the rule to return to deny-by-default.

### Quick Add: 2FA Block

Click **"+ Quick Add 2FA Block"** to instantly create a rule that blocks your agent from reading emails containing 2FA verification codes, password reset links, and security notifications.

### Creating a Custom Rule

1. Click **"Create Custom Rule"**.
2. Fill in:
   - **Rule Name**: A descriptive label (e.g., `Block Sensitive Emails`)
   - **Service**: `gmail`
   - **Action Type**: `read_blacklist` or `send_whitelist`
   - **Match Pattern**: The text to match against email content (for read rules) or recipient addresses (for send rules). `*` is a wildcard: `*@acme.com` covers every address at that domain, and `*` on its own matches everything. Full regular expressions also work if you need them.
   - **Target Email** (optional): Scope the rule to a specific email. Leave blank to apply globally.
3. Click **"Create Rule"**.

### Rule Scope

- **Global rules** (not assigned to any key) apply to **all** API keys.
- **Key-specific rules** (assigned to one or more keys) only apply to those keys.

---

## Delegation: Access to Other People's Email

Delegation lets one user grant another user's AI agents access to their Gmail. This is useful when:
- A user wants an assistant (another person) to manage their email via an AI agent.
- A team lead wants to let a colleague's agent monitor their inbox.

### How Delegation Works

Each person signs up with their own Google account. The **owner** grants the **delegate** permission to create API keys that can access the owner's Gmail. Clerk manages all token refresh — the delegate never sees the owner's Google credentials.

```
Owner (user_a@example.com)              Delegate (user_b@example.com)
       │                                      │
       │  "I delegate to kenyesh2"            │
       ├──────────────────────────────────────►│
       │                                      │
       │                              Creates API key with
       │                              access to BOTH emails
       │                                      │
       │                              Agent uses key to access
       │                              user_a@example.com's Gmail
       │                              (proxy fetches owner's token)
```

### Setting Up a Delegation

**As the Owner** (the person whose email will be accessed):

1. Sign in to SecureAgent with your Google account.
2. Go to the **Dashboard**.
3. In the **"Delegation Management"** section, click **"Delegate Access"**.
4. Enter the delegate's email address (they **must** already have a SecureAgent account).
5. Click **"Grant"**.
6. The delegation is **active immediately** — no approval step needed from the delegate.

**As the Delegate** (the person whose agent will access the owner's email):

1. Sign in to SecureAgent with your own Google account.
2. Go to the **Dashboard**.
3. Under **"Accessible Gmail Accounts"**, you'll see:
   - Your own email (green **"You"** badge)
   - The delegated email (indigo **"Delegated"** badge)
4. **Your Default Profile picks up the delegated mailbox automatically** — agents
   connected on the Default Profile can read it immediately, with the same
   read-only default posture as your own mailbox (no sending, no Sheets or
   Docs, until you add rules).
5. For a **custom** API key/profile, mailbox access stays opt-in: check both
   emails under **"Email Access"** when creating the key.
6. Either way, one key serves both inboxes — no separate key per mailbox.

> [!NOTE]
> Revoking the delegation removes the mailbox from the Default Profile (and
> every other profile) immediately.

### Targeting a Specific Email in API Calls

When your key has access to multiple emails, specify which inbox to access in the Gmail API path. **You do not need separate API keys for separate emails.** A single proxy key will handle multiple delegated accounts as long as you specify the target email instead of `"me"`.

```bash
# Access your own email
curl -H "Authorization: Bearer $KEY" \
  "$PROXY/gmail/v1/users/user_b@example.com/messages"

# Access a delegated email
curl -H "Authorization: Bearer $KEY" \
  "$PROXY/gmail/v1/users/user_a@example.com/messages"

# "me" always resolves to YOUR email (the key owner's)
curl -H "Authorization: Bearer $KEY" \
  "$PROXY/gmail/v1/users/me/messages"
```

### Revoking a Delegation

The **owner** can revoke a delegation at any time:

1. Go to the **Dashboard**.
2. In **"Delegation Management"**, find the delegation.
3. Click **"Revoke"** and confirm.
4. Access is cut off **immediately** — the delegate's keys can no longer access the owner's email.

> [!NOTE]
> Revoking a delegation does not delete the delegate's API keys. The keys still work for the delegate's own email — only access to the specific delegated email is revoked.

---

## Managing API Keys

### Viewing Your Keys

All your API keys are listed in the **"API Keys"** section. Each key shows:
- **Label**: The name you gave it.
- **Key value**: The `sk_proxy_...` string your agent uses.
- **Email badges**: Which email accounts the key can access.

### Rolling a Key

Click **"Roll"** to generate a new key value while keeping the same label, email access grants, and rule assignments. The old key value immediately stops working. Use this if you suspect a key has been compromised.

### Revoking a Key

Click **"Revoke"** to permanently disable a key. Revoked keys return `401 Unauthorized` on every request.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `401 Missing or invalid Authorization header` | No `Bearer` token in request | Add `Authorization: Bearer sk_proxy_...` header |
| `401 Invalid API Key` | Key doesn't exist | Check for typos in the key value |
| `401 This API key has been revoked` | Key was revoked | Create a new key or roll the existing one |
| `403 This API key does not have access to 'email'` | Key wasn't granted access to that email | Edit the key's email access on the dashboard |
| `403 Access to 'email' has been revoked or is not delegated` | Delegation was revoked by owner | Ask the owner to re-delegate |
| `403 FGAC read rule '<name>' blocked this message` | A read rule matched (the error names the rule) | Adjust that rule on the dashboard |
| `403 Unauthorized email address` | No send whitelist matches the recipient | Add a send whitelist rule |
| `403 Could not fetch Google access token` | The email owner needs to reconnect Google | Sign out and sign back in with Google |

---

## Data Model Reference

| Concept | Description |
|---------|-------------|
| **User** | A person who signed up with their Google account |
| **Proxy Key** | A `sk_proxy_...` token your agent uses instead of a real Google token |
| **Key Email Access** | Links a key to one or more email addresses it can access |
| **Email Delegation** | Owner grants a delegate permission to create keys accessing the owner's email |
| **Access Rule** | A pattern-based filter applied to reads (blacklist) or sends (whitelist) |
| **Key Rule Assignment** | Links a rule to a specific key (unassigned rules are global) |
