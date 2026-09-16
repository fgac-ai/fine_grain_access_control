/**
 * Agent-facing denial copy — the sentences that tell an agent what to do
 * AFTER a refusal. Pure strings, so `scripts/test-denial-copy.ts` can pin
 * them; `src/app/api/mcp/route.ts` assembles them into tool results.
 *
 * Two invariants, both load-bearing for analytics:
 *   - The FIRST characters decide the outcome class (`classifyToolOutcome`
 *     in route.ts): 🚫 → `denied_by_policy`, ❌ → `failed`. Every builder
 *     here keeps its prefix, and appended guidance never precedes it.
 *   - Guidance is appended, never substituted: the refusal's own sentence
 *     (what was refused, and why) stays first, because that is the part the
 *     agent quotes to the user.
 *
 * Why this module exists (measured in production, 2026-09-04 → 09-11):
 *   - Linked denials have carried AGENT_APPROVAL_PROTOCOL's "do not retry"
 *     since 2026-08-19, and agents largely obey it. The largest send burst
 *     in the window — 12 `send_disabled` denials in 19 s — was twelve
 *     DIFFERENT recipients issued in one assistant turn (twelve distinct
 *     `send_whitelist` request ids, one `send_all` id minted twelve times):
 *     batch demand, not a retry loop. The agent then stopped and relayed the
 *     link, and the user approved it 65 s later. Text cannot recall calls an
 *     agent has already emitted; what it can do is say the refusal covers
 *     EVERY recipient, so the agent holds the rest of a batch it has not
 *     sent yet.
 *   - The denials that looped were the ones WITHOUT guidance. The ❌
 *     `account_not_permitted` form ran hourly for four days from a scheduled
 *     job with no stated fix (graduated to 🚫 on 2026-09-08); the 🚫 form
 *     that replaced it names the fix, and the agent applies it within seconds
 *     when it reads it — but a scheduled task re-sends the same wrong value
 *     on the next run with a fresh context, so it has hit the refusal 23 more
 *     times since. The task, not the call, is what has to change, and the
 *     text now says so.
 *   - Explicit blocks (`sheets_blocked` / `docs_blocked`) and link-mint
 *     failures returned a bare "Access Denied" with no next step at all.
 */

/**
 * Appended to every denial that carries an approval link.
 *
 * Originally added 2026-08-19 on the theory that agents were dropping the URL
 * when paraphrasing. Measured afterwards, that theory did not hold: most users
 * DO open their links, and the apparent shortfall was retry-inflated counting
 * (see approvalLinks.ts). What the data does show is that retrying is pure
 * waste — the same request re-emits the same URL — so the protocol says to
 * stop and ask the user rather than to expect a fresh link.
 */
export const AGENT_APPROVAL_PROTOCOL =
  'IMPORTANT — how to handle this: (1) Show the link above to the user VERBATIM as a clickable URL; only they can open it, and it is the only way to get access. ' +
  '(2) Do NOT retry the denied call until the user says they approved — retrying just fails again, and re-requesting returns the SAME link; the link does not change no matter how many times the call is repeated. ' +
  '(3) The link does not expire — if the user has not opened it yet, ask them directly rather than retrying. ' +
  // (4) added 2026-09-08: a file Google does not share with FGAC yet cannot be
  // resolved by title, so the approval page shows a raw Google id — while
  // Google's Picker lists files by NAME. Users opened the Picker and closed it.
  '(4) For a spreadsheet or document, tell the user the file\'s NAME along with the link: the approval page can only show Google\'s file id for a file FGAC cannot reach yet, and the user has to find the file by name in Google\'s picker. If you know the title, call request_access with resourceName so the page shows it.';

/**
 * For 🚫 refusals that carry NO link because nothing an agent can request
 * would lift them — explicit blocks, which are a deliberate dashboard act.
 * Without this the agent received "Access Denied" and nothing else.
 */
export const NO_LINK_STOP =
  'STOP — do not retry this call; the same request is refused every time, and there is no approval link for it. ' +
  'Only the user can change this, from the Rules page of their FGAC dashboard — tell them what was refused and retry once after they confirm.';

export function withNoLinkStop(message: string): string {
  return `${message} ${NO_LINK_STOP}`;
}

/**
 * For a denial that WOULD carry a link, when minting it failed (signing or
 * bookkeeping error). The refusal itself stands; the missing link must not
 * turn into a retry loop hunting for one.
 */
export const LINK_UNAVAILABLE_STOP =
  'FGAC could not generate the approval link just now. Do not retry the denied call in a loop — ' +
  'call request_access ONCE to mint the link again, or ask the user to grant this from the Rules page of their FGAC dashboard.';

export function withLinkUnavailableStop(message: string): string {
  return `${message} ${LINK_UNAVAILABLE_STOP}`;
}

/** `send_disabled`: the profile has no send whitelist at all. */
export const SEND_DISABLED_MESSAGE =
  '🚫 Sending is disabled on this profile (no send whitelist configured). This is the safe default. ' +
  'Every send from this profile — to ANY recipient — is refused until the user approves one of the links below, ' +
  'so do not retry this message, and hold any other messages you were about to send rather than trying them.';

/** `recipient_not_whitelisted`: a whitelist exists and this address is not on it. */
export function recipientNotWhitelistedMessage(recipient: string): string {
  return `🚫 Unauthorized recipient. '${recipient}' is not in the send whitelist. ` +
    'Sending to this address is refused until the user approves one of the links below — do not retry it.';
}

/**
 * `account_not_permitted`, CALLER-chosen form: the call named an `account`
 * the key does not cover. A 🚫 refusal (the key's account list is
 * user-configured policy) with the fix stated twice — once for an
 * interactive agent, once for the scheduled task that cannot learn.
 */
export function accountNotPermittedByCaller(targetEmail: string, usable: string): string {
  return `🚫 This connection cannot use the account '${targetEmail}'. Accounts it can use: ${usable}. ` +
    'Omit the "account" parameter to use the default account, or pass one of the listed addresses. ' +
    `Do not retry with '${targetEmail}' — it is refused every time, and no approval link exists for it: only the user can add an account to this key, from the FGAC dashboard. ` +
    'If this call comes from a scheduled or automated task, the task will send the same value again on its next run — tell the user which account it names so they can correct the task itself.';
}

/**
 * `account_not_permitted`, DEFAULT form: no `account` was given and the
 * owner's own address is not on the key. Stays ❌ `failed` — nothing the
 * caller sent caused it, and a key that cannot reach its owner's mailbox is
 * a real misconfiguration — but it now says what would work.
 */
export function accountNotPermittedByDefault(targetEmail: string, usable: string): string {
  return `❌ This proxy key does not have access to '${targetEmail}'. Accessible: ${usable}. ` +
    `Pass one of the accessible addresses as "account", or ask the user to add '${targetEmail}' to this key's accounts in the FGAC dashboard. ` +
    'Retrying unchanged fails the same way.';
}

/**
 * Upstream Google 404, named to the mailbox the call actually ran against.
 *
 * Measured 2026-09-12 → 09-13 (production): an operator whose mailbox work
 * is 100% delegated fetched thread ids obtained from the delegated mailbox
 * WITHOUT `account`, so every call resolved to their own (empty) mailbox and
 * 404ed — 20 times, the same ids retried, because the response never said
 * which mailbox had been searched. 183 identical calls WITH the delegated
 * account succeeded in the same hours. The text now says which account the
 * id was looked up in, so "not visible to this account" is checkable.
 */
export function googleNotFoundMessage(detail: string, targetEmail: string): string {
  const who = targetEmail ? `'${targetEmail}'` : 'this account';
  return `❌ Google resource not found (404)${detail ? `: ${detail}` : ''}. ` +
    `The id is wrong, stale, or not visible to ${who} — the account this call ran against. ` +
    `Verify it against a fresh listing on that account before retrying; the same id unchanged will 404 again.`;
}

/**
 * Appended to a 404 ONLY when the connection reaches more than one mailbox
 * (`otherAccounts` = every reachable address except the one the call used).
 * Single-mailbox callers get the unchanged message: for them "another
 * mailbox" is not a possible cause, and the sentence would be noise.
 *
 * Why it names the fix and not just the fact: the same 30-day query that
 * found the operator above found five people and 52 events with the shape
 * "404 on mailbox X within 24 h of a success on mailbox Y, same tool"
 * (docs/monitoring.md 7.23) — on typed gmail_read as well as raw threads
 * reads. None of them had been told that ids do not carry across mailboxes.
 */
export function crossMailboxHint(otherAccounts: readonly string[]): string {
  const n = otherAccounts.length;
  if (n === 0) return '';
  const fix = n === 1
    ? `pass account: '${otherAccounts[0]}'`
    : `pass account: '<that address>'`;
  return `This connection can also reach ${n} other mailbox${n === 1 ? '' : 'es'}: ${otherAccounts.join(', ')} (see list_accounts). ` +
    `Gmail and Drive ids are mailbox-specific — an id from a listing or search on one account never resolves on another. ` +
    `If this id came from one of those mailboxes, retry ONCE with the same id and ${fix}; if it did not, stop — retrying here will not change the answer.`;
}
