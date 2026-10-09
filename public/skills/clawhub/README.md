# ClawHub skill `fgac-google-workspace` (staging copy)

`fgac-google-workspace/SKILL.md` is an instructions-only OpenClaw skill: it
connects OpenClaw to FGAC's hosted MCP server
(`openclaw mcp add fgac --url https://fgac.ai/api/mcp --transport streamable-http --auth oauth`).
No scripts, no env vars, no API keys — the profile ClawHub's security audit
scores best (declared metadata matches content). It supersedes the legacy
script-based `public/skills/open-claw/` and `docs/skills/fgac/`.

## Publishing (vendor action — public, under FGAC's name)

Real-client verification passed on a local build on 2026-10-07 (OpenClaw
2026.9.8, which needs Node >= 24.16): DCR `client_name` "OpenClaw MCP",
clientInfo `openclaw-bundle-mcp`, redirect `http://127.0.0.1:8989/oauth/callback`
accepted first try, tool calls and refresh OK. Publish only after PR #196 is
live in production: it serves the RFC 9728 resource-metadata path that
OpenClaw also probes (one probe hung for 60 s without it).

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
