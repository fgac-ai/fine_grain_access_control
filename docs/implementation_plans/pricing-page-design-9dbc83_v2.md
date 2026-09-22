# Pricing strategy and fake-door page — v2

Branch: `claude/pricing-page-design-9dbc83` · PR #154 · supersedes v1

## Why v2

Ken's review of v1 (2026-09-18):

1. A free tier that keeps 93% of users free does not recoup the fixed costs:
   the annual third-party security review, the Claude subscription used to
   build and run the product, and hosting.
2. No comparable-product pricing was checked.
3. "Up to 5 Google accounts" is a bad mechanic. It bills the *delegate* for
   something the *owner* initiates, double-charges a household, and needs a
   counting rule nobody can explain in one sentence.

All three are right. v2 starts from the cost base and the market, and picks
the mechanic last.

## 1. What it costs to run FGAC

Measured 2026-09-18 (`~/.claude/fgac-usage-budget.sh`, memory, Vercel/Neon
dashboards) unless marked *assumed*.

| Line | Amount | Basis |
| --- | --- | --- |
| CASA Tier 2 assessment (Gmail restricted scope, annual) | $540–1,800 / yr | 2026 lab quotes: TAC $540–1,800, Leviathan $800–1,200, Bishop Fox $1,500+ |
| Vercel Pro | $240 / yr | $20/mo platform fee; Sep usage projected $12.53, inside the $20 credit |
| Neon Launch | ~$250 / yr | Sep projected $20.64 (117 CU-h so far, 9 branches, storage negligible) |
| Claude subscription (build + operate) | *assumed* $1,200–2,400 / yr | Max plan at $100 or $200/mo — Ken to confirm |
| Clerk | $0 today | free tier to 10k MAU; Pro $300/yr only if a paid feature is needed |
| PostHog, Cloudflare DNS, domain, 1Password | ~$100 / yr | free tiers plus registrar |
| **Fixed total** | **≈ $2,300–5,100 / yr** | **≈ $200–425 / mo** |

Variable cost per active user is noise: Vercel usage plus Neon compute is
about $33/mo across ~170 monthly active users, roughly **$0.20 per active user
per month**. The business is fixed-cost. Break-even is a *count of paying
users*, not a usage number.

| Price | Net after Stripe (2.9% + $0.30) | Paying users to cover $425/mo |
| --- | --- | --- |
| $5/mo | $4.55 | 94 |
| $8/mo | $7.47 | 57 |
| $10/mo | $9.41 | 46 |
| $12/mo | $11.35 | 38 |
| $15/mo | $14.27 | 30 |
| $20/mo | $19.12 | 23 |

## 2. What our users actually do (production, 28 days to 2026-09-18)

| Measure | Value |
| --- | --- |
| Active users (≥1 successful tool call) | 153 |
| Monthly active users, Aug / Sep-to-date | 188 / 171 |
| Sign-ups, Aug / Sep-to-date | 185 / 102 |
| Active in 2+ of the last 4 weeks | 96 (63%) |
| Active in 3+ of the last 4 weeks | 51 (33%) |
| Performed at least one write (send, append, edit) | 106 (69%) |
| Sheets/Docs only · Gmail only · both | 51 · 26 · 52 |
| ≤100 successful calls in the period | 84 (55%) |
| ≤250 successful calls | 119 (78%) |
| Reach ≥2 Google accounts through the proxy | 20 (13%) |
| Client mix (users) | claude.ai connectors 129, Claude Code 15, other ~14 |

Three things follow. Writes and Sheets/Docs are the *majority* behaviour, so
gating either behind paid would hit two thirds of users, not a premium
minority. A third of users come back three weeks out of four, which is the
pool that would convert at all. And 84% of active users arrive through
claude.ai connectors, which require a paid Claude plan, so every one of them
already pays $20+/mo for the assistant FGAC is attached to.

## 3. Comparables (vendor pricing pages, checked 2026-09-18)

### 3a. Products between agents and SaaS/Google APIs

| Product | Free | First paid | Price axis |
| --- | --- | --- | --- |
| Composio | 100k tool calls/mo, unlimited connected accounts | Scale $29/mo flat incl. $29 usage credit, $0.30 per extra 1k calls | per tool call |
| Zapier (+ Zapier MCP) | 100 tasks/mo; an MCP call costs 2 tasks | Pro $19.99/mo annual ($29.99 monthly) = 750 tasks | per task |
| Arcade.dev | 2k auth events + 2k tool calls/mo | Team $25/mo + $0.01/call + $0.10/auth event | per call + auth event |
| Smithery (now Arcade) | 50k RPCs/mo | $10/mo credit, then $0.10 per 1k RPCs | per call |
| Pipedream | 100 credits, **3 connected accounts** | Basic $29/mo, 5 accounts; Advanced $49 unlimited | credits + connections |
| Nango | 10 connections | $50/mo base + **$0.29/connection/mo** | per connection |
| Merge.dev | 3 linked accounts | Launch $650/mo, $65 per linked account after 10 | per linked account |
| Auth0 Token Vault | 2 vault connections | AI-agent add-on = +50% of base plan | MAU + percentage |
| Descope | 2k monthly active consents | Pro from $249/mo | MAU + consents |
| Make | 1k credits/mo | Core $12/mo | per operation |
| n8n cloud | trial only | Starter €20/mo | per execution |
| Lindy | trial only (free plan dropped 2026) | Plus $29.99/user/mo | per seat + credits |
| Gumloop | trial only (free plan dropped 2026-07) | Pro from $37/mo | credits |
| Rube (Composio consumer) | — | **discontinued 2026-05** | — |
| Relay.app | — | **shutting down 2026-09** | — |

Sources: composio.dev/pricing, zapier.com/pricing + docs.zapier.com/mcp/overview/usage,
arcade.dev/pricing, smithery.ai/pricing, pipedream.com/pricing, nango.dev/pricing,
merge.dev/pricing, auth0.com/ai/pricing, descope.com/pricing, make.com/en/pricing,
n8n.io/pricing, lindy.ai/pricing, gumloop.com/pricing, rube.app, relay.app.

What the table says:

- The dominant axis is **per tool call or a flat fee with a usage credit**, at
  **$19–29/mo** for an individual. Seats appear only where the product is an
  app people sit in (Lindy, Oso).
- **Nobody gates write or send actions behind paid.** Paid unlocks breadth:
  premium apps, production use, SSO.
- **Per-connected-account pricing exists only in B2B developer platforms**
  (Nango, Merge, Pipedream Connect, Paragon), where the "account" is the
  developer's end customer, and it is the free-tier lever there. No consumer
  product does it. v1's "up to 5 accounts" imported a B2B meter into a
  consumer plan.
- **The consumer end of this category is dying, not maturing**: Rube gone,
  Relay gone, Lindy and Gumloop dropped free tiers, Klavis pivoted. What
  survives is either trial-then-paid or rides a developer plan.

### 3b. What FGAC's buyer already pays for

| Product | Free | Individual paid | Axis |
| --- | --- | --- | --- |
| Claude | yes | Pro $20/mo ($17 annual); Max $100–200 | flat per person |
| ChatGPT | yes | Go $8, Plus $20 | flat per person |
| Google AI Pro (Gemini in Gmail/Docs/Sheets) | base Gemini | $19.99/mo, shareable with 5 | flat, family-shareable |
| Microsoft 365 Premium (Copilot) | Copilot chat | $19.99/mo; Family $12.99 for 6 (AI owner-only) | flat per person |
| Superhuman | trial only | $25–30/mo | per seat |
| Shortwave | thin free | $24–30/seat/mo | per seat + AI tier |
| Fyxer | 7-day trial only | $22.50–30/user/mo (unlimited inboxes per seat) | per user |
| Reclaim.ai | free Lite | $10–12/seat/mo | per seat |
| Bardeen | 100 credits | $10/mo | credits |
| Motion | 7-day trial, card required | $19–29/seat/mo | per seat + credits |
| 1Password | **no free tier**, 14-day trial | $2.99–3.99/mo; Families $4.49 for 5 | flat per person / household |
| Proton Mail | thin free (1 GB) | Plus $3.99–4.99/mo; Duo $14.99; Family $23.99 | flat; bundles |
| Tailscale | free personal (6 users) | $8/user/mo on admin features | per user |
| ngrok | free with interstitial | Hobbyist $10/mo | flat + usage |

Sources: claude.com/pricing, chatgpt.com/pricing, one.google.com/about/ai-premium,
microsoft.com/en-us/microsoft-365/buy/compare-all-microsoft-365-products,
superhuman.com/pricing, shortwave.com/pricing, fyxer.com/pricing, reclaim.ai/pricing,
bardeen.ai/pricing, usemotion.com/pricing, 1password.com/personal-pricing,
proton.me/mail/pricing, tailscale.com/pricing, ngrok.com/pricing.

What this table says:

- **Anything that touches a real inbox with AI sells at $20–30/mo.** Our
  users already pay that to Claude, ChatGPT or Google for the agent itself.
- **The add-on band for a security or utility subscription is $3–10/mo**
  (1Password, Proton Mail Plus, ngrok Hobbyist, Reclaim, Bardeen). A
  permission layer is bought the way 1Password is bought.
- **Trial-then-paid is normal for this buyer**: Superhuman, Fyxer, Lindy,
  Motion, 1Password. Where a permanent free tier exists it is deliberately
  thin (Proton 1 GB) or monetises admins, not individuals (Tailscale,
  Cloudflare).
- **Household pricing is ~1.5× the individual price for 5–6 people**
  (1Password Families, Proton Family, Microsoft Family), and it is the
  household plan, not a per-member meter, that covers "my partner's inbox".
- Annual discounts run 15–25%.

## 4. The mechanic

### What was wrong with v1

Per-account pricing charges the delegate for a grant the owner makes, so the
person who pays is not the person who acted. A household of three with one
agent is billed as "3 accounts" on one person. And the counting rule
("linked plus delegated, active ones only?") cannot be stated in one
sentence, which is the test a consumer price must pass. It was a B2B meter
(Nango, Merge) transplanted into a consumer product.

### Options considered

| Mechanic | Example | Break-even at ~$425/mo fixed | Verdict |
| --- | --- | --- | --- |
| A. **Trial, then one flat plan** | 1Password, Superhuman, Fyxer | 46 payers at $10 | **Recommended** — one sentence, no meter, every returning user is a prospect |
| B. Thin free tier (e.g. 100 requests/mo) + flat paid | Zapier, Proton, Make | 46 payers at $10, but the free tier is a permanent competitor for the returning third | Viable fallback; "request" needs explaining, and denied vs successful calls invites disputes |
| C. Free personal, paid team only | Tailscale, Cloudflare | never on individuals; needs ~28 paid seats | Rejected — Ken's constraint: fixed costs must be recouped |
| D. Per account / per delegation | Nango, Merge (B2B only) | — | Rejected — see above |
| E. Per tool call with credits | Composio, Arcade | 46 payers, plus budget anxiety on calls the user never sees | Rejected for consumers; keep as a Team/Enterprise overage later if ever needed |

### Recommendation

**One Personal plan at $10/month ($8/month billed yearly, $96), everything
included, after a 30-day free trial. No permanent free tier on the hosted
service. Team $15/user/month ($12 yearly). Enterprise per contract.
Self-hosting stays free for personal use under the repo licence.**

Why each number:

- **$10** is the top of the add-on band our buyer already accepts for
  security utilities (1Password $3.99, Proton $4.99, ngrok/Reclaim/Bardeen
  $10) and half the $20 they pay for the agent. It is below the $19–29
  developer-platform band because 84% of our users are claude.ai consumers,
  not developers. The one survey answer that called $10 "too expensive" came
  from a student in May, before the product worked; it is one data point and
  the fake door is how we get more.
- **$8 annual (20% off)** matches the 15–25% norm and gives the page a second
  price to measure.
- **30-day trial, not 7 or 14**: a third of our users are active in 3 of 4
  weeks, and that habit forms over the whole month because agents run in
  bursts. A 14-day wall lands before the value does.
- **No card at sign-up**: keeps the connector-directory funnel exactly as it
  is today. The wall appears at day 30, in the dashboard and by email.
- **Team $15/user** is the low end of B2B security tooling (Slack $8.75,
  Notion Business $20, Oso $15/user) and carries the commercial licence the
  repo already requires of businesses. Seats, not accounts: a seat can
  connect as many of its own inboxes as it likes; delegation between seats
  is free because both people are paying.
- **Household**: not a separate plan yet. A Personal subscriber can still
  delegate to and from anyone; if the fake door shows household demand
  (`team_size` = "2–5" on Team clicks), add a Family plan at ~1.5× ($15 for
  up to 5), which is the market norm.

What this recovers: at $10/mo, 46 payers cover the top of the fixed-cost
range. Today's pool is ~51 users active 3+ weeks a month plus ~100 new
sign-ups a month. Converting a third of the returning cohort plus 10% of new
sign-ups gives ~27/month after the first month, so break-even needs roughly a
doubling of the base or a higher price. The page carries `pricing_variant`
so a $15 variant can be tested by feature flag without a code change.

### Existing users

Everyone who signed up before billing exists keeps full access free until we
email them, with notice, and they get the first paid month free. The FAQ says
"we will tell you first" and nothing more specific, so the promise stays
keepable.

## 5. Page changes for v2 (this PR)

- Two cards, not three: **Personal** (highlighted, $10 / $8 annual, "Start
  30-day free trial" signed out → Clerk sign-up; "Subscribe" signed in → fake
  door "billing isn't live yet, you keep full access free, we'll email you
  first") and **Team** ($15 / $12 annual, "Talk to us" with team size).
  Enterprise strip unchanged.
- Header: one plan, everything included, no meters. A line under the cards
  says self-hosting is free for personal use and links the licence.
- FAQ rewritten: is there a free plan; I signed up before pricing; do you
  meter requests; can I use it at work; do you see my data; which agents.
- Events unchanged in name and shape; `plan` values are now `personal`,
  `team`, `enterprise`; `pricing_interest_submitted {plan: 'personal'}` is
  the willingness-to-pay signal (a signed-in user pressing Subscribe).
- Landing closing CTA: "Free to start" links to `/pricing` (the old line said
  "free for personal use", which the hosted plan no longer promises).
- `pricing_variant` bumps to `v2-2026-09` so v1 clicks are separable.

## 6. What to read from the door

1. `pricing_interest_submitted {plan: 'personal'}` by `signed_in` — the
   number of existing users who pressed Subscribe is the willingness-to-pay
   count; divide by pricing-page views from signed-in users.
2. `pricing_plan_clicked {plan: 'personal'}` from signed-out visitors →
   `sign_up_completed` — does "$10 after a trial" change the sign-up rate
   versus the "free" landing CTA (`cta_location` splits them).
3. `pricing_interval_toggled` → annual share.
4. `pricing_interest_submitted {plan: 'team', team_size}` — household vs
   business demand.
5. `pricing_faq_opened` — which objection gets read.

Four weeks of data, then decide: ship billing at $10, test $15, or add Family.
