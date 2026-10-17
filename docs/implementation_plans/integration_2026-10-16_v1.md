# Integration train 2026-10-16 — approval links survive the signed-out sign-in leg, uptime monitors classed as scanners (v1: landed, unit validation)

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
- **Preview + QA:** pending. Scope:
  - capability 14 (magic-link approvals): A5, A6 (owner + non-owner, signed out, `+tag`),
    A7, A12, A19 **offer path with USER_B unattached** (owed from the branch's QA), A20,
    A21 regression;
  - analytics events: `approval_sign_in_wall.target_hash` joins `approval_link_minted`
    for an encoded (`~`) link;
  - #207: none beyond unit (label only, no UI); measure after deploy via monitoring 7.21e.
