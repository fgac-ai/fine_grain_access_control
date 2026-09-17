# FGAC.ai — Project Rules

> This file is the single source of truth for project rules. Workflows (slash commands)
> live in `.claude/commands/`. The legacy Antigravity tree (`.agent/`) has been retired —
> everything it contained was folded in here or into `.claude/commands/`.

## General Workflow

1. **Branching**: Always pull the latest changes from main and create a new branch when starting new work.
2. **Database Changes**: Follow the Database Rules below. Always run `npm run db:branch` BEFORE schema changes to enforce Neon branching.
3. **Implementation Plans**: Document implementation plans as you normally would, but save a copy of each revision to `docs/implementation_plans/[branch_name]_v[revision].md`. If the file already exists, increment the revision number instead of editing it. This keeps a reviewable history of how plans evolved for QA and validation work.
4. Review the `docs/` folder and update the docs and data model to match your changes.
5. Commit frequently as you work through the problem.
6. **Validation**: Validate changes locally, then in the preview branch via `/deploy-pr-preview`, running the applicable `docs/QA_Acceptance_Test` suites before handing back to the user.
7. **Browser Automation**: In Claude Code, use the **built-in browser tools** (`mcp__Claude_Browser__*`) for ALL UI testing — `preview_start`, `navigate`, `get_page_text`, `read_page`, `read_console_messages`, `read_network_requests`, `computer`, `resize_window` (viewport + light/dark emulation). NEVER write ad-hoc Node.js browser scripts. **The built-in browser keeps persistent cookies, and both QA Google accounts (`USER_A`, `USER_B`) are signed in there** — so signed-in flows (dashboard, Clerk sign-in via the Google account chooser, OAuth consent) run in the built-in browser too; switching accounts through the chooser is the standing-approved routine step.

   **Fall back to Path B (Playwright CLI CDP-attached Chrome, see `/browser-agent`) BY DEFAULT — without asking — whenever the built-in browser cannot drive a flow.** Known triggers, from QA experience:
   - a flow lands on a Google *password* prompt (session expired — STOP, never type a password, switch to Path B);
   - Google Picker / `drive.file` consent flows (the embedded pane cannot complete them);
   - the session is unattended (scheduled task / remote dispatch): `preview_start {name}` is blocked there, and a hidden pane reports 0×0 / black screenshots — DOM tools still work, but input-gesture flows need Path B;
   - any flow that silently ignores clicks in the embedded pane (Google surfaces requiring trusted gestures).

   A QA pass that leaves a flow untested because the built-in browser couldn't drive it is incomplete — run it via Path B before reporting, and say which path each flow used.

### Google surfaces: TRY FIRST — the hard stop is narrower than "the Picker"

**Default to attempting Google flows yourself.** Handing the user a click they did not
need to make is a failure mode too, and the automation succeeds more often than not.
Only ONE branch is genuinely off-limits, and you can tell in advance which branch you
are in.

Decision procedure before driving a Picker/consent flow:

1. **Check the scope first** — `GET /api/auth/google-picker-token` returns
   `hasDriveFileScope`.
   - `true` → `useGooglePicker` goes straight to step 3 and opens the Picker. No
     reconnect, nothing shared is mutated. **Automate it.**
   - `false` → the click enters the reconnect branch (`useGooglePicker.ts`, the
     `!tokenData.hasDriveFileScope` case). Go to 2.
2. **In the reconnect branch, `googleReconnect.ts` forks on the Clerk external
   account's `verification.status`:**
   - `'verified'` → `reauthorize()` in place. Recoverable; attempting is fine.
   - anything else → `destroy()` then `createExternalAccount()`. **This is the only
     hard stop.** An abandoned pass leaves the Google grant broken on the *shared* dev
     Clerk instance for every other session on the machine — a failed attempt does not
     merely fail, it breaks the environment.
3. So hand off to the user **only** when `hasDriveFileScope` is false AND the external
   account is not `verified`. Say which check produced the hand-off.

### What Google counts as a real click (measured 2026-08-26)

Google's surfaces gate on `event.isTrusted`. Measured against a probe element in the
built-in browser:

| how you click | `isTrusted` | coords reported | use it for |
| --- | --- | --- | --- |
| `computer {action:'left_click'}` (CDP `Input.dispatchMouseEvent`) | **`true`** | real | **Google surfaces** — verified working on the account chooser AND the OAuth consent "Allow" button |
| `element.click()` | `false` | `0,0` | FGAC's own UI only |
| `element.dispatchEvent(new MouseEvent('click'))` | `false` | as supplied | FGAC's own UI only |

Practical consequences:

- **Our React app accepts all three** (React does not check `isTrusted`), so a JS click
  is the right tool for FGAC UI — especially when the pane reports 0×0 and `computer`
  cannot see anything. Native `confirm()` is inert in the embedded pane: override
  `window.confirm = () => true` before clicking confirm-gated controls.
- **Google gets `computer` clicks, never JS clicks.** A JS click on a Google surface
  silently does nothing — that is the "the button did nothing" symptom, not a bug.
- `computer` needs a prior `computer {action:'screenshot'}` to cache dimensions, and its
  coordinates are in the **screenshot frame**. Do NOT derive the scale as
  `screenshotWidth / window.innerWidth` — the pane **letterboxes** the page, so the
  canvas is larger than the rendered page and that formula over-estimates.
  Measured 2026-08-27: viewport 1280x900, screenshot 800x562, page rendered into only
  ~683x480 of it (grey margins right and bottom). Real scale **0.5333**, not the 0.625
  the formula predicts — a `getBoundingClientRect()` centre converted with 0.625 lands
  ~60px off and silently misses the target. That is the "the button did nothing"
  symptom on Google surfaces, and it cost a whole QA pass to a needless hand-off.
  **Calibrate instead of computing.** One click probe settles it exactly:

  ```js
  window.__probe=[]; window.addEventListener('click',
    e => window.__probe.push({x:e.clientX, y:e.clientY, trusted:e.isTrusted}), true);
  ```
  then `computer {action:'left_click', coordinate:[400,300]}` and read back
  `400/__probe[0].x`. It also re-confirms `isTrusted: true` on the spot. Or skip the
  maths entirely and click where the target visibly is in the screenshot.
- **The Picker is keyboard-accessible — drive it that way (measured 2026-09-03).** The
  Picker renders in a cross-origin iframe whose document reports a 0×0 viewport, so
  every coordinate derived from inside it (`boundingBox()`, `getBoundingClientRect()`)
  is null/garbage and pointer clicks — built-in `computer` or Path B `page.mouse` —
  never reach a tile (an in-frame event probe recorded zero pointer events across
  three targets). Keyboard focus works normally: from the Picker's search input,
  `Tab`×4 lands on the first file tile (`role=option`), `ArrowRight`/`ArrowLeft` move
  between tiles (the focused tile becomes `aria-selected=true`), then `Tab` to the
  `Select` button and `Enter` confirms — the parent page renders "✓ Sheet access
  granted" (or the substitution notice when the picked file isn't the requested id).
  Verify each step by reading `document.activeElement` inside the frame rather than
  by screenshot. This is the standard accessibility path, not a workaround, and it
  is what the QA runners use.

## QA Subagent Architecture

QA execution is delegated to cost-tiered subagents defined in `.claude/agents/`:
`qa-env-runner` (Sonnet) executes runbooks and writes
`docs/QA_Acceptance_Test/qa-results.json`; `qa-smoke` and `deploy-watcher` (Haiku) handle
mechanical polling and smoke checks; `qa-coverage-auditor` (Sonnet) adversarially reviews
results; `qa-setup-driver` (inherits the session model) drives the browser setup flows.
Four rules bind this architecture:

1. **Only the orchestrator (main session) edits source, schema, or config.** Runners
   execute and report; a runner that hits a code problem records it, never fixes it.
2. **`npx tsx scripts/qa-coverage-check.ts` is the arbiter of QA completeness** — it
   parses the `### A<n>:` assertions in `docs/QA_Acceptance_Test/capabilities/` and
   validates `qa-results.json` (schema in `docs/QA_Acceptance_Test/README.md`). Prose
   assertion counts are informational.
3. **Production QA is user-confirmed, every time.** Routine validation is local +
   preview (`/deploy-pr-preview`) only. `/qa-production` and the
   `docs/QA_Acceptance_Test/production/` runbooks never run autonomously or as a step
   of another workflow, and even a user-typed `/qa-production` requires an in-session
   scope confirmation before any runner is dispatched (the suite mutates the shared
   production QA account, which can back live claude.ai connectors — breakage there
   registers as connector-directory disconnect/health events). Expect production QA
   to be rare.
4. **The orchestrator never drives a third-party surface — not even for a "quick
   diagnostic."** Google Picker, Clerk sign-in, OAuth consent, account choosers, and
   any probing of how those surfaces receive input belong in a runner
   (`qa-env-runner` / `qa-setup-driver`), which has its own transcript. The
   vocabulary that work generates — trusted input, cross-origin frames, session
   handoffs, bearer tokens — reads as security-sensitive to automated classifiers
   regardless of the authorization behind it, and on 2026-09-03 an hour of it in the
   main session degraded the whole session while the runners that did the same work
   earlier were unaffected. Every runner prompt states the context plainly: QA of
   FGAC's own Google integration against a local or preview build, using the two test
   accounts we own.

QA environments run sequentially (they share one dev server, one Neon branch, and the QA
accounts/keys — lifecycle capabilities mutate that shared state). Targeted re-tests
re-dispatch a runner scoped to the failed capabilities only, bounded at 3 fix-and-retest
rounds.

## Local Development Environment

There is exactly one supported way to run this app locally. Do NOT improvise an
environment — no local Postgres in Docker, no hand-written `.env.local`, no Clerk
keyless mode. Those all produce an app that appears to work while testing a stack
that does not match production.

```bash
npx vercel link --yes --project fine-grain-access-control   # once per clone
npx vercel env pull .env.local --environment=development     # dev Clerk + Neon creds
npm run db:branch                                            # isolated Neon branch
npm run dev:qa                                               # webpack, 8GB heap
```

Notes:

1. **Node version**: system Node may be older than Next's `>=20.9` requirement. Use the
   Node 22 install (`~/local/node22/bin`) — `.claude/launch.json` already wraps `dev:qa`
   so `preview_start` resolves it correctly.
2. **Verify Clerk is real**: the dev server log must say
   `Clerk has been loaded with development keys`. If it says *keyless mode*, the pull
   did not work and you are testing against a throwaway Clerk instance.
3. **Verify Neon isolation**: `.env.local` must contain `neon__POSTGRES_URL` pointing at
   a branch named after your git branch. `db:branch` writes it.
4. **Never copy a whole `.env.local` between machines** — it carries another machine's
   `neon__POSTGRES_URL` and will silently point you at someone else's database branch.
   Copy individual missing keys.
5. **Switch freely between the two QA test users. Never ask permission to do it.**

   `USER_A` and `USER_B` from `.qa_test_emails.json` both stay signed in to Google on the
   QA machine. Signing out of Clerk and back in as either one is a **routine step of the
   harness**, exactly like clicking a button — not a decision, not an approval point, not
   something to confirm, flag, or check in about. Do it as many times as the tests
   require and simply carry on. Clicking through Google's account chooser and Clerk's
   OAuth consent for these two accounts is included in this standing approval.

   Do not ask again. Do not end a turn asking whether you may switch. Do not treat a
   previous approval as single-use — this rule *is* the approval, permanently, for every
   QA run. If a test needs the other account, switch and keep going.

   Three hard limits remain (these are about safety, not permission):
   - **Never type a password.** Both accounts are already authenticated with Google. If a
     password, passkey, or 2FA prompt ever appears, stop and hand back to the user.
   - **Never create a new account.** If an expected test account is missing, say so
     rather than signing up.
   - Only these two accounts, and only against a local or preview deployment. Outside a
     QA run, or for any other account, sign-in remains the user's job.
6. `bash scripts/qa-secrets.sh` pulls the 1Password *test account emails* only — it does
   not populate app secrets. Do not confuse the two.

   **Missing `.qa_test_emails.json` is NOT a blocker — copy it before asking.** It holds
   only the two QA account addresses, it is identical for every checkout on this machine,
   and it carries no database pointer or credential. So when it is absent, copy it from
   the main clone yourself and carry on:

   ```bash
   cp ~/GitRepos/fine_grain_access_control/.qa_test_emails.json .
   ```

   Only if the main clone does not have it either does `qa-secrets.sh` (and its
   1Password prompt, which needs the user) come into play. Stopping a QA run to ask the
   user to run the script, when the file was sitting in the main clone the whole time,
   has cost a full session before — check first, ask second.
7. **Every git worktree bootstraps separately, but not everything must be re-derived.**
   `.env.local`, `.qa_test_emails.json`, `node_modules`, and `.vercel/` are gitignored
   and do NOT carry over automatically from the main clone or other worktrees. A fresh
   worktree needs the full bootstrap above, and a key "fixed" in another worktree has
   not fixed it here. `npm run env:check` is the first move whenever auth or DB behaves
   unexpectedly.

   The distinction that matters when a file is missing:

   | file | copy from another checkout? |
   | --- | --- |
   | `.qa_test_emails.json` | **Yes** — machine-level, no DB pointer (rule 6) |
   | `.env.local` | **Never** — carries that checkout's `neon__POSTGRES_URL`, so copying it silently points you at someone else's database branch (rule 4). Re-pull it, then `npm run db:branch` |
   | `node_modules`, `.vercel/` | Regenerate — `npm install`, `npx vercel link` |
8. **Paste env values into Vercel WITHOUT quotes.** A value stored as `"sk_test_…"`
   (quotes included) survives `vercel env pull` and dotenv parsing looking superficially
   fine, but the runtime value starts with a literal `"` and auth fails as if the key
   were unset. `env:check` detects this exact case and prints the remediation
   (rm + re-add the var, then re-pull).

These rules are enforced by `.claude/hooks/guard-local-env.sh` (PreToolUse), which blocks
local database containers, schema pushes without an isolated branch, and hand-written
`.env` files.

## PostHog Verification (analytics tasks)

Any task that verifies analytics events — telemetry fixes, the analytics
review, QA capability 16, "did this event land?" — has a **required first
move, before writing any code**: load the PostHog MCP with

> `ToolSearch "posthog exec"`

That exact keyword matters. The connector's tool is named `exec` under a
**connector-UUID prefix** (`mcp__<uuid>__exec`) — generic queries like
"posthog query insights events" rank it poorly and can return only noise.
That exact failure happened on 2026-08-24: the connector was present the whole
session, a generic search missed it, and a production-data question that one
HogQL query settles in seconds was instead argued from code inspection for the
whole task. If the first search looks wrong, try the documented keyword before
concluding the connector is absent. Never hardcode the UUID (it changes);
never conclude "unavailable" without diagnosing *why*.

Production event data outranks code inspection: query first, then read code to
explain what the data shows.

If the connector is genuinely absent (headless/cron sessions, CI), two
fallback paths exist with **different env sources** — provisioning one does
not enable the other:

| path | reads the key from | works when |
| --- | --- | --- |
| `posthog` MCP server (`.mcp.json` → mcp.posthog.com) | `${POSTHOG_PERSONAL_API_KEY}` in the **shell env at `claude` launch** (`.env.local` is invisible to it) | key exported in `~/.zshrc` (or launcher env) |
| `scripts/qa-posthog-events.ts` | `.env.local` via dotenv | key in Vercel dev env + `vercel env pull` |

`NEXT_PUBLIC_POSTHOG_KEY` (`phc_…`) is the write-side ingestion key and cannot
query — only a personal API key (`phx_…`, Query:Read scope) can. As of
2026-08-24 that key is unprovisioned everywhere; creating one is a **user
action** in the PostHog UI (agents must not create accounts or keys), and
`npm run env:check` diagnoses this exact gap with remediation steps. When
blocked, report it explicitly and early ("production verification blocked:
POSTHOG_PERSONAL_API_KEY unprovisioned") instead of silently substituting
local-only validation, and never leave a "verify in PostHog" step implicit —
name the query to run and the result that confirms success.

## Production Credentials on a Local Machine

Pulling live credentials for diagnostics is fine. Letting them become the *ambient*
environment is not. The rules below exist so that "am I pointed at prod?" is never a
question you have to hold in your head.

**Check first, always:**

```bash
npm run env:check
```

Prints the resolved database host, whether it is the production branch, which Clerk
instance the secret belongs to, whether the two are consistent, and whether any
production URL is sitting in the environment.

**Pull production credentials only to `.secrets/`:**

```bash
npx vercel env pull .secrets/prod.env --environment=production
```

`.secrets/` is gitignored and nothing auto-loads it. Do **not** use
`.env.production.local` — Next.js auto-loads that name whenever `NODE_ENV=production`, so
a local `npm run build && npm start` would silently run against production. Delete
`.secrets/prod.env` when finished.

**Never copy production values into `.env.local`.** That file is development-only.

**How the app protects itself** (`src/db/connectionSafety.ts`):

- Outside a production runtime the ONLY accepted connection is `neon__POSTGRES_URL`
  (written by `npm run db:branch`). There is no fallback chain — a missing branch URL is
  a hard error, not a reason to try `POSTGRES_URL` or `DATABASE_URL`, both of which point
  at production in a pulled `.env.local`.
- The resolved host is checked against the production endpoint and refused outside
  production, so even a branch variable containing a prod URL is caught.

**Scripts that touch production** must require an explicit `--prod`, read `.secrets/prod.env`
by name, and refuse to write unless `--apply` is also given. See
`scripts/tombstone-orphaned-users.ts` for the pattern.

**Clerk instance must match the database.** Production user ids do not exist in the
development Clerk instance — every lookup 404s and reads as "account deleted". Any script
that infers state from Clerk must verify the key mode (`sk_live_` vs `sk_test_`) and bail
if a majority of users resolve as deleted. The branch database is a copy of main, so its
user ids are production-instance ids too.

## Preview Database Architecture (verified 2026-08-24)

Vercel **Preview deployments run against an isolated Neon branch**, named
`preview/<git-branch>`, created by the Vercel–Neon integration on the first preview
deploy of that git branch. Facts that are easy to get wrong:

- **`vercel env ls` / `vercel env pull --environment=preview` CANNOT see this.** They
  show the stored project vars, where `POSTGRES_URL` points at production. The
  integration injects the branch-scoped `neon__`-prefixed vars per-deployment; that is
  why `resolveConnection` checks `neon__POSTGRES_URL` FIRST even in production runtime.
  Never infer a deployment's database from pulled env — verify at runtime (where does a
  write land, or a logged resolved host).
- **Preview builds migrate the preview branch, not production.** `migrate.ts`'s
  `VERCEL=1` bypass only skips local neonctl auto-provisioning; the connection chain
  still resolves the injected branch URL.
- **The preview branch is a copy of production data** at branch-creation time.
  Stateful QA against a preview is DB-isolated, but the branch holds real customer
  data — the public-repo rules apply to anything quoted from it.
- **Preview branches and local `db:branch` branches share the same Neon branch cap.**
  Both kinds count toward the plan limit; when preview deploys fail instantly with
  empty Builds, check the combined branch count first (read-only) before any cleanup.
- **Both kinds are pruned on a timer.** `bash scripts/cleanup-neon-branches.sh`
  (`npm run db:prune-branches`, and a daily scheduled task) deletes any branch whose
  compute has been idle more than 6h, once EITHER it is older than 24h OR the PR for
  its git branch is merged. A worktree checkout protects nothing. **Git state can only
  bring deletion forward, never hold it off** — that direction is the invariant; a git
  fact used as a *keep* is what let leftover worktrees pin branches forever. If the PR
  lookup fails (no `gh`), merged-PR pruning goes quiet and the 24h clock still applies. So:
  - **Merging a PR ends its local `db:branch` database immediately** — no idle wait,
    on the next prune. The running-compute guard is the only thing left protecting it,
    and Neon suspends compute after a few minutes, so a dev server sitting idle between
    queries does NOT count as running. Its `preview/` twin gets the 6h idle floor,
    because a deployed URL can be hit by anyone at any moment. **Finish QA against a
    branch before you merge, not after.**
  - **A preview whose PR is still open is not exempt either.** If its preview URL has
    been quiet for 6h AND it is over 24h old, the database goes; redeploy the PR to get
    a fresh branch. To keep one across the timers, mark it `protected` in the Neon
    console — that is the only opt-out.
  - **A worktree you come back to after a day needs `npm run db:branch` again.** Its
    `.env.local` still names the deleted branch, and the dev server will fail to
    connect until you re-run it. The replacement is a fresh copy of main: accumulated
    QA state (approved connections, proxy keys, rules) does not survive, so re-run the
    relevant `docs/QA_Acceptance_Test/setup/` steps before trusting a stale worktree.
  - **A branch with compute running right now is never deleted**, so a live dev server
    or an in-flight preview request cannot lose its database mid-run.
  - Leftover worktree directories no longer pin database branches. `npm run
    worktrees:report` lists finished ones; it only reports — removing a worktree stays
    a manual decision, because a clean merged directory can still be a live session's cwd.

## Database Rules

1. **Isolation First**: BEFORE creating any migration or pushing schema changes, ALWAYS run `npm run db:branch` so Drizzle-Kit executes against an isolated development branch.
2. **Verify Connection**: Use the output of `db:branch` to confirm you are NOT connected to the production database branch (unless explicitly instructed for a hotfix, which requires extreme caution).
3. **No Manual Prod Migrations**: NEVER run `drizzle-kit push` or `migrate` manually against a production connection string. Production changes happen via CI/CD.
4. **Schema Changes**: Modifying `src/db/schema.ts` requires a subsequent `npm run db:push` to your local branch to verify correctness.
5. **Drizzle/Migration Safety**: `drizzle.config.ts` and `src/db/migrate.ts` carry environment safety guards. On a feature branch (not `main`) they crash rather than implicitly falling back to production parameters (e.g. `DATABASE_URL`). Do not bypass this. If it halts, ensure your branch was populated via `npm run db:branch`.
6. **Environment Variables**: NEVER commit `.env` or `.env.local` files containing database credentials.
7. **No Direct DB Writes During QA**: NEVER write ad-hoc scripts (`psql`, `npx tsx`, raw SQL, Drizzle ORM scripts) that INSERT, UPDATE, or DELETE application data to simulate user actions during QA. QA exists to validate the real user flow. All state changes (approving connections, creating keys, configuring rules) MUST go through the Web UI via `/browser-agent` or the application's own API endpoints — exactly as a real user would. Direct DB manipulation bypasses the authorization checks the tests are meant to validate and can create invalid cross-user data bindings. Read-only queries for debugging are fine.
8. **Migration File Verification**: After `drizzle-kit generate`, ALWAYS verify (a) the new `.sql` file exists in `src/db/migrations/`, (b) `migrate.ts` will pick it up (it uses a dynamic `readdirSync` — confirm the `.sql` extension and `NNNN_*.sql` naming convention), and (c) `npm run db:migrate` succeeds locally against your dev branch. NEVER assume a generated migration will be discovered without verification.

## This Repository Is Public

`fgac-ai/fine_grain_access_control` is open source. Everything pushed or posted — code,
commit messages, issues, PRs, comments, releases — is world-readable, permanently and
immediately.

**Never put customer data in anything that reaches GitHub.** That means real email
addresses, Clerk user ids (`user_...`), proxy keys (`sk_proxy_...`), delegation or
connection ids tied to a person, and database rows quoted verbatim.

This applies to *diagnostic* content as much as code. Triaging production data is normal;
pasting the results into an issue is not. Refer to the query or the local report instead:

> Two addresses carry active keys — run `npm run db:tombstone-orphans -- --prod` to see them.

not

> ~~Two addresses carry active keys: alice@example-university.edu and bob@example-corp.com~~

**Editing does not undo publication.** GitHub retains edit history on issues and PRs and
shows it to anyone. The only real remedy is deleting the issue/PR, which destroys the
thread. Treat every post as final.

**If it happens anyway**: delete the issue/PR (not just edit it), check whether the data
also reached commit messages or files (`git log --all -S '<value>'`), recreate the content
sanitised, and tell the user what was exposed and for how long.

Enforced by `.claude/hooks/guard-public-content.sh` (PreToolUse), which blocks
`gh issue/pr create|edit|comment`, `gh gist create`, and `gh release create` when the body
— inline or via `--body-file` — contains an email address outside the allowlist, a proxy
key, or a Clerk user id. Reads (`view`, `list`, `checks`) are unaffected.

## Security, Safety, and Workflow Best Practices

- **Strict UI Policy**: Put debug information exclusively in server logs. NEVER render debug identifiers, developer tokens, or internal error objects into the HTML/UI.
- **Git Hook Restrictions**: NEVER bypass Git hooks (`--no-verify`) without explicit user approval. Stop and investigate failures such as secret scanning to prevent compromised credentials.
- **Never Push to Main**: NEVER push directly or merge automatically to `main`. Always open a PR, use `/deploy-pr-preview` for validation, and leave `/deploy-prod` to the user.
- **Never Deploy to Production**: NEVER run `npx vercel --prod`, `vercel --prod`, `vercel deploy --prod`, or ANY command that triggers a production deployment, regardless of how small the change appears. Production deployments are done ONLY by the user via `/deploy-prod`. If a production redeploy is needed (e.g. after env var changes), tell the user and let them trigger it.

### Vercel CLI Safety

Safe, no approval needed:
- `vercel env ls` — list environment variables
- `vercel env pull` — pull env vars to local files
- `vercel inspect` — inspect deployments
- `vercel ls` / `vercel logs` — list and read deployments

State-modifying, require user approval (but NOT production deployments):
- `vercel env add` / `vercel env rm` — add or remove environment variables
- `vercel cancel` — cancel a queued or building deployment

**BANNED** — never run:
- `vercel --prod` / `vercel deploy --prod` — deploys to production
- `vercel promote` — promotes a deployment to production
- `vercel alias` — aliases a deployment to a production domain

These bans are additionally enforced as `deny` rules in `.claude/settings.json`.

## Review-Ready Summary

When work is complete and ready for the user to review (a PR is open and validated,
a report is finished, a fix is verified), close with a summary of **300 words or
less** with exactly three labelled parts, in this order:

1. **What the work does** — the change or finding, in plain language, with the PR
   and preview links.
2. **Why it matters** — the problem it solves and the evidence that showed it.
3. **What the impact is** — measured before/after where there is data, the
   behavioural consequences a reviewer should know, and what remains open.

Rules: lead with the outcome, no headers beyond the three labels, no code in
prose, numbers only where they change what the reviewer does. Anything longer
belongs in the implementation plan under `docs/implementation_plans/`, which the
summary links to instead of repeating. Interim progress updates are exempt; this
applies to the hand-back message.

## Context Efficiency & Session Hygiene

Originally derived from Antigravity's session-stability rules; the IDE-specific parts
(ptyHost crash pacing, `waitForPreviousTools`, `command_status` polling) do not apply to
Claude Code and were dropped. What remains are the rules that still hold here.

1. **Batch related shell checks into one command.** Instead of five separate `curl` calls, run one command with `curl ... && curl ... && curl ...`. Independent commands may be issued in parallel in a single response.
2. **Playwright snapshots**: ALWAYS pipe through `grep` to extract only relevant elements.
   - Bad: `npx @playwright/cli -s=foo snapshot`
   - Good: `npx @playwright/cli -s=foo snapshot 2>&1 | grep -E "heading|button|Agent|Approve" | head -10`
3. **Command output**: pipe long output through `head`/`tail`/`grep` rather than dumping it whole.
4. **File reads**: use `Read` with `offset`/`limit` when you know which section you need.
5. **NEVER leave binary files** (PNGs, PDFs) in the project root. Save QA screenshots to a gitignored directory or delete them after use.
6. **NEVER create `node_modules`** outside the project root without adding it to `.gitignore`.
7. **Before starting a QA session**, verify the workspace is clean: `git status --short | grep '^??' | wc -l` should be under 20.
8. **Kill stale processes** from crashed sessions before restarting: `pkill -f 'chrome.*playwright_user_data'`. Never plain `pkill chrome` — that kills the user's real browser.
9. **After an interrupted session**, use `/recover-session` to rebuild context from compact artifacts and git state rather than re-reading a long transcript.
10. At natural phase boundaries, write a walkthrough artifact and update the task list for cross-session continuity.
