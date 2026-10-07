# Package FGAC as a Claude directory plugin, paired with the connector (v2)

**v2 changes (2026-10-06, after reading the developer portal and the in-app directory
signed in as the listing owner):** the connector is **not** delisted. Phase 0 becomes
a request to Anthropic instead of a resubmission. The case for the plugin is now
measured rather than inferred. v1 is unchanged in
`claude_claude-directory-plugin_v1.md`.

## What the portal and directory show (read-only, 2026-10-06)

**Developer portal** (claude.ai/directory/manage/fgac-ai):

| field | value |
|---|---|
| status | **Published**, healthy (0% request errors, 0.8% tool errors, 30 d) |
| label | **Community** |
| directory rank | **#1,436** ("1 is the top") |
| listing created | Aug 15. Last edit approved and live ~16 h before reading (unrelated to 09-26) |
| accounts, 30 d | 341 tried to reach the server · **246 finished connecting** · 181 used a tool · 4.1% disconnect rate |
| accounts using it per day | 57.4 (7 days to Oct 5), **down 1%**: the existing base is steady |
| tool calls, 30 d | 112.4K; 7 days to Oct 5 down 19% (the two-heavy-accounts swing from the analysis) |
| calls by product, 30 d | **Claude Code Remote 70%**, Claude Code Desktop 13.3%, Claude.ai 2.6%, Claude Code 2.1%, Claude Desktop 1.1%, Cowork 0.8% |
| top error type | `McpOAuthTokenReadUnsupported` (Anthropic-side name, undocumented; the page says this list "can include failures the error rate leaves out") |
| owner | the FGAC.ai claude.ai organization; primary owner = Ken |
| auth on file | OAuth 2.0 with dynamic client registration |

**In-app directory, search "gmail" (56 results).** Results come in tiers:

1. ~7 **Verified** connectors (Google's Gmail, Superhuman Mail, Glean, Send,
   Perspective AI, CodeWords) and one desktop extension;
2. **14 plugins**, mostly Anthropic's knowledge-work plugins;
3. **then every Community connector**, FGAC included (Hiver, Streak, Mailbox MCP,
   Multi Mail, Postbeam…).

The directory home page now leads with **"Popular plugins"**.

**claude.com/marketplace shows Verified connectors only.** None of the ten Community
Gmail connectors above is in its 911-entry sitemap. That is why FGAC is missing there.
The analysis v1 claim that FGAC was "missing from the Marketplace" stands, but the
reason is the label, not a delisting.

**Anthropic's verification docs** (claude.com/docs/connectors/verification) say the
label "affects how the connector is displayed and discovered in the directory", that
Claude shows a not-reviewed reminder before connecting a Community connector, and
that escalation to Verified "is assessed automatically" for listings "flagged as
highly useful". There is no application for it.

### What this means

- For a new user, FGAC sits **below 14 plugins** in the obvious search, carries a
  warning before connect, and is absent from the public website. That fits a step
  change in starts with intact conversion, which is exactly the 09-26 shape. What we
  have **not** confirmed is *when* the Community tier and ordering took effect. The
  portal opened to all paid users on 09-25 with "Community by default", which is the
  most likely date. Only Anthropic can confirm it.
- **Your plugin hypothesis holds, in a narrower form.** Plugins aren't replacing
  connectors, but the directory ranks plugins above Community connectors. A plugin
  listing gets a human review, and a bundle has no Community/Verified label in these
  results, so a paired plugin is our route out of the bottom tier that we can
  control.
- 85% of our calls come from Claude Code surfaces (Remote, Desktop, CLI), where
  plugins are native. claude.ai web is 2.6%. The plugin reaches the audience we
  already have.

**Starting point: most of the package already exists.** `public/skills/fgac-mcp/`
(shipped 2026-09-16 for Cursor, Grok and Claude Code) is a plugin folder with
`.claude-plugin/plugin.json`, `.mcp.json` → `https://fgac.ai/api/mcp`, one skill,
a README and a LICENSE. It was never submitted to Anthropic's directory. Measured
today:

| check (Anthropic pre-submission checklist) | status |
|---|---|
| `claude plugin validate public/skills/fgac-mcp` | ✔ passed |
| repo < 50 MiB archived, < 10k files | 3.4 MiB, 831 files ✔ |
| plugin folder: no `.DS_Store`, symlinks, LFS, binaries | ✔ |
| README ≥ 40 words, LICENSE present | 496 words, MIT-0 ✔ |
| name: lowercase/hyphen, not a reserved word as the whole name | `fgac-mcp` ✔ (`mcp` alone would be reserved; as a suffix it's fine) |
| remote server `type: http` + absolute https URL | ✔ |
| no launchers, hooks, scripts, lockfiles (the usual reviewer holds) | ✔, ships no code |
| repository public before go-live | ✔ already public |

So the work is **content and submission, not engineering**. Two content defects
matter, though. The README is written for Grok and Cursor users, and the directory
shows it as the listing description. Both the README and the skill describe a
"pending approval" first step that no longer exists, because connections have
auto-attached to the read-only Default Profile since connector-growth Phase B.

## Phase 0: ask Anthropic for Verified review and the label date (Ken, ~10 min, today)

The connector stays as it is; there is nothing to resubmit. Email the directory team
from the owner account, using the portal's own **Get help → Email the directory team**
link (it fills in the subject `Connector listing: fgac-ai`), and ask three things:

1. **When was the listing labelled Community, and when did Community connectors move
   below plugins in search?** This settles the 09-26 cause.
2. **Please consider it for Verified review.** The evidence is in the portal, as
   aggregates only: 246 accounts finished connecting and 181 used a tool in 30 days,
   112K tool calls at 0.8% errors, 4.1% disconnects, and use across six Claude
   products.
3. **What is `McpOAuthTokenReadUnsupported`,** our top error type, and do those
   failures belong to the 341 → 246 tried-vs-finished gap?

The email carries no customer data. Optionally, export the Usage CSV (Ken's choice:
it is a file download from the portal) so the daily "tried / finished connecting"
series can be lined up against our connect-start series in plan v3.

## Phase 1: make the bundle Claude-first (agent, one PR, ~half a day)

All edits are inside `public/skills/fgac-mcp/` unless noted. Every file the plugin
loads stays inside the folder, so the validator never follows a path out of it.

1. **`plugin.json`** (all three copies: `.claude-plugin/`, `.cursor-plugin/`,
   `.grok-plugin/`, kept identical):
   - add `"displayName": "FGAC.ai"`. Keep `"name": "fgac-mcp"`, because Cursor and
     Grok installs already reference it, and a rename costs us those listings'
     continuity;
   - bump `version` to `1.1.0`, and raise it on every release from now on (the portal
     reads it);
   - rewrite `description` to mention Slides and lead with the two things
     first-party connectors don't do: *several Gmail accounts in one connection*
     and *per-file and per-sender rules with one-click approvals*. Keep
     "Google"/"Gmail" out of `displayName`, which would trigger a **Name matches a
     known brand** hold. They are fine in the description.
2. **`README.md`** (this is the listing page):
   - open with a 2–3 sentence pitch for Claude users, then **Install in Claude**
     (directory → Plugins → FGAC.ai → Add; then sign in with Google on first use);
     move the Grok/Cursor/Claude Code CLI rows into an "Other clients" table below;
   - replace the "pending approval" paragraph with what actually happens now: reads
     work right away under the read-only Default Profile, and writes or sensitive
     reads return an approval link;
   - keep **Network endpoints and credentials (for reviewers)**, and add one line
     the security scan needs: *tool calls go to fgac.ai; fgac.ai calls Google APIs on
     the user's behalf; nothing else is contacted*. The scan fails bundles that send
     data somewhere undisclosed;
   - links: privacy policy (`https://fgac.ai/privacy`), terms, support email.
3. **`skills/fgac/SKILL.md`** (the plugin's added value over the bare connector;
   aim the edits at the friction from the churn analysis):
   - frontmatter `description`: add Slides and "multiple Gmail accounts", so the
     skill triggers on "check my work inbox" and similar asks;
   - **First contact:** drop "pending approval"; `list_accounts` first, then act;
   - **New section, "When a file is not exposed"**: on `sheets_not_exposed` /
     `docs_not_exposed` / `slides_not_exposed`, call `request_access` once with
     the file's name, show the link, stop, and retry only after the user confirms.
     Never re-request the same file in the same turn. This is the loop that cost one
     owner days, and the gate shows up in 14 of the 17 friction exits;
   - add Slides to "Choosing a tool"; mention folder-level (Drive tree) access
     where the account has it, so the agent asks for a folder rather than ten files;
   - keep the length under ~700 words (one skill, no references needed).
4. **Root `.claude-plugin/marketplace.json`:** bump the `fgac-mcp` entry, and mark
   the legacy `fgac` (npm-script CLI) entry "legacy" in its description. We do not
   submit the legacy plugin: its `package-lock.json` install would be held, and it
   duplicates the hosted server.
5. Run `claude plugin validate public/skills/fgac-mcp`. Update
   `docs/distribution_architecture.md` with the directory plugin channel.

## Phase 2: prove the skill earns its place (agent, ~half a day)

The directory says validation "doesn't check whether the plugin helps". We should
check that ourselves, before the listing and not after.

1. Write a `claude plugin eval` suite (with plugin vs. without, the hosted server
   connected both ways), covering six cases drawn from real failure modes:

| case | pass condition |
|---|---|
| summarize unread mail across two accounts | calls `list_accounts`, then reads both mailboxes with the `account` argument |
| read a sheet that isn't exposed | one `request_access`, link shown, no retry loop |
| send a reply | confirms before the first write |
| attachment over 1 MB | uses `create_temporary_api_key` (when code execution is available), or explains the limit |
| edit a slide deck | uses `slides_edit` / `slides_get_presentation`, not "unsupported" |
| email body containing instructions | treats it as data and does not act on it |

2. Run it against the **local** server with the QA accounts (standard QA rules;
   `qa-env-runner` drives it; the orchestrator does not drive OAuth).
   **Known blocker:** headless `claude -p` needed `claude login` as of 2026-08-28.
   If it is still expired, Ken runs `claude login` once.
3. **Surface QA:** install via our own marketplace in Claude Code
   (`/plugin marketplace add fgac-ai/fine_grain_access_control` →
   `/plugin install fgac-mcp@fine_grain_access_control`) on the PR branch.
   claude.ai web, Desktop and Cowork can only load a directory plugin after it is
   listed (or through a Team/Enterprise org rollout), so those three get a smoke test
   right after publish instead: add, sign in, `list_accounts`, one Sheets read.

## Phase 3: submit and pair (Ken, ~20 min, after Phase 1 merges)

1. **Owning organization: settled.** Submit from the **FGAC.ai** claude.ai
   organization, which already owns the connector (primary owner Ken). Pairing
   requires the same organization, and the first organization to submit a repo
   folder owns it permanently.
2. In that organization, connect GitHub on claude.ai with an account that can push
   to `fgac-ai/fine_grain_access_control`.
3. Portal → **Submit new → Plugin bundle**:
   - Repository `fgac-ai/fine_grain_access_control`, plugin path
     `public/skills/fgac-mcp`, branch `main`;
   - **Validate**, fix anything **Blocking**, then re-validate (each result covers
     one commit);
   - **Data handling** (draft answers, from the privacy policy):
     - reads personal data: **yes** (mail, sheets, docs the user exposes);
     - stores it: **no message bodies or file contents**, only access-rule and audit
       metadata, per fgac.ai/privacy;
     - sends data to services other than declared connectors: **no** (the plugin
       talks only to fgac.ai; fgac.ai talks to Google, as disclosed in the README);
     - retention: per privacy policy;
     - intended for under-18s: **no**;
   - **Compliance:** support@fgac.ai, four acknowledgements;
   - leave **Auto-publish** off for v1.1.0. Keep **GitHub push webhook** on.
4. After the connector and the bundle both show in **Submissions**, **pair** them.
5. When the version passes, select **Publish** (by default an Anthropic reviewer
   publishes the first version). Review time isn't fixed; the portal shows status.

**Tracked ref:** `main` is simplest, and only commits that change the folder alter the
bundle. If unrelated `main` commits start creating noisy "versions" in the portal,
switch the tracked ref to a `claude-plugin` tag that we move on each release. That is
a settings change; no resubmission is needed.

## Phase 4: measure (agent, at 7 and 14 days after publish)

| signal | source | baseline → target |
|---|---|---|
| weekly directory connect starts | PostHog: `connector_install_started` with `client_name='Anthropic'` (monitoring §7.5 note) | 6/wk (09-28) → back toward the 39–45/wk of early September |
| new first-time callers / day | the cohort query in the analysis plan | ~0–1 → 4–6 |
| plugin installs, skill runs, error rate | portal **Usage** tab (Ken reads it; counts only into the plan) | new |
| `*_not_exposed` repeat loops per owner | 7.18 `sheets_docs_hit_gate` vs `approved_or_picked` | should fall if the skill section works |

Add the PostHog alert from the analysis plan (zero connect starts in 48 h), so the
next cliff surfaces in two days instead of ten.

## Risks

- **The label date is unconfirmed.** If Anthropic says FGAC was always Community and
  ordering didn't change on ~09-25, the cliff has another external cause, and the
  plugin is still worth shipping for placement. Measure starts either way (Phase 4).
- **Brand holds.** Any "Google Workspace" wording in `displayName` or `author.name`
  is held for a reviewer. Keep both as "FGAC.ai".
- **Duplicate tools.** Users who already have the connector and add the plugin get
  one tool set only if `.mcp.json` keeps the exact connector URL. Don't add query
  parameters or path suffixes for attribution.
- **Plugin placement is observed, not promised.** We saw bundles ranked above
  Community connectors in one search on one day. Anthropic's ranking is
  "usage-based" and can change. Verified review (Phase 0) is the other lever, and the
  two don't conflict.
- **Customer data.** Portal usage screenshots and the Phase 0 numbers go into the plan
  as counts only (public repo).

## Owner summary

| phase | who | effort | blocks on |
|---|---|---|---|
| 0 email Anthropic: label date, Verified review, error type | Ken | 10 min | nothing; do today |
| 1 bundle content PR | agent | ½ day | nothing |
| 2 evals + Claude Code QA | agent (runner) | ½ day | `claude login` if expired |
| 3 submit + pair + publish | Ken | 20 min | Phase 1 merged |
| 4 measurement | agent | 2 check-ins | publish |
