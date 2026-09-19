'use client'

import { useRef } from 'react'
import Link from 'next/link'
import posthog from 'posthog-js'
import { PRICING_VARIANT } from './PricingPlans'

/* Native <details> accordions. Each question captures `pricing_faq_opened`
   the first time it is opened, so the answer to "which objection do people
   look for?" is a breakdown by `question`. */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: 'Is there a free plan?',
    a: (
      <>
        The hosted service is free for 30 days, then $10 a month. There is no
        permanent free tier: FGAC has real fixed costs — an annual third-party
        security assessment for Gmail access chief among them — and a plan
        that covers them is what keeps the service running. The code is open
        source and{' '}
        <Link
          href="https://github.com/fgac-ai/fine_grain_access_control/blob/main/LICENSE"
          className="text-primary underline underline-offset-2"
        >
          free to self-host for personal use
        </Link>
        .
      </>
    ),
  },
  {
    q: 'I signed up before pricing existed. What happens to me?',
    a: 'Nothing yet. You keep full access, free, until billing launches, and we will email you before anything changes. When it does, your first paid month is free.',
  },
  {
    q: 'Do you count requests, accounts, or seats?',
    a: 'Personal is one flat price for one person: every Google account you own, unlimited agent profiles, unlimited requests. Delegating an inbox to someone else, or being delegated one, costs neither of you anything. Team is per seat, because a team is a number of people.',
  },
  {
    q: 'What does the trial include?',
    a: 'Everything. Every rule type, Sheets and Docs per-file access, multiple accounts, delegation, approval links. No card up front; the trial simply ends after 30 days.',
  },
  {
    q: 'Do you ever see my email or documents?',
    a: 'No. Requests pass through and are checked against your rules; content is never stored, never used to train models, and no human reads it. That is true on every plan.',
  },
  {
    q: 'Can I use this at work?',
    a: 'Personal covers your own accounts. Use by or for a company, school or agency needs the Team plan (or Enterprise), which also carries the commercial licence. If you are not sure which side you are on, ask us.',
  },
  {
    q: 'Which agents does it work with?',
    a: 'Anything that speaks MCP: Claude (the connectors directory), Claude Code, Cursor, Windsurf, Claude Desktop, OpenAI clients and your own scripts. One URL, the same rules everywhere.',
  },
]

export function PricingFaq() {
  const opened = useRef(new Set<string>())

  const onToggle = (q: string, open: boolean) => {
    if (!open || opened.current.has(q)) return
    opened.current.add(q)
    posthog.capture('pricing_faq_opened', { question: q, pricing_variant: PRICING_VARIANT })
  }

  return (
    <div className="flex flex-col gap-3">
      {FAQ.map(({ q, a }) => (
        <details
          key={q}
          onToggle={(e) => onToggle(q, (e.currentTarget as HTMLDetailsElement).open)}
          className="group rounded-lg border border-border bg-card px-5 py-4"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold text-foreground">
            {q}
            <span
              aria-hidden
              className="text-muted-foreground transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{a}</p>
        </details>
      ))}
    </div>
  )
}
