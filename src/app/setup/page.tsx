import React from "react";
import Link from "next/link";
import { Terminal, ChevronRight, ArrowRight, Sparkles } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { DirectoryCta } from "../DirectoryCta";

export const metadata = {
  title: "Setup & Integration | fgac.ai",
  description:
    "Connect AI agents to fgac.ai — one click from the Claude connectors directory, or one URL in Claude Code, Cursor, Windsurf, and Claude Desktop.",
};

const MCP_URL = "https://fgac.ai/api/mcp";
const CLAUDE_CODE_CMD = `claude mcp add \\
  --transport http \\
  fgac https://fgac.ai/api/mcp`;

/* ─── Page ───────────────────────────────────────────────────────────────
   Nav and footer come from the root layout; this file is the page body only.
   All colors are design tokens (globals.css) — no raw hex. */

function StepHeading({
  number,
  title,
  subtitle,
}: {
  number: string;
  title: React.ReactNode;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground">
        {number}
      </span>
      <div>
        <h2 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

export default function SetupPage() {
  return (
    <div className="pb-24">
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <div className="border-b border-border bg-card px-6 py-16 sm:px-8 sm:py-[72px]">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 flex flex-wrap justify-center gap-2.5">
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
              Google Docs
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slides-border bg-slides-bg px-3 py-1 text-[13px] font-semibold text-slides">
              <span className="h-[7px] w-[7px] rounded-full bg-slides" />
              Google Slides
            </span>
          </div>

          <h1 className="mb-3.5 text-[34px] font-extrabold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[44px]">
            Connected in three steps
          </h1>
          <p className="mx-auto mb-6 max-w-[560px] text-[17px] leading-relaxed text-muted-foreground">
            Add FGAC as an MCP server, sign in with Google, and decide exactly
            what your agents can read, write, and send.
          </p>

          <div className="inline-flex items-center gap-2.5 rounded-sm bg-surface-inverse px-4 py-2.5 font-mono text-sm text-surface-inverse-foreground">
            {MCP_URL}
            <CopyButton
              value={MCP_URL}
              label="Copy MCP server URL"
              className="text-muted-foreground hover:text-surface-inverse-foreground"
            />
          </div>
          <p className="mt-3 text-xs text-subtle">
            Works with any MCP client — one URL everywhere.
          </p>
        </div>
      </div>

      <div className="mx-auto mt-14 flex max-w-3xl flex-col gap-14 px-6 sm:px-8">
        {/* ── Step 1 ──────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-6">
          <StepHeading
            number="1"
            title="Add the MCP server"
            subtitle="Pick your client — one click from the directory, or one URL everywhere else."
          />

          <div className="rounded-lg border border-primary/40 bg-card p-6">
            <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-background">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground">
                  Claude.ai &mdash; web, desktop &amp; mobile
                </h3>
              </div>
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-[12px] font-semibold text-primary">
                Easiest
              </span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              FGAC.ai is listed in the Claude connectors directory &mdash; no
              URLs to paste. Open the listing, click{" "}
              <strong>Connect</strong>, and jump straight to step 2.
            </p>
            <DirectoryCta
              location="setup_step1"
              className="mt-4 inline-flex items-center gap-2 rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Open FGAC.ai in the Claude directory
              <ArrowRight className="h-4 w-4" />
            </DirectoryCta>
          </div>

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-3.5 flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-sm border border-border bg-background">
                <Terminal className="h-4 w-4 text-foreground" />
              </div>
              <h3 className="font-semibold text-foreground">Claude Code</h3>
            </div>
            <div className="overflow-x-auto rounded-sm bg-surface-inverse p-4 font-mono text-sm text-surface-inverse-foreground">
              <div className="flex min-w-0 items-center justify-between gap-4">
                <code className="whitespace-pre text-primary">
                  {CLAUDE_CODE_CMD}
                </code>
                <CopyButton
                  value={CLAUDE_CODE_CMD}
                  label="Copy Claude Code command"
                  className="rounded-sm bg-foreground/10 p-1.5 text-muted-foreground hover:text-surface-inverse-foreground"
                />
              </div>
            </div>
            <p className="mt-3 text-xs text-subtle">
              Run this in any project directory. The server persists across
              sessions. Working per-project? Each agent profile has its own
              URL (<code className="font-mono">/api/mcp/&lt;profile&gt;</code>)
              that maps the connection to that profile automatically —{" "}
              <Link
                href="/use-cases/claude-code-per-project"
                className="text-primary underline underline-offset-2"
              >
                see the per-project guide
              </Link>
              .
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-md border border-border bg-card p-5">
              <h4 className="mb-2 text-sm font-semibold text-foreground">
                Cursor
              </h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open <strong>Settings → MCP Servers</strong>. Click{" "}
                <strong>Add new HTTP server</strong>. Paste the URL above.
              </p>
            </div>
            <div className="rounded-md border border-border bg-card p-5">
              <h4 className="mb-2 text-sm font-semibold text-foreground">
                Windsurf
              </h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open <strong>Settings → MCP</strong>. Click{" "}
                <strong>Add Server</strong>. Choose Streamable HTTP and paste the
                URL above.
              </p>
            </div>
            <div className="rounded-md border border-border bg-card p-5">
              <h4 className="mb-2 text-sm font-semibold text-foreground">
                Claude Desktop
              </h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Open <strong>Settings → Developer → MCP Servers</strong>. Add a
                new server with type <strong>&quot;url&quot;</strong> and paste
                the URL above.
              </p>
            </div>
          </div>

          <p className="text-center text-xs text-subtle">
            FGAC uses <strong>MCP Streamable HTTP</strong> with OAuth 2.1 (DCR +
            PKCE). Your client handles authentication automatically.
          </p>
        </section>

        {/* ── Step 2 ──────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-6">
          <StepHeading
            number="2"
            title={<>Sign in — you&apos;re connected</>}
            subtitle="Your agent triggers an OAuth flow. Signing in attaches it to your read-only Default Profile."
          />

          <div className="rounded-lg border border-border bg-card p-6">
            <ol className="flex list-none flex-col gap-4 p-0 text-sm text-foreground">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-muted text-xs font-bold text-primary">
                  A
                </span>
                <div>
                  <strong>Your agent tries to use a tool</strong>
                  <span className="text-muted-foreground">
                    {" "}
                    — a browser window opens asking you to sign in with Google.
                    This links your agent to your FGAC account. No API keys
                    needed.
                  </span>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-muted text-xs font-bold text-primary">
                  B
                </span>
                <div>
                  <strong>Safe defaults apply instantly</strong>
                  <span className="text-muted-foreground">
                    {" "}
                    — the agent attaches to your{" "}
                    <strong>Default Profile</strong>: it can read this
                    account&apos;s mail, and cannot send, edit, or delete.
                    Upgrade, re-scope, or block it any time in your{" "}
                    <Link
                      href="/dashboard"
                      className="text-primary underline underline-offset-2"
                    >
                      FGAC Dashboard
                    </Link>
                    .
                  </span>
                </div>
              </li>
            </ol>
          </div>

          <div className="rounded-md border border-border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-medium">
              <span className="rounded-sm border border-border bg-background px-3 py-1.5 text-muted-foreground">
                Agent connects
              </span>
              <ChevronRight className="h-3 w-3 shrink-0 text-subtle" />
              <span className="rounded-sm border border-border bg-background px-3 py-1.5 text-muted-foreground">
                OAuth sign-in
              </span>
              <ChevronRight className="h-3 w-3 shrink-0 text-subtle" />
              <span className="rounded-sm border border-warning-foreground bg-warning px-3 py-1.5 text-warning-foreground">
                Pending
              </span>
              <ChevronRight className="h-3 w-3 shrink-0 text-subtle" />
              <span className="rounded-sm border border-success-foreground bg-success px-3 py-1.5 text-success-foreground">
                ✓ Approved
              </span>
            </div>
          </div>
        </section>

        {/* ── Step 3 ──────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-6">
          <StepHeading
            number="3"
            title="Grant access, service by service"
            subtitle="Everything is denied until you allow it. Grants live on reusable agent profiles."
          />

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-start gap-3.5 border-b border-border px-6 py-5">
              <span className="mt-px shrink-0 rounded-full border border-sheets-border bg-sheets-bg px-2.5 py-0.5 text-xs font-bold text-sheets">
                Sheets, Docs &amp; Slides
              </span>
              <div>
                <strong className="text-sm text-foreground">
                  Expose spreadsheets, documents and presentations with the Google Picker
                </strong>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                  Click <strong>+ Expose a sheet</strong> (or a doc, or a
                  presentation) on a profile and pick files. Each file starts
                  read-only; enable write access per file when the agent needs it. Full walkthrough with video:{" "}
                  <Link
                    href="/use-cases/google-sheets-agent"
                    className="text-primary underline underline-offset-2"
                  >
                    let an agent update your Sheets
                  </Link>
                  .
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3.5 border-b border-border px-6 py-5">
              <span className="mt-px shrink-0 rounded-full border border-gmail-border bg-gmail-bg px-2.5 py-0.5 text-xs font-bold text-gmail">
                Gmail
              </span>
              <div>
                <strong className="text-sm text-foreground">
                  Read blocklist &amp; send whitelist
                </strong>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                  Regex rules hide sensitive mail — 2FA codes, password resets,
                  financial alerts. Sending only works to addresses and domains
                  you approve.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3.5 px-6 py-5">
              <span className="mt-px shrink-0 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-bold text-foreground">
                Profiles
              </span>
              <div>
                <strong className="text-sm text-foreground">
                  One profile per agent
                </strong>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                  Profiles bundle rules and grants into a scoped identity. Your
                  research agent and your inbox agent don&apos;t have to share
                  permissions — and each profile has its own MCP URL, so an
                  agent connecting through it lands on the right profile
                  automatically. See{" "}
                  <Link
                    href="/use-cases/claude-code-per-project"
                    className="text-primary underline underline-offset-2"
                  >
                    per-project profiles in Claude Code
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>

          <div className="text-center">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-sm bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Open Dashboard
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        {/* ── Multi-account ───────────────────────────────────────────── */}
        <section className="rounded-lg border border-brand-purple/25 bg-brand-purple/5 p-6 sm:p-8">
          <div className="mb-3.5 flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-brand-purple/25 bg-brand-purple/10 px-2.5 py-0.5 text-xs font-bold text-brand-purple">
              Multi-account
            </span>
            <h2 className="text-xl font-bold tracking-[-0.01em] text-foreground">
              Multiple Gmail accounts, one agent
            </h2>
          </div>
          <p className="mb-4 max-w-[580px] text-sm leading-[1.65] text-foreground">
            One agent connection can reach several inboxes. Other people delegate
            access from their own FGAC dashboard — no password sharing — and the
            inbox joins your Default Profile automatically. Your agent then
            targets it with the{" "}
            <code className="rounded-xs bg-brand-purple/10 px-1.5 py-0.5 font-mono text-xs text-brand-purple">
              account
            </code>{" "}
            parameter. Every delegation keeps its own rules and is revocable in
            one click. Step-by-step guide with video:{" "}
            <Link
              href="/use-cases/multiple-gmail-accounts"
              className="text-primary underline underline-offset-2"
            >
              connect multiple Gmail accounts
            </Link>
            .
          </p>
          <div className="flex flex-col gap-2.5">
            <div className="rounded-sm border border-border bg-card px-3.5 py-3 font-mono text-[13px]">
              <span className="mb-0.5 block text-[11px] text-subtle">
                Your inbox
              </span>
              <span className="font-semibold text-primary">gmail_list</span>
              <span className="text-subtle"> → returns your emails</span>
            </div>
            <div className="rounded-sm border border-border bg-card px-3.5 py-3 font-mono text-[13px]">
              <span className="mb-0.5 block text-[11px] text-subtle">
                Delegated inbox
              </span>
              <span className="font-semibold text-primary">gmail_list</span>{" "}
              <span className="text-subtle">account=</span>
              <span className="font-semibold text-brand-purple">
                boss@company.com
              </span>
            </div>
          </div>
        </section>

        {/* ── Use-case guides ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-5">
          <div className="text-center">
            <h2 className="mb-1 text-xl font-bold tracking-[-0.01em] text-foreground">
              Go deeper: use-case guides
            </h2>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              Step-by-step walkthroughs — each with a demo video — for the two
              most common setups.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Link
              href="/use-cases/google-sheets-agent"
              className="group rounded-lg border border-border bg-card p-6 hover:border-ring"
            >
              <span className="mb-2.5 inline-block rounded-full border border-sheets-border bg-sheets-bg px-2.5 py-0.5 text-xs font-bold text-sheets">
                Sheets
              </span>
              <h3 className="mb-1.5 text-[15px] font-bold text-foreground">
                Let an agent update your Google Sheets
              </h3>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Expose individual spreadsheets, grant read or read&nbsp;&amp;
                write per sheet, and keep the rest of Drive invisible.
              </p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary">
                Read the guide
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
            <Link
              href="/use-cases/multiple-gmail-accounts"
              className="group rounded-lg border border-border bg-card p-6 hover:border-ring"
            >
              <span className="mb-2.5 inline-block rounded-full border border-gmail-border bg-gmail-bg px-2.5 py-0.5 text-xs font-bold text-gmail">
                Gmail
              </span>
              <h3 className="mb-1.5 text-[15px] font-bold text-foreground">
                Multiple Gmail accounts, one agent
              </h3>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Work + personal inboxes, and mailboxes teammates delegate to
                you — each under its own rules, revocable in one click.
              </p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary">
                Read the guide
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
            <Link
              href="/use-cases/claude-code-per-project"
              className="group rounded-lg border border-border bg-card p-6 hover:border-ring sm:col-span-2"
            >
              <span className="mb-2.5 inline-block rounded-full border border-claude-border bg-claude-bg px-2.5 py-0.5 text-xs font-bold text-claude">
                Claude Code
              </span>
              <h3 className="mb-1.5 text-[15px] font-bold text-foreground">
                One profile per project in Claude Code
              </h3>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Scope FGAC to a single project directory and map it to a
                specific agent profile just by the MCP URL it connects to.
              </p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary">
                Read the guide
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </div>
        </section>

        {/* ── Alternative: proxy key ──────────────────────────────────── */}
        <section className="flex flex-col gap-5 border-t border-border pt-10">
          <div className="text-center">
            <h2 className="mb-1 text-base font-bold text-foreground">
              Alternative: Direct Proxy Key
            </h2>
            <p className="mx-auto max-w-md text-xs text-subtle">
              For agents that don&apos;t support MCP, create a proxy API key and
              use our downloadable skill files.
            </p>
          </div>

          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-ring"
            >
              Create Key in Dashboard
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
            <a
              href="/skills/claude-code/SKILL.md"
              target="_blank"
              className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-ring"
            >
              Claude Code SKILL.md
              <Terminal className="h-3.5 w-3.5" />
            </a>
            <a
              href="/skills/open-claw/SKILL.md"
              target="_blank"
              className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-border bg-card px-4 py-2 text-sm text-foreground hover:border-ring"
            >
              Open Claw SKILL.md
              <Terminal className="h-3.5 w-3.5" />
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
