# Privacy policy rewrite for Google OAuth verification — v2

Supersedes v1 (same branch, PR #178). Everything in v1 stands except the
section list below; the claim → evidence table (v1 §2) and the decisions for
Ken (v1 §3) are unchanged and not repeated here.

## What changed in v2 (Ken, 2026-10-03: "remove the extra non-Google related sections")

The v1 page had 14 sections. Five were general-privacy boilerplate that Google's
verification does not ask for and that the Gmail-only policy passed without:
**Delegated access**, **Emails FGAC sends you**, **Your rights and choices**,
**Children**, **Changes to this policy**. v2 removes them. The page now has
nine sections:

1. Introduction
2. Google API Services User Data Policy (Limited Use, verbatim + commitments)
3. Information we collect (account; per-permission table; configuration;
   usage/technical data incl. analytics and session replay; cookies; forms)
4. How we use information
5. AI agents and MCP clients you connect
6. Sharing and service providers
7. Security
8. Retention, deletion and revoking access
9. Contact

Facts the removed sections carried that Google's checklist still needs were
folded into surviving sections rather than dropped:

| Fact | Now lives in |
| --- | --- |
| How to revoke Google access (myaccount.google.com/permissions) and the effect | §8 "Revoking access" |
| How to narrow/block/revoke agents and withdraw the full Drive permission | §8 "Revoking access" |
| How to delete the account and what happens (tombstone, erase on request) | §8 "Deleting your account" (unchanged) |
| Delegation: owner's token never leaves the owner's account, calls recorded under both accounts, revocable | one paragraph at the end of §5 |
| Transactional emails exist and are sent from FGAC's own mailbox, never the user's grant | one bullet in §4 |
| Data requests (access, correction, export, deletion) go to support@ and are verified against the account address | §9 Contact |

Dropped outright: the GDPR legal-bases paragraph, the GDPR/CCPA rights list,
the children statement, the change-notification promise. The effective-date
line stays; the Terms page keeps its own "Changes" clause.

## Validation

Local (Path B, Playwright CLI, dev server on the branch database): 9 headings,
9 contents links, 0 missing anchors, no stale "Section N" cross-references,
Limited Use link and revoke link present, 0 console errors, no overflow at
375 px. Preview: recorded in the PR after the watcher reports the build for the
v2 commit.
