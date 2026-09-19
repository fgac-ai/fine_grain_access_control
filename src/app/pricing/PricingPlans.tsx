'use client'

import { useEffect, useRef, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import posthog from 'posthog-js'
import { Check, X } from 'lucide-react'
import { SignUpCta } from '../SignUpCta'

/* ─── Pricing plans (fake door) ─────────────────────────────────────────────
   Nothing here is enforced or billed. The page exists to measure whether
   people will pay, so every interaction captures a PostHog event (catalog in
   docs/analytics.md; strategy in
   docs/implementation_plans/pricing-page-design-9dbc83_v2.md).

   Mechanic (v2): one flat Personal plan after a 30-day trial, no meters, no
   per-account maths; Team is per seat. Prices live in PLANS so a variant is
   a one-place change; PRICING_VARIANT rides on every event so variants stay
   comparable in one query. */

export const PRICING_VARIANT = 'v2-2026-09'

type Interval = 'monthly' | 'annual'
type PlanId = 'personal' | 'team'

type Plan = {
  id: PlanId
  name: string
  tagline: string
  monthly: number
  annual: number // per month, billed yearly
  unit: string
  trial?: string
  features: string[]
  highlight?: boolean
  badge?: string
}

const PLANS: Plan[] = [
  {
    id: 'personal',
    name: 'Personal',
    tagline: 'Everything, for one person. No meters.',
    monthly: 10,
    annual: 8,
    unit: '/ month',
    trial: '30-day free trial · no card',
    features: [
      'All your own Google accounts — Gmail, Sheets, Docs',
      'Every rule type: send allowlists, read blacklists, labels, per-file access',
      'Delegate to and from anyone, free for both of you',
      'Unlimited agent profiles and requests',
      'Claude, Cursor, Claude Code, any MCP client',
      'One-click approval links and email reminders',
    ],
    highlight: true,
    badge: 'One plan',
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'Shared rules for everyone’s agents.',
    monthly: 15,
    annual: 12,
    unit: '/ user / month',
    features: [
      'Everything in Personal, for every seat',
      'Shared rule templates across the team',
      'Admin view of every profile and approval',
      'Google Workspace domain',
      'Commercial licence and invoicing',
    ],
    badge: 'Early access',
  },
]

const TEAM_SIZES = ['2–5', '6–20', '21–100', '100+'] as const

function capture(event: string, props: Record<string, unknown>) {
  posthog.capture(event, { ...props, pricing_variant: PRICING_VARIANT })
}

export function PricingPlans({ signedIn }: { signedIn: boolean }) {
  const [interval, setInterval] = useState<Interval>('monthly')
  const [door, setDoor] = useState<PlanId | null>(null)

  const toggle = (next: Interval) => {
    if (next === interval) return
    setInterval(next)
    capture('pricing_interval_toggled', { interval: next })
  }

  const clickPlan = (plan: PlanId) => {
    capture('pricing_plan_clicked', { plan, interval, signed_in: signedIn })
  }

  const ctaClass = (primary: boolean) =>
    primary
      ? 'block w-full rounded-sm bg-primary px-5 py-3 text-center text-[15px] font-semibold text-primary-foreground hover:opacity-90'
      : 'block w-full rounded-sm border border-border bg-card px-5 py-3 text-center text-[15px] font-semibold text-foreground hover:border-ring'

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
                    · save 20%
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="mx-auto grid max-w-[880px] gap-5 md:grid-cols-2">
        {PLANS.map((plan) => {
          const price = interval === 'monthly' ? plan.monthly : plan.annual
          return (
            <article
              key={plan.id}
              data-plan={plan.id}
              className={`relative flex flex-col gap-5 rounded-lg border bg-card p-7 ${
                plan.highlight ? 'border-primary shadow-lg' : 'border-border'
              }`}
            >
              {plan.badge && (
                <span
                  className={`absolute -top-3 left-6 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                    plan.highlight
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-background text-muted-foreground'
                  }`}
                >
                  {plan.badge}
                </span>
              )}

              <div>
                <h2 className="text-[22px] font-extrabold tracking-[-0.02em] text-foreground">
                  {plan.name}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
              </div>

              <div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[40px] font-extrabold leading-none tracking-[-0.03em] text-foreground">
                    ${price}
                  </span>
                  <span className="text-sm text-muted-foreground">{plan.unit}</span>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {interval === 'annual'
                    ? `Billed yearly · $${plan.annual * 12}${plan.id === 'team' ? ' per user' : ''}`
                    : 'Billed monthly · cancel any time'}
                </p>
              </div>

              {plan.trial && (
                <p className="rounded-sm bg-primary-muted px-3 py-2 text-[13px] font-semibold text-primary">
                  {plan.trial}
                </p>
              )}

              <ul className="flex flex-col gap-2.5 text-sm text-foreground">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="leading-snug">{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-2">
                {plan.id === 'personal' && !signedIn ? (
                  /* Signed-out: the trial IS today's product, so this is a real
                     sign-up. Clicking captures pricing_plan_clicked, then the
                     ordinary sign_up_started with cta_location pricing_personal. */
                  <span onClickCapture={() => clickPlan('personal')} className="block">
                    <SignUpCta location="pricing_personal" className={ctaClass(true)}>
                      Start 30-day free trial
                    </SignUpCta>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      clickPlan(plan.id)
                      setDoor(plan.id)
                    }}
                    className={ctaClass(Boolean(plan.highlight))}
                  >
                    {plan.id === 'personal' ? 'Subscribe' : 'Talk to us'}
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>

      {door && (
        <InterestDialog
          plan={door}
          interval={interval}
          signedIn={signedIn}
          onClose={() => setDoor(null)}
        />
      )}
    </>
  )
}

/* ─── Fake door ──────────────────────────────────────────────────────────────
   Honest copy: billing is not live. A signed-in person pressing Subscribe is
   the willingness-to-pay signal; they confirm with one click (their Clerk
   email is already on the PostHog person). Signed-out visitors only reach
   the Team door and leave an email, stored as a person property so the
   launch list is a PostHog query. Nothing is written to our database. */

function InterestDialog({
  plan,
  interval,
  signedIn,
  onClose,
}: {
  plan: PlanId
  interval: Interval
  signedIn: boolean
  onClose: () => void
}) {
  const { user } = useUser()
  const knownEmail = user?.primaryEmailAddress?.emailAddress ?? null
  const [email, setEmail] = useState('')
  const [teamSize, setTeamSize] = useState<(typeof TEAM_SIZES)[number] | ''>('')
  const [done, setDone] = useState(false)
  const firstField = useRef<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(null)

  useEffect(() => {
    firstField.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const planName = plan === 'personal' ? 'Personal' : 'Team'
  const price = plan === 'personal' ? (interval === 'annual' ? '$8/month billed yearly' : '$10/month') : null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const submittedEmail = knownEmail ?? email.trim()
    if (!submittedEmail) return
    capture('pricing_interest_submitted', {
      plan,
      interval,
      signed_in: signedIn,
      ...(plan === 'team' ? { team_size: teamSize || 'unspecified' } : {}),
    })
    posthog.setPersonProperties({
      pricing_interest_plan: plan,
      pricing_interest_interval: interval,
      pricing_interest_at: new Date().toISOString(),
      ...(plan === 'team' && teamSize ? { pricing_interest_team_size: teamSize } : {}),
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
            {done
              ? 'Thanks — you’re on the list'
              : plan === 'personal'
                ? 'Billing isn’t live yet'
                : 'Team isn’t available yet'}
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
              {plan === 'personal'
                ? 'before anything changes, and your first paid month is on us. Until then you keep full access, free.'
                : `when ${planName} launches.`}
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
              {plan === 'personal'
                ? `You keep full access free until billing launches. Tell us you’d pay ${price} and we’ll email you before anything changes — with your first paid month free.`
                : 'Team is in early access. Tell us roughly how big your team is and we’ll reach out to set it up with you.'}
            </p>

            {plan === 'team' && (
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                Team size
                <select
                  ref={firstField as React.RefObject<HTMLSelectElement>}
                  value={teamSize}
                  onChange={(e) => setTeamSize(e.target.value as (typeof TEAM_SIZES)[number])}
                  className="rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="">Select…</option>
                  {TEAM_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s} people
                    </option>
                  ))}
                </select>
              </label>
            )}

            {knownEmail ? (
              <p className="rounded-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                We’ll email <span className="font-semibold text-foreground">{knownEmail}</span>
              </p>
            ) : (
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                Email
                <input
                  ref={plan === 'team' ? undefined : (firstField as React.RefObject<HTMLInputElement>)}
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
                ref={knownEmail && plan === 'personal' ? (firstField as React.RefObject<HTMLButtonElement>) : undefined}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {plan === 'personal' ? 'Count me in' : knownEmail ? 'Notify me' : 'Keep me posted'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
