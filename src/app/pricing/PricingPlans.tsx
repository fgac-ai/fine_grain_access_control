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

export function PricingPlans({ signedIn: signedInOnServer }: { signedIn: boolean }) {
  /* The server's auth() reads the session cookie, which on localhost goes
     stale while Clerk's client keeps a live session (and the reverse right
     after a modal sign-in). Rendering the signed-out CTAs to a signed-in
     browser makes the Clerk sign-up modal refuse to open ("single-session
     mode") and the button looks dead. So once Clerk has loaded, its client
     state wins; the server value only covers the first paint. */
  const { isLoaded, isSignedIn } = useUser()
  const signedIn = isLoaded ? Boolean(isSignedIn) : signedInOnServer
  const [interval, setInterval] = useState<Interval>('monthly')
  const [door, setDoor] = useState<'pro' | 'enterprise' | null>(null)

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
                      Start for free
                    </SignUpCta>
                  </span>
                ))}

              {plan.id === 'pro' && (
                <button
                  type="button"
                  onClick={() => {
                    clickPlan('pro')
                    setDoor('pro')
                  }}
                  className={ctaClass(true)}
                >
                  {signedIn ? 'Upgrade to Pro' : 'Get Pro'}
                </button>
              )}

              {plan.id === 'enterprise' && (
                /* A short form rather than a bare mailto: — a mailto does
                   nothing visible in browsers without a mail handler (the
                   desktop app's pane, most work machines), which reads as a
                   dead button. The address stays as a fallback link inside. */
                <button
                  type="button"
                  onClick={() => {
                    clickPlan('enterprise')
                    setDoor('enterprise')
                  }}
                  className={ctaClass(false)}
                >
                  Contact sales
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {door === 'pro' && (
        <ProDoor interval={interval} signedIn={signedIn} onClose={() => setDoor(null)} />
      )}
      {door === 'enterprise' && (
        <EnterpriseDoor signedIn={signedIn} onClose={() => setDoor(null)} />
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
   Honest copy: Pro is not billed yet. A signed-in person pressing Upgrade and
   then "Count me in" is the willingness-to-pay signal; their Clerk email is
   already on the PostHog person, so the launch list is a PostHog query.
   Signed-out visitors are sent to sign-up instead of being asked for an
   email (sign_up_started carries cta_location pricing_pro). Nothing is
   written to our database. */

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
  const [done, setDone] = useState(false)
  const firstField = useRef<HTMLButtonElement>(null)

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
    capture('pricing_interest_submitted', { plan: 'pro', interval, signed_in: signedIn })
    posthog.setPersonProperties({
      pricing_interest_plan: 'pro',
      pricing_interest_interval: interval,
      pricing_interest_at: new Date().toISOString(),
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
              <span className="font-semibold text-foreground">{knownEmail}</span>{' '}
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
        ) : signedIn && knownEmail ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Tell us you’d pay {price} and we’ll email you before billing starts — with
              your first month free. Until then, nothing changes.
            </p>

            <p className="rounded-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
              We’ll email <span className="font-semibold text-foreground">{knownEmail}</span>
            </p>

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
                ref={firstField}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Count me in
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sign up free and start using it today. We’ll email you before billing starts,
              and if you tell us then that you’d pay {price}, your first month is free.
            </p>

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-sm px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
              >
                Not now
              </button>
              <SignUpCta
                location="pricing_pro"
                className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Sign up free
              </SignUpCta>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Contact sales ──────────────────────────────────────────────────────────
   Typeform-style capture (Ken, 2026-09-21): every field is captured to
   PostHog as it is filled, not only on Send, so a partial form is still a
   lead; closing without sending records which fields were filled. Send
   also POSTs to /api/sales-lead, which emails the submitter with the sales
   inbox in copy (src/lib/salesLead.ts) and reports whether it went out. */

const TEAM_SIZES = ['2–10', '11–50', '51–250', '250+'] as const
const NEEDS = ['BAA', 'SOC 2 report', 'SSO / SAML', 'Self-hosted', 'DPA / security review', 'Invoicing'] as const
const FIELD_DEBOUNCE_MS = 700
const EMAIL_LOOKS_VALID = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function EnterpriseDoor({ signedIn, onClose }: { signedIn: boolean; onClose: () => void }) {
  const { user } = useUser()
  const knownEmail = user?.primaryEmailAddress?.emailAddress ?? ''
  // Derived, not synced: Clerk resolves the user after mount, so the field
  // shows the account email until the visitor types their own.
  const [emailEdit, setEmailEdit] = useState<string | null>(null)
  const email = emailEdit ?? knownEmail
  const [company, setCompany] = useState('')
  const [teamSize, setTeamSize] = useState<(typeof TEAM_SIZES)[number] | ''>('')
  const [needs, setNeeds] = useState<string[]>([])
  const [website, setWebsite] = useState('') // honeypot — hidden, must stay empty
  const [phase, setPhase] = useState<'form' | 'sending' | 'done'>('form')
  const [emailed, setEmailed] = useState(false)
  const firstField = useRef<HTMLInputElement>(null)
  const openedAt = useRef(Date.now())
  const submitted = useRef(false)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // The Escape listener is registered once, so it reads the form through a
  // ref that every render refreshes — otherwise it sees the first render's
  // empty values and the abandonment event lists no fields.
  const latest = useRef({ email, company, teamSize, needs })
  latest.current = { email, company, teamSize, needs }

  /* Field-level capture. Text fields debounce so a person typing is one
     event per pause, not per keystroke; choices capture at once. A
     plausible email also goes on the person, so a lead who never presses
     Send is still reachable in PostHog. */
  const trackField = (field: string, value: string | string[], immediate = false) => {
    const fire = () => {
      capture('pricing_sales_form_field', { plan: 'enterprise', field, value, signed_in: signedIn })
      if (field === 'email' && typeof value === 'string' && EMAIL_LOOKS_VALID.test(value) && !knownEmail) {
        posthog.setPersonProperties({ email: value, pricing_interest_plan: 'enterprise' })
      }
      if (field === 'company' && typeof value === 'string' && value) {
        posthog.setPersonProperties({ pricing_interest_company: value })
      }
    }
    clearTimeout(timers.current[field])
    if (immediate) fire()
    else timers.current[field] = setTimeout(fire, FIELD_DEBOUNCE_MS)
  }

  const close = () => {
    if (!submitted.current) {
      const cur = latest.current
      const filled = [
        cur.email.trim() ? 'email' : null,
        cur.company.trim() ? 'company' : null,
        cur.teamSize ? 'team_size' : null,
        cur.needs.length ? 'needs' : null,
      ].filter(Boolean)
      capture('pricing_sales_form_abandoned', {
        plan: 'enterprise',
        fields_filled: filled,
        seconds_open: Math.round((Date.now() - openedAt.current) / 1000),
        signed_in: signedIn,
      })
    }
    onClose()
  }

  useEffect(() => {
    firstField.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    const pending = timers.current
    return () => {
      window.removeEventListener('keydown', onKey)
      Object.values(pending).forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleNeed = (n: string) => {
    const next = needs.includes(n) ? needs.filter((x) => x !== n) : [...needs, n]
    setNeeds(next)
    trackField('needs', next, true)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const submittedEmail = email.trim()
    if (!submittedEmail || phase !== 'form') return
    submitted.current = true
    Object.values(timers.current).forEach(clearTimeout)
    setPhase('sending')
    capture('pricing_interest_submitted', {
      plan: 'enterprise',
      interval: 'contract',
      signed_in: signedIn,
      team_size: teamSize || 'unspecified',
      company: company.trim() || undefined,
      needs,
    })
    posthog.setPersonProperties({
      pricing_interest_plan: 'enterprise',
      pricing_interest_at: new Date().toISOString(),
      pricing_interest_team_size: teamSize || 'unspecified',
      ...(company.trim() ? { pricing_interest_company: company.trim() } : {}),
      ...(knownEmail ? {} : { email: submittedEmail }),
    })
    try {
      const res = await fetch('/api/sales-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: submittedEmail, company: company.trim(), teamSize, needs, website }),
      })
      const data = (await res.json().catch(() => ({}))) as { emailed?: boolean }
      setEmailed(Boolean(data.emailed))
    } catch {
      setEmailed(false)
    }
    setPhase('done')
  }

  const field =
    'rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground-subtle'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-surface-inverse/60 p-4 sm:items-center"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-sales-title"
        data-testid="pricing-sales"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id="pricing-sales-title" className="text-lg font-bold text-foreground">
            {phase === 'done' ? 'Thanks — we’ll be in touch' : 'Talk to sales'}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {phase === 'done' ? (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {emailed ? (
                <>
                  We’ve emailed a confirmation to{' '}
                  <span className="font-semibold text-foreground">{email.trim()}</span> with a copy
                  to our sales team, and we’ll reply within one business day.
                </>
              ) : (
                <>
                  We’ll reply to{' '}
                  <span className="font-semibold text-foreground">{email.trim()}</span> within one
                  business day.
                </>
              )}{' '}
              Prefer email? Write to{' '}
              <a href={`mailto:${SALES_EMAIL}`} className="text-primary underline underline-offset-2">
                {SALES_EMAIL}
              </a>
              .
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
              Tell us a little about your team and what your vendor process needs. We reply
              within one business day.
            </p>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              Work email
              <input
                ref={firstField}
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmailEdit(e.target.value)
                  trackField('email', e.target.value)
                }}
                placeholder="you@company.com"
                className={field}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              Company
              <input
                type="text"
                autoComplete="organization"
                value={company}
                onChange={(e) => {
                  setCompany(e.target.value)
                  trackField('company', e.target.value)
                }}
                placeholder="Optional"
                className={field}
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              Team size
              <select
                value={teamSize}
                onChange={(e) => {
                  const v = e.target.value as (typeof TEAM_SIZES)[number]
                  setTeamSize(v)
                  trackField('team_size', v, true)
                }}
                className={field}
              >
                <option value="">Select…</option>
                {TEAM_SIZES.map((t) => (
                  <option key={t} value={t}>
                    {t} people
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium text-foreground">What do you need?</legend>
              <div className="flex flex-wrap gap-2">
                {NEEDS.map((n) => (
                  <label
                    key={n}
                    className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold ${
                      needs.includes(n)
                        ? 'border-primary bg-primary-muted text-primary'
                        : 'border-border bg-card text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={needs.includes(n)}
                      onChange={() => toggleNeed(n)}
                    />
                    {n}
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Honeypot: invisible to people, filled by naive bots. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="hidden"
            />

            <div className="flex items-center justify-between gap-3 pt-1">
              <a
                href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('FGAC.ai Enterprise')}`}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                or email {SALES_EMAIL}
              </a>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={close}
                  className="rounded-sm px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
                >
                  Not now
                </button>
                <button
                  type="submit"
                  disabled={phase === 'sending'}
                  className="rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {phase === 'sending' ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
