import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { TrackedVideoEmbed } from "@/components/TrackedVideoEmbed";

export const metadata = {
  title: "Connect Multiple Gmail Accounts to Claude | fgac.ai",
  description:
    "Let Claude and other AI agents work across multiple Gmail accounts — work and personal inboxes, delegated team mailboxes — through one MCP connector, with per-inbox permission rules.",
};

/* SEO landing page (connector-growth Phase A): targets searches like
   "claude multiple gmail accounts", "AI agent work and personal email",
   "delegate inbox to AI assistant". */

export default function MultipleGmailAccountsPage() {
  return (
    <div className="pb-24">
      <div className="border-b border-border bg-card px-6 py-16 sm:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="mb-3.5 text-[34px] font-extrabold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[42px]">
            Multiple Gmail accounts, one AI agent
          </h1>
          <p className="mx-auto max-w-[620px] text-[17px] leading-relaxed text-muted-foreground">
            Connect Claude to your work and personal email at the same time —
            and to teammates&apos; inboxes they delegate to you — through a
            single FGAC connector. Every inbox keeps its own rules, and every
            delegation is revocable in one click.
          </p>
        </div>
      </div>

      <div className="mx-auto mt-12 flex max-w-3xl flex-col gap-8 px-6 sm:px-8">
        {/* Walkthrough video, framed as a browser window (matches the home-page demos) */}
        <div className="rounded-lg border border-border bg-card p-2.5 shadow-lg">
          <div className="flex items-center gap-1.5 px-1.5 pb-2.5 pt-0.5">
            <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
            <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
            <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
            <span className="flex-1 text-center font-mono text-[15px] font-semibold text-foreground">
              Multiple Gmail accounts — setup walkthrough
            </span>
          </div>
          <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-surface-inverse">
            <TrackedVideoEmbed
              src="https://share.descript.com/embed/ZQ0snxtpdAK"
              title="Setting up multiple Gmail accounts with FGAC"
            />
          </div>
        </div>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-3 text-xl font-bold text-foreground">How it works</h2>
          <ol className="m-0 flex list-decimal flex-col gap-2.5 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>
              Connect FGAC once ({" "}
              <Link href="/setup" className="text-primary underline underline-offset-2">
                three-step setup
              </Link>
              ). Your own inbox works immediately, read-only by default.
            </li>
            <li>
              Click <strong>+ Add account</strong> on your Accounts page and
              open the link it gives you signed in as the other Gmail account
              — your own second inbox, or a teammate&apos;s (send it to them).
              One click there delegates that inbox to you — no password
              sharing, no Google Workspace admin, no second FGAC account.
            </li>
            <li>
              That&apos;s it — the delegated inbox attaches to your Default
              Profile automatically, read-only like your own. Your agent
              targets any inbox with the{" "}
              <code className="rounded-xs bg-primary-muted px-1.5 py-0.5 font-mono text-xs text-primary">
                account
              </code>{" "}
              parameter: <em>&ldquo;Check my work email&rdquo;</em>,{" "}
              <em>&ldquo;Summarize unread mail in the support inbox&rdquo;</em>.
            </li>
          </ol>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Building a custom profile instead? Delegated inboxes stay opt-in
            there — pick the mailboxes when you create the profile. And when a
            delegation is revoked, the inbox disappears from every profile
            immediately.
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-3 text-xl font-bold text-foreground">
            Things people run across their inboxes
          </h2>
          <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>Morning triage across work + personal email in one prompt</li>
            <li>An EA-style agent over a delegated executive inbox</li>
            <li>A support agent reading a shared team mailbox, send-restricted to your domain</li>
            <li>Sweeping receipts and travel confirmations from every account into one Google Sheet</li>
          </ul>
          <p className="mt-4 text-sm text-muted-foreground">
            Each inbox keeps independent guardrails: read rules that hide
            sensitive mail, send whitelists per profile, and one-click
            revocation of any delegation.
          </p>
        </section>

        <div className="text-center">
          <Link
            href="/setup"
            className="inline-flex items-center gap-2 rounded-sm bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Connect your inboxes
            <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="mt-3 text-xs text-subtle">
            Free for personal use ·{" "}
            <Link href="/docs" className="underline hover:text-foreground">
              full documentation
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
