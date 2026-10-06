# Capability: Send Whitelist Enforcement

> Extracted from `02_gmail_fine_grain_control.md` §1

## Assertions

### A1: Send to whitelisted address succeeds
- Send an email to an address on the send whitelist (e.g., `USER_B_EMAIL` or `allowed@example.com`)
- **Expected**: Proxy passes the request, email sent successfully

### A2: Send to blocked address is refused with an actionable denial
- Send an email to an address NOT on the send whitelist (e.g., `blocked@untrusted.com`)
- **Expected**: Nothing is sent, and the denial names the offending recipient and
  the reason. Assert on **substance, not an exact string** — the two live shapes are
  `🚫 Unauthorized recipient. '<addr>' is not in the send whitelist.` (a whitelist
  exists, this address is not on it) and `🚫 Sending is disabled on this profile
  (no send whitelist configured). This is the safe default.` (no rules at all).
  Both carry the recipient-scoped and send-to-anyone approval links (A1)
- **Note**: this assertion previously quoted *"Unauthorized email address. Please ask
  your user to add … to the sending whitelist."*, which predates magic-link denials
  and no longer exists in the code. A QA run failed on the literal text while the
  behavior was correct — assert the recipient, the refusal, and the link, not the
  wording

### A3: get_my_permissions shows send whitelist rules
- Query the agent's permissions
- **Expected**: Send whitelist rules visible in the response

### A4: One-click "Enable sending to anyone" on the Default Profile
- On the dashboard's Default Profile Gmail Rules card, click
  "Enable sending to anyone" (shown while no all-recipients rule covers the
  profile)
- **Expected**: A single click creates a "Send to Anyone" send_whitelist rule
  (pattern `*`) assigned to the Default Profile; `gmail_send` to any address
  now succeeds on that profile; other profiles are unaffected; deleting the
  rule restores the deny-by-default posture and the button reappears

### A5: Wildcard rules can be created and re-saved through the form
- Create a custom rule with pattern `*@example.com`, then open the "Send to
  Anyone" rule (pattern `*`) from A4, click **Edit**, and click **Save Changes**
  without altering anything
- **Expected**: both saves succeed. No 500, no blank page. Regression guard for
  the 2026-04-10 → 2026-08-25 outage, where the dashboard validated the raw glob
  instead of its expansion and rejected every `*`-leading pattern — including
  the one the "Send to Anyone" button had just written
- Also check the rejection path: a pattern of `[` shows an inline "not a valid
  match pattern" message with the modal still open and the input preserved, and
  `(a+)+$` shows an inline "too complex" message. Neither returns a 500

### A6: A long paragraph is delivered intact (HTML alternative present)
- Through `gmail_send`, send `USER_B_EMAIL` a body whose first paragraph is ONE
  line of at least 300 characters (no newline inside it). Then read the
  **delivered** copy from USER_B's mailbox with `format=raw`
  (`google_api_get` on USER_B's key: `gmail/v1/users/me/messages?q=subject:...`
  then `gmail/v1/users/me/messages/{id}?format=raw`, base64url-decode `raw`).
  The sender's Sent copy is NOT evidence — Gmail stores it as submitted and
  rewrites only the outbound copy
- **Expected**: the delivered message is `multipart/alternative` with a
  `text/html` part (Gmail keeps the submitter's HTML part, re-boundaried) whose
  decoded content holds the paragraph in ONE `<p>…</p>` with no line break
  inside, and a `text/plain` part whose text is the paragraph. Gmail
  re-serialises the plain part on delivery (typically `charset="UTF-8"`, no
  transfer encoding, folded at word boundaries around 72 columns) — that
  folding is Gmail's and is NOT a failure; the phone renders the HTML part.
  Regression guard for 2026-10-05: with a text-only body, Gmail's folding was
  all the recipient had, so every message any agent sent through FGAC rendered
  ragged on phones (each wrapped line at the sender's width, the leftover
  words underneath)
