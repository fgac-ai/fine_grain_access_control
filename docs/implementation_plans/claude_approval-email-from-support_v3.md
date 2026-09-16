# Approval-link reminder email — revision 3: sent through FGAC's own proxy API

Branch: `claude/approval-email-from-support` · revision 3 · 2026-09-16
Replaces v1's "Sender" paragraph. Everything else in v1/v2 stands.

## Change (Ken, 2026-09-15: "use the FGAC API key/tool to send this")

The support mailbox is a normal FGAC user. It signs up, connects Google with
Gmail, and gets a proxy key on a profile with a "Send to Anyone" rule. The
reminder is then a `gmail/v1/users/me/messages/send` call to FGAC's proxy
API with that key — the same route, auth, send-rule enforcement and
`proxy_request` analytics as any customer call — invoked in-process (the
proxy route reads only the request and its path params, so no network hop
and no dependence on the deployment's public URL, which on previews points
at production). SMTP, the app password and the `nodemailer` dependency are
gone.

Env: `SUPPORT_FGAC_PROXY_KEY` (`sk_proxy_…`), `SUPPORT_SENDER_EMAIL`
(that key's mailbox; From "FGAC <…>" and Reply-To). Both absent = off.
Kill switch `APPROVAL_LINK_EMAIL=off` unchanged.

Why this is the right credential: the grant behind the key is FGAC's own
consent for FGAC's own mailbox, and the send goes through the same policy
layer users get — if the support profile ever loses its send rule the
reminder is refused with a 403 and degrades to link-only, which is the
product working as designed.

Analytics note: each reminder is one `proxy_request` row under the support
key; exclude that key (or the support address as `account_email`) from
customer usage counts. `monitoring.md` 7.23c says so.

## QA

USER_A stands in for the support mailbox locally: a profile with a Send to
Anyone rule and a key, created through the dashboard; the reminder lands
in USER_A's own inbox, sent by USER_A's own key, read through the MCP Gmail
tools. This is the QA account using FGAC as a customer would, not FGAC
using a customer's grant.

## What Ken must provision for production

1. Sign up support@fgac.ai on fgac.ai with Google, Gmail scope included.
2. Create a profile ("FGAC reminders"), attach a Send to Anyone rule,
   create a key.
3. Vercel Production env, no quotes: `SUPPORT_FGAC_PROXY_KEY=<that key>`,
   `SUPPORT_SENDER_EMAIL=support@fgac.ai`. Deploy.
