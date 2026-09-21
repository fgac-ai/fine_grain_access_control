'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useUser } from '@clerk/nextjs'
import posthog from 'posthog-js'
import { Check, X } from 'lucide-react'
import { SignUpCta } from '../SignUpCta'

/* ─── Pricing plans (fake door) ─────────────────────────────────────────────
   Nothing here is enforced or billed; the page exists to measure whether
   people will pay,
   so every interaction captures a PostHog event (catalog in docs/analytics.md;
   strategy in docs/implementation_plans/pricing-page-design-9dbc83_v3.md).

   Mechanic (v3, Ken 2026-09-19): Free for occasional use, capped by
   successful requests per month so "less than weekly" stays free; Pro is a
   flat $5/month or $30/year per person with no cap; Enterprise is a sales
   conversation. Prices live in PLANS so a variant is a one-place change;
   PRICING_VARIANT rides on every event so variants stay comparable. */

export const PRICING_VARIANT = 'v3-2026-09'
export const SALES_EMAIL = 'sales@fgac.ai'

/* Internal approximation of "less than one task a week" — deliberately NOT
   shown on the page (Ken, 2026-09-20). In production the users active fewer
   than 4 days a month make a median of 14 successful calls (p90 114),
   weekly-plus users start at ~58, and an active day is ~15 calls. */
export const FREE_REQUESTS_PER_MONTH = 50

type Interval = 'monthly' | 'annual'
type PlanId = 'free' | 'pro' | 'enterprise'

type Plan = {
  id: PlanId
  name: string
  tagline: string
  features: string[]
  highlight?: boolean
  badge?: string
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'For occasional use.',
    features: [
      'Occasional use — less than one task a week',
      'All your Google accounts — Gmail, Sheets, Docs',
      'Delegate to and from anyone',
      'Claude, Cursor, Claude Code, any MCP client',
      'Support within 7 days',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For regular use.',
    features: [
      'Regular use — more than one task a week',
      'Everything in Free',
      'Support within 24 hours',
    ],
    highlight: true,
    badge: 'Most popular',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'For companies with vendor requirements.',
    features: [
      'BAA and SOC 2 for regulated teams',
      'Vendor security review and DPA',
      'SSO / SAML and admin controls',
      'Self-hosted gateway in your VPC',
      'Invoicing and procurement',
    ],
  },
]

function capture(event: string, props: Record<string, unknown>) {
  posthog.capture(event, { ...props, pricing_variant: PRICING_VARIANT })
}

const ctaClass = (primary: boolean) =>
  primary
    ? 'block w-full rounded-sm bg-primary px-5 py-3 text-center text-[15px] font-semibold text-primary-foreground hover:opacity-90'
    : 'block w-full rounded-sm border border-border bg-card px-5 py-3 text-center text-[15px] font-semibold text-foreground hover:border-ring'

export function PricingPlans({ signedIn }: { signedIn: boolean }) {
  const [interval, setInterval] = useState<Interval>('monthly')
  const [door, setDoor] = useState(false)

  const toggle = (next: Interval) => {
    if (next === interval) return
    setInterval(next)
    capture('pricing_interval_toggled', { interval: next })
  }

  const clickPlan = (plan: PlanId) => {
    capture('pricing_plan_clicked', {
      plan,
      interval: plan === 'enterprise' ? 'contract' : interval,
      signed_in: signedIn,
    })
  }

  return (
    <>
      {/* Interval toggle */}
      <div className="mb-8 flex justify-center">
        <div
          role="group"
          aria-label="Billing interval"
          className="inline-flex rounded-full border border-border bg-card p-1 text-sm font-semibold"
        >
          {(['monthly', 'annual'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              aria-pressed={interval === opt}
              onClick={() => toggle(opt)}
              className={
                interval === opt
                  ? 'rounded-full bg-primary px-4 py-1.5 text-primary-foreground'
                  : 'rounded-full px-4 py-1.5 text-muted-foreground hover:text-foreground'
              }
            >
              {opt === 'monthly' ? 'Monthly' : (
                <>
                  Annual{' '}
                  <span className={interval === opt ? 'opacity-80' : 'text-primary'}>
                    · save 50%
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid gap-5 md:grid-cols-3">
        {PLANS.map((plan) => (
          <article
            key={plan.id}
            data-plan={plan.id}
            className={`relative flex flex-col gap-5 rounded-lg border bg-card p-7 ${
              plan.highlight ? 'border-primary shadow-lg' : 'border-border'
            }`}
          >
            {plan.badge && (
              <span className="absolute -top-3 left-6 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-primary-foreground">
                {plan.badge}
              </span>
            )}

            <div>
              <h2 className="text-[22px] font-extrabold tracking-[-0.02em] text-foreground">
                {plan.name}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
            </div>

            <Price plan={plan.id} interval={interval} />

            <ul className="flex flex-col gap-2.5 text-sm text-foreground">
              {plan.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="leading-snug">{f}</span>
                </li>
              ))}
            </ul>

            <div className="mt-auto pt-2">
              {plan.id === 'free' &&
                (signedIn ? (
                  <Link
                    href="/dashboard"
                    onClick={() => clickPlan('free')}
                    className={ctaClass(false)}
                  >
                    Go to Dashboard
                  </Link>
                ) : (
                  /* A real sign-up: Free is today's product. Captures
                     pricing_plan_clicked, then the ordinary sign_up_started. */
                  <span onClickCapture={() => clickPlan('free')} className="block">
                    <SignUpCta location="pricing_free" className={ctaClass(false)}>
                      Start free
                    </SignUpCta>
                  </span>
                ))}

              {plan.id === 'pro' && (
                <button
                  type="button"
                  onClick={() => {
                    clickPlan('pro')
                    setDoor(true)
                  }}
                  className={ctaClass(true)}
                >
                  {signedIn ? 'Upgrade to Pro' : 'Get Pro'}
                </button>
              )}

              {plan.id === 'enterprise' && (
                /* No fake door — a real conversation is the product. */
                <a
                  href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('FGAC.ai Enterprise')}`}
                  onClick={() => clickPlan('enterprise')}
                  className={ctaClass(false)}
                >
                  Contact sales
                </a>
              )}
            </div>
          </article>
        ))}
      </div>

      {door && (
        <ProDoor interval={interval} signedIn={signedIn} onClose={() => setDoor(false)} />
      )}
    </>
  )
}

function Price({ plan, interval }: { plan: PlanId; interval: Interval }) {
  if (plan === 'enterprise') {
    return (
      <div>
        <span className="text-[40px] font-extrabold leading-none tracking-[-0.03em] text-foreground">
          Custom
        </span>
        <p className="mt-1.5 text-xs text-muted-foreground">Priced per contract</p>
      </div>
    )
  }
  if (plan === 'free') {
    return (
      <div>
        <span className="text-[40px] font-extrabold leading-none tracking-[-0.03em] text-foreground">
          $0
        </span>
        <p className="mt-1.5 text-xs text-muted-foreground">No card, no time limit</p>
      </div>
    )
  }
  return interval === 'monthly' ? (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[40px] font-extrabold leading-none tracking-[-0.03em] text-foreground">
          $5
        </span>
        <span className="text-sm text-muted-foreground">/ month</span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">Per person · cancel any time</p>
    </div>
  ) : (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[40px] font-extrabold leading-none tracking-[-0.03em] text-foreground">
          $30
        </span>
        <span className="text-sm text-muted-foreground">/ year</span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">Per person · $2.50 a month</p>
    </div>
  )
}

/* ─── Fake door ──────────────────────────────────────────────────────────────
   Honest copy: Pro is not billed during the launch period. A signed-in person
   pressing Upgrade and then "Count me in" is the willingness-to-pay signal;
   their Clerk email is already on the PostHog person. Signed-out visitors
   leave an email, stored as a person property so the launch list is a
   PostHog query. Nothing is written to our database. */

function ProDoor({
  interval,
  signedIn,
  onClose,
}: {
  interval: Interval
  signedIn: boolean
  onClose: () => void
}) {
  const { user } = useUser()
  const knownEmail = user?.primaryEmailAddress?.emailAddress ?? null
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)
  const firstField = useRef<HTMLInputElement | HTMLButtonElement>(null)

  useEffect(() => {
    firstField.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const price = interval === 'annual' ? '$30 a year' : '$5 a month'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const submittedEmail = knownEmail ?? email.trim()
    if (!submittedEmail) return
    capture('pricing_interest_submitted', { plan: 'pro', interval, signed_in: signedIn })
    posthog.setPersonProperties({
      pricing_interest_plan: 'pro',
      pricing_interest_interval: interval,
      pricing_interest_at: new Date().toISOString(),
      // Signed-in persons already carry `email` from sign_up_completed.
      ...(knownEmail ? {} : { email: submittedEmail }),
    })
    setDone(true)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-surface-inverse/60 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-door-title"
        data-testid="pricing-door"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id="pricing-door-title" className="text-lg font-bold text-foreground">
            {done ? 'Thanks — you’re on the list' : 'Pro isn’t billed yet'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {done ? (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              We’ll email{' '}
              <span className="font-semibold text-foreground">{knownEmail ?? email.trim()}</span>{' '}
              before billing starts, and your first month of Pro is on us.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Tell us you’d pay {price} and we’ll email you before billing starts — with
              your first month free. Until then, nothing changes.
            </p>

            {knownEmail ? (
              <p className="rounded-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                We’ll email <span className="font-semibold text-foreground">{knownEmail}</span>
              </p>
            ) : (
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                Email
                <input
                  ref={firstField as React.RefObject<HTMLInputElement>}
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground-subtle"
                />
              </label>
            )}

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-sm px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
              >
                Not now
              </button>
              <button
                type="submit"
                ref={knownEmail ? (firstField as React.RefObject<HTMLButtonElement>) : undefined}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Count me in
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
