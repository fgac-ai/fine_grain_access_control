# claude/neonctl-transient-retry — v1

## Symptom (2026-10-07, ~04:00–04:20Z)

`npm run db:branch` failed with

    ERROR: Cannot read properties of undefined (reading 'branches')
    ❌ Neon CLI error. Are you authenticated?

`neonctl me` and `projects list` worked; `branches list -o json` failed on 7.0.1
and on 8.0.11, with and without `--org-id`; `--debug` printed nothing more.

## Root cause

Not auth, not an API change, not the pin.

1. **Auth was fine.** The CLI's own OAuth token (scope includes
   `projects:read`, refreshed 23:39 EDT, valid for an hour) returned the full
   branch list from `GET /api/v2/projects/young-lake-60767275/branches` via
   curl during the same window.
2. **The failure was transient.** Re-running the identical command minutes later
   succeeded repeatedly from the same directory, with the same token and pin.
   The API answered in ~0.12s by then (43 KB body).
3. **Why it looks like a code bug:** `neonctl@7.0.1` is a shim over `neon@7.0.1`,
   whose API client uses `@neon/sdk`. In the SDK's `client.gen.js` any exception
   thrown *after* the response headers arrive (body stream aborted, truncated or
   non-JSON body) is caught and returned as `{ error, response }`. The CLI's
   `call()` (`neon/dist/api.js`) checks only `response.ok`, so a 200 whose body
   failed to read becomes `{ data: undefined }`, and `data.branches` throws.
   The real error is swallowed, which is why `--debug` showed nothing.
   Reproduced exactly by injecting a mid-body abort into a 200 response
   (fetch preload) — the CLI printed the identical message.
4. **Our script made it worse** by printing "Are you authenticated?" for every
   failure, pointing at the wrong cause.

Latent second bug found on the way: `neonctl api <path>` reads a request body
from stdin whenever stdin is not a TTY. `cleanup-neon-branches.ts` called it
with inherited stdin, so from a shell whose stdin stays open (an agent's Bash
tool) the prune's endpoints read hangs forever. The scheduled task works only
because its stdin happens to be closed.

## Daily prune

Not failing. All runs through 2026-10-06 09:36Z completed and printed their
kept-branch tables (the 10-06 run kept 20 branches, all under 24h). The 10-07
run had not fired yet at diagnosis time.

## Fix

`scripts/lib/neonctl.ts` gains one runner every Neon script now uses:

- `runNeonctl` / `runNeonctlJson`: `stdin` closed (`'ignore'`), 180s process
  timeout, retries transient failures (2 retries, 2s/4s backoff), never throws.
- `classifyNeonctlError`: `transient` (the swallowed-body signature, network
  errors, 5xx), `auth` (401/unauthorized/expired), `other` (limit, not found).
- `neonctlHint`: one honest line per kind — re-auth instructions only for `auth`.

Callers:

- `branch-db.ts`: reads retry; `branches create` is NOT blindly retried (a lost
  response may hide a successful create) — on a transient failure it re-lists,
  adopts the branch if it landed, otherwise creates once more. Adopt logic
  extracted to `adoptExistingBranch`.
- `cleanup-neon-branches.ts`, `report-branch-creation.ts`: reads retry; deletes
  single-attempt as before; stdin closed for all calls (fixes the `api` hang).

The pin stays at 7.0.1 — 8.0.11 has the same swallowing behaviour, so bumping
buys nothing.

## Validation

- `scripts/test-neonctl-runner.ts` (added to `mcp:lint`): classification,
  retry-then-succeed, give-up after 3, no retry on auth, `retries: 0`, non-JSON.
- End to end: `npm run db:branch` with a fetch preload that breaks the first
  `GET …/branches` body exactly like the incident → one retry warning, branch
  `claude-neonctl-transient-retry` created, `.env.local` written. Re-run adopts
  it. `env:check`: branch host, not production, dev Clerk. `db:migrate` applies.
- `cleanup-neon-branches.ts --dry-run` from an agent shell (open stdin): done in
  12s, nothing deleted.

No re-auth needed. No production data touched.
