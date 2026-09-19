'use client'

import { useRef } from 'react'
import Link from 'next/link'
import posthog from 'posthog-js'
import { FREE_REQUESTS_PER_MONTH, PRICING_VARIANT, SALES_EMAIL } from './PricingPlans'

/* Native <details> accordions. Each question captures `pricing_faq_opened`
   the first time it is opened, so the answer to "which objection do people
   look for?" is a breakdown by `question`. */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: 'What counts as a request?',
    a: `One successful call your agent makes through FGAC to Google — reading a thread, appending rows to a sheet, sending an email. Denied calls never count. A typical task is a handful of requests, so ${FREE_REQUESTS_PER_MONTH} a month is roughly one task a week.`,
  },
  {
    q: 'What happens when I reach the Free limit?',
    a: 'During the launch period, nothing — every account has Pro-level access. Once billing starts, your agent gets a clear message that the monthly limit is reached and you can upgrade in one click; nothing is silently dropped.',
  },
  {
    q: 'Is billing live?',
    a: 'Not yet. Prices are published so you know what to expect. We will email every account before billing starts, and anyone who tells us they would upgrade gets their first month of Pro free.',
  },
  {
    q: 'Is Pro per Google account or per person?',
    a: 'Per person. One Pro subscription covers every Google account you connect and every agent you run. Delegating an inbox to someone else, or being delegated one, costs neither of you anything.',
  },
  {
    q: 'Do you ever see my email or documents?',
    a: 'No. Requests pass through and are checked against your rules; content is never stored, never used to train models, and no human reads it. That is true on every plan.',
  },
  {
    q: 'Can I use this at work?',
    a: (
      <>
        Free and Pro cover your own accounts. Use by or for a company, school or agency
        needs Enterprise, which carries the commercial licence and the paperwork vendors
        are asked for — BAA, SOC 2, DPA, security review. Write to{' '}
        <Link href={`mailto:${SALES_EMAIL}`} className="text-primary underline underline-offset-2">
          {SALES_EMAIL}
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Can I run it myself?',
    a: (
      <>
        Yes. The code is open source and{' '}
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
