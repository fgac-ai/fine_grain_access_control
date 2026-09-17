import {
  ClerkProvider,
  Show,
  UserButton
} from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import Link from 'next/link';
import { PostHogProviderWrapper } from './providers';
import SuspendedPostHogPageView from './PostHogPageView';
import PostHogIdentify from './PostHogIdentify';
import { SignUpCta } from './SignUpCta';
import { DirectoryCta } from './DirectoryCta';
import { NavLink } from './NavLink';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: 'FGAC.ai | Fine Grain Access Control for AI',
  description: 'Fine Grain Access Control proxy for AI Agents using Google APIs.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className={`${geist.variable} ${jetbrainsMono.variable} font-sans h-full bg-background text-foreground antialiased`}>
        <ClerkProvider>
          <div className="min-h-full flex flex-col">
            {/* Site-wide announcement bar — wording is deliberately
                descriptive ("available in"): Anthropic's directory terms bar
                partnership/endorsement claims, and there is no official badge
                program to borrow assets from. */}
            <DirectoryCta
              location="announcement_bar"
              className="block bg-primary px-4 py-2 text-center text-[13px] font-medium text-primary-foreground hover:opacity-90"
            >
              <span className="mr-2 rounded-full bg-primary-foreground/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
                New
              </span>
              FGAC.ai is now available in the Claude connectors directory{' '}
              <span aria-hidden>&rarr;</span>
            </DirectoryCta>
            <nav className="border-b border-border bg-card">
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="flex h-16 items-center justify-between gap-6">
                  <div className="flex items-center gap-10 min-w-0">
                    <Link href="/" className="flex items-center gap-2 shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/logo-v2.png" alt="" className="h-8 w-8" />
                      <span className="text-base font-bold tracking-tight text-foreground">FGAC.ai</span>
                    </Link>

                    <div className="hidden sm:flex items-center gap-7">
                      {/* Clerk's <Show> takes a single child, so the two links
                          are wrapped rather than passed as siblings. */}
                      <Show when="signed-in">
                        <div className="flex items-center gap-7">
                          <NavLink href="/dashboard">Agent Profiles</NavLink>
                          <NavLink href="/dashboard/accounts">Accounts</NavLink>
                        </div>
                      </Show>
                      <NavLink href="/setup">Setup Guide</NavLink>
                      <NavLink href="/docs">Docs</NavLink>
                      <NavLink href="/pricing">Pricing</NavLink>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <Show when="signed-out">
                      <SignUpCta location="nav" className="rounded-sm bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90">Sign Up</SignUpCta>
                    </Show>
                    <Show when="signed-in">
                      <UserButton
                        userProfileProps={{
                          additionalOAuthScopes: {
                            google: ['https://www.googleapis.com/auth/gmail.modify']
                          }
                        }}
                      />
                    </Show>
                  </div>
                </div>

                {/* Nav links wrap below the logo on small screens rather than
                    disappearing — Accounts is not reachable any other way. */}
                <div className="sm:hidden flex items-center gap-6 pb-3">
                  <Show when="signed-in">
                    <div className="flex items-center gap-6">
                      <NavLink href="/dashboard">Agent Profiles</NavLink>
                      <NavLink href="/dashboard/accounts">Accounts</NavLink>
                    </div>
                  </Show>
                  <NavLink href="/setup">Setup Guide</NavLink>
                  <NavLink href="/docs">Docs</NavLink>
                  <NavLink href="/pricing">Pricing</NavLink>
                </div>
              </div>
            </nav>

            <main className="flex-1">
              <PostHogProviderWrapper>
                <SuspendedPostHogPageView />
                <PostHogIdentify />
                {children}
              </PostHogProviderWrapper>
            </main>

            <footer className="bg-card border-t border-border">
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 flex flex-col sm:flex-row justify-between items-center text-sm text-muted-foreground gap-4 sm:gap-0">
                <p>&copy; {new Date().getFullYear()} FGAC.ai. All rights reserved.</p>
                <div className="flex flex-wrap justify-center gap-x-8 gap-y-2">
                  <Link href="/docs" className="hover:text-foreground">Docs</Link>
                  <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
                  <Link href="/use-cases/google-sheets-agent" className="hover:text-foreground">Sheets Guide</Link>
                  <Link href="/use-cases/multiple-gmail-accounts" className="hover:text-foreground">Multi-Account Guide</Link>
                  <Link href="/privacy" className="hover:text-foreground">Privacy Policy</Link>
                  <Link href="/terms" className="hover:text-foreground">Terms of Service</Link>
                </div>
              </div>
            </footer>
          </div>
        </ClerkProvider>
      </body>
    </html>
  );
}
