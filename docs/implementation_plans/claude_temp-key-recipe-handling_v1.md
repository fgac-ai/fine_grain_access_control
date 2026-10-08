# Temporary-key recipe: a compliant way to hand the key to a script — v1

Branch: `claude/temp-key-recipe-handling` · 2026-10-06 · follows `large-api-payload-options_v7.md`
(PR #179, shipped in train #187). Lands on the next integration train (ADR-002): pushed, no PR.

## Why

2026-10-06: an agent in Claude Code minted a temporary key to send a 196 KB email with an inline
image. It put the key inline in the curl command text; Claude Code's auto-mode classifier blocked
that as credential leakage. The recipe also said "never … write it to a file", so the agent had
no compliant way to hand the key to a script at all — the recipe as written could not be followed
under auto mode.

The feature author confirmed against the shipped code (`src/app/api/proxy/[...path]/route.ts`,
`src/lib/gmailRules.ts`, `src/lib/temporaryApiKeys.ts`):

- a chmod-600 temp file in the session scratchpad, read with `$(cat file)` and deleted afterwards,
  is the intended pattern. What must be forbidden is the key reaching the user's chat, a URL or
  query string, logs, or anything committed/shared;
- `users/me` resolves to the key **owner's primary FGAC address** (`users.email`), not the
  connection's mailbox or a linked/delegated one. Rule matching keeps global rules + this profile's
  rules whose `targetEmail` is null or the resolved address. Other mailboxes need `users/<address>`
  and a `key_email_access` row for that mailbox;
- JSON `POST gmail/v1/users/<mbox>/messages/send {"raw"}` is supported; with the 4.25 MiB body limit
  and ~33 % base64 overhead it suits messages up to ~3 MB. `upload/…?uploadType=media`
  (`message/rfc822`) works up to ~4 MB; resumable above that.

## Changes

| where | before | after |
| --- | --- | --- |
| `temporaryKeyRecipe` key-handling line | "never show it to the user, write it to a file, or put it in a URL" | "Keep the key out of anything that leaves this session: don't show it to the user, put it in a URL or query string, log it, or commit it. Hand it to your script through a private temp file (chmod 600) or an environment variable, and delete the file when done." |
| recipe, how to write the file | — | preferred: write `KEY_FILE` with the agent's file-writing tool then chmod 600 (the key never appears in command text — the thing the classifier blocks); fallback `(umask 077; printf %s '<api_key>' > "$KEY_FILE")`; `rm -f "$KEY_FILE"` when done |
| recipe, scope | per-purpose recipes only | general line: any Google REST call the rules allow; main uses are large attachments and Drive uploads; recipes are examples |
| recipe, Gmail mailbox | examples hard-coded `users/me` | `users/MAILBOX` placeholder; `users/me` = FGAC sign-in address, `users/<address>` for linked/delegated mailboxes (list_accounts names them) |
| `send_attachment` | resumable first, media as an afterthought | ordered by size: JSON `{"raw"}` ≤ ~3 MB → `uploadType=media` ≤ 4 MB → resumable (every To/Cc/Bcc header in the first chunk) |
| every curl example | `-H "Authorization: Bearer $KEY"` | `-H "Authorization: Bearer $(cat "$KEY_FILE")"` |
| `create_temporary_api_key` description (`toolDefs.ts`) | "never display it, save it to a file, or put it in a URL" | same key-handling sentence as the recipe + the `users/me` vs `users/<address>` sentence |
| QA capability 23 (temporary keys) | A1 "must not be shown"; A11 "never show the key" | A1 checks the file hand-off, no bare `$KEY`, and the mailbox sentence; A11 checks the new rule; A12 records any harness block |

Unit checks added in `scripts/test-temporary-api-keys.ts` (kept "4 MB" / "bytes */TOTAL"): every
purpose's recipe uses `umask 077` + `rm -f "$KEY_FILE"` and no bare `$KEY`; no recipe says "write it
to a file"; every recipe has the `users/me` sentence; `send_attachment` is ordered raw → media →
resumable and names ~3 MB.

## Considered, unchanged: the tool result still prints the key

The key lands in the transcript because the tool result carries it. Alternatives:

- **Don't return it; have FGAC write it somewhere** — impossible: FGAC is a remote server and cannot
  write to the agent's machine.
- **Return it only in `structuredContent`** — still in the transcript for most clients, and
  clients that drop structured content would lose the key entirely.
- **Return a one-time redemption URL the script fetches** — the URL becomes the credential (and
  lands in the transcript and in command text), adding a round trip and a new secret type for no
  real reduction in exposure.

The transcript is the agent's own context, which is inside the session boundary the rule draws.
The real exposure controls are what already exist: 15-minute default / 60-minute cap, the same FGAC
rules as the parent profile, revocation with the parent, and 10 live keys per connection. Kept
as-is; revisit if a client starts persisting tool results somewhere shared.

## Validation

- `npx tsx scripts/test-temporary-api-keys.ts` — all checks pass (4 new).
- `npx tsx scripts/mcp-tool-lint.ts` — 22 tools OK; `tsc --noEmit` clean.
- Train QA scope: capability 23 (temporary keys) A1 + A11 on the preview (recipe text and
  `tools/list` description), A12 in Claude Code (auto mode) to confirm the agent completes the
  download without a classifier block.
