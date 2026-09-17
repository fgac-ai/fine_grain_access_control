'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useUser } from '@clerk/nextjs'
import posthog from 'posthog-js'
import { Check, X } from 'lucide-react'
import { SignUpCta } from '../SignUpCta'

/* ─── Pricing plans (fake door) ─────────────────────────────────────────────
   Nothing here is enforced or billed. The page exists to measure which plan
   prospective users reach for, so every interaction captures a PostHog event
   (catalog in docs/analytics.md; rationale in
   docs/implementation_plans/pricing-page-design-9dbc83_v1.md). Prices and
   limits live in PLANS so a later variant is a one-place change; the
   PRICING_VARIANT constant rides on every event so variants stay comparable. */

export const PRICING_VARIANT = 'v1-2026-09'

type Interval = 'monthly' | 'annual'
type PlanId = 'personal' | 'pro' | 'team'

type Plan = {
  id: PlanId
  name: string
  tagline: string
  monthly: number
  annual: number // per month, billed yearly
  unit: string
  metric: string
  features: string[]
  cta: string
  highlight?: boolean
  badge?: string
}

const PLANS: Plan[] = [
  {
    id: 'personal',
    name: 'Personal',
    tagline: 'One Google account, every rule.',
    monthly: 0,
    annual: 0,
    unit: '',
    metric: '1 Google account',
    features: [
      'Send allowlists, read blacklists, label rules',
      'Per-file Sheets and Docs access',
      'One-click approval links',
      'Unlimited agent profiles',
      'Claude, Cursor, Claude Code, any MCP client',
      '1,000 requests / month fair use',
    ],
    cta: 'Get started — it’s free',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Every inbox your agent should reach.',
    monthly: 8,
    annual: 6,
    unit: '/ month',
    metric: 'Up to 5 Google accounts',
    features: [
      'Everything in Personal',
      'Multi-account delegation — family, teammates, extra inboxes',
      'One agent, many mailboxes, each under its own rules',
      '10,000 requests / month fair use',
      'Priority support',
    ],
    cta: 'Get Pro',
    highlight: true,
    badge: 'Most popular',
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'Shared rules for everyone’s agents.',
    monthly: 15,
    annual: 12,
    unit: '/ user / month',
    metric: 'Per seat',
    features: [
      'Everything in Pro, for every member',
      'Shared rule templates across the team',
      'Admin view of every profile and approval',
      'Google Workspace domain',
      'Commercial licence and invoicing',
    ],
    cta: 'Talk to us',
    badge: 'Early access',
  },
]

const TEAM_SIZES = ['2–5', '6–20', '21–100', '100+'] as const

function capture(event: string, props: Record<string, unknown>) {
  posthog.capture(event, { ...props, pricing_variant: PRICING_VARIANT })
}

export function PricingPlans({ signedIn }: { signedIn: boolean }) {
  const [interval, setInterval] = useState<Interval>('monthly')
  const [door, setDoor] = useState<Extract<PlanId, 'pro' | 'team'> | null>(null)

  const toggle = (next: Interval) => {
    if (next === interval) return
    setInterval(next)
    capture('pricing_interval_toggled', { interval: next })
  }

  const clickPlan = (plan: PlanId) => {
    capture('pricing_plan_clicked', { plan, interval, signed_in: signedIn })
    if (plan !== 'personal') setDoor(plan)
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
                    · save 25%
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid gap-5 md:grid-cols-3">
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
                    {price === 0 ? 'Free' : `$${price}`}
                  </span>
                  {plan.unit && (
                    <span className="text-sm text-muted-foreground">{plan.unit}</span>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {price === 0
                    ? 'For personal use, forever'
                    : interval === 'annual'
                      ? `Billed yearly · $${plan.annual * 12}${plan.id === 'team' ? ' per user' : ''}`
                      : 'Billed monthly · cancel any time'}
                </p>
              </div>

              <p className="rounded-sm bg-primary-muted px-3 py-2 text-[13px] font-semibold text-primary">
                {plan.metric}
              </p>

              <ul className="flex flex-col gap-2.5 text-sm text-foreground">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="leading-snug">{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-2">
                {plan.id === 'personal' ? (
                  signedIn ? (
                    <Link
                      href="/dashboard"
                      onClick={() => clickPlan('personal')}
                      className="block rounded-sm border border-border bg-card px-5 py-3 text-center text-[15px] font-semibold text-foreground hover:border-ring"
                    >
                      Go to Dashboard
                    </Link>
                  ) : (
                    <span onClickCapture={() => clickPlan('personal')} className="block">
                      <SignUpCta
                        location="pricing_personal"
                        className="block w-full rounded-sm border border-border bg-card px-5 py-3 text-center text-[15px] font-semibold text-foreground hover:border-ring"
                      >
                        {plan.cta}
                      </SignUpCta>
                    </span>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => clickPlan(plan.id)}
                    className={
                      plan.highlight
                        ? 'block w-full rounded-sm bg-primary px-5 py-3 text-[15px] font-semibold text-primary-foreground hover:opacity-90'
                        : 'block w-full rounded-sm border border-border bg-card px-5 py-3 text-[15px] font-semibold text-foreground hover:border-ring'
                    }
                  >
                    {plan.cta}
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
   Honest copy: the plan is not purchasable yet. Signed-in visitors confirm
   with one click (their Clerk email is already on the PostHog person);
   signed-out visitors leave an email, stored as a person property so the
   launch list is a PostHog query. Nothing is written to our database. */

function InterestDialog({
  plan,
  interval,
  signedIn,
  onClose,
}: {
  plan: 'pro' | 'team'
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

  const planName = plan === 'pro' ? 'Pro' : 'Team'

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
            {done ? 'You’re on the list' : `${planName} isn’t available yet`}
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
              Thanks — we’ll email{' '}
              <span className="font-semibold text-foreground">{knownEmail ?? email.trim()}</span>{' '}
              when {planName} launches. Until then everything on the Personal plan is free,
              including the rules {planName} builds on.
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
              {plan === 'pro'
                ? 'We’re finishing Pro now. Leave your email and you’ll hear from us the day multi-account delegation moves to Pro — nothing changes for you until then.'
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
                ref={knownEmail && plan === 'pro' ? (firstField as React.RefObject<HTMLButtonElement>) : undefined}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {knownEmail ? 'Notify me' : 'Keep me posted'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
