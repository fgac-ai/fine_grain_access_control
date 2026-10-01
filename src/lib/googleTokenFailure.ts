/**
 * Classification and agent-facing guidance for "Clerk could not hand us a
 * Google access token" — the failure class behind `google_token_fetch_failed`.
 *
 * Pure (no Clerk, no DB, no PostHog) so the MCP route's wording and retry
 * policy are unit-testable: scripts/test-google-token-failure.ts.
 *
 * Why the split between TRANSIENT and DETERMINISTIC matters (measured in
 * production, 30 days to 2026-09-04): every MCP-path token failure in that
 * window was `clerk_error`, and the one account that produced one per day
 * was HEALTHY — its agent fires two calls on the same delegated mailbox
 * within ~100 ms on its first touch of the day, one of them fails at Clerk
 * in ~80-120 ms, the other succeeds, and every later call on that mailbox
 * succeeds. A "reconnect your account" refusal there would be a daily false
 * alarm aimed at a user whose grant is fine. So: unknown Clerk errors are
 * retried once server-side and, if they still fail, get hedged
 * retry-then-reconnect guidance as a ❌ failure; only the states that cannot
 * clear on their own (no grant stored at all, Clerk cannot refresh) get the
 * 🚫 stop-and-reconnect refusal.
 *
 * The 2026-09-08 lesson: "unknown Clerk error" must not swallow a KNOWN
 * dead-grant code. Clerk's 400 `oauth_token_retrieval_error` ("Failed to
 * retrieve a new access token from the OAuth provider") is Clerk relaying
 * Google's refusal to refresh; every production instance inspected on
 * 2026-09-09 (three accounts, raw Backend API) carried Google's
 * `invalid_grant "Token has been expired or revoked."`, no account recovered
 * on its own, and the retry had recovered nothing since it shipped. Falling
 * through to `clerk_error` meant a pointless retry, a ❌ "usually temporary"
 * answer, and no reconnect link from list_accounts — 14 identical Sheets
 * failures from one account in two days. That code now classifies
 * `grant_revoked` (deterministic, reconnect repairs it).
 */

export type GoogleTokenFailureReason =
  /** Clerk did not answer within CLERK_TOKEN_TIMEOUT_MS. */
  | 'timeout'
  /** Clerk answered with a refresh failure (422 cannot-refresh: the stored
   * grant has no usable refresh token). Deterministic until reconnect. */
  | 'refresh_failed'
  /** Clerk asked Google to refresh and Google refused (400
   * `oauth_token_retrieval_error`, Google: invalid_grant "Token has been
   * expired or revoked"): the user revoked FGAC in their Google account,
   * changed their Google password (Google revokes Gmail-scoped grants on a
   * password change), or the grant aged out. Deterministic until the user
   * reconnects — Google then shows consent again and issues a new grant. */
  | 'grant_revoked'
  /** Any other Clerk error — transient every time it was inspected. */
  | 'clerk_error'
  /** Clerk answered cleanly but holds no Google token for the user: no
   * Google external account, or one with no stored grant. */
  | 'no_token'
  /** Clerk has no user with the id FGAC stored for the mailbox owner
   * (404 resource_not_found): the owner's FGAC account was deleted, or the
   * row was created against a different Clerk instance. Deterministic, and
   * a reconnect link cannot repair a missing account — the owner must sign
   * in again. Seen 2026-09-04 on a preview (production data + dev Clerk). */
  | 'owner_not_found'
  /** The target address is an access-row entry whose delegation is no longer
   * active (or whose owner row is gone) and is not the key owner's own
   * mailbox either. Nothing to reconnect — the owner must re-delegate. */
  | 'delegation_inactive';

export interface ClassifiedClerkTokenError {
  reason: Extract<GoogleTokenFailureReason, 'timeout' | 'refresh_failed' | 'grant_revoked' | 'clerk_error' | 'owner_not_found'>;
  /** Worth one immediate server-side retry. Timeouts already burned the
   * budget; refresh failures and revoked grants are deterministic. */
  retryable: boolean;
  /** Clerk's HTTP status and first error code, when the thrown value is a
   * ClerkAPIResponseError. Enum-like, no customer data — safe on events. */
  clerkStatus?: number;
  clerkCode?: string;
  /** The upstream provider's error, when Clerk relays one under
   * `errors[0].meta.provider_error` (e.g. `oauth2: "invalid_grant" "Token has
   * been expired or revoked."`). The installed @clerk/backend (3.4.x) maps
   * `meta` onto a fixed key set and DROPS this field, so it is normally
   * absent — it was read from the raw Backend API during the 2026-09-09
   * triage. Kept so a future SDK that surfaces it sharpens the class. */
  providerError?: string;
}

/**
 * Map a rejection from `clerkClient().users.getUserOauthAccessToken` to a
 * reason. The regexes mirror the classification that has stamped
 * `google_token_fetch_failed.reason` since 2026-08-20, so the series stays
 * comparable across the change.
 */
export function classifyClerkTokenError(err: unknown): ClassifiedClerkTokenError {
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  const e = err as { status?: unknown; errors?: Array<{ code?: unknown; meta?: Record<string, unknown> }> } | null;
  const clerkStatus = typeof e?.status === 'number' ? e.status : undefined;
  const first = Array.isArray(e?.errors) ? e.errors[0] : undefined;
  const clerkCode = typeof first?.code === 'string' ? first.code : undefined;
  const rawProvider = first?.meta?.provider_error ?? first?.meta?.providerError;
  const providerError = typeof rawProvider === 'string' ? rawProvider.slice(0, 200) : undefined;
  const base = { clerkStatus, clerkCode, ...(providerError ? { providerError } : {}) };

  if (isTimeout) return { reason: 'timeout', retryable: false, ...base };
  if (clerkStatus === 404 || clerkCode === 'resource_not_found') {
    return { reason: 'owner_not_found', retryable: false, ...base };
  }
  if (clerkCode === 'oauth_token_retrieval_error') {
    // Clerk 400: it asked the provider for a new access token and the
    // provider refused. Deterministic on the code alone (see the header);
    // the only escape hatch is a relayed provider error that is explicitly
    // NOT a dead grant (a Google token-endpoint outage would read as a
    // server_error / temporarily_unavailable), which stays transient.
    if (providerError && !/invalid_grant|expired|revoked/i.test(providerError)) {
      return { reason: 'clerk_error', retryable: true, ...base };
    }
    return { reason: 'grant_revoked', retryable: false, ...base };
  }
  if (/refresh/i.test(message) || (clerkCode !== undefined && /refresh/i.test(clerkCode))) {
    return { reason: 'refresh_failed', retryable: false, ...base };
  }
  return { reason: 'clerk_error', retryable: true, ...base };
}

/** Reasons that cannot clear on their own: the tool refuses (🚫) instead of
 * failing (❌), because retrying is pointless and the fix is a known user
 * action. `delegation_inactive` is deterministic too but is not a token
 * problem — it gets its own text. */
export function isDeterministicTokenFailure(reason: GoogleTokenFailureReason): boolean {
  return reason === 'no_token' || reason === 'refresh_failed' || reason === 'grant_revoked' || reason === 'owner_not_found';
}

/** Subset of the deterministic reasons that a reconnect actually repairs —
 * what list_accounts mints a reconnect link for. A missing owner account
 * has nothing to reconnect. */
export function reconnectRepairs(reason: GoogleTokenFailureReason): boolean {
  return reason === 'no_token' || reason === 'refresh_failed' || reason === 'grant_revoked';
}

export interface TokenFailureGuidanceInput {
  /** The mailbox the call targeted — the account whose grant is involved. */
  targetEmail: string;
  /** The FGAC user whose proxy key made the call. */
  keyOwnerEmail: string;
  reason: GoogleTokenFailureReason;
  /** `reconnectLink(targetEmail)` — already bound to the target via `for=`. */
  reconnectUrl: string;
  /** Whether a server-side retry already ran (and failed) for this call. */
  retried: boolean;
}

export interface TokenFailureGuidance {
  /** Starts with 🚫 (deterministic → outcome `denied_by_policy`) or ❌
   * (transient / delegation → outcome `failed`). */
  text: string;
  /** Present exactly when `text` is a 🚫 refusal. */
  denialCode?: 'google_token_unavailable';
}

/**
 * The person who can run the reconnect is the mailbox OWNER. For a delegated
 * mailbox that is not the key owner, and the link refuses to run for anyone
 * else (the Accounts page blocks auto-reconnect and warns when `for=` is not
 * the signed-in user — 2026-08-30 incident), so the agent must be told to
 * relay it rather than to "click here".
 */
function reconnectInstruction(input: TokenFailureGuidanceInput): string {
  const delegated = input.targetEmail.toLowerCase() !== input.keyOwnerEmail.toLowerCase();
  if (!delegated) {
    return `👉 Send the user this one-click link — it opens Google's consent screen directly: ${input.reconnectUrl}`;
  }
  return `'${input.targetEmail}' is a delegated mailbox, so only its owner can repair it — the key owner ('${input.keyOwnerEmail}') cannot fix it from their own dashboard, and the link below refuses to run for any other account. ` +
    `👉 Ask the user to forward this one-click link to the owner of '${input.targetEmail}', who must open it while signed in to FGAC as that account: ${input.reconnectUrl}`;
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

export function tokenFailureGuidance(input: TokenFailureGuidanceInput): TokenFailureGuidance {
  const { targetEmail, reason } = input;
  const reconnect = reconnectInstruction(input);

  if (reason === 'delegation_inactive') {
    return {
      text: `❌ '${targetEmail}' is listed on this key, but its delegation to '${input.keyOwnerEmail}' is no longer active, so there is no Google token to use. ` +
        `STOP — retrying will not help. The owner of '${targetEmail}' must re-delegate the mailbox from "Delegations You've Granted" on their own Accounts page; it then works here again without any change to the key.`,
    };
  }

  if (reason === 'owner_not_found') {
    const origin = safeOrigin(input.reconnectUrl);
    const delegated = targetEmail.toLowerCase() !== input.keyOwnerEmail.toLowerCase();
    return {
      denialCode: 'google_token_unavailable',
      text: `🚫 Not available yet: FGAC's auth provider has no record of the user who owns '${targetEmail}' — the FGAC account behind that mailbox was deleted or never finished signing up. ` +
        `STOP — retrying will NOT help, and a reconnect link cannot repair a missing account. ` +
        (delegated
          ? `The owner of '${targetEmail}' must sign in to FGAC again at ${origin} (that recreates their account), then re-delegate the mailbox to '${input.keyOwnerEmail}' from "Delegations You've Granted" on their Accounts page.`
          : `The user must sign in to FGAC again at ${origin} and reconnect Google from the Accounts page.`),
    };
  }

  if (isDeterministicTokenFailure(reason)) {
    const why = reason === 'no_token'
      ? `FGAC's auth provider holds no Google grant for '${targetEmail}' — the Google account was never connected, or the connection was removed`
      : reason === 'grant_revoked'
        ? `Google has expired or revoked FGAC's access to '${targetEmail}' (Google's answer when FGAC asked for a fresh token: "Token has been expired or revoked" — the user removed FGAC from their Google account's third-party access, changed their Google password, or the grant aged out)`
        : `FGAC's auth provider can no longer refresh the Google grant for '${targetEmail}' (the stored grant has no usable refresh token — this happens when Google revokes access or the account was connected without offline access)`;
    return {
      denialCode: 'google_token_unavailable',
      text: `🚫 Not available yet: ${why}. ` +
        `STOP — every call on this account will fail until it is reconnected; retrying will NOT help. ` +
        `${reconnect} — then retry once after they confirm.`,
    };
  }

  // Transient: timeout, or an unknown Clerk error that survived one retry.
  const what = reason === 'timeout'
    ? `FGAC's auth provider did not return a Google token for '${targetEmail}' in time`
    : `FGAC's auth provider returned an error instead of a Google token for '${targetEmail}'${input.retried ? ' (retried once)' : ''}`;
  return {
    text: `❌ ${what}. This is usually temporary — the same account typically succeeds on the next attempt. ` +
      `Retry ONCE after a few seconds. If the retry fails the same way, the account's Google grant needs reconnecting: ${reconnect} — then retry once after they confirm.`,
  };
}

// ─── Undeliverable mailbox: the truthful stop ───────────────────────────────
// When FGAC's own notice to the mailbox came back as a permanent DSN
// (src/lib/emailBounces.ts), the reconnect story above is false in one of
// two ways, and the agent must be told which:
//   - `mailbox_gone` (Google: "The email account that you tried to reach
//     does not exist", 5.1.3 on a Workspace domain = the mailbox was
//     deleted): nobody can reconnect it. The 09-23 account was refused four
//     more times over two days, each time handed a dead link.
//   - `rejected` (the mailbox exists but refused FGAC's mail): the link is
//     fine, but the owner has NOT been told — the 📧 "do not re-ask" line
//     would be a lie, so the agent is asked to relay the link itself.

export interface UndeliverableGuidanceInput {
  targetEmail: string;
  keyOwnerEmail: string;
  reason: GoogleTokenFailureReason;
  bounceClass: 'mailbox_gone' | 'rejected';
  /** The DSN's enhanced status, e.g. `5.1.3`; '' when unknown. */
  dsnStatus: string;
  bouncedAt: Date;
  reconnectUrl: string;
  dashboardUrl: string;
}

function whenUtcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Replacement 🚫 text for a reconnect-repairable refusal whose mailbox is on
 * the bounce ledger. Always a refusal (`google_token_unavailable`): the
 * series in monitoring.md 7.13a / 7.30c stays comparable.
 */
export function undeliverableGuidance(input: UndeliverableGuidanceInput): TokenFailureGuidance {
  const { targetEmail, keyOwnerEmail, bounceClass } = input;
  const delegated = targetEmail.toLowerCase() !== keyOwnerEmail.toLowerCase();
  const code = input.dsnStatus ? ` (${input.dsnStatus})` : '';
  const base = input.dashboardUrl.trim().replace(/\/+$/, '');
  if (bounceClass === 'mailbox_gone') {
    const remove = delegated
      ? `Remove '${targetEmail}' from this task. The delegation that put it on this key is now pointing at nothing; '${keyOwnerEmail}' can drop it from "Delegations You've Received" on their Accounts page (${base}/dashboard/accounts).`
      : `Remove '${targetEmail}' from this task and from this key's accounts on the FGAC dashboard (${base}/dashboard/accounts). If the person now uses a different address, they must sign in to FGAC with that address and connect Google there — this account cannot be transferred.`;
    return {
      denialCode: 'google_token_unavailable',
      text: `🚫 Not available: the mailbox '${targetEmail}' no longer exists. ` +
        `Google's grant for it was revoked, and when FGAC emailed the owner about that on ${whenUtcDay(input.bouncedAt)}, Google's own mail server returned the message as undeliverable${code}: "The email account that you tried to reach does not exist" — on a Google Workspace domain that means the account was deleted. ` +
        `STOP — retrying will NOT help, and there is no reconnect: nobody can repair a deleted account, so do not give the user a reconnect link. ` +
        remove,
    };
  }
  // rejected: the grant story stands; only the "owner was told" part does not.
  const reconnect = delegated
    ? `Ask the user to forward this one-click link to the owner of '${targetEmail}', who must open it while signed in to FGAC as that account: ${input.reconnectUrl}`
    : `Send the user this one-click link — it opens Google's consent screen directly: ${input.reconnectUrl}`;
  return {
    denialCode: 'google_token_unavailable',
    text: `🚫 Not available yet: Google has expired or revoked FGAC's access to '${targetEmail}', and every call on this account fails until it is reconnected — retrying will NOT help. ` +
      `FGAC tried to email the owner about this on ${whenUtcDay(input.bouncedAt)} and the message was rejected by their mail server${code}, so the owner has NOT been told and FGAC will not email that address again — you must relay the fix yourself. 👉 ${reconnect} — then retry once after they confirm.`,
  };
}
