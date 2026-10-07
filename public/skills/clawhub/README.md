# ClawHub skill `fgac-google-workspace` (staging copy)

`fgac-google-workspace/SKILL.md` is an instructions-only OpenClaw skill: it
connects OpenClaw to FGAC's hosted MCP server
(`openclaw mcp add fgac --url https://fgac.ai/api/mcp --transport streamable-http --auth oauth`).
No scripts, no env vars, no API keys — the profile ClawHub's security audit
scores best (declared metadata matches content). It supersedes the legacy
script-based `public/skills/open-claw/` and `docs/skills/fgac/`.

## Publishing (vendor action — public, under FGAC's name)

Do not publish until the real-client verification has passed: OpenClaw
completes FGAC's OAuth (DCR `client_name` "OpenClaw MCP", redirect
`http://127.0.0.1:8989/oauth/callback`, fallback `localhost:8989`) and a tool
call succeeds.

1. Sign in with a GitHub account at least 14 days old (ClawHub refuses
   younger accounts): `clawhub login`. Decide the owner — personal account or
   an `fgac-ai` org (request the namespace claim first if using the org).
2. Publish:

   ```bash
   clawhub skill publish ./fgac-google-workspace \
     --slug fgac-google-workspace \
     --name "FGAC — Safe Google Workspace" \
     --categories productivity,security,integrations \
     --topics "gmail,google-workspace,mcp,access-control,gog-alternative"
   ```

   Max 3 categories / 5 topics; `official`, `verified`, `trusted`,
   `clawhub`, `openclaw` are reserved topic names. The first publish is
   1.0.0; later publishes auto-bump the patch version.
3. Check `https://clawhub.ai/<owner>/skills/fgac-google-workspace/security-audit`
   (VirusTotal + SkillSpector + A.I.G + ClawScan) reads Pass / Low.
4. Then add "or install the fgac-google-workspace skill from ClawHub" to
   step 1 of `src/app/openclaw/page.tsx`.

Search ranking is embedding similarity on the SKILL.md plus a lexical boost
on slug and display-name tokens, so the slug and name carry "google
workspace"; the description names gog so "gog alternative" searches match.

Later option: ask OpenClaw for a **managed MCP plugin** (admin-published under
the OpenClaw publisher, `docs/managed-mcp.md` in `openclaw/clawhub`) — a
native install that configures the server itself, which a skill cannot.
