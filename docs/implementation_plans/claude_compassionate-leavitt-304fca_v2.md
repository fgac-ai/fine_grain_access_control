# Approval-link delivery — revision 2: the self-sent email is withdrawn

Branch: `claude/compassionate-leavitt-304fca` · revision 2 · 2026-09-15
Supersedes v1's "Decision" and "Design" sections. The evidence in v1 stands.

## What changed

v1 built, tested locally and on a preview, an email that carried the
approval link to the account owner's inbox — sent FROM the owner's own Gmail
account, through the Google grant FGAC holds for that owner's agent. Ken
rejected it on 2026-09-15 before it reached production: the grant exists so
the user's agent can act at the user's direction; FGAC using it for an
action FGAC itself initiates is a use the user never consented to, contrary
to the TOS and to what users were told about how their credentials are
used. The intent (reaching a person their agent's surface hides the link
from) does not change that. Every line of that feature is removed from the
branch — code, schema, migration, analytics properties, QA assertions, user
guide text. Nothing reached production; the only emails ever sent were from
a QA account to itself during testing.

Standing rule, recorded in the agent memory as well: **no FGAC-initiated
action may exercise a user's Google grant**, in any environment, for any
purpose. If a design needs the user's token for something the user did not
ask their agent to do, the design is wrong.

## What the evidence still says (from v1, unchanged)

- Per request, ~45–55% of minted approval requests are never opened; the
  open step is the whole loss (opened → approved runs ~82%).
- The never-openers cluster on agent surfaces that collapse the tool result
  (Claude Code); two of the three zero-open people in the window were on it.
- 67% of opens happen within ten minutes of the mint: the chat path works
  when the URL survives it.
- No out-of-band surface exists; half the cluster never visits the
  dashboard.
- Document reads (22 minted / 3 opened) and per-recipient sends (21 / 1) are
  the worst rows.

## Options that remain, for Ken to choose (none started)

1. **FGAC's own transactional sender** (e.g. an fgac.ai address via a mail
   provider): the same one-email-per-request design, but from FGAC, not from
   the user. Needs a provider, a domain/DKIM setup, a secret, and a TOS /
   privacy check that account-activity notifications to the sign-up address
   are covered. Reaches owners without the Gmail scope too.
2. **Dashboard pending-approvals list**: reaches the half of the cluster
   that does visit the dashboard (7–9 visits each in 14 d) and costs nothing
   in trust; misses the half that never opens it.
3. **Denial-copy experiment only**: the text already says "show the link
   VERBATIM"; the evidence suggests copy is not the lever for surfaces that
   hide the tool result. Cheap to A/B by deploy date, unlikely to move the
   Claude Code cluster.

`docs/monitoring.md` 7.19 (approval funnel per action, per request) is the
right read for whichever ships; v1's proposed 7.23 was tied to the withdrawn
properties and is not added.
