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

The support address (support@fgac.ai) is a send-as ALIAS on the operator's
own Google Workspace mailbox (Ken, 2026-09-16), not a separate account, so the sender is the
operator's existing FGAC account and no sign-up is needed:

1. Signed in to fgac.ai as the operator account that owns the alias:
   "+ New profile" named `FGAC reminders`, mailbox access = that mailbox
   only (no delegated mailboxes). A profile IS its key.
2. On that profile: "+ Apply a rule" → "+ Create a new rule…" → Gmail send
   whitelist with pattern `*` (the quick-add is Default-Profile-only, and
   the Default Profile should not be the sender). "Reveal Key".
3. Vercel Production env, no quotes: `SUPPORT_FGAC_PROXY_KEY=<that key>`,
   `SUPPORT_SENDER_EMAIL=support@fgac.ai`. Deploy.
4. The message is sent by the operator mailbox's grant with `From: FGAC
   <support@fgac.ai>` and `Reply-To: support@fgac.ai`. Gmail honours a From
   that matches a configured send-as alias; if the alias were ever removed
   Gmail would silently rewrite From to the mailbox's primary address (no
   error). Check the first production reminder's headers once (7.23c shows
   the send). Replies land in the operator's inbox via the alias, as
   support mail does today.
5. The operator address is already on the internal-account exclusion list,
   so the reminders' `proxy_request` rows stay out of customer counts as
   long as the exclusion is by owner address; queries keyed on
   `proxy_key_id` should exclude the reminders profile's key too.

Key hygiene: the key can send as the operator to anyone, so it lives only
in the Vercel Production env; revoking the `FGAC reminders` profile kills
it without touching anything else.
