# `client_name` on tool calls: the proxied claude.ai vs Claude Code split is a latest-handshake proxy

Branch: `claude/mcp-client-name-shared-registrations` — revision 1 (2026-10-01)

Follows `mcp-client-name-inspector_v1.md` (PR #162, deployed 2026-10-01 ~00:03Z
in train #168). Runbook: `docs/monitoring.md` 7.32, revision 2026-10-01.

## Finding (production PostHog, project FGAC.ai, external accounts)

PR #162 made the agent connection row follow the most recent product
handshake, and the first half-day after the deploy read as a reversal:

| day | labelled `Anthropic/ClaudeAI` (+ inspector) | labelled `claude-code`, `Claude-User` agent | labelled `claude-code`, CLI agent |
| --- | --- | --- | --- |
| 09-27 | 6,756 | 34 | 0 |
| 09-28 | 6,284 | 69 | 18 |
| 09-29 | 7,205 | 53 | 22 |
| 09-30 | 4,126 | 66 | 63 |
| 10-01 (to ~11Z) | 79 | 2,415 | 0 |

The suspicion was that "latest handshake wins" is biased toward Claude Code,
which handshakes more often (once per process, plus the 7.16 automation
loops), replacing the inspector bias with one the other way. Established
before building:

1. **What `claude-code` on the `Claude-User` agent is.** The Claude Code
   harness — CLI, desktop Code tab, web, Cowork — using the claude.ai-managed
   connector through Anthropic's proxy. Its `client_version` is the harness
   version (2.1.280 → 2.1.286 across 09-22 → 10-01), rolling forward daily in
   lockstep: 80–118 people a day on the newest version, the whole population
   moved within two days. The same version numbers appear on the CLI's own
   `claude-code/<ver> (claude-desktop, agent-sdk/0.3.x)` agent, which over 21
   days is one person's direct registration. So yes, the CLI handshakes as
   `Claude-User` whenever its connector is managed; the CLI agent only marks a
   `claude mcp add` registration. `Anthropic/ClaudeAI` is always `1.0.0`.
   Pinned stragglers (one person each on 2.1.218, 2.1.259, 2.1.263) are the
   7.16 loop clients — 2.1.259 handshook 239 times in 48 h with no calls.
2. **How much of the volume is a proxy.** Week 09-24 → 10-01, `Claude-User`
   registrations by the handshake names they reported: 163 shared (both
   names, 34,768 calls, 91%), 53 claude.ai-only (3,310 calls), 3 harness-only
   (4 calls). Exact only on the single-product 9%.
3. **Flip-flops since the deploy** (`mcp_connection_client_identified`,
   `product_switch` between the two names, first eleven hours): 77
   registrations, 162 switches — 35 once, 16 twice, 26 three or more; 42 in
   both directions. Gap between consecutive switches on one registration: p25
   11 min, median 63 min, p75 2.6 h; 20 of 85 follow-on switches within 10 min.
   The rule does what it says: 2,467 of 2,476 post-deploy proxied calls carry
   exactly the latest preceding handshake's name (the rest: six inspector rows
   on registrations with no handshake since the deploy, three third-party
   names).
4. **The post-deploy mix is not new.** Attributing every proxied call to its
   nearest preceding handshake (7.32e, handshake-based so valid on both sides)
   gives the harness 91% on 09-27, 87% on 09-28, 67% on 09-29, 86% on 09-30,
   97% on 10-01. The pre-deploy row labels (98% claude.ai-family) were the
   first-handshake pin, not a measurement; the deploy exposed the proportion.
   Independently, the 14 registrations with 100+ harness handshakes that week
   (the 7.16 automation loops, Claude Code processes by construction) carried
   17,475 of 38,082 proxied calls.
5. **No per-request signal exists.** A tool call carries the user agent
   (`Claude-User` for both) and the `MCP-Protocol-Version` header, which the
   one event recording it (`mcp_transport_rejected`) shows as the same value,
   `2026-07-28`, from claude.ai's discovery probes and from the desktop CLI.
   Measurable ambiguity: 75 of 2,476 post-deploy calls (3%) followed
   handshakes from both products within ten minutes; 1,003 (40%) rest on a
   handshake older than ten minutes.

## Directions, with the evidence that decided them

| direction | decision | why |
| --- | --- | --- |
| mark a registration SHARED when two names arrive within N minutes; stop renaming; stamp `claude.ai-family` | **rejected** | 163 of 219 registrations would be shared — the whole split collapses to one bucket, including the 9% that is exact; the registration-level split is consistent (finding 3) and worth keeping as a labelled proxy |
| per-product last-handshake timestamps on the row; label each call by the nearer preceding handshake | **rejected** | it is the current rule under another name — the row's name IS the nearest preceding product handshake (finding 3, 2,467 of 2,476) |
| dampen: ignore a switch when the other product handshook within the last few minutes | **rejected** | re-labels at most the 3% both-within-10-minutes calls, and nothing says which way is right; the 7.16 loop clients' zero-call bursts only mislabel calls of a user who is also on claude.ai, and those calls are inside that same 3% or rest on a handshake older than ten minutes either way |
| per-request fingerprint (protocol-version header) | **rejected** | already recorded on one event and identical for both products (finding 5) |
| docs-only: reading rule + queries | **accepted** | the split cannot be made exact per call under stateless streamable HTTP; what can be fixed is how it is read |

## Change

No behaviour change. `src/lib/mcpClientName.ts` keeps its rule and gains the
measured reading in its header comment.

- `docs/monitoring.md` 7.32: the five findings above, the rejected
  directions, the reading rule (CLI direct = exact; claude.ai-only and
  harness-only registrations = exact; shared registrations = latest-handshake
  proxy, reported as "claude.ai-family, split by latest handshake"), and three
  queries: 7.32c rewritten as the family split with exact and proxy portions
  separated, 7.32d flip rate on shared registrations, 7.32e nearest-handshake
  attribution with the both-within-10-minutes ambiguity column. Healthy
  conditions restated: a product-mix change is real only when the exact
  buckets move, or when 7.32e moves on a day 7.32d did not.
- `docs/analytics.md`: the `client_name` passage carries the limit.
- Daily analytics review task (`fgac-user-behavior-review`): the directory
  parity item now reports the family with the 7.32c buckets and runs 7.32d
  and 7.32e alongside; the 10-01 "claude-code 2,415 vs ClaudeAI 73" reading
  is written in as the baseline non-finding. The task file is outside the
  repo; the edited line is quoted in the hand-back.

## Residual error, stated

On a shared registration every call's `client_name` is the latest handshake.
That is right whenever one product is in use at a time and wrong for the
minutes after the other product handshakes while the first is still calling;
3% of calls are provably in that state, and the rest cannot be checked. The
split is internal — Anthropic's directory dashboard computes its own per-
product numbers on the proxy side — so no user-facing number depends on it.

## Verification

- Unit: `npx tsx scripts/test-mcp-client-name.ts` (unchanged rule, still
  green; part of `npm run mcp:lint`).
- The three runbook queries were run against production on 2026-10-01 and
  their outputs are quoted in the runbook comments (7.32c week to 10-01,
  7.32d first eleven hours, 7.32e harness share per day).
- Preview: docs and a comment only; the preview build is the check that
  nothing else moved. No organic traffic reaches a preview, so the queries
  stay production-only.
- Production, a week on: 7.32d daily flip rate settles (expect tens of
  registrations a day), 7.32e's `both_within_10m` stays in single-digit
  percent, 7.32a's toolbox column reaches zero.
