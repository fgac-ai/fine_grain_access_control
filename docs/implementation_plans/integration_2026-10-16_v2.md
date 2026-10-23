# Integration train 2026-10-16 — approval links survive the signed-out sign-in leg, uptime monitors classed as scanners (v2: preview QA, 0 fails; canonical-form hardening)

Branch: `integration/2026-10-16` (from `origin/main` at `991c351`, the #205 merge).
Architecture: `docs/adr/002_integration_trains.md`.
Sidebar group: `Train 2026-10-16` (this session, the approval-link session, #207's session).

## Candidate table (Ken approved 2026-10-16: "Skip 209, 208")

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| `claude/approval-link-plus-recipient` (no PR) | `r` travels as `~<base64url>` when it holds anything outside `[A-Za-z0-9._@-]`; legacy raw-`+` links verify through space→`+` tolerance | Train 2026-10-10b QA A6: a `+tag` recipient opened signed out returned "Invalid link" (pre-existing, reproduced on main's preview) | Signed-out approvals to plus-addressed recipients go from dead end to confirm page; non-owners see the wrong-account card (count not measured) | Unit (`mcp:lint`, tsc); preview cap 14 A5/A6/A7 pass, A19 skipped | Yes |
| #207 | `fixter-uptime` and `McpStatus` monitors classed `scanner` | They inflated the unlabelled `direct` no_token series from ~110/day to 350–450/day | Measurement only; 7.21 stops reading monitor noise as broken clients | `test-mcp-client-class.ts`; 90-day prod check: 0 ok / 0 tool calls | Yes |
| #209 | Privacy Limited Use statement | Google verification | — | copy only | No — Ken: skip |
| #208 | monitoring §7.35 verdict | docs | — | — | No — Ken: skip |
| #194 | ChatGPT directory packet | — | — | stale | No; RFC 9728 route duplicates #196's |

## What landed (each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| approval-link | `claude/approval-link-plus-recipient` | `scripts/qa-mint-approval-link.ts` | union: #204's `--profile` and this branch's `--recipient` (header doc, `Args`, parser, usage line) |
| #207 | `claude/scanner-uptime-monitors` (local ref, includes the unpushed plan v1 commit) | none | — |

**Semantic check:** the approval-link change alters `r`'s wire form; #204's `--profile`
only picks which key signs, so the two compose (the signature covers the decoded target,
not the wire form). #207 touches only `mcpClientSignals.ts`, a measurement label.

## Registries after landing

- Migrations: none.
- Assertions: cap 14 A6 rewritten (signed-out plus-addressed variant required); no new ids.
- `mcp:lint`: unchanged list (`test-approval-links.ts` was already in it).

## Validation

- **Unit (train head):** `npm run mcp:lint` exit 0; `tsc --noEmit` exit 0;
  `test-mcp-client-class.ts` and `test-approval-links.ts` pass; `qa-coverage-check.ts`
  dup-id guard clean.
- **Preview + QA:** see below.

## v2 — train-owned fix: one wire form per link (0707dc0)

The first audit reproduced that `atob` discards the unused trailing bits, so for a
target whose UTF-8 length is not a multiple of 3, up to four final base64url characters
decode to the same bytes and verify. Harmless (the signature is over the decoded
target, so no new grant), but one link had several wire forms and A7's "edit one
character → Invalid link" did not hold for that position. `decodeApprovalTarget` now
returns the param unchanged (→ signature fails) unless `encodeApprovalTarget(decoded)`
reproduces it exactly. Unit: `test-approval-links.ts` gains "non-canonical encoded alias
does not decode" (fails on d75f082, passes on 0707dc0). `mcp:lint` and `tsc` exit 0.
Note: the test address had to be `example.com` (pre-commit public-repo guard) and 16
bytes long so it still carries trailing bits.

## Preview QA

| round | preview | commit | runner scope |
| --- | --- | --- | --- |
| 0 | fine-grain-access-control-fic3gsk1i-kenyesh-gmailcoms-projects.vercel.app | d75f082 | cap 14 A5 A6 A7 A12 A19 A20 A21 + wall join |
| 1 | fine-grain-access-control-3sc1zgyoc-kenyesh-gmailcoms-projects.vercel.app | 0707dc0 | A5 A6 A7 + wall join recorded; A21 status; audit nits |

Every flow used the built-in browser; Path B was not needed. All links were minted by a
real denied `gmail_send` over MCP (`qa:mint-link` reads the local branch DB, whose key
ids differ from the preview's).

| assertion | result | evidence (short) |
| --- | --- | --- |
| A5 | pass (r1) | wrong-account card, owner masked, profile label shown, sign-out `redirect_url` returns to the identical approve URL |
| A6 | pass (r0, r1) | `r=~…` (no raw `+`/`&`/`%`); signed-out owner → confirm page with `+tag` intact → `result=ok`, retry sent, other `+tag` still denied; signed-out USER_B → wrong-account card |
| A7 | pass (r1) | changed signature, changed recipient, and same-bytes final-character edit all "Invalid link" (`invalid_reason=signature`); the last case was accepted by r0's build |
| A12 | pass (r0, carried) | three identical denials → byte-identical URLs; r1 re-observed a stable request_id |
| A19 | pass (r0, carried) | **offer path** run: delegation revoked via the dashboard, prominent `delegate-panel`, Attach → done state held 3.5 s, reopen `data-initial=true`, delegation restored |
| A20 | partial pass (r0, carried) | first open `visitor_row_provisioned=true`, wrong-account card not Invalid; `delegate_offer` was false on that open (delegation existed) |
| A21 | **blocked** | needs a denial from a non-default-profile connection; the stored bearer is default-profile. The train does not touch the approve page or `profileDashboardHref` (`git diff 991c351 -- src`); A21 passed on train 2026-10-10b and is live |
| wall join | pass (r0, r1) | `approval_sign_in_wall.target_hash` = `approval_link_minted.target_hash` for two encoded links (PostHog, environment=preview; wall rows carry no request_id, join is on target_hash) |

Coverage check: scoped run, all in-scope assertions accounted for (6 pass, 13 skip, 1
blocked, 0 fail). Two audits; every finding resolved except A21 (blocked by fixture).
#207: unit only (measurement label); measure after deploy with monitoring 7.21e — the
unlabelled `direct` no_token remainder should fall back to ~110/day.

Cleanup: the `+qa` whitelist rule was deleted through the dashboard (a re-send was denied
again); USER_B→USER_A delegation exists again after A19; a throwaway "QA Second Profile"
was created and its key revoked during the A21 attempt.

Release PR: `gh` failed with x509 TLS errors throughout this session; open via
https://github.com/fgac-ai/fine_grain_access_control/compare/main...integration/2026-10-16
