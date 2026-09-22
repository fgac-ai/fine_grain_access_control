# Pricing page (fake door) — v3

Branch: `claude/pricing-page-design-9dbc83` · PR #154 · supersedes v2

## What changed and why

Ken's decision (2026-09-19), replacing the v2 recommendation (trial-then-paid
at $10, Team per seat):

- **Free plan stays**, for people to try the product. Roughly: anyone using
  it **less than once a week stays free**; weekly-to-daily users should pay.
  Approximate "use" with tool calls.
- **Paid plan at $5/month or $30/year, per tool-calling account** — one
  price per person, no other meter.
- **A custom plan** for companies that need BAAs, SOC 2 and the other vendor
  paperwork, with a contact-sales button that emails `sales@fgac.ai`.
- **Nothing is billed during the initial period**, and the page must say so.

v2's cost base, usage analysis and comparables tables still apply (see that
file); this revision records the cap, the tier names, and the page.

## The Free cap: 50 successful requests a month

Production, 28 days to 2026-09-19, successful `$mcp_tool_call` per user:

| Group | Users | Calls in the period |
| --- | --- | --- |
| Active on ≤3 distinct days ("less than weekly") | 82 | median 14, p90 114 |
| Active on ≥4 distinct days ("weekly or more") | 71 | p10 58, median 196 |
| Median calls per active day | — | ~15 |
| Users at or under 25 / 50 / 100 calls | 57 / 71 / 84 of 153 | |

A cap of **50 successful requests a month** puts 71 of 153 active users
under it, almost exactly the 82 who use it less than weekly, and the weekly
users' 10th percentile (58) is already over it. At ~15 calls per active day,
50 is three or four sessions — "about one task a week" is honest copy.
Denied calls do not count (every comparable that meters calls exempts
failures; Zapier says so explicitly).

Why calls and not days: days are what we mean, but a cap the agent can hit
mid-task needs to be a number the user can see on the dashboard and the
agent can report in a refusal message. "50 requests" is that number; "4
active days" is not.

What the cap is not: it is not enforced. The launch-period notice says every
account has Pro-level access until billing starts. When billing ships, the
enforcement is a clear refusal message with an upgrade link, never a silent
drop (FAQ promises this).

## Tier names

Every comparable checked in v2 calls the custom, contract-priced tier
**Enterprise** (Composio, Zapier, Pipedream, Nango, Arcade, Auth0, Descope,
Permit, Cerbos, Lindy, Gumloop, n8n). "Business" is used only for a
mid-tier with a list price (Notion, Zapier Team, Google Workspace). For the
individual paid tier, "Pro" is the norm (Claude Pro, Google AI Pro, Zapier
Professional, Motion Pro, Bardeen Premium is the outlier). So: **Free · Pro
· Enterprise**.

## Prices on the page

| Plan | Price | CTA |
| --- | --- | --- |
| Free | $0, 50 requests/month, no card, no time limit | signed out: **Start free** (real Clerk sign-up); signed in: Go to Dashboard |
| Pro | $5/month, or $30/year ($2.50/month, "save 50%") per person, unlimited requests | **Get Pro** / **Upgrade to Pro** → fake door naming the price; "Count me in" is the willingness-to-pay signal |
| Enterprise | Custom | **Contact sales** → `mailto:sales@fgac.ai?subject=FGAC.ai Enterprise` |

Enterprise bullet list: BAA and SOC 2 for regulated teams, vendor security
review and DPA, SSO/SAML and admin controls, self-hosted gateway in your
VPC, invoicing and procurement. **These are what the tier will offer, not
what exists today** — the page is public, so Ken owns that wording. FGAC
holds a CASA Tier 2 assessment for Gmail; it holds no SOC 2 report and no
BAA template as of this revision.

`sales@fgac.ai` must exist as a mailbox or alias before merge; the repo
only references `support@fgac.ai` today.

## Events

Names and shapes unchanged from v1/v2 (`docs/analytics.md`). `plan` values
are now `free` / `pro` / `enterprise`; `pricing_variant` is `v3-2026-09`;
the Free CTA's `sign_up_started` carries `cta_location: 'pricing_free'`.
The willingness-to-pay count is `pricing_interest_submitted {plan: 'pro',
signed_in: true}`.

## What to read from the door

1. `pricing_interest_submitted {plan: 'pro', signed_in: true}` ÷ signed-in
   pricing-page views — the share of existing users who say they would pay
   $5. Break-even on v2's fixed-cost range at $5/month net ~$4.55 is ~94
   payers; today's weekly-plus pool is 71 users.
2. Monthly vs annual on those submissions — whether $30/year is the draw.
3. Signed-out `pricing_plan_clicked {plan: 'free'}` → `sign_up_completed`
   — whether a visible cap changes sign-up rate against the landing CTA.
4. `pricing_plan_clicked {plan: 'enterprise'}` — count of sales clicks; the
   mailbox is the rest of the funnel.
5. `pricing_faq_opened` by question — the objection people read first.

After four weeks: ship billing at $5 with the 50-request cap, or raise the
cap if the free/paid split lands far from the 82/71 the data predicts.

## Addendum 2026-09-20 (Ken, testing locally)

- The request number is **not shown on the page**. Free is framed as
  "occasional use — less than one task a week", Pro as "regular use — more
  than one task a week". The 50-request approximation above stays internal
  (a code constant and this document) for when enforcement is built.
- Support commitments on the cards: **Free — support within 7 days; Pro —
  support within 24 hours.**
- Removed from the cards: agent profiles, one-click approval links and
  reminders, and the rule-type list. The cards now say what the plan is
  for, which accounts it covers, and the support commitment.
- **FAQ section removed** (Ken, same session). `PricingFaq.tsx` deleted;
  `pricing_faq_opened` retired before reaching production.
- **Launch-period notice removed** from above the cards (Ken, same session).
  The Pro dialog is now the only place that says billing is not live.
- **Signed-out Pro dialog offers sign-up, not an email field** (Ken, same
  session). `sign_up_started {cta_location: 'pricing_pro'}` counts it;
  `pricing_interest_submitted` is signed-in only from here on.
- **Contact sales is a form, not a mailto** (Ken, 2026-09-21: the mailto
  did nothing visible in the desktop app's browser pane). Submissions land
  in PostHog as `pricing_interest_submitted {plan: 'enterprise'}` with team
  size, company and needs; the sales address is a fallback link inside the
  dialog. Follow-up: a server-side email to the sales mailbox via the
  support sender so leads are not PostHog-only.
- **Contact-sales form captures every field as filled** (Typeform-style;
  Ken 2026-09-21) and **emails on Send**: confirmation to the submitter with
  the sales inbox in Cc and Reply-To, from the support sender through FGAC's
  own proxy (`src/lib/salesLead.ts`, `/api/sales-lead`). Sender vars are
  Production-only, so local/preview record `sales_lead_emailed {status:
  'disabled'}`. Honeypot field drops naive bots.
