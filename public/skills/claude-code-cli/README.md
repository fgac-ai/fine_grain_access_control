# fgac — Claude Code Plugin

Secure Gmail access for [Claude Code](https://code.claude.com) via the [FGAC.AI](https://fgac.ai) proxy.

## What is FGAC.AI?

FGAC.AI provides **Fine Grain Access Control** for AI agents accessing Google APIs. It acts as a transparent proxy that enforces:

- **Content Filtering**: Block agents from reading sensitive emails (2FA, password resets)
- **Recipient Allow-lists**: Restrict who agents can send/forward emails to
- **Deletion Safeguards**: Whitelist domains for deletion, block "Empty Trash"
- **Agent Profiles**: Each agent gets its own proxy key with scoped permissions

## Installation

### Via Claude Code Marketplace (Recommended)

```
/plugin marketplace add fgac-ai/fine_grain_access_control
/plugin install fgac@fine_grain_access_control
```

### Manual Installation

```bash
# Clone into your Claude Code skills directory
git clone https://github.com/fgac-ai/fine_grain_access_control.git /tmp/fgac
cp -r /tmp/fgac/public/skills/claude-code-cli/skills/fgac ~/.claude/skills/fgac
cp -r /tmp/fgac/public/skills/claude-code-cli/scripts ~/.claude/skills/fgac/scripts
cd ~/.claude/skills/fgac/scripts && npm install
rm -rf /tmp/fgac
```

## Setup

1. **Create an account** at https://fgac.ai/sign-up (sign in with the Google account you want to protect)
2. **Authenticate** (one-time):
   ```bash
   node ~/.claude/skills/fgac/scripts/auth.js --action login
   ```
3. **Approve** the agent connection in your [FGAC.AI dashboard](https://fgac.ai/dashboard?tab=connections)
4. **Verify**:
   ```bash
   node ~/.claude/skills/fgac/scripts/auth.js --action status
   ```

## Usage

Once installed, Claude Code will automatically discover the `fgac` skill. Just ask Claude to interact with your email:

- "List my recent emails"
- "Send an email to alice@example.com about the meeting"
- "Read the email with subject 'Invoice'"
- "What email accounts can I access?"

## Learn More

- Website: https://fgac.ai
- Dashboard: https://fgac.ai/dashboard
- Documentation: https://fgac.ai/docs
- Privacy Policy: https://fgac.ai/privacy
