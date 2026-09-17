'use client'

import { SignUpButton } from '@clerk/nextjs'
import posthog from 'posthog-js'

/**
 * Clerk sign-up button with funnel instrumentation: clicking any sign-up CTA
 * captures `sign_up_started`; the Clerk `user.created` webhook captures
 * `sign_up_completed`. The drop-off between the two is the abandoned-sign-up
 * rate (the modal + Google OAuth steps in between are Clerk-internal and not
 * individually observable).
 */
export function SignUpCta({
  location,
  className,
  children,
}: {
  location: 'nav' | 'hero' | 'bottom_cta' | 'pricing_personal'
  className: string
  children: React.ReactNode
}) {
  return (
    <SignUpButton mode="modal" fallbackRedirectUrl="/dashboard" signInFallbackRedirectUrl="/dashboard">
      <button
        className={className}
        onClick={() => posthog.capture('sign_up_started', { cta_location: location })}
      >
        {children}
      </button>
    </SignUpButton>
  )
}
