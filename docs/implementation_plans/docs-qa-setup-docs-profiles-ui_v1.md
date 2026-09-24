# QA setup docs → agent-profiles UI (v1)

Branch: `docs/qa-setup-docs-profiles-ui`. Docs only — no source changes.

## Problem

`docs/QA_Acceptance_Test/setup/01–03` and the coverage checkpoint in
`.claude/commands/qa-setup.md` still described the retired dashboard: an
"API Keys" section with "Create New Key", an "Access Rules" table with a Scope
column ("Global (all keys)" / "🔑 1 key"), "Delegation Management" on the
dashboard, and green/teal dots under "Accessible Gmail Accounts". Two
`qa-setup-driver` runs (2026-09-21, 2026-09-22) reported the mismatch as a
finding instead of improvising, as their hard rules require — so `/qa-setup`
could not complete without a human translating each step.

## What the live UI does (verified against the components)

| Doc said | Live UI | Source |
| --- | --- | --- |
| "API Keys" → "Create New Key" | Tab strip → **"+ New profile"**; a profile IS a proxy key; page per profile at `/dashboard/agents/<slug>` | `AgentProfilesView.tsx` (`ProfileTabs`), `KeyControls.tsx` (`variant="button"`, `triggerLabel="+ New profile"`), `agents/[slug]/page.tsx`, `lib/profileSlugs.ts` |
| Modal "Key Label" / "Email Access" / "Create Key" | Unchanged inside the modal (still headed "Create API Key") | `KeyControls.tsx` |
| Key list with masked key, Reveal/Copy, Roll/Revoke | Masked bearer token in the **"Connect a new agent via MCP"** card (eye tooltip "Reveal Key"/"Hide Key", copy tooltip "Copy to clipboard"); **"Revoke key"** → **"Confirm revoke"** in the profile header; no Roll control on the profile page | `AgentProfilesView.tsx` (`McpConnectCard`, `ProfileHeader`), `KeyControls.tsx` (`SecretKeyDisplay`) |
| Default state: no keys | Every account has a **`Default Profile`** from sign-up with its own mailbox | `db/userHelpers.ts` (`createDbUser`) |
| "Delegation Management" → "Delegate Access" on the dashboard | `/dashboard/accounts` → **"Delegations You've Granted"** → **"Delegate Access"** (inline email input → **"Grant"**); row shows "Active" + "Revoke" | `accounts/page.tsx`, `DelegateAccessButton.tsx`, `RevokeDelegationButton.tsx` |
| "Accessible Gmail Accounts" with green/teal dots | Accounts page card with **"You"** + **"Active"/"Reconnect"** badges, delegated rows **"Delegated to you"**; profile page **"Gmail Account Access"** card with **"You"/"Delegated"/"Reconnect"** | `accounts/page.tsx`, `AgentProfilesView.tsx` (`GmailAccessCard`) |
| Delegated mailbox appears on keys only if checked | Also attaches to the delegate's **Default Profile automatically** | `actions.ts` (`grantDelegation` → `syncDefaultProfileDelegatedAccess`) |
| Yellow banner "Connect Google Account" / "Sign in with Google" | Title and button depend on the missing scope: "Connect Google Account"/"Sign in with Google", or "Grant Gmail access" / "Grant Google Drive file access" with **"Reconnect Google"**; Accounts page shows per-scope `gmail.modify` / `drive.file` badges | `ConnectGoogleWarning.tsx`, `lib/googleScopeCopy.ts`, `accounts/page.tsx` |
| "Access Rules" section, Scope column | Per-profile **"Gmail Rules"** card: type badge, **"Global"** badge, pattern, "All accessible mailboxes"/"Scoped to …", Edit / Detach / Delete | `AgentProfilesView.tsx` (`GmailRulesCard`, `RuleTypeBadge`, `DetachRuleButton`) |
| "+ Quick Add 2FA Block" / "Create Custom Rule" | Same two buttons, now in the **"Create a rule"** card at the bottom of every profile page; quick-add seeds four global read-blacklist rules and flips to "✓ 2FA Block Applied" | `RuleControls.tsx`, `actions.ts` (`applyRecommendedSecurityRules`) |
| — | **"+ Apply a rule"** popover (existing non-global rules) with **"+ Create a new rule…"** opening the same modal | `AgentProfilesView.tsx` (`ApplyRulePopover`), `RuleControls.tsx` (`openSignal`) |
| — | Default-Profile-only **"Enable sending to anyone"** (`Send to Anyone`, pattern `*`) — must NOT be clicked during setup | `AgentProfilesView.tsx` (`GmailRulesCard`), `actions.ts` (`enableSendToAnyone`) |
| Regex patterns (`.*@competitor\.com`) | Patterns are globs (`*` → `.*`), validated by `validateRulePattern`; docs now use `*@competitor.com`, `*@spam-newsletter.com`; `|` alternation still compiles | `lib/rulePatterns.ts` |
| Nav "Dashboard" link | Nav shows **"Agent Profiles"** and **"Accounts"** when signed in; sign-up CTAs are "Get Started — it's free" (hero) and "Sign Up" (nav), Clerk modal → "Continue with Google" | `layout.tsx`, `page.tsx`, `SignUpCta.tsx` |

Two things the task statement assumed that the code contradicts, recorded so
nobody "fixes" the docs back:

- The 2FA quick-add button is on **every** profile page's "Create a rule" card,
  not only the Default Profile. Only "Enable sending to anyone" is
  Default-Profile-only.
- Rule assignment in the create/edit modal ("Assign to Specific Keys") lists
  profiles by label with the key id as the checkbox value — that part was already
  accurate.

## What changed

- `setup/01_signup_and_credential.md`: new "How the dashboard is organised"
  primer (profiles, slugs, nav, the native alert/confirm override for the
  embedded browser); Tests 1–5 re-pointed at the profile pages and the Accounts
  page. Test 3 creates `QA First Key` as a profile; Test 4 exercises the bearer
  token row; Test 5 checks USER_B sees only their own Default Profile and warns
  not to accept the second-account prompt yet.
- `setup/02_multi_account_linking.md`: delegation via the Accounts page;
  Test 4 also checks the delegated mailbox auto-attached to USER_A's Default
  Profile; Test 5 creates the three named profiles and verifies each "Gmail
  Account Access" card; slug-collision recovery note.
- `setup/03_rules_configuration.md`: rules model (global vs assigned, badges,
  Detach-makes-global), the three creation paths, the "Enable sending to
  anyone" hazard; Tests 1–5 keep every rule name, type, pattern intent and
  profile assignment; verification now reads badges instead of a Scope column.
  Per-file fixtures section kept, with the profile-page "+ Expose a …"
  shortcuts added.
- `.claude/commands/qa-setup.md`: checkpoint items name the UI evidence for
  each (Accounts badges, tab strip, "Gmail Account Access" cards, "Gmail
  Rules" badges) and add a "no `Send to Anyone` rule" guard.

Every existing assertion's intent is preserved: same accounts, same
USER_B → USER_A delegation, same three profiles with the same mailbox
mappings, same rule names/types on the same profiles. Capability docs
(`03_multi_email_scoping.md` etc.) keep referring to `QA-Agent-A/B` and
`QA-Power-Agent`, which are now profile labels. The `### A<n>:` convention is
untouched (setup docs use `## Test n:` and are not parsed by
`scripts/qa-coverage-check.ts`).

## Not changed (follow-ups)

- `docs/user_guide.md` still documents the old "Create New Key" / "Delegation
  Management" UI — user-facing, out of this task's scope.
- Live-browser re-validation of the rewritten steps is the next `/qa-setup`
  run; the click labels here were verified by reading the components, not by
  driving a dev server.
