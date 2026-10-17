# Approval links survive the signed-out sign-in leg (`+tag` recipients) — v1

Branch: `claude/approval-link-plus-recipient` (from `main` @ cfec532). Lands via the
next integration train.

## Problem (observed)

Found by preview QA of train 2026-10-10b (release PR #205), magic-link approvals
A6. It reproduced on the previous train's preview too, which runs main's code, so it
is a pre-existing bug and not a regression.

A `send_whitelist` link whose recipient contains `+` (`owner+tag@…`, minted as
`r=owner%2Btag%40…`) works when opened signed in. Opened **signed out**, the owner
goes through the Clerk wall and Google sign-in, then returns with the query decoded
one time too many:

| character in `r` | arrives as |
| --- | --- |
| `+` | space |
| `&` | `r` truncated at the `&` |
| `%` | dropped |

The HMAC is recomputed over the mangled target, fails, and the genuine owner sees
"Invalid link". A non-owner gets "Invalid link" too, instead of the
wrong-account card (A5/A19).

- **Observed by QA:** FGAC's own redirect to sign-in encodes correctly, and a
  signed-in Clerk `redirect_url` hop keeps `%2B`.
- **Inferred:** the extra decode happens on the Clerk/Google OAuth return leg. We do
  not control that leg, so the fix has to make the link survive it.

## Fix

Both changes are in `src/lib/approvalLinks.ts`. The parameter names and the plumbing
stay the same: every consumer already passes `r` through verbatim.

1. **Decode-proof wire form.** `encodeApprovalTarget` leaves a target matching
   `[A-Za-z0-9._@-]*` verbatim. That covers plain addresses and every Google file id,
   so those URLs stay byte-identical to pre-change links (A12 determinism across the
   deploy). Any other target travels as `r=~<base64url(utf-8 target)>`. Base64url and
   `~` are unreserved characters, so there is nothing left to mangle. This covers
   `+`, `&`, `%`, `#`, `=`, spaces and non-ASCII.
   `decodeApprovalTarget` reverses it. The two forms are unambiguous: base64url
   never contains `@`, file ids never start with `~`, and a raw target that starts
   with `~` falls outside the safe set and gets encoded itself. The signature,
   request_id and target_hash are all computed over the **decoded** target, so
   existing values are unchanged and no new grant becomes reachable.
2. **Tolerant verification for legacy links.** Links minted before this change still
   carry a raw `+` in emails, transcripts and the pending-approvals ledger. When the
   received target contains a space, `verifyApprovalParams` also tries the same
   target with spaces turned back into `+`. A space is never valid in an address or a
   file id, and the signature still has to match, so this widens nothing. Legacy
   links with `&` or `%` cannot be recovered; agents mint a fresh link on retry, and
   the new link uses the `~` form.

`approvalWall.ts` decodes `r` before hashing, so `approval_sign_in_wall.target_hash`
still joins to `approval_link_minted` for encoded links. The wrong-account path in
the approve page re-verifies against the resolved owner through the same function,
so A5/A19 recover automatically.

`scripts/qa-mint-approval-link.ts` gains `--action send_whitelist --recipient <addr>`
so QA can mint the A6 variant deterministically.

## Validation

- Unit: `scripts/test-approval-links.ts` (in `npm run mcp:lint`) simulates the
  return leg with one redundant `decodeURIComponent`. Covered cases: `+tag`, `&`,
  `%`, space, leading `~`, a mixed `+&%=#` address and non-ASCII. Each must:
  - travel as `~…`;
  - verify for the owner after the leg, with the same request_id and target_hash;
  - still reject a non-owner.

  Also covered:
  - plain addresses and file ids stay verbatim;
  - a legacy raw `+` link verifies after `+` → space;
  - a genuine space target is not rewritten;
  - tolerance does not admit a different target.

  Result: `mcp:lint` passes and `tsc --noEmit` is clean.
- QA: capability 14 A6 now **requires** a signed-out plus-addressed recipient
  variant (owner path, plus the non-owner path showing the wrong-account card).
  This runs on the train preview. QA scope for the train: magic-link approvals
  A5, A6, A7, A12, A19, A20, plus the analytics events wall-join check (§
  approval_sign_in_wall target_hash).

## Risks

- Plus-addressed links change form once, at deploy. The request_id is unchanged, so
  ledger dedupe and the funnel joins still work. The pending-approvals banner keeps
  the old `link_query` until the next mint, and that old link now verifies through
  tolerance.
