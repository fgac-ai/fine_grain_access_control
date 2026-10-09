# Package FGAC as a Claude directory plugin, paired with the connector (v6)

**v2 changes (2026-10-06, after reading the developer portal and the in-app directory
signed in as the listing owner):** the connector is **not** delisted. Phase 0 becomes
a request to Anthropic instead of a resubmission. The case for the plugin is now
measured rather than inferred. v1 is unchanged in
`claude_claude-directory-plugin_v1.md`.

**v3 changes (2026-10-07):** Ken confirmed FGAC has **always** been Community, and
that most installs came from Claude's in-chat connector suggestions, not from directory
browsing. Our data agrees: before 09-26, 82 of 141 new accounts called a tool within 5
minutes of connecting. v3 adds a direct test of those suggestions. It moves the
Verified label to the top of the plan, because the plugin alone may not restore
suggestions.

**v4 changes (2026-10-07):** a wider test compares Community connectors, Verified
connectors and plugins in Claude's in-chat suggestions (32 prompts across both orgs).
It confirms that Community connectors are invisible to suggestions. It also shows
plugins are surfaced by a separate mechanism that does reach third-party listings.

**v5 changes (2026-10-07):** Ken pointed out that several earlier statements were
hypotheses presented as findings. v5 adds a claim audit, answers the three
open questions from our own checks, and reverses one conclusion: **Community
exclusion from in-chat search predates the 09-26 drop, so it is unlikely to be the
cause.**

## Claim audit (2026-10-07): what is observed, inferred, or unknown

| # | claim made earlier in this thread | status | evidence / caveat |
|---|---|---|---|
| 1 | New connections fell ~85–90% starting 2026-09-26 | **Observed** | PostHog `mcp_connection_created` and the `Anthropic` python-httpx probe: ~40/week → 6/week |
| 2 | The connect flow still works (starts still complete) | **Observed, small n** | 6 of 8 starts completed after 09-26, against 9 of 10 before |
| 3 | The python-httpx `Anthropic` 401 marks the start of a directory connect | **Inferred** | it preceded 9 of 10 completed connects by 0–2 min on 09-24..25; never confirmed by Anthropic |
| 4 | Most installs came from in-chat suggestions | **Inferred** (Ken's belief, weak support) | 82 of 141 pre-cliff new accounts called a tool within 5 min of connecting. That is consistent with mid-task connects, but browse-then-try would look the same |
| 5 | FGAC was "missing from the Marketplace" because it is Community | **Inferred** | sitemap (911 entries) holds none of the 10 Community Gmail connectors checked; no statement from Anthropic |
| 6 | Directory search ranks Verified → plugins → Community | **Observed on one account, one day** | 13 searches; relevance can override the tier (exact name matches) |
| 7 | In-chat "Searching connectors" does not return Community connectors | **Observed on one Free account, one day, incognito, default model** | Community 0/9 by name, Verified 7/7, plugins 5/5. Not tested on a paid personal plan (Team search only covers org-enabled connectors), so it may be plan-specific |
| 8 | That behaviour started on or around 09-25/26 | **Contradicted** | public reports from 08-04 (#762) and 08-29 (#954) describe the same exclusion |
| 9 | Community exclusion caused the 09-26 drop | **Now unlikely (downgraded in v5)** | the same exclusion was publicly reported on 2026-08-04 and 2026-08-29, while FGAC was still adding ~40 connections a week; see below |
| 10 | The developer portal opened 09-25 | **Secondary sources + archive** | press articles; earliest archive capture of /docs/directory/publish is 2026-09-25 20:20Z; no Anthropic announcement found |
| 11 | A plugin would be found by name in chat | **Inferred from other plugins** | 5/5 third-party and Anthropic plugins found by name; never tested with a new, low-usage plugin |
| 12 | Anthropic's docs say all directory entries are suggestion-eligible | **Observed** (docs read 2026-10-07) | "Every directory entry is automatically eligible, and there is no separate opt-in" |
| 13 | No release note announces a suggestion-eligibility change | **Observed** | claude.ai release notes 09-15..10-06 are empty; Cowork/Desktop and Claude Code changelogs 09-22..10-07 have no such entry |


## Plugins: is there a Community/Verified split? (2026-10-07)

- **Docs (observed):** Verified/Community labels are defined for connectors only. No
  doc says plugins carry them.
- **Directory (observed, 7 searches on the Team org):** plugin cards show **no label**,
  only "Plugin" and the GitHub repo. Community connector cards on the same result
  pages do show "Community". That holds for obscure plugins too, such as
  `taosdata/agent-skills` (idmp-plugin) and a Carta plugin listed with "(No
  description)". So the only visible distinction is the publisher (`anthropics/…` vs
  third-party).
- **In-chat by name (observed, Free org, incognito):** 10 of 10 plugins found, each
  with an Add card. 8 are third-party, including low-profile ones: idmp-plugin
  (TDengine), Carta investors, SearchAtlas Toolkit, Descope, Apify. There is no sign
  of a label or usage gate for plugins, unlike connectors.
- **Unprompted tasks (observed, Free org):** 0 of 3 for niche third-party plugins
  (Auth0 migration → Descope, TDengine IDMP schema → idmp-plugin, SEO/GBP →
  SearchAtlas). For the TDengine prompt Claude searched *connectors*, found
  nothing, and didn't offer the plugin it installs by name. On Team, 1 of 3 earlier
  task prompts got an unprompted plugin (Anthropic's Marketing).
- **Unknown:** whether a **newly published** plugin with no installs is findable by
  name right away. All plugins tested are already listed and in use. That can only
  be tested after ours publishes.
- **What this means (inference):** a plugin listing would make FGAC installable from
  chat whenever a user asks for it by name. Today that fails as a Community
  connector. It would not, on this evidence, bring back unprompted
  task-based suggestions.

## First-pass answers to the open questions (2026-10-07)

### Q1. Is leaving Community connectors out of in-chat search intended? Since when?

- **Docs (observed today):** the directory page and the directory-vs-custom page say
  "Every directory entry is automatically eligible" for Suggested Connectors, with no
  opt-in.
- **Behaviour (observed today, two ways):**
  - In-chat prompts on a Free org: Community 0/9 by name, Verified 7/7.
  - The `search_mcp_registry` tool itself (the tool chat uses, called directly from
    this Claude Code session on Ken's account): lemlist, Missive, Hostinger, Akiflow,
    Hiver, Postbeam and Point Hacks (all Community) → **no match**. AgentMail and
    Inkbox (Verified) → returned. FGAC → returned **only because it is already
    connected** (`connected: true`).
  - Adspirer was reported as Community in #954 and is returned today. It now has
    pages on claude.com/marketplace, which appears to list Verified connectors only,
    so it has **probably** been promoted since (inferred).
- **Public reports (read on GitHub):** anthropics/claude-ai-mcp
  [#762](https://github.com/anthropics/claude-ai-mcp/issues/762) (2026-08-04, a
  Community connector "never" returned by `search_mcp_registry`) and
  [#954](https://github.com/anthropics/claude-ai-mcp/issues/954) (2026-08-29,
  exact brand-name query returns zero results). Both are open, labelled `bug` in
  #954's case, with **no reply from Anthropic**.
- **Release notes:** no entry about suggestion eligibility in claude.ai (09-15..10-06),
  Cowork/Desktop (09-22..10-07) or Claude Code (09-23..09-29).
- **Answer:** *since when*: at least 2026-08-04, which is **before** our drop.
  *Intended?* **Unknown.** The pattern is clean (label-gated, with a promoted
  connector moving into results), which looks deliberate (inference). But the docs
  say the opposite, and Anthropic has not answered two bug reports.
- **Consequence:** suggestions were probably **not** the source of FGAC's
  August–September installs, assuming FGAC was excluded then too. That is
  unverified, but it follows if the gate is the label. Ken's belief that installs came
  from suggestions conflicts with this, and the 5-minute-to-first-call statistic
  doesn't separate suggestion connects from mid-task directory connects. **The
  cause of the 09-26 drop is open again.** Remaining candidates, all untested:
  - the directory surface itself changed around the Marketplace launch (09-23),
    for example plugins now ranking above Community in search and the home page
    leading with plugins;
  - something on Claude Code's side, which carries 85% of our calls;
  - something not yet thought of.

### Q2. What is the path to Verified?

- **Docs (observed):** listings start as Community. Anthropic "may escalate listings
  flagged as highly useful to Claude users to Verified review"; this is assessed
  automatically, there is no application, and escalations go to the directory team.
- **Comparison (inferred):** Adspirer had 3,378 users and rank #352 in August while
  still Community, and appears Verified now. FGAC has 181 users and rank #1,436. If
  the bar is usage-based, FGAC is far below it. This is one data point; the threshold
  is not public.

### Q3. What is `McpOAuthTokenReadUnsupported`?

- **Unknown.** It appears nowhere in Anthropic's docs (llms-full.txt searched) and
  nowhere in public issues found. Our own auth-failure events carry no matching
  reason. It is an Anthropic-side error name. Only the directory team can explain it.

## Where to raise it

- **anthropics/claude-ai-mcp Issues** is the active official tracker (about 592 open
  issues, newest filed today). Adding our reproduction to #954 is the strongest
  move, because a second, independent, current report on an open `bug` issue is more
  likely to be triaged than a new duplicate. The repo is **public**: post the
  reproduction (connector names, prompts, the tool's empty results) and our own
  aggregates only, never user data. **Ken approves the post text first.**
- The portal's "Email the directory team" link (the escalation path the docs name).
- Not found: an official Discord or forum thread. Reddit could not be searched in
  this session.

## Community vs Verified vs plugins in in-chat suggestions (2026-10-07)

Fresh incognito chats on Ken's login. "Free" = the Personal (Free) org with no
connectors (the new-user view). "Team" = the FGAC.ai Team org.

| group | how asked | org | result |
|---|---|---|---|
| **Community connectors**: FGAC.ai, Streak, Mailbox MCP, lemlist, Front, Hostinger, Missive, Teamwork.com, Akiflow | by name ("Connect the X connector…") | Free | **0 of 9 found.** Claude says "not listed in the directory" and offers Verified alternatives |
| **Verified connectors** (small and niche): AgentMail, Fyxer, Inkbox, Autosheet, Rockhopper, SlidesGPT, Brightdeck | by name | Free | **7 of 7 found**, each with a Connect card |
| FGAC-shaped tasks (multi-account Gmail, block 2FA mail, Sheets, Slides, plan my day) | task only | Free | only Verified connectors suggested (Google Gmail/Sheets/Drive/Slides/Calendar, Superhuman, Fastmail, Microsoft 365) |
| **Plugins**, third-party included: Carta, AgentMail, Val Town, Anthropic Productivity, Marketing | by name, or "is there a plugin…" | Free | **5 of 5 found**, with an "Add" install card listing the plugin's skills |
| plugin-shaped tasks (deploy a script, cap table, agent inboxes, plan my day) | task only | Free | **0 of 5 plugins** suggested; connectors or a plain answer instead |
| plugin by name (AgentMail) | by name | Team | found ("in your organization's catalog") |
| plugin-shaped tasks (marketing campaign, deploy a script, organize tasks) | task only | Team | **1 of 3**: Anthropic's Marketing plugin suggested unprompted. Third-party Val Town not suggested |

Notes:
- Team-org connector search only covers connectors the Owner enabled, so Team rows
  say nothing about directory connectors.
- One Team cap-table response failed to capture.
- "Is there a plugin that lets you manage multiple Gmail accounts?" on Free returned
  connectors (Gmail, Superhuman), not the third-party multi-Gmail plugin that the
  directory search lists. Plugin search, too, seems to fire on names more than
  needs.

### What this means

1. **Community connectors don't exist as far as chat is concerned.** Not suggested
   for tasks, and not found even by exact name. Verified connectors of any size are.
   That is the most direct explanation of the 09-26 cliff, given that installs were
   suggestion-driven.
2. **A plugin listing is findable in chat; a Community connector listing is not.**
   Every plugin named was found and offered with an install card, third-party ones
   included. Unprompted suggestions favour connectors on Free, and Anthropic's own
   plugins on Team, with only one example of the latter. **So the plugin restores
   "user asks for FGAC by name → one-tap add"** (word of mouth, docs, flyers,
   directory search). It does not, on this evidence, restore proactive suggestions.
   Only Verified does that.
3. **Two parallel tracks, and neither replaces the other:**
   - **Plugin** (we control it, ~1 day of work plus review): restores by-name
     discovery in chat, and outranks Community in directory search.
   - **Verified** (Anthropic decides; automatic assessment): the only route back
     into proactive task suggestions, which is where the pre-09-26 volume came from.

## In-chat suggestion test (2026-10-07)

**Setup:** Ken's login, **Personal (Free) org** with no connectors, which is the
new-user view. Each prompt went into a fresh incognito chat. The FGAC.ai Team org was
not usable for this: in a Team org the "Searching connectors" step only searches
connectors the Owner has enabled, so even Google's Gmail came back empty there.

| prompt (abridged) | connectors Claude suggested |
|---|---|
| summarize unread mail in my work **and** personal Gmail | Gmail (Google). Claude also told the user to "connect each account separately", which Google's connector can't do |
| check work, school and personal inboxes at once: which tool can do that? | Gmail, Superhuman Mail |
| update totals in my Google Sheet | Google Sheets, Google Drive |
| give my agent Gmail access but block password-reset/2FA mail | Gmail. Claude: "it doesn't block anything by default" |
| change the title slide of my Google Slides deck | Google Slides |
| **"Connect FGAC.ai so you can read my Gmail"** | Gmail, plus a leftover *custom* "FGAC - Test" entry. **The FGAC.ai directory listing was not returned** |
| control: "Connect … Streak CRM for Gmail" (**Community**) | "couldn't find a Streak CRM for Gmail connector in the directory" |
| control: "Connect … Mailbox MCP" (**Community**) | "didn't find a connector named Mailbox"; offered Gmail, Fastmail, Superhuman, AgentMail |
| control: "Connect … AgentMail" (**Verified**, niche) | AgentMail, found by name at once |

**Finding:** in-chat connector search on a consumer account **does not return
Community connectors, even when the user names them**, while a niche Verified
connector is found by name. Anthropic's directory doc still says "Every directory
entry is included automatically" in Suggested Connectors, so either the doc is stale
or the behaviour changed. No plugin was suggested in any chat (plugins need a paid
plan, and this was Free).

**What this means for the 09-26 cliff:** if Community connectors dropped out of
in-chat suggestions around the 09-25 portal launch, it explains everything we saw:
a one-day drop in connect starts, intact conversion, a steady existing base, and the
fact that we were "always Community". We still cannot date the change from
outside, because we have no pre-09-26 observation of a suggestion naming FGAC. But it
is the only mechanism found so far that matches every fact.

**Consequences for the plan:**
1. **The Verified label is now the main lever, ahead of the plugin.** Verified
   connectors are what the suggestion search returns. The docs say escalation to
   Verified review "is assessed automatically" for listings flagged as highly useful,
   and there is no application. Phase 0 changes accordingly.
2. **The plugin is still worth shipping, but it may not fix suggestions.** Nothing
   in this test shows the suggestion search returning plugins. Re-run the same
   prompts on a **paid personal** org once the plugin is live, to see whether a
   plugin card appears. Until then, its value is directory placement (plugins
   outrank Community connectors in search) and Claude Code reach (85% of our calls).
3. **Measuring recovery:** a re-run of this prompt table is the direct test.
   Re-run it after any label change and after the plugin publishes. The
   connect-start series (§Phase 4) remains the outcome metric.

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

## Phase 0: push for Verified (Ken; email optional)

Ken expects no reply from support, so treat the email as optional. The levers we
control:

1. **Make the listing look "highly useful" to the automated assessment.** Re-read
   the connector pre-submission checklist (claude.com/docs/connectors/building/review-criteria),
   which Verified reviewers test against. Then close any gaps in tool annotations,
   tool descriptions, the privacy and docs links, and a reviewer test account.
   `docs/connector_submission/reviewer_runbook.md` already covers most of it, so
   check it against today's checklist.
2. **Fix the tagline keywords** (directory search matches name, tagline and
   category). Add "inbox", "Google Drive", "Google Workspace" and "access control".
   It goes through review but costs nothing.
3. **Email the directory team anyway** (portal → Get help), asking for Verified
   review and quoting the portal's usage aggregates. One message, low cost.

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
