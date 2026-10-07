import Link from "next/link";
import { AgentSetupGuide } from "@/components/AgentSetupGuide";

export const metadata = {
  title: "Connect Hermes Agent to Gmail and Google Docs Safely | fgac.ai",
  description:
    "Give Hermes Agent rule-limited access to Gmail, Google Docs, Sheets, Slides and Drive through FGAC's hosted MCP server — hidden sensitive mail, send whitelists, per-file access, one-click approvals.",
};

/* SEO landing page: targets "hermes agent gmail", "hermes agent google
   workspace", "hermes mcp gmail". Doubles as the `source:` link of the Hermes
   MCP catalog entry (public/skills/hermes-catalog/fgac/manifest.yaml). */

const HERMES_CONFIG = `# ~/.hermes/config.yaml
mcp_servers:
  fgac:
    url: https://fgac.ai/api/mcp
    auth: oauth`;

export default function HermesPage() {
  return (
    <AgentSetupGuide
      agentName="Hermes"
      headline="Gmail and Google Docs for Hermes Agent, with guardrails"
      intro={
        <>
          Hermes gets your inbox, documents and spreadsheets through one
          hosted MCP server. You decide what it can read, who it can email and
          which files it can touch, and it asks you instead of guessing when
          it hits a limit.
        </>
      }
      steps={[
        {
          title: "Add FGAC as an MCP server",
          body: <>Add this entry to your Hermes config. Nothing to install: it&apos;s a remote server with standard MCP OAuth.</>,
          code: HERMES_CONFIG,
          codeLabel: "Copy Hermes config",
        },
        {
          title: "Sign in",
          body: <>Start a session (or run the command below). Hermes opens a browser: sign in to FGAC with the Google account you want the agent to use. Finish within a few minutes; if it times out, run the command again.</>,
          code: "hermes mcp login fgac",
          codeLabel: "Copy login command",
        },
        {
          title: "Start using it",
          body: (
            <>
              Restart the session so the tools load, then ask Hermes to{" "}
              <em>&ldquo;summarize my unread email from today&rdquo;</em>.
              It starts read-only. Open your{" "}
              <Link href="/dashboard" className="text-primary underline underline-offset-2">
                FGAC dashboard
              </Link>{" "}
              to let it send, edit, or see more, and to hide mail it
              shouldn&apos;t read.
            </>
          ),
        },
      ]}
      footnote={
        <>
          Prefer to keep sending and raw Google API writes off? Run{" "}
          <code className="font-mono">hermes mcp configure fgac</code> and
          untick <code className="font-mono">gmail_send</code> and{" "}
          <code className="font-mono">google_api_modify</code>. FGAC still
          enforces your rules on whatever stays enabled. Using OpenClaw
          instead?{" "}
          <Link href="/openclaw" className="text-primary underline underline-offset-2">
            See the OpenClaw guide
          </Link>
          .
        </>
      }
    />
  );
}
