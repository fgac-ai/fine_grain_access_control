import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { PricingPlans } from './PricingPlans';
import { PricingFaq } from './PricingFaq';
import { EnterpriseCta } from './EnterpriseCta';

export const metadata = {
  title: 'Pricing | fgac.ai',
  description:
    'One plan, everything included: $10 a month after a 30-day free trial. Teams per seat. Self-hosting is free for personal use.',
};

/* ─── Pricing ────────────────────────────────────────────────────────────────
   Fake-door page: prices are real, purchase is not wired. Nav and footer come
   from the root layout; this is the page body only. All colors are design
   tokens (globals.css) — no raw hex. */

export default async function PricingPage() {
  const { userId } = await auth();
  const signedIn = Boolean(userId);

  return (
    <div className="pb-24">
      {/* Header */}
      <section className="px-6 pt-16 pb-10 text-center sm:px-8">
        <div className="mx-auto max-w-[720px]">
          <h1 className="mb-3.5 text-[36px] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground sm:text-[48px]">
            One plan.
            <br />
            Everything included.
          </h1>
          <p className="text-[17px] leading-[1.55] text-muted-foreground">
            Try it free for 30 days, then $10 a month. No request meters, no
            per-account maths, nothing to count. Teams pay per seat. Your data
            passes through and is never stored, on every plan.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="px-6 sm:px-8">
        <div className="mx-auto max-w-[1120px]">
          <PricingPlans signedIn={signedIn} />
          <p className="mx-auto mt-6 max-w-[880px] text-center text-sm text-muted-foreground">
            Prefer to run it yourself? The code is open source and{' '}
            <Link
              href="https://github.com/fgac-ai/fine_grain_access_control/blob/main/LICENSE"
              className="text-primary underline underline-offset-2"
            >
              free to self-host for personal use
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Enterprise strip */}
      <section className="px-6 pt-8 sm:px-8">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-4 rounded-lg border border-border bg-surface-inverse p-7 text-surface-inverse-foreground md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-primary-foreground">Enterprise</h2>
            <p className="mt-1 max-w-[640px] text-sm leading-relaxed">
              The same gateway, deployed in your own VPC. Single sign-on, a
              data-processing agreement, and a security review with your team.
              Priced per contract.
            </p>
          </div>
          <EnterpriseCta />
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 pt-16 sm:px-8">
        <div className="mx-auto max-w-[760px]">
          <h2 className="mb-6 text-center text-[28px] font-extrabold tracking-[-0.02em] text-foreground">
            Questions people ask
          </h2>
          <PricingFaq />
        </div>
      </section>

      {/* Closing */}
      <section className="px-6 pt-16 text-center sm:px-8">
        <h2 className="mb-2 text-[26px] font-extrabold tracking-[-0.02em] text-foreground">
          Thirty days to decide. Nothing to cancel.
        </h2>
        <p className="mb-6 text-base text-muted-foreground">
          Connected in under a minute from the{' '}
          <Link href="/setup" className="text-primary underline underline-offset-2">
            setup guide
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
