/**
 * OpenAI plugin directory domain verification.
 *
 * When connecting the MCP server in platform.openai.com/plugins, the portal
 * shows a challenge token and fetches https://fgac.ai/.well-known/openai-apps-challenge
 * expecting exactly that token as plain text (not JSON). The token proves
 * domain control, not identity — it is not a secret — but it is only known at
 * submission time, so it comes from the environment: set
 * OPENAI_APPS_CHALLENGE_TOKEN in Vercel production and redeploy.
 *
 * Unset → 404, so nothing is served before a submission exists.
 * Runbook: docs/distribution/chatgpt-plugin-submission.md
 */

import { challengeResponse } from '@/lib/openaiAppsChallenge';

export function GET() {
  return challengeResponse(process.env.OPENAI_APPS_CHALLENGE_TOKEN);
}
