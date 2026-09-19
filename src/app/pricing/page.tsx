import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { PricingPlans } from './PricingPlans';
import { PricingFaq } from './PricingFaq';

export const metadata = {
  title: 'Pricing | fgac.ai',
  description:
    'Free for occasional use. Pro is $5 a month or $30 a year per person, with unlimited requests. Enterprise adds BAA, SOC 2 and vendor paperwork.',
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
            Free to try.
            <br />
            $5 a month when it earns its keep.
          </h1>
          <p className="text-[17px] leading-[1.55] text-muted-foreground">
            Every plan has the same rules engine and the same promise: your
            data passes through and is never stored. Pro is one flat price per
            person — every Google account, every agent, no counting.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="px-6 sm:px-8">
        <div className="mx-auto max-w-[1120px]">
          <PricingPlans signedIn={signedIn} />
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
          Start free. Nothing to cancel.
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
