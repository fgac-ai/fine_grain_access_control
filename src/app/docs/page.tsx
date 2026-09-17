import Link from "next/link";
import { ArrowRight, BookOpen, Eye, PenLine } from "lucide-react";
import { DirectoryCta } from "../DirectoryCta";

export const metadata = {
  title: "Documentation | fgac.ai",
  description:
    "How to use FGAC with Claude and other MCP clients: tools, example prompts, expected outcomes, limitations, and support.",
};

/* ─── Public product documentation ──────────────────────────────────────
   This page is the documentation URL for the Anthropic Connectors
   Directory listing: product summary, example prompts with expected
   outcomes, tool reference, limitations, and support contact.
   Connect steps live on /setup. Design tokens only — no raw hex. */

const READ_TOOLS: Array<[string, string]> = [
  ["list_accounts", "Lists the inboxes this connection can reach"],
  ["gmail_list", "Lists recent messages, with optional Gmail search query"],
  ["gmail_read", "Reads one message: headers, body text, attachment list"],
  ["gmail_get_attachment", "Downloads an attachment (up to ~150 KB)"],
  ["gmail_labels", "Lists the account's Gmail labels"],
  ["sheets_get_spreadsheet", "Spreadsheet metadata and sheet tabs"],
  ["sheets_read_range", "Reads cell values from a range"],
  ["docs_read_document", "Reads a Google Doc (optionally trimmed by a field mask)"],
  ["slides_get_presentation", "Reads a Google Slides presentation (optionally trimmed by a field mask)"],
  ["comments_read", "Lists the comments and replies on a doc, sheet or presentation"],
  ["get_my_permissions", "Shows the rules that govern this connection"],
  ["google_api_get", "Any Google API read endpoint, rule-checked (others limited by your Google grant)"],
  ["request_access", "Asks you to approve a specific permission upgrade"],
];

const WRITE_TOOLS: Array<[string, string]> = [
  ["gmail_send", "Sends mail — recipients must be on your send whitelist"],
  ["sheets_update_range", "Overwrites cells — needs Read & Write on the sheet"],
  ["sheets_append_rows", "Appends rows — needs Read & Write on the sheet"],
  ["docs_edit", "Edits a doc via Docs batchUpdate (text, tables, styles) — needs Read & Write"],
  ["slides_edit", "Edits a presentation via Slides batchUpdate (slides, shapes, text) — needs Read & Write"],
  ["sheets_edit", "Formats/restructures a sheet via Sheets batchUpdate — needs Read & Write"],
  ["comments_add", "Adds a comment or reply on a doc, sheet or presentation — needs Read & Write"],
  ["google_api_modify", "Write endpoints incl. Docs/Sheets/Slides batchUpdate and file creation, rule-checked"],
];

const EXAMPLES: Array<{
  prompt: string;
  outcome: string;
  denied?: boolean;
}> = [
  {
    prompt: "Summarize my unread email.",
    outcome:
      "Claude lists and reads recent unread messages and summarizes them. Any message blocked by your rules (a blacklisted label, or content matching a block pattern like a 2FA code) is withheld — Claude sees an “FGAC read rule … blocked this message” notice instead of the message.",
  },
  {
    prompt: "Read the latest message from my bank.",
    denied: true,
    outcome:
      "If your rules block financial mail (by label or content pattern), Claude receives “🚫 FGAC read rule '…' blocked this message” and tells you it can't read that message. The denial names the rule, states that FGAC (not the agent) made the decision, and links the dashboard so you know which grant to change if you actually wanted access.",
  },
  {
    prompt: "Email alex@example.com a short status update.",
    outcome:
      "If alex@example.com matches your send whitelist, the mail is sent and Claude confirms with the Gmail message id. If not, nothing is sent — Claude is told the recipient isn't whitelisted and to ask you to add it in the dashboard.",
  },
  {
    prompt: "What's in the Budget tab of my planning spreadsheet?",
    outcome:
      "Claude reads the exposed spreadsheet and reports the cell values. Spreadsheets you haven't exposed on the agent's profile are denied by default — Claude is told the sheet isn't exposed rather than seeing any data.",
  },
  {
    prompt: "Log today's totals as a new row in the tracking sheet.",
    outcome:
      "With Read & Write enabled on that spreadsheet, Claude appends the row and confirms the updated range. If the sheet is read-only, the write is refused with a clear read-only message and no data changes.",
  },
  {
    prompt: "Append today's meeting notes to my running notes doc.",
    outcome:
      "Google Docs work like Sheets: expose a document in the picker, and with Read & Write enabled Claude appends the notes and confirms. Documents you haven't exposed are denied by default, and a denial includes a one-click approval link so granting access takes seconds.",
  },
];

function ToolTable({
  icon,
  title,
  note,
  tools,
}: {
  icon: React.ReactNode;
  title: string;
  note: string;
  tools: Array<[string, string]>;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        {icon}
        <h3 className="font-semibold text-foreground">{title}</h3>
        <span className="ml-auto hidden text-xs text-subtle sm:block">{note}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {tools.map(([name, desc]) => (
          <li
            key={name}
            className="flex flex-col gap-0.5 border-b border-border px-5 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
          >
            <code className="shrink-0 font-mono text-[13px] font-semibold text-primary sm:w-52">
              {name}
            </code>
            <span className="text-[13px] leading-relaxed text-muted-foreground">
              {desc}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="pb-24">
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <div className="border-b border-border bg-card px-6 py-16 sm:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-[13px] font-semibold text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" />
            Documentation
          </div>
          <h1 className="mb-3.5 text-[34px] font-extrabold leading-[1.1] tracking-[-0.03em] text-foreground sm:text-[44px]">
            Using FGAC with your agent
          </h1>
          <p className="mx-auto max-w-[620px] text-[17px] leading-relaxed text-muted-foreground">
            FGAC.ai is a permission layer between AI agents and your Google
            account. Agents connect once over MCP; every Gmail, Sheets, and
            Docs request they make is checked against rules you control — deny
            by default, allow on your terms.
          </p>
          <p className="mt-5 text-sm text-muted-foreground">
            Not connected yet?{" "}
            <Link href="/setup" className="text-primary underline underline-offset-2">
              Follow the three-step setup guide
            </Link>
            . See also:{" "}
            <Link href="/use-cases/multiple-gmail-accounts" className="text-primary underline underline-offset-2">
              multiple Gmail accounts
            </Link>{" "}
            ·{" "}
            <Link href="/use-cases/google-sheets-agent" className="text-primary underline underline-offset-2">
              Google Sheets agents
            </Link>
          </p>
        </div>
      </div>

      <div className="mx-auto mt-14 flex max-w-3xl flex-col gap-14 px-6 sm:px-8">
        {/* ── Example prompts ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-5">
          <div>
            <h2 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
              Example prompts
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              What to say to Claude (or any MCP agent), and what to expect —
              including what a denial looks like.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {EXAMPLES.map((ex) => (
              <div
                key={ex.prompt}
                className="rounded-lg border border-border bg-card p-5"
              >
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  <span className="rounded-sm bg-surface-inverse px-3 py-1.5 font-mono text-[13px] text-surface-inverse-foreground">
                    “{ex.prompt}”
                  </span>
                  {ex.denied && (
                    <span className="rounded-full border border-warning-foreground bg-warning px-2.5 py-0.5 text-xs font-bold text-warning-foreground">
                      shows a denial
                    </span>
                  )}
                </div>
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {ex.outcome}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Tool reference ──────────────────────────────────────────── */}
        <section className="flex flex-col gap-5">
          <div>
            <h2 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
              Tool reference
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Read-only tools can run without per-call confirmation in Claude;
              write tools always ask first. Every tool is additionally checked
              against your FGAC rules on our servers.
            </p>
          </div>

          <ToolTable
            icon={<Eye className="h-4 w-4 text-foreground" />}
            title="Read-only tools"
            note="run without confirmation prompts"
            tools={READ_TOOLS}
          />
          <ToolTable
            icon={<PenLine className="h-4 w-4 text-foreground" />}
            title="Write tools"
            note="Claude asks before each call"
            tools={WRITE_TOOLS}
          />

          <p className="text-[13px] leading-relaxed text-muted-foreground">
            <code className="font-mono text-xs text-primary">google_api_get</code>{" "}
            and{" "}
            <code className="font-mono text-xs text-primary">
              google_api_modify
            </code>{" "}
            cover the long tail of the{" "}
            <a
              href="https://developers.google.com/gmail/api/reference/rest"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              Gmail API
            </a>{" "}
            and{" "}
            <a
              href="https://developers.google.com/sheets/api/reference/rest"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              Sheets API
            </a>{" "}
            without loosening anything: raw reads pass the same read rules, the
            only raw Gmail write is <em>send</em> (whitelist-checked), Sheets,
            Docs and Slides writes (including <em>batchUpdate</em>{" "}and file
            creation) need the same Read &amp; Write grants, and endpoints outside those
            services are bounded by the narrow Google OAuth scopes FGAC holds.
          </p>
        </section>

        {/* ── Limitations ─────────────────────────────────────────────── */}
        <section className="flex flex-col gap-5">
          <div>
            <h2 className="text-2xl font-bold tracking-[-0.01em] text-foreground">
              Limitations
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Most of these are safety guarantees, not gaps.
            </p>
          </div>

          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {[
              ["Gmail, Google Sheets, Google Docs, and Google Slides are the enforced services.", "Requests to other Google services are limited by the narrow OAuth scopes FGAC holds — Drive access, for example, covers only files you picked or the agent created (drive.file), and services like Calendar or Contacts fail at Google without a granted scope. Rule enforcement arrives service by service."],
              ["Agents can never delete.", "No tool exposes DELETE. Trash, empty-trash, and destructive Gmail settings are refused regardless of your rules."],
              ["Sending requires a whitelist.", "With no send-whitelist rule configured, all outbound mail is refused. That's the default. When a send is denied, you get a one-click, single-use link to approve exactly that recipient — or the agent can ask via request_access."],
              ["New connections start read-only.", "Connecting attaches the agent to your Default Profile: it can read this account's mail — plus any inbox its owner has delegated to you — and nothing else: no sending, no Sheets, Docs or Slides, no undelegated inboxes. You can review, re-scope, or block it from the dashboard at any time."],
              ["Attachments cap at ~150 KB", "through MCP responses. Larger files must be fetched from Gmail directly."],
              ["Delegated inboxes need an explicit delegation", "created by the inbox owner from their own FGAC account, revocable any time. Once granted, the inbox attaches to your Default Profile automatically."],
            ].map(([lead, rest]) => (
              <li
                key={lead}
                className="rounded-md border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-muted-foreground"
              >
                <strong className="text-foreground">{lead}</strong> {rest}
              </li>
            ))}
          </ul>
        </section>

        {/* ── Support ─────────────────────────────────────────────────── */}
        <section className="rounded-lg border border-border bg-card p-6 text-center sm:p-8">
          <h2 className="mb-1.5 text-xl font-bold tracking-[-0.01em] text-foreground">
            Support
          </h2>
          <p className="mx-auto mb-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Questions, bug reports, or access issues — email{" "}
            <a
              href="mailto:support@fgac.ai"
              className="text-primary underline underline-offset-2"
            >
              support@fgac.ai
            </a>
            . See also the{" "}
            <Link href="/privacy" className="text-primary underline underline-offset-2">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/terms" className="text-primary underline underline-offset-2">
              Terms of Service
            </Link>
            . On claude.ai? FGAC.ai is available in the{" "}
            <DirectoryCta
              location="docs_support"
              className="text-primary underline underline-offset-2"
            >
              Claude connectors directory
            </DirectoryCta>
            .
          </p>
          <Link
            href="/setup"
            className="inline-flex items-center gap-2 rounded-sm bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Get connected
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </div>
    </div>
  );
}
