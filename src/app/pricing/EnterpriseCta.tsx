'use client'

import posthog from 'posthog-js'
import { PRICING_VARIANT } from './PricingPlans'

const SUPPORT = 'support@fgac.ai'

/** Enterprise has no fake door — a real conversation is the product. The
    click is still counted under `pricing_plan_clicked` so it sits in the same
    breakdown as the other plans. */
export function EnterpriseCta() {
  return (
    <a
      href={`mailto:${SUPPORT}?subject=${encodeURIComponent('FGAC.ai Enterprise')}`}
      onClick={() =>
        posthog.capture('pricing_plan_clicked', {
          plan: 'enterprise',
          interval: 'contract',
          pricing_variant: PRICING_VARIANT,
        })
      }
      className="shrink-0 rounded-sm border border-surface-inverse-foreground/40 px-5 py-3 text-center text-[15px] font-semibold text-primary-foreground hover:border-primary-foreground"
    >
      Contact us
    </a>
  )
}
