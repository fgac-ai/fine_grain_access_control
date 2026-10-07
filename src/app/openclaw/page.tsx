import Link from "next/link";
import { AgentSetupGuide } from "@/components/AgentSetupGuide";

export const metadata = {
  title: "Connect OpenClaw to Gmail and Google Docs Safely | fgac.ai",
  description:
    "Give OpenClaw rule-limited access to Gmail, Google Docs, Sheets, Slides and Drive through FGAC's hosted MCP server — no Google Cloud project, hidden sensitive mail, send whitelists, per-file access, one-click approvals.",
};

/* SEO landing page: targets "connect openclaw to gmail", "openclaw gmail
   safely", "openclaw google workspace", "gog alternative". Doubles as the
   homepage of the ClawHub skill (public/skills/clawhub/fgac-google-workspace). */

const ADD_CMD =
  "openclaw mcp add fgac --url https://fgac.ai/api/mcp --transport streamable-http --auth oauth";

export default function OpenClawPage() {
  return (
    <AgentSetupGuide
      agentName="OpenClaw"
      headline="Gmail and Google Docs for OpenClaw, with guardrails"
      intro={
        <>
          OpenClaw gets your inbox, documents and spreadsheets through one
          hosted MCP server. No Google Cloud project, no client secrets on
          the box. You decide what it can read, who it can email and which
          files it can touch.
        </>
      }
      steps={[
        {
          title: "Add FGAC as an MCP server",
          body: (
            <>
              One command. Keep{" "}
              <code className="font-mono">--transport streamable-http</code>:
              OpenClaw defaults to SSE otherwise.
            </>
          ),
          code: ADD_CMD,
          codeLabel: "Copy OpenClaw command",
        },
        {
          title: "Sign in",
          body: (
            <>
              OpenClaw prints a sign-in link: open it and sign in to FGAC with
              the Google account you want the agent to use. Running OpenClaw
              on a server? Use the <code className="font-mono">--code</code>{" "}
              fallback the command prints.
            </>
          ),
          code: "openclaw mcp login fgac",
          codeLabel: "Copy login command",
        },
        {
          title: "Approve the agent",
          body: (
            <>
              The first tool call reports <strong>pending approval</strong>{" "}
              with a dashboard link. Approve OpenClaw there and pick its
              rules. It starts read-only by default. Then ask it to{" "}
              <em>&ldquo;summarize my unread email from today&rdquo;</em>.
            </>
          ),
        },
      ]}
      footnote={
        <>
          Several people on one OpenClaw gateway? Set{" "}
          <code className="font-mono">oauth.identity: &quot;per-requester&quot;</code>{" "}
          on the <code className="font-mono">fgac</code> server so each person
          connects their own account under their own rules. Using Hermes
          instead?{" "}
          <Link href="/hermes" className="text-primary underline underline-offset-2">
            See the Hermes guide
          </Link>
          .
        </>
      }
    />
  );
}
