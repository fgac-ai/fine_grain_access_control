# Google OAuth verification — AI/ML Limited Use statement (v1)

Branch: `claude/google-verification-limited-use` (off `main` at cfec532).

## Why

Google's Third-Party Data Safety Team asked (2026-10-10) for, among other items, an
affirmative, easy-to-find statement that FGAC's use of Workspace API data follows the
Limited Use requirements, including the AI/ML training prohibition. `/privacy` §2
already carried Google's standard Limited Use disclosure and a "no generalized AI/ML
training" bullet; the homepage card linked to `/privacy` without an anchor. The gap was
wording: Google's own example sentence ("raw or derived user data received from
Workspace APIs") and an explicit statement about third-party AI providers were absent.

## Change (copy only)

| file | change |
| --- | --- |
| `src/app/privacy/page.tsx` | §2 title → "Google API Services User Data Policy and Limited Use"; second affirmative paragraph using Google's example sentence plus the no-training sentence (raw, aggregated, anonymized or derived); new bullet "Have no AI provider of our own" — FGAC integrates no AI service, data reaches an AI only via the agent the user connects, recommendation to turn off training in that agent; `EFFECTIVE_DATE` → October 14, 2026 |
| `src/app/page.tsx` | "Limited Use compliant" card links to `/privacy#google-limited-use` and states Workspace data is never used to train AI/ML models |

## Claims verified in code

- No LLM SDK in `src/` or `package.json` (grep for anthropic / openai / genai /
  langchain / cohere / mistral: no hits). FGAC calls no AI model.
- Scopes requested in code: `gmail.modify` (nav connect-account), `drive.file`
  (`googleReconnect.ts` default `additionalScopes`), `drive` (flag-gated
  `EnableDriveAccessCard` / nav button only). The sign-in scope set lives in the Clerk
  dashboard, documented in `docs/monitoring.md` §7.12 as `openid email profile
  gmail.modify` (measured on dev; production not re-read in this session).

## Validation

- Copy-only; `tsc` shows two pre-existing unrelated missing-module errors in this
  worktree's stale `node_modules` (happy-dom, posthog-node), none in the changed files.
- Preview: render `/privacy#google-limited-use` and `/` and check the new text and anchor.

## Not in this PR (open for Ken)

- PostHog session replay is on with default (unmasked) page text, so dashboard replays
  can contain Workspace-derived strings (file names, approval targets). PostHog is a
  service provider, not an AI trainer, but confirm PostHog AI features (replay
  summaries etc.) are off for project 343912, or mask dashboard text.
