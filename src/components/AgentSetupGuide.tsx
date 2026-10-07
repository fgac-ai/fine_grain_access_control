import Link from "next/link";
import { ArrowRight, Check, X } from "lucide-react";
import { CopyButton } from "@/app/setup/CopyButton";

/* Shared layout for the self-hosted agent landing pages (/openclaw, /hermes).
   Both target "connect <agent> to Gmail safely" searches and land on the
   hosted MCP server — no local scripts, the same OAuth flow as every other
   client, so usage shows up under the client's name in MCP analytics. */

export type SetupStep = {
  title: string;
  body: React.ReactNode;
  code?: string;
  codeLabel?: string;
};

const COMPARISON: { label: string; fullAccess: boolean; fgac: boolean }[] = [
  { label: "Reads, drafts, and edits your Gmail, Docs, and Sheets", fullAccess: true, fgac: true },
  { label: "Hides 2FA codes, password resets, and mail you mark sensitive", fullAccess: false, fgac: true },
  { label: "Sends only to recipients you whitelisted", fullAccess: false, fgac: true },
  { label: "Sees only the files you exposed, not your whole Drive", fullAccess: false, fgac: true },
  { label: "Asks you with a one-click approval link instead of failing", fullAccess: false, fgac: true },
  { label: "Your Google token never sits on the agent's machine", fullAccess: false, fgac: true },
  { label: "Revoke the agent in one click without touching Google", fullAccess: false, fgac: true },
];

export function AgentSetupGuide({
  agentName,
  headline,
  intro,
  steps,
  footnote,
}: {
  agentName: string;
  headline: string;
  intro: React.ReactNode;
  steps: SetupStep[];
  footnote?: React.ReactNode;
}) {
  return (
    <div className="pb-24">
      <div className="border-b border-border bg-card px-6 py-16 sm:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="mb-3.5 text-[34px] font-extrabold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[42px]">
            {headline}
          </h1>
          <p className="mx-auto max-w-[620px] text-[17px] leading-relaxed text-muted-foreground">
            {intro}
          </p>
        </div>
      </div>

      <div className="mx-auto mt-12 flex max-w-3xl flex-col gap-8 px-6 sm:px-8">
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-bold text-foreground">
            Set up {agentName} in {steps.length} steps
          </h2>
          <ol className="m-0 flex list-none flex-col gap-6 p-0">
            {steps.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="mb-1.5 font-semibold text-foreground">{step.title}</h3>
                  <div className="text-sm leading-relaxed text-muted-foreground">{step.body}</div>
                  {step.code && (
                    <div className="mt-3 overflow-x-auto rounded-sm bg-surface-inverse p-4 font-mono text-sm text-surface-inverse-foreground">
                      <div className="flex min-w-0 items-start justify-between gap-4">
                        <code className="whitespace-pre text-primary">{step.code}</code>
                        <CopyButton
                          value={step.code}
                          label={step.codeLabel ?? `Copy ${step.title}`}
                          className="rounded-sm bg-foreground/10 p-1.5 text-muted-foreground hover:text-surface-inverse-foreground"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {footnote && (
            <p className="mt-6 text-xs leading-relaxed text-subtle">{footnote}</p>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-1 text-xl font-bold text-foreground">
            Why not a full-access Google skill?
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
            The popular Google Workspace skills hand {agentName} your whole
            account. That&apos;s a lot to trust to an always-on agent that reads
            untrusted email all day: one injected instruction is enough to
            forward your inbox somewhere else.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-subtle">
                  <th className="py-2 pr-4 font-semibold">What {agentName} gets</th>
                  <th className="px-3 py-2 text-center font-semibold">Full-access skill</th>
                  <th className="px-3 py-2 text-center font-semibold">FGAC</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.label} className="border-b border-border last:border-0">
                    <td className="py-2.5 pr-4 text-muted-foreground">{row.label}</td>
                    <td className="px-3 py-2.5 text-center">
                      <Mark yes={row.fullAccess} />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <Mark yes={row.fgac} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="text-center">
          <Link
            href="/setup"
            className="inline-flex items-center gap-2 rounded-sm bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            See every setup option
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

function Mark({ yes }: { yes: boolean }) {
  return yes ? (
    <Check className="mx-auto h-4 w-4 text-primary" aria-label="Yes" />
  ) : (
    <X className="mx-auto h-4 w-4 text-subtle" aria-label="No" />
  );
}
