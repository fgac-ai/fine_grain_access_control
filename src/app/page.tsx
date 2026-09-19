import { Show } from '@clerk/nextjs';
import Link from 'next/link';
import { SignUpCta } from './SignUpCta';
import { Shield } from 'lucide-react';
import { TrackedVideoEmbed } from '@/components/TrackedVideoEmbed';

/* ─── Landing ─────────────────────────────────────────────────────────────
   Nav and footer come from the root layout, so this file is the page body
   only. All colors are design tokens (globals.css) — no raw hex. */

const heroCta =
  'rounded-sm bg-primary px-7 py-3 text-[15px] font-semibold text-primary-foreground hover:opacity-90';

export default async function LandingPage() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="px-6 pt-16 pb-16 text-center sm:px-8 sm:pt-20">
        <div className="mx-auto flex max-w-[880px] flex-col items-center gap-6">
          <div className="flex flex-wrap justify-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-gmail-border bg-gmail-bg px-3 py-1 text-[13px] font-semibold text-gmail">
              <span className="h-[7px] w-[7px] rounded-full bg-gmail" />
              Gmail
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sheets-border bg-sheets-bg px-3 py-1 text-[13px] font-semibold text-sheets">
              <span className="h-[7px] w-[7px] rounded-full bg-sheets" />
              Google Sheets
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-docs-border bg-docs-bg px-3 py-1 text-[13px] font-semibold text-docs">
              <span className="h-[7px] w-[7px] rounded-full bg-docs" />
              Google Docs — new
            </span>
          </div>

          <h1 className="text-[40px] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground sm:text-[60px]">
            Your agents can work your{' '}
            <span className="text-primary">Docs, Sheets and Gmail.</span>
            <br />
            You hold the keys.
          </h1>

          <p className="mx-auto max-w-[640px] text-[17px] leading-[1.55] text-muted-foreground sm:text-[19px]">
            Read and write Google Sheets and Docs. Send email from Gmail — even
            across multiple accounts. Every request passes through your rules
            first.
          </p>

          <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-center">
            <Show when="signed-out">
              <SignUpCta location="hero" className={heroCta}>Get Started — it&apos;s free</SignUpCta>
            </Show>
            <Show when="signed-in">
              <Link href="/dashboard" className={`${heroCta} inline-block`}>
                Go to Dashboard
              </Link>
            </Show>
            <Link
              href="/setup"
              className="rounded-sm border border-border bg-card px-7 py-3 text-[15px] font-semibold text-foreground hover:border-ring"
            >
              Setup Guide
            </Link>
          </div>

        </div>

        {/* Demo videos, framed as browser windows — stacked and outside the
            880px text column so they match the 1120px card grid below, keeping
            titles and content legible */}
        <div className="mx-auto mt-12 grid w-full max-w-[1120px] gap-6 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-2.5 shadow-lg">
            <div className="flex items-center gap-1.5 px-1.5 pb-2.5 pt-0.5">
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
              <span className="flex-1 text-center font-mono text-[15px] font-semibold text-foreground">
                FGAC × Google Sheets — demo
              </span>
            </div>
            <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-surface-inverse">
              <TrackedVideoEmbed
                src="https://share.descript.com/embed/Fv9pwXugLUa"
                title="FGAC Google Sheets demo"
              />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-2.5 shadow-lg">
            <div className="flex items-center gap-1.5 px-1.5 pb-2.5 pt-0.5">
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
              <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
              <span className="flex-1 text-center font-mono text-[15px] font-semibold text-foreground">
                Multiple Gmail accounts — demo
              </span>
            </div>
            <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-surface-inverse">
              <TrackedVideoEmbed
                src="https://share.descript.com/embed/ZQ0snxtpdAK"
                title="FGAC multiple Gmail accounts demo"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── What it does ──────────────────────────────────────────────── */}
      <section className="px-6 pb-16 pt-4 sm:px-8">
        <div className="mx-auto grid max-w-[1120px] gap-5 md:grid-cols-3">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-7">
            <span className="self-start rounded-full border border-sheets-border bg-sheets-bg px-2.5 py-0.5 text-[12px] font-semibold text-sheets">
              Sheets
            </span>
            <h3 className="text-[19px] font-bold tracking-[-0.01em] text-foreground">
              Read &amp; write Sheets — only the ones you pick
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Expose individual spreadsheets with the Google Picker. Grant
              read-only or read/write per sheet, per agent. Everything else stays
              invisible.
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-2 rounded-sm bg-surface-inverse px-3.5 py-3 font-mono text-[13px] text-surface-inverse-foreground">
              <span className="font-semibold text-primary">sheets_write</span>
              <span>Q3 Pipeline</span>
              <span className="rounded-xs bg-success px-1.5 py-px text-[11px] text-success-foreground">
                ✓ allowed
              </span>
            </div>
            <Link
              href="/use-cases/google-sheets-agent"
              className="text-sm font-semibold text-primary hover:underline"
            >
              See the Sheets guide →
            </Link>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-7">
            <span className="self-start rounded-full border border-gmail-border bg-gmail-bg px-2.5 py-0.5 text-[12px] font-semibold text-gmail">
              Gmail
            </span>
            <h3 className="text-[19px] font-bold tracking-[-0.01em] text-foreground">
              Send with Gmail — to an allowlist you control
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Agents send real email from your address, but only to recipients
              and domains you approve. 2FA codes and password resets are never
              readable.
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-2 rounded-sm bg-surface-inverse px-3.5 py-3 font-mono text-[13px] text-surface-inverse-foreground">
              <span className="font-semibold text-primary">gmail_send</span>
              <span>→ intern@evil.co</span>
              <span className="rounded-xs bg-error px-1.5 py-px text-[11px] text-error-foreground">
                ✕ blocked
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-7">
            <span className="self-start rounded-full border border-brand-purple/25 bg-brand-purple/10 px-2.5 py-0.5 text-[12px] font-semibold text-brand-purple">
              Multi-account
            </span>
            <h3 className="text-[19px] font-bold tracking-[-0.01em] text-foreground">
              Many inboxes, one agent
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Family or teammates delegate their Gmail from their own dashboard.
              Your agent switches inboxes with a single parameter — each under
              its own rules.
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-2 rounded-sm bg-surface-inverse px-3.5 py-3 font-mono text-[13px] text-surface-inverse-foreground">
              <span className="font-semibold text-primary">gmail_list</span>
              <span>account=mom@gmail.com</span>
            </div>
            <Link
              href="/use-cases/multiple-gmail-accounts"
              className="text-sm font-semibold text-primary hover:underline"
            >
              See the multi-account guide →
            </Link>
          </div>
        </div>
      </section>

      {/* ── Three steps ───────────────────────────────────────────────── */}
      <section className="border-y border-border bg-card px-6 py-16 sm:px-8">
        <div className="mx-auto max-w-[1120px]">
          <h2 className="mb-10 text-center text-[28px] font-extrabold tracking-[-0.02em] text-foreground">
            Live in three steps
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            <div className="flex flex-col gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-muted text-sm font-bold text-primary">
                1
              </span>
              <h3 className="text-base font-bold text-foreground">
                Add one MCP URL
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Claude Code, Cursor, Windsurf, Claude Desktop — same URL
                everywhere:{' '}
                <code className="rounded-xs border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
                  fgac.ai/api/mcp
                </code>
              </p>
            </div>
            <div className="flex flex-col gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-muted text-sm font-bold text-primary">
                2
              </span>
              <h3 className="text-base font-bold text-foreground">
                Sign in with Google
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Your agent opens a browser to link your account. It connects
                with safe defaults: read-only, nothing else until you allow it.
              </p>
            </div>
            <div className="flex flex-col gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-muted text-sm font-bold text-primary">
                3
              </span>
              <h3 className="text-base font-bold text-foreground">
                Set your rules
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Pick sheets to expose, allowlist send targets, block sensitive
                reads. Rules are reusable across agent profiles.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Google data usage ─────────────────────────────────────────── */}
      <section className="px-6 py-16 sm:px-8">
        <div className="mx-auto max-w-[1120px]">
          <div className="mb-9 text-center">
            <div className="mb-3.5 inline-flex h-11 w-11 items-center justify-center rounded-md bg-primary-muted">
              <Shield className="h-[22px] w-[22px] text-primary" />
            </div>
            <h2 className="mb-2.5 text-[28px] font-extrabold tracking-[-0.02em] text-foreground">
              How we use Google Data
            </h2>
            <p className="mx-auto max-w-[720px] text-[15px] leading-[1.65] text-muted-foreground">
              FGAC.ai requests Gmail and per-file Drive scopes — covering Sheets
              and Docs — to act as a secure proxy between Google and your AI
              agents. Every request is checked against your rules before it is
              forwarded — verbatim — to Google.
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-6">
              <h3 className="mb-1.5 text-[15px] font-bold text-foreground">
                Nothing stored
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                We never permanently store your email or spreadsheet content.
                Requests pass through; your data doesn&apos;t stay.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6">
              <h3 className="mb-1.5 text-[15px] font-bold text-foreground">
                Never trained on
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Your data is never used to train AI models, and no humans read
                your mail or sheets. Ever.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6">
              <h3 className="mb-1.5 text-[15px] font-bold text-foreground">
                Limited Use compliant
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Our use of Google API data adheres to the{' '}
                <Link href="/privacy" className="text-primary underline">
                  Google API Services User Data Policy
                </Link>
                , including the Limited Use requirements.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Closing CTA ───────────────────────────────────────────────── */}
      <section className="px-6 pb-20 pt-2 text-center sm:px-8">
        <h2 className="mb-2 text-[30px] font-extrabold tracking-[-0.02em] text-foreground">
          Deny by default. Allow on your terms.
        </h2>
        <p className="mb-6 text-base text-muted-foreground">
          Free to start — connected in under a minute.{' '}
          <Link href="/pricing" className="underline underline-offset-2 hover:text-foreground">
            See pricing
          </Link>
          .
        </p>
        <Show when="signed-out">
          <SignUpCta
            location="bottom_cta"
            className="rounded-sm bg-primary px-8 py-3.5 text-[15px] font-semibold text-primary-foreground hover:opacity-90"
          >
            Get Started
          </SignUpCta>
        </Show>
        <Show when="signed-in">
          <Link
            href="/dashboard"
            className="inline-block rounded-sm bg-primary px-8 py-3.5 text-[15px] font-semibold text-primary-foreground hover:opacity-90"
          >
            Go to Dashboard
          </Link>
        </Show>
      </section>
    </>
  );
}
