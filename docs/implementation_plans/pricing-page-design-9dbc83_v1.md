# Pricing page (fake door) — v1

Branch: `claude/pricing-page-design-9dbc83`

## Goal

Ship `/pricing` as a **fake-door test**: the page presents a real pricing
structure and measures how prospective users interact with it (which plan they
click, which billing interval, whether they leave an email), without taking
payment. Nothing is gated, no billing provider is wired, and no plan limits are
enforced by the app. Every CTA is instrumented in PostHog so the result is
readable as a funnel before any money changes hands.

## Pricing recommendation

### What we are pricing

FGAC.ai is a control layer between AI agents and a person's Google account. The
value scales with three things a user can see and reason about:

1. **How many Google accounts** the agent can reach (the multi-account /
   delegation feature is the headline differentiator).
2. **How many people** are covered by the rules (a household or a team).
3. **How much control** they get: rule types, approval flow, notifications.

It does **not** scale with our cost per request. The proxy stores nothing, so a
tool call costs fractions of a cent in Vercel and Neon time. Metering tool
calls would sell our cost structure rather than our value, and it creates
budget anxiety for consumers whose agents make calls they never see. Calls are
therefore only a **fair-use ceiling** per plan, not the price axis.

### What the data says (production, 30 days to 2026-09-17)

| Measure | Value | Implication |
| --- | --- | --- |
| Active callers (≥1 successful tool call) | 148 | Small base, so the page must measure intent, not conversion |
| Successful calls per active user — p50 / p75 / p90 / p99 / max | 84 / 219 / 636 / 2,842 / 3,888 | A 1,000-call free ceiling keeps ~93% of today's users on Free; 10,000 covers everyone |
| Users reaching ≥2 Google accounts through the proxy | 20 of 148 (14%) | Multi-account is a real, minority need — a clean Pro gate |
| Users with delegations received (all time) | 30 of 281; three run 10 mailboxes | Same signal from the DB side |
| Users with ≥2 agent profiles (all time) | 9 of 273 | Profiles are not a lever; leave them unlimited |
| Client mix (users) | Toolbox 79, ClaudeAI 50, Claude Code 15, OpenAI/other ~14 | The audience is claude.ai consumers first, developers second — consumer price points apply |
| Marketing visitors per week | 54–106 | Weeks, not days, of data per read-out; no A/B split yet |
| Van Westendorp survey (the one completed answer, 2026-05) | bargain $1 · expensive $5 · too expensive $10 | One respondent; treat as a hint that $10+/mo is a wall for individuals |

The repo licence already prohibits corporate and educational use without a
separate agreement, so a paid Team tier is not only a revenue line, it is the
compliant path for the users the licence currently excludes.

### Recommended structure

| Plan | Price | Value metric | Includes |
| --- | --- | --- | --- |
| **Personal** | Free | 1 Google account | Every rule type (send allowlist, read blacklist, labels, per-file Sheets/Docs), approval links, agent profiles, all MCP clients, 1,000 calls/mo fair use |
| **Pro** | $8/mo, or $72/yr ($6/mo) | Up to 5 Google accounts | Everything in Personal, multi-account delegation (family, teammates, extra inboxes), 10,000 calls/mo, priority support |
| **Team** | $15/user/mo, or $12/user/mo annual | Per seat | Everything in Pro for each member, shared rule templates, admin view of every profile, Google Workspace domain, commercial licence, invoicing. Early access |
| **Enterprise** | Custom | Contract | Self-hosted gateway in your VPC (strategy doc, prong 3), SSO, DPA and security review |

Why these numbers:

- **$8 Pro** sits under the $10 "too expensive" point from the survey and at
  40% of a Claude Pro subscription, which is the product most of our users are
  attaching FGAC to. Annual at $6/mo gives a second price point on the same
  page, and the monthly/annual toggle is itself a measurement.
- **$15/seat Team** is the low end of B2B security tooling (Slack Pro is
  $8.75, Notion Business $20, Zapier Team far higher) and is consistent with
  the licence requirement that businesses pay.
- **Free stays generous** because the connector-directory funnel depends on it
  and because the licence already promises personal use is free. The Pro gate
  is multi-account, which 86% of today's users do not touch.

### What to read from the experiment

With ~80 visitors a week the page will not support a statistically clean A/B
test for months. The readable signals, in order of usefulness:

1. Pricing-page views as a share of landing-page views (is pricing even a
   question people ask?).
2. Plan clicks by plan and interval (`pricing_plan_clicked`).
3. Interest submissions by plan (`pricing_interest_submitted`), with the
   emails as a launch list.
4. Monthly vs annual toggle rate (`pricing_interval_toggled`).
5. FAQ opens by question (`pricing_faq_opened`) — which objection people look
   for.

If Pro click-through is low after four weeks, run a second variant at $5 via a
PostHog feature flag; every pricing event carries `pricing_variant` so the two
can be compared without a schema change.

## Implementation

### New files

- `src/app/pricing/page.tsx` — server component: metadata, reads Clerk `auth()`
  for signed-in state, renders the header, `PricingPlans`, an Enterprise strip,
  `PricingFaq`, and a closing CTA.
- `src/app/pricing/PricingPlans.tsx` — client component: monthly/annual
  toggle, three plan cards, and the fake-door dialog. Signed-in visitors see a
  one-click "Notify me" (Clerk primary email via `useUser`); signed-out
  visitors get an email field. Team asks for a team-size bucket.
- `src/app/pricing/PricingFaq.tsx` — client component: native
  `<details>` accordions that capture `pricing_faq_opened` on first open.

### Modified files

- `src/app/layout.tsx` — "Pricing" nav link (desktop and mobile) and footer
  link.
- `src/app/page.tsx` — the closing CTA's "Free for personal use" line links to
  `/pricing`.
- `src/app/SignUpCta.tsx` — `cta_location` union gains `pricing_personal`.
- `docs/analytics.md` — event catalog rows for the four pricing events and the
  new `cta_location` value.
- `docs/QA_Acceptance_Test/capabilities/16_analytics_events.md` — A26: the
  pricing events land with canonical props.

### Events (all client-side, PostHog)

| Event | Properties |
| --- | --- |
| `pricing_interval_toggled` | `interval` (`monthly` / `annual`), `pricing_variant` |
| `pricing_plan_clicked` | `plan` (`personal` / `pro` / `team` / `enterprise`), `interval`, `signed_in`, `pricing_variant` |
| `pricing_interest_submitted` | `plan`, `interval`, `signed_in`, `team_size` (team only), `pricing_variant`; also sets person properties `pricing_interest_plan`, `pricing_interest_interval`, `pricing_interest_at`, and `email` for signed-out submitters |
| `pricing_faq_opened` | `question`, `pricing_variant` |

`pricing_variant` is a constant (`v1-2026-09`) so later price variants are
comparable in one query. No server capture is needed; there is no server-side
state.

### Out of scope

- Billing (Stripe or otherwise), plan enforcement, seat management.
- A dedicated interest table. PostHog person properties hold the emails; a
  table comes with the first real plan.
- Price A/B via feature flag (documented as the follow-up).

## Verification

1. `npm run lint` and `npx tsc --noEmit` clean.
2. Local: `/pricing` renders signed-out and signed-in; each CTA emits its event
   (network requests to the PostHog host carry the event names); dialog opens,
   submits, and closes; mobile width has no horizontal scroll; nav and footer
   links resolve.
3. Preview via `/deploy-pr-preview`; repeat the click-through and confirm
   `environment = preview` events in PostHog via the connector.
