# Integration train 2026-10-07 — approval-email episodes, temporary-key recipe, reconnect scope union, coverage guard (v1: landed, unit validation)

Branch: `integration/2026-10-07` (from `origin/main` at `df2100a`, the #193 merge).
Architecture: `docs/adr/002_integration_trains.md` (sixth train).

## Candidate table (the selection Ken approved, 2026-10-07)

| PR | What it is | Why it matters | Impact | Validation before the train | Bundle? |
| --- | --- | --- | --- | --- | --- |
| #192 | One approval-link reminder email per owner per 14-day episode | One owner got 5 reminders in 5 days; 2nd+ reminders produced no additional opens in 14 d | Owners whose agent requests many files: an email stream → one email per episode | Unit (`test-notify-claim-race` 2b, copy test), `mcp:lint`; capability 14 pending | Yes |
| `claude/temp-key-recipe-handling` | Temporary-key recipe hands the key over via a private temp file; `users/MAILBOX`; `send_attachment` ordered by size | The old recipe left inline command text as the only option, which Claude Code auto mode blocks as credential leakage | Large-transfer users (baseline 17 people) in Claude Code auto mode: blocked mid-transfer → completes | Unit (4 new), tool lint; capability 23 A1/A11/A12 pending | Yes |
| #182 | `include_granted_scopes=true` on every FGAC reconnect URL | Drive tree users lost `drive` on the next reconnect | Flag-gated Drive tree users keep `drive`; any reconnect repairs a narrowed grant | Local + its own preview (10-04, capability 18 A17 twice) | Yes (held out of the 10-06 train for independent rollback; approved this time — revert its landing commit to back it out) |
| `fix/qa-duplicate-a29-guard` | `qa-coverage-check` exits 2 on a repeated `A<n>` heading | ADR-002 Landing step 2 guard; the 10-06 train hit another duplicate | None for users; protects every train | n/a | Yes |
| `claude/facebook-muse-marketplace-42e936` | Meta Muse submission packet (docs/assets) | Owner submits when ready | None at runtime | n/a | Optional — not taken (Ken took the yeses only) |
| #188 | Drive card override count | Already shipped in #193 | — | — | No — close as shipped |
| #121, #72 | Old growth / sheets branches | 329 / 631 commits behind | — | — | No — stale |

## What landed (in landing order, each a `--no-ff` merge)

| source | branch | conflicts | resolution |
| --- | --- | --- | --- |
| #192 | `claude/approval-link-email-episode` | none | — |
| temp keys | `claude/temp-key-recipe-handling` | none | — |
| guard | `fix/qa-duplicate-a29-guard` | none | The A29 → A32 heading renumber was already on `main`; the landing brings the checker guard plus the plan cross-references (`lucid-pare` v1/v2, `integration_2026-09-25_v2`) that still said A29 |
| #182 | `claude/wizardly-shamir-8304cf` | `package.json` | union of the `mcp:lint` chains (adds `test-google-reconnect-url`) |

**Not landed:** Muse packet (optional, not selected), #188 (already shipped), #121, #72 (stale).

## Registries after landing

- Capability 18: A17 (#182), next free after A16. Capability 14 and 23: existing
  assertions edited, no new ids. No duplicates (the new guard passes).
- No migrations.
- `mcp:lint`: adds `test-google-reconnect-url`.

## Validation

- **Unit (train head):** `tsc --noEmit` clean; `npm run mcp:lint` exit 0; eslint clean on
  every changed file (one pre-existing unused-directive warning); `qa-coverage-check`
  passes the duplicate-id guard.
- **Preview + QA:** pending. Scope:
  - capability 14 (magic-link approvals): second request within 14 d of an emailed one →
    `skipped_episode`, chat link and denial text unchanged (#192);
  - capability 23 (temporary keys) A1, A11 on the preview; A12 in Claude Code auto mode —
    the agent completes the transfer without a classifier block (temp-key recipe);
  - capability 18 (Google reconnect) A17, before/after probe. Check `hasDriveFileScope` and
    the external account's `verification.status` first; only the destroy-and-recreate
    branch is a hand-off (#182);
  - `qa-coverage-check` over the run's results (guard).
