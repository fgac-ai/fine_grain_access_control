'use client'

import { useRef } from 'react'
import posthog from 'posthog-js'
import { PRICING_VARIANT } from './PricingPlans'

/* Native <details> accordions. Each question captures `pricing_faq_opened`
   the first time it is opened, so the answer to "which objection do people
   look for?" is a breakdown by `question`. */

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: 'Is Personal really free?',
    a: 'Yes. FGAC.ai is free for personal use, and stays that way. The Personal plan has every rule type — the only limits are one Google account and a fair-use request ceiling that almost nobody reaches today.',
  },
  {
    q: 'I already connected more than one account. What happens to me?',
    a: 'Nothing. Accounts and delegations you set up before Pro launches keep working. When Pro is live we will tell you well ahead of any change, and you will have the choice of moving to Pro or trimming back to one account.',
  },
  {
    q: 'What counts as a request?',
    a: 'One call your agent makes through FGAC to Google: reading a thread, appending rows to a sheet, sending an email. Denied calls do not count. The typical active user makes under a hundred a month; the Personal ceiling is a thousand.',
  },
  {
    q: 'Do you ever see my email or documents?',
    a: 'No. Requests pass through and are checked against your rules; content is never stored, never used to train models, and no human reads it. That is true on every plan.',
  },
  {
    q: 'Can I use this at work?',
    a: 'Personal use means your own accounts. Use by or for a company, school or agency needs the Team plan (or Enterprise), which also carries the commercial licence. If you are not sure which side you are on, ask us.',
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
