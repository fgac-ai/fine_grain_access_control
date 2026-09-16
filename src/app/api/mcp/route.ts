/**
 * Production MCP Server — FGAC.ai Gmail Access Control
 *
 * Promoted from /api/spike/mcp with full Gmail tool support.
 * Uses the Pending Approval pattern validated in spikes #1 and #2.
 *
 * Auth chain: OAuth token → userId + clientId → agent_connections →
 *   proxy_key → key_email_access → Clerk Google token → Gmail API
 *
 * Tool metadata (names, titles, annotations) lives in ./toolDefs.ts and is
 * linted by scripts/mcp-tool-lint.ts against the Anthropic Connectors
 * Directory requirements. Raw Google API calls are classified (allow-by-default,
 * with sends whitelisted and scopes as the backstop) in ./googleApiPolicy.ts.
 */
import { createMcpHandler, experimental_withMcpAuth } from 'mcp-handler';
import type { JWTVerifyGetKey } from 'jose';
import { verifyClerkToken } from '@clerk/mcp-tools/next';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { db } from '@/db';
import {
  agentConnections, users, proxyKeys, keyEmailAccess,
  accessRules, keyRuleAssignments, emailDelegations,
} from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { filterLiveDelegatedAccess } from '@/db/delegationQueries';
import { clerkClient } from '@clerk/nextjs/server';
import { resolveDbUser } from '@/db/userHelpers';
import { loadApplicableRules, checkReadRestrictions, decodeB64Url, stripHtmlToText, type ApplicableRules } from '@/lib/gmailRules';
import { compileRulePattern } from '@/lib/rulePatterns';
import { captureServerEvent } from '@/lib/posthogServer';
import { runWithToolCallProps, addToolCallProps, getToolCallProps } from '@/lib/toolCallContext';
import { cleanResourceName } from '@/lib/pickerRecoveryCopy';
import { GOOGLE_FETCH_TIMEOUT_MS, CLERK_TOKEN_TIMEOUT_MS, withTimeout, isUpstreamTimeout } from '@/lib/upstreamTimeouts';
import { classifyMcpClient, classifyTransportRejection, installFingerprint, parseInitializeClientInfo, parseRpcEnvelope, resourceIdHash, type McpClientInfo } from '@/lib/mcpClientSignals';
import { recordEagerResolve, shouldSkipEagerResolve } from '@/lib/connectionTouchMemo';
import { after } from 'next/server';
import { inSuccessSample, AUTH_SUCCESS_SAMPLE } from '@/lib/authSampling';
import { ensureDefaultProfile } from '@/db/defaultProfile';
import { mintApprovalLink, type ApprovalAction } from '@/lib/approvalLinks';
import { connectionsDeepLink } from '@/lib/dashboardAgentLinks';
import { recordApprovalMint, getApprovalRequestResourceName } from '@/lib/approvalRequests';
import {
  AGENT_APPROVAL_PROTOCOL, SEND_DISABLED_MESSAGE, recipientNotWhitelistedMessage,
  accountNotPermittedByCaller, accountNotPermittedByDefault, withNoLinkStop, withLinkUnavailableStop, LINK_UNAVAILABLE_STOP,
} from '@/lib/denialCopy';
import { TOOL_DEFS, toolAnnotations, type FgacToolDef } from './toolDefs';
import {
  classifyGoogleApiCall, canonicalizeGoogleApiPath, extractSendRecipients, extractDraftSendInfo,
  sheetsApprovalAction, docsApprovalAction, parseDriveFileId,
  templateGoogleApiPath, rawApiFamily, extractGoogleErrorReason,
  type RawCallClass, type GoogleErrorReason,
} from './googleApiPolicy';
import { DRIVE_FILE_KINDS, ACTIVE_DRIVE_FILE_KINDS, type DriveFileKind } from '@/lib/driveFileKinds';
import { clerkPrimaryEmail } from '@/lib/clerkPrimaryEmail';
import { ownClerkEmailMatch } from '@/lib/identityDrift';
import { slugifyProfileLabel } from '@/lib/profileSlugs';
import { logAndSanitize, describeErrorForLog, toolErrorResult } from '@/lib/serverErrors';
import {
  classifyClerkTokenError, reconnectRepairs, tokenFailureGuidance,
  type GoogleTokenFailureReason,
} from '@/lib/googleTokenFailure';
import { liveTokenScopes, reconcileScopes } from '@/lib/googleTokenScopes';

/** Env URL values have shipped with trailing whitespace/newlines (pasted
 * Vercel vars); a whitespace-only value must also not win the fallback chain.
 * Sanitizing here fixes every consumer: approval links, pending-approval
 * dashboard URLs, everything built on DASHBOARD_URL. */
function cleanUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed || null;
}

const DASHBOARD_URL = cleanUrl(process.env.NEXT_PUBLIC_APP_URL)
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}` : null)
  || 'http://localhost:3000';

/**
 * One-click reconnect link, bound to the account it is meant to repair. The
 * `for=` param lets the Accounts page refuse to auto-fire reconnect when the
 * browser that opens the link is signed in to a DIFFERENT FGAC user — without
 * it, the wrong user's grant gets "repaired" and reported as success while
 * the affected account stays broken (2026-08-30 incident). `targetEmail` is
 * the mailbox owner: for delegated mailboxes that owner — not the key owner —
 * is the one who must run the reconnect.
 */
function reconnectLink(targetEmail: string): string {
  return `${DASHBOARD_URL}/dashboard/accounts?reconnect=1&for=${encodeURIComponent(targetEmail)}`;
}

/** Per-account bound on the list_accounts scope probes — deliberately far
 * below CLERK_TOKEN_TIMEOUT_MS (15 s): list_accounts is the first tool most
 * agents call, and the probes run one per accessible account. A probe that
 * misses the bound reports scope state 'unknown', never an error. */
const LIST_ACCOUNTS_SCOPE_PROBE_TIMEOUT_MS = 4_000;

/** Pause before the single retry of a failed Clerk token fetch. The
 * production failure this absorbs (two calls on the same mailbox ~100 ms
 * apart, one fails at Clerk, the other succeeds) resolves well inside this. */
const CLERK_TOKEN_RETRY_DELAY_MS = 300;

// ─── Connection Resolution ──────────────────────────────────────────────────

interface ConnectionApproved {
  authorized: true;
  reason: 'approved';
  connectionId: string;
  proxyKeyId: string | null;
  nickname: string | null;
  clientName: string | null;
  user: { id: string; email: string; clerkUserId: string };
}

interface ConnectionDenied {
  authorized: false;
  reason: 'pending_approval' | 'blocked' | 'no_client_id' | 'user_not_found' | 'no_auth';
  dashboardUrl?: string;
  connectionId?: string;
}

type ConnectionResult = ConnectionApproved | ConnectionDenied;

/** Resolve a profile-addressed MCP URL's slug (set by middleware from
 * /api/mcp/<slug>) to one of THIS user's live profiles. The slug is
 * addressing, not authorization: an unknown slug falls back to the default
 * profile rather than failing, so a renamed profile degrades gracefully. */
async function findProfileBySlug(userId: string, slug: string) {
  const keys = await db.query.proxyKeys.findMany({
    where: and(eq(proxyKeys.userId, userId), isNull(proxyKeys.revokedAt)),
  });
  return keys.find((k) => slugifyProfileLabel(k.label) === slug);
}

async function resolveConnection(
  userId: string,
  clientId: string | undefined,
  // Self-reported name/version from an MCP `initialize` request — only the
  // auth layer's eager resolve ever has it (tool handlers see later POSTs,
  // which carry no clientInfo in stateless mode).
  clientHint?: McpClientInfo,
  // Profile slug from a profile-addressed URL (/api/mcp/<slug>). Applies only
  // when the connection is FIRST created; an existing connection keeps its
  // dashboard-managed binding regardless of which URL requests arrive on.
  profileSlug?: string,
): Promise<ConnectionResult> {
  if (!clientId) {
    return { authorized: false, reason: 'no_client_id' };
  }

  let user = await db.query.users.findFirst({
    where: eq(users.clerkUserId, userId),
  });

  if (!user) {
    try {
      const client = await clerkClient();
      const clerkUser = await client.users.getUser(userId);
      const email = clerkPrimaryEmail(clerkUser);

      if (!email) {
        return { authorized: false, reason: 'user_not_found' };
      }

      user = await resolveDbUser(userId, email);
      console.log(`[MCP] Auto-created DB user for ${email}`);
    } catch (err) {
      console.error('[MCP] Failed to auto-create user:', describeErrorForLog(err));
      return { authorized: false, reason: 'user_not_found' };
    }
  }

  let connection = await db.query.agentConnections.findFirst({
    where: and(
      eq(agentConnections.userId, user.id),
      eq(agentConnections.clientId, clientId),
    ),
  });

  if (!connection) {
    // Instant-start (connector-growth Phase B): the caller personally
    // completed OAuth for this client, which is per-client consent — so the
    // connection auto-attaches to the read-only Default Profile instead of
    // starting pending. Delegated mailboxes are still gated by delegation.
    // A profile-addressed URL (/api/mcp/<slug>) overrides the default with
    // the caller's own matching profile.
    const slugKey = profileSlug ? await findProfileBySlug(user.id, profileSlug) : undefined;
    const defaultKey = slugKey ?? await ensureDefaultProfile(user.id, user.email);
    if (profileSlug) {
      console.log(`[MCP] Profile slug '${profileSlug}' ${slugKey ? `matched profile '${slugKey.label}' (${slugKey.id})` : 'matched no live profile — falling back to default'} for user=${user.email}`);
    }
    try {
      const [newConn] = await db.insert(agentConnections).values({
        userId: user.id,
        clientId,
        // Real product name when the creating request was `initialize`;
        // the opaque client_id otherwise (later initializes backfill it).
        clientName: clientHint?.name ?? clientId,
        status: 'approved',
        proxyKeyId: defaultKey.id,
        approvedAt: new Date(),
      }).returning();
      connection = newConn;

      console.log(`[MCP] New connection: user=${user.email} client=${clientId} conn=${connection.id} auto-attached to default profile`);
      // account_age_seconds separates connector-flow sign-ups (Clerk hosted
      // OAuth → first MCP request within seconds/minutes of account creation;
      // no fgac.ai pageview ever) from established users adding a client. A
      // fresh account stamps signup_source once — the website flow's competing
      // $set_once fires from PostHogIdentify on the first dashboard visit,
      // and whichever touchpoint a new account reaches first wins.
      const accountAgeSeconds = Math.round((Date.now() - user.createdAt.getTime()) / 1000);
      captureServerEvent(user.clerkUserId, 'mcp_connection_created', {
        connection_id: newConn.id,
        client_id: clientId,
        client_name: clientHint?.name,
        client_version: clientHint?.version,
        auto_attached: true,
        profile_slug: profileSlug,
        profile_slug_matched: profileSlug ? !!slugKey : undefined,
        account_age_seconds: accountAgeSeconds,
        ...(accountAgeSeconds < 600 ? { $set_once: { signup_source: 'claude_connector' } } : {}),
      });
    } catch (err) {
      // The auth-layer eager resolve and the tool handler can race this
      // insert on a client's very first request; the loser reads the
      // winner's row instead of surfacing a SQL error (QA cap 06 A3).
      connection = await db.query.agentConnections.findFirst({
        where: and(
          eq(agentConnections.userId, user.id),
          eq(agentConnections.clientId, clientId),
        ),
      });
      if (!connection) throw err;
    }
  }

  // Backfill-on-touch: rows created before initialize-time capture (or by a
  // tool-handler resolve losing the race) hold the opaque client_id as their
  // name; the next initialize replaces it. Never overwrites a real name.
  const backfillName =
    clientHint?.name && connection.clientName === connection.clientId
      ? { clientName: clientHint.name }
      : {};
  await db.update(agentConnections)
    .set({ lastUsedAt: new Date(), ...backfillName })
    .where(eq(agentConnections.id, connection.id));
  if (backfillName.clientName) {
    connection.clientName = backfillName.clientName;
    // The row is almost never created by the initialize POST itself — the
    // client's concurrent SSE GET (no body, no clientInfo) usually wins the
    // insert race — so mcp_connection_created fires nameless (measured
    // 2026-08-29: 0 of 10 events since 08-27 carried client_name). This
    // one-time event, on the opaque-id → product-name transition, is the
    // reliable connection→client mapping; join on connection_id.
    captureServerEvent(user.clerkUserId, 'mcp_connection_client_identified', {
      connection_id: connection.id,
      client_id: clientId,
      client_name: clientHint?.name,
      client_version: clientHint?.version,
    });
  }

  if (connection.status === 'pending') {
    return {
      authorized: false,
      reason: 'pending_approval',
      connectionId: connection.id,
      dashboardUrl: await connectionsDeepLink(DASHBOARD_URL, user.id),
    };
  }

  if (connection.status === 'blocked') {
    return { authorized: false, reason: 'blocked', connectionId: connection.id };
  }

  // A connection is only as alive as the key behind it. The proxy path checks
  // revokedAt/expiresAt on every request; without this, a revoked key kept
  // working through hosted MCP for connections bound before the revocation.
  if (connection.proxyKeyId) {
    const boundKey = await db.query.proxyKeys.findFirst({
      where: eq(proxyKeys.id, connection.proxyKeyId),
    });
    if (!boundKey || boundKey.revokedAt) {
      return { authorized: false, reason: 'blocked', connectionId: connection.id };
    }
    if (boundKey.expiresAt && boundKey.expiresAt < new Date()) {
      return { authorized: false, reason: 'blocked', connectionId: connection.id };
    }
  }

  return {
    authorized: true,
    reason: 'approved',
    connectionId: connection.id,
    proxyKeyId: connection.proxyKeyId,
    nickname: connection.nickname,
    clientName: connection.clientName,
    user: { id: user.id, email: user.email, clerkUserId: user.clerkUserId },
  };
}

// ─── Tool Result Helpers ────────────────────────────────────────────────────

/** Successful tool response, including FGAC policy denials — a denial is the
 * tool working as designed, not a tool failure. */
const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

/** Genuine unhealth — FGAC or Google is broken: 5xx, timeouts, network
 * failures, throttling 403s, unhandled exceptions. Marked isError so clients
 * see a real tool error. The three-way boundary (2026-09-03): genuine
 * unhealth and caller mistakes Google diagnoses (bad payloads, stale ids)
 * are errorResult or ❌ textResult (`failed`) — BOTH count in the Connector
 * Directory's published error rate (measured: its 18.3% for
 * google_api_modify, 7d to 2026-09-03, matches outcome error+failed, so ❌
 * alone does not keep a result out of the metric). Deterministic
 * access/grant refusals that carry their own remediation are 🚫 textResult
 * (`denied_by_policy`) — the tool working as designed, excluded from the
 * metric; see gmailScopeDenial / fileGrantErrorResult. */
const errorResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const jsonResult = (data: unknown) => textResult(JSON.stringify(data, null, 2));

// ─── Pending Approval Message ───────────────────────────────────────────────

function pendingMessage(result: ConnectionDenied) {
  switch (result.reason) {
    case 'pending_approval':
      return [
        '⏳ This connection is awaiting user approval, so tools cannot run yet.',
        `Connection ID: ${result.connectionId}`,
        `The user can approve it by attaching it to a permission profile at: ${result.dashboardUrl}`,
      ].join('\n');
    case 'blocked':
      return '🚫 This connection has been blocked by the user.';
    case 'no_client_id':
      return '❌ No client_id found in auth token.';
    case 'user_not_found':
      return '❌ User not found. Please sign up at the FGAC dashboard first.';
    default:
      return '❌ Authentication failed.';
  }
}

// ─── Email & Permission Resolution ──────────────────────────────────────────

async function getAccessibleEmails(proxyKeyId: string) {
  const rows = await db.select().from(keyEmailAccess)
    .where(eq(keyEmailAccess.proxyKeyId, proxyKeyId));
  // Revoked delegations must not keep granting access — see delegationQueries.
  return filterLiveDelegatedAccess(rows);
}

async function checkEmailAccess(proxyKeyId: string, targetEmail: string) {
  const rows = await getAccessibleEmails(proxyKeyId);
  return rows.find(r => r.targetEmail.toLowerCase() === targetEmail.toLowerCase());
}

/**
 * Whether `email` belongs to the key owner's own Clerk account — a verified
 * email address or the connected Google external account. Guards against
 * identity drift: `users.email` once tracked `emailAddresses[0]`, whose order
 * changes when a second address is added, so a key's own-mailbox access row
 * can legitimately name an address that no longer equals `users.email`
 * (support case 2026-08-24). Only consulted after the delegation lookup
 * fails, so it costs nothing on the happy paths.
 *
 * Also returns the account's primary email so the caller can heal the drift
 * it just confirmed, without a second Clerk fetch.
 */
async function checkOwnClerkEmail(
  clerkUserId: string, email: string,
): Promise<{ own: boolean; primaryEmail?: string }> {
  try {
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(clerkUserId);
    return {
      own: ownClerkEmailMatch(clerkUser, email),
      primaryEmail: clerkPrimaryEmail(clerkUser),
    };
  } catch (err) {
    console.error('[MCP] Clerk lookup failed while checking own-email fallback:', err);
    return { own: false };
  }
}

/**
 * The one Gmail scope FGAC requests at sign-in (src/app/layout.tsx), plus the
 * broader legacy grant that also covers every Gmail call. Google's granular
 * consent screen lets a user finish sign-in with the Gmail checkbox unchecked —
 * Clerk then holds a verified account whose token Google 403s on every Gmail
 * call, forever. The dashboard detects that state (googleAccess.ts); the MCP
 * path must too, or the user is silently locked out of Gmail tools while
 * everything else half-works.
 */
// The scope lists (Gmail; drive.file for every non-Gmail surface) and the
// record-vs-token decision live in @/lib/googleTokenScopes (reconcileScopes).

type GoogleTokenResult = {
  token: string;
  /** undefined = Clerk did not report scopes; never enforce on missing metadata. */
  hasGmailScope?: boolean;
  /** undefined = Clerk did not report scopes; never enforce on missing metadata. */
  hasDriveFileScope?: boolean;
};

/** Why no token came back — the caller turns this into class-specific
 * guidance (src/lib/googleTokenFailure.ts) instead of one "reconnect" text
 * for every cause. `retried` = a server-side retry already ran and failed. */
type GoogleTokenFailure = { failure: GoogleTokenFailureReason; retried: boolean };

/**
 * `quiet` suppresses the PostHog captures and tool-call props this function
 * stamps (google_token_identity_fallback / google_token_fetch_failed /
 * google_token_error / google_token_retry / token_ms). The list_accounts
 * scope probe runs this once per accessible account on the first tool most
 * agents call — letting those probes fire the events would corrupt the
 * monitoring counts in docs/monitoring.md §7.4/§7.6, whose queries count
 * the events unfiltered. Quiet does NOT suppress the retry: that is repair,
 * not analytics.
 */
async function getGoogleToken(
  targetEmail: string, keyOwner: { id: string; email: string; clerkUserId: string },
  { quiet = false }: { quiet?: boolean } = {},
): Promise<GoogleTokenResult | GoogleTokenFailure> {
  let tokenOwnerClerkId: string;

  if (targetEmail.toLowerCase() === keyOwner.email.toLowerCase()) {
    tokenOwnerClerkId = keyOwner.clerkUserId;
  } else {
    // Delegated email — find the email owner
    const emailOwner = await db.select().from(users)
      .where(eq(users.email, targetEmail))
      .limit(1).then(r => r[0]);

    // Verify active delegation
    const delegation = emailOwner
      ? await db.select().from(emailDelegations)
          .where(and(
            eq(emailDelegations.ownerUserId, emailOwner.id),
            eq(emailDelegations.delegateUserId, keyOwner.id),
            eq(emailDelegations.status, 'active'),
          )).limit(1).then(r => r[0])
      : undefined;

    if (emailOwner && delegation) {
      tokenOwnerClerkId = emailOwner.clerkUserId;
    } else {
      const own = await checkOwnClerkEmail(keyOwner.clerkUserId, targetEmail);
      if (!own.own) {
        // The access row exists (checkEmailAccess passed) but the delegation
        // behind it is no longer active and the address is not the key
        // owner's either. Not a token problem — nothing to reconnect.
        return { failure: 'delegation_inactive', retried: false };
      }
      // Not a delegation — the address is the key owner's own mailbox under a
      // drifted `users.email`. Use their token and record that the fallback
      // fired so analytics can watch the drift population shrink.
      //
      // Two signals, deliberately: the tool-call property attributes the
      // fallback to the individual call, while the standalone event is the
      // countable one — it is unsampled and does not depend on the enclosing
      // $mcp_tool_call, so `uniq(person)` over it is the size of the drifted
      // population still being rescued. The monitoring runbook watches this
      // count fall to zero as the population self-heals (docs/monitoring.md).
      if (!quiet) {
        addToolCallProps({ google_token_identity_fallback: true });
        captureServerEvent(keyOwner.clerkUserId, 'google_token_identity_fallback', {
          via: 'mcp',
        });
      }
      // Heal the drift this branch just proved: `resolveDbUser` syncs
      // `users.email` to the Clerk primary and re-points own-mailbox access
      // rows, exactly as a dashboard load would — but an MCP-only connector
      // user never loads the dashboard, and `resolveConnection` only calls
      // resolveDbUser for brand-new rows, so without this the drift (and the
      // fallback's Clerk round-trip) persisted on every call indefinitely
      // (observed in production, 2026-08-25 → 08-31). Runs on `quiet` scope
      // probes too — quiet suppresses analytics, not repair. On failure the
      // fallback still serves this call; the next one retries the heal.
      if (own.primaryEmail && own.primaryEmail.toLowerCase() !== keyOwner.email.toLowerCase()) {
        try {
          await resolveDbUser(keyOwner.clerkUserId, own.primaryEmail);
          console.log(`[MCP] Healed drifted identity email for ${keyOwner.clerkUserId}`);
        } catch (err) {
          console.error('[MCP] Identity drift heal failed (fallback still serving):', describeErrorForLog(err));
        }
      }
      tokenOwnerClerkId = keyOwner.clerkUserId;
    }
  }

  const client = await clerkClient();
  const tokenStarted = Date.now();
  const accountDelegated = targetEmail.toLowerCase() !== keyOwner.email.toLowerCase();
  const fetchGrant = () => withTimeout(
    client.users.getUserOauthAccessToken(tokenOwnerClerkId, 'oauth_google'),
    CLERK_TOKEN_TIMEOUT_MS,
  );
  let tokenResponse: Awaited<ReturnType<typeof fetchGrant>>;
  let retried = false;
  try {
    try {
      tokenResponse = await fetchGrant();
    } catch (firstErr) {
      // One retry for unknown Clerk errors. Measured 2026-09-04 over 30 days
      // of production: EVERY MCP-path token failure was `clerk_error`, and
      // the account producing one per day was healthy — its agent fires two
      // calls on the same delegated mailbox ~100 ms apart on its first
      // touch of the day, one fails at Clerk in ~80-120 ms, the other
      // succeeds, and every later call succeeds. Telling that agent to
      // "reconnect" daily was the bug. Timeouts (budget already spent),
      // refresh failures and revoked grants (deterministic — Google refused
      // the refresh, 2026-09-09 triage) are not retried. Measured 2026-09-09:
      // the retry had recovered ZERO calls since it shipped (§7.13), and
      // every `retry_failed` row was a revoked grant — so for that class it
      // only added 300 ms plus a second Clerk round-trip.
      const first = classifyClerkTokenError(firstErr);
      if (!first.retryable) throw firstErr;
      retried = true;
      await new Promise(resolve => setTimeout(resolve, CLERK_TOKEN_RETRY_DELAY_MS));
      tokenResponse = await fetchGrant();
      // Keep the race visible even though the agent never sees it: the
      // recovered signal is what tells monitoring the retry is doing work
      // (docs/monitoring.md §7.13).
      if (!quiet) addToolCallProps({ google_token_retry: 'recovered' });
      console.warn(
        `[MCP] Google token fetch recovered on retry (${first.reason}${first.clerkStatus ? ` ${first.clerkStatus}` : ''}${first.clerkCode ? ` ${first.clerkCode}` : ''}):`,
        describeErrorForLog(firstErr),
      );
    }
  } catch (err) {
    // Observability for the "Clerk cannot hand us a Google token" failure
    // mode. The reason strings are unchanged since 2026-08-20 so the series
    // stays comparable; clerk_status/clerk_code (enum-like, no customer
    // data) are new so the next triage can see WHAT Clerk said instead of
    // arguing from timing alone.
    const cls = classifyClerkTokenError(err);
    if (!quiet) {
      // clerk_code rides on the tool call too (since 2026-09-09), so the
      // directory-parity error table can split "dead grant" from "upstream
      // trouble" without a join to the standalone event.
      addToolCallProps({
        token_ms: Date.now() - tokenStarted,
        google_token_error: cls.reason,
        ...(retried ? { google_token_retry: 'retry_failed' } : {}),
        ...(cls.clerkCode ? { google_token_clerk_code: cls.clerkCode } : {}),
      });
      captureServerEvent(keyOwner.clerkUserId, 'google_token_fetch_failed', {
        reason: cls.reason,
        via: 'mcp',
        account_delegated: accountDelegated,
        retried,
        ...(cls.clerkStatus !== undefined ? { clerk_status: cls.clerkStatus } : {}),
        ...(cls.clerkCode ? { clerk_code: cls.clerkCode } : {}),
        ...(cls.providerError ? { provider_error: cls.providerError } : {}),
      });
    }
    console.error(`[MCP] Google token fetch failed (${cls.reason}${retried ? ', after retry' : ''}) for target mailbox:`, describeErrorForLog(err));
    return { failure: cls.reason, retried };
  }
  if (!quiet) addToolCallProps({ token_ms: Date.now() - tokenStarted });
  const grant = tokenResponse.data?.[0];
  if (!grant?.token) {
    // Clerk answered cleanly and holds no Google grant for this user. Fires
    // the standalone event too (it did not before 2026-09-04, so the event
    // under-counted the token-failure population by this class).
    if (!quiet) {
      addToolCallProps({ google_token_error: 'no_token' });
      captureServerEvent(keyOwner.clerkUserId, 'google_token_fetch_failed', {
        reason: 'no_token', via: 'mcp', account_delegated: accountDelegated, retried: false,
      });
    }
    return { failure: 'no_token', retried: false };
  }
  // Clerk's `scopes` is the scope set of the last OAuth request that
  // completed for the account — not necessarily what the token in hand
  // carries. A plain Google sign-in rewrites it without drive.file
  // (2026-09-04 finding; the dashboard reads tokeninfo instead and the two
  // disagreed). Only computed here — gmailScopeDenial / driveFileScopeDenial
  // do the enforcement and the analytics, so a sheets-only call by a
  // Gmail-scope-less user records nothing.
  const scopes = Array.isArray(grant.scopes) ? grant.scopes : undefined;
  // Ask Google what the token really carries (cached per token, ~one
  // lookup per account per token lifetime). The record is wrong in both
  // directions in practice, so the token decides whenever tokeninfo
  // answers; the record only stands in when it does not
  // (reconcileScopes, unit-tested). Deliberately OUTSIDE the Clerk
  // try/catch above: liveTokenScopes never throws, and a tokeninfo problem
  // must never be classified as a Clerk token failure.
  const verdict = reconcileScopes(scopes, await liveTokenScopes(grant.token));
  if (!quiet) {
    if (verdict.recordStale) addToolCallProps({ clerk_scope_cache_stale: true });
    if (verdict.recordOverstates) addToolCallProps({ clerk_scope_record_overstates: true });
  }
  return { token: grant.token, hasGmailScope: verdict.hasGmailScope, hasDriveFileScope: verdict.hasDriveFileScope };
}

// loadApplicableRules / checkReadRestrictions moved to src/lib/gmailRules.ts —
// shared with the push-notification filter so read policy and notification
// policy can never drift apart.

/**
 * Send-whitelist enforcement shared by gmail_send and google_api_modify.
 * Every recipient must match a whitelist pattern; unknown recipients deny.
 * Returns a denial ({ message, deniedRecipient? }) or null if sending is
 * allowed. deniedRecipient feeds the magic approval link — absent when we
 * could not even parse who the mail was for (no link in that case).
 */
type SendDenial = { message: string; deniedRecipient?: string; code: string };

function checkSendWhitelist(rules: ApplicableRules, recipients: string[] | null): SendDenial | null {
  const sendRules = rules.filter(r => r.service === 'gmail' && r.actionType === 'send_whitelist');

  if (!recipients || recipients.length === 0) {
    return { message: '🚫 Could not determine the message recipients, so sending was denied. Provide a standard RFC 2822 message with To/Cc/Bcc headers.', code: 'recipients_undetermined' };
  }

  if (sendRules.length === 0) {
    return {
      message: SEND_DISABLED_MESSAGE,
      deniedRecipient: recipients[0],
      code: 'send_disabled',
    };
  }

  for (const recipient of recipients) {
    let isWhitelisted = false;
    for (const rule of sendRules) {
      if (!rule.regexPattern) continue;
      const regex = compileRulePattern(rule.regexPattern);
      if (!regex) continue;
      if (regex.test(recipient)) { isWhitelisted = true; break; }
    }
    if (!isWhitelisted) {
      return {
        message: recipientNotWhitelistedMessage(recipient),
        deniedRecipient: recipient,
        code: 'recipient_not_whitelisted',
      };
    }
  }

  return null;
}

/**
 * Magic-link denial (connector-growth Phase C): policy denials that a user
 * would plausibly want to approve carry a signed link that pre-fills exactly
 * that grant. The link is DETERMINISTIC — denying the same operation again
 * re-emits the same URL rather than minting a new one — and does not expire.
 * Every attempt is still recorded, so demand (rows in approval_requests) stays
 * separable from retry pressure (mintCount). Explicit blocks and read
 * restrictions never get links — weakening those stays a deliberate
 * dashboard act.
 */
async function policyDenialWithLink(
  conn: ConnectionApproved,
  proxyKeyId: string,
  message: string,
  action: ApprovalAction | null,
) {
  // No action = nothing an agent can request lifts this (explicit block):
  // say so, or the agent gets "Access Denied" and tries again.
  if (!action) return textResult(withNoLinkStop(message));
  try {
    const { url, requestId, targetHash } = await mintApprovalLink(DASHBOARD_URL, conn.user.id, proxyKeyId, action);
    const mintCount = await recordApprovalMint({
      requestId, userId: conn.user.id, proxyKeyId, action: action.action, targetHash,
    });
    captureServerEvent(conn.user.clerkUserId, 'approval_link_minted', {
      action: action.action, request_id: requestId, target_hash: targetHash, mint_count: mintCount,
    });
    addToolCallProps({ approval_request_id: requestId });
    // The user-facing sentence exists because the denial text above is
    // FGAC-jargon the agent tends to paraphrase AT the user ("not exposed in
    // your FGAC rules") — and measured 2026-08-25→29, 62% of file-approval
    // links were never opened while every opened+approved link now verifies
    // clean, so the remaining funnel loss is entirely in getting the click.
    // A quotable, jargon-free line doubles the URL's survival odds in
    // paraphrase and tells the user why clicking is safe.
    return textResult(
      `${message}\n👉 Share this link with the user to approve it in one click: ${url}\n` +
      `Suggested wording to relay: "FGAC is blocking this until you approve it here: ${url} — one click, and you can revoke it any time from your dashboard."\n` +
      AGENT_APPROVAL_PROTOCOL,
    );
  } catch (err) {
    console.error('[MCP] Failed to mint approval link:', err);
    return textResult(withLinkUnavailableStop(message));
  }
}

// AGENT_APPROVAL_PROTOCOL lives in src/lib/denialCopy.ts (tested by scripts/test-denial-copy.ts).

/**
 * Send denials offer BOTH one-click options: approve just this recipient, or
 * flip the profile to "Send to Anyone" — the escape hatch for users who find
 * per-recipient whitelisting confusing. Each is its own signed deterministic
 * link; only the human choosing one applies anything. Note this mints TWO
 * requests per denial, so send actions carry roughly double the request count
 * of a single-option denial — a known accounting quirk, not duplicate demand.
 */
async function sendDenialWithLinks(
  conn: ConnectionApproved,
  proxyKeyId: string,
  denial: SendDenial,
) {
  const lines = [denial.message];
  addToolCallProps({ denial_code: denial.code });
  try {
    if (denial.deniedRecipient) {
      const one = await mintApprovalLink(DASHBOARD_URL, conn.user.id, proxyKeyId, {
        action: 'send_whitelist', recipient: denial.deniedRecipient,
      });
      lines.push(`👉 Allow sending to '${denial.deniedRecipient}' only — share this one-click link with the user: ${one.url}`);
      const oneMintCount = await recordApprovalMint({
        requestId: one.requestId, userId: conn.user.id, proxyKeyId,
        action: 'send_whitelist', targetHash: one.targetHash,
      });
      captureServerEvent(conn.user.clerkUserId, 'approval_link_minted', {
        action: 'send_whitelist', request_id: one.requestId, target_hash: one.targetHash, via: 'send_denial',
        mint_count: oneMintCount,
      });
    }
    const all = await mintApprovalLink(DASHBOARD_URL, conn.user.id, proxyKeyId, { action: 'send_all' });
    lines.push(`👉 Or allow sending to ANY recipient from this profile — share this one-click link with the user instead: ${all.url}`);
    const allMintCount = await recordApprovalMint({
      requestId: all.requestId, userId: conn.user.id, proxyKeyId, action: 'send_all',
    });
    captureServerEvent(conn.user.clerkUserId, 'approval_link_minted', {
      action: 'send_all', request_id: all.requestId, via: 'send_denial', mint_count: allMintCount,
    });
    lines.push('Present both options and let the user pick; "any recipient" is the convenient choice if they expect to send freely, and it stays revocable from the dashboard rules.');
    lines.push(AGENT_APPROVAL_PROTOCOL);
  } catch (err) {
    console.error('[MCP] Failed to mint approval link:', err);
    lines.push(LINK_UNAVAILABLE_STOP);
  }
  return textResult(lines.join('\n'));
}

// ─── Google API Helpers ─────────────────────────────────────────────────────

type GoogleFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number };

// GoogleErrorReason / extractGoogleErrorReason moved to googleApiPolicy.ts
// (pure parsing, now unit-tested — it also reads the gRPC-style
// error.details[] ErrorInfo shape that Sheets/Docs/Slides/People return).

/** 403s Google raises for throttling rather than for a missing/revoked grant. */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded',
  'quotaExceeded', 'sharingRateLimitExceeded',
]);

/**
 * 403s that genuinely mean the grant is wrong. Deliberately NOT including
 * Google's generic `forbidden`: it appears for several unrelated conditions,
 * so claiming "retrying will NOT fix it" for it would repeat the
 * over-confident assertion this branching exists to remove. It falls through
 * to the hedged default instead.
 */
const SCOPE_REASONS = new Set([
  'insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'insufficientFilePermissions',
]);

function describe403(detail: string, targetEmail: string, r: GoogleErrorReason): string {
  const reconnect = `Ask the user to reconnect the account with this one-click link (it opens Google's consent screen directly): ` +
    `${reconnectLink(targetEmail)} — then retry once after they confirm.`;

  // Throttling. Reconnecting the account does nothing here, and the retry the
  // old text suppressed is exactly the right move.
  if ((r.reason && RATE_LIMIT_REASONS.has(r.reason)) || r.domain === 'usageLimits' || r.status === 'RESOURCE_EXHAUSTED') {
    return `❌ Google is rate limiting this account (403 ${r.reason || 'usageLimits'})${detail ? `: ${detail}` : ''}. ` +
      `This is temporary and NOT a permissions problem — do not ask the user to reconnect. ` +
      `Wait a few seconds and retry; if several retries fail, slow down the rate of calls and tell the user Google is throttling.`;
  }

  // Workspace admin policy. A reconnect re-grants the same scopes and fails
  // identically — only an admin can change this.
  if (r.reason === 'domainPolicy') {
    return `❌ A Google Workspace admin policy blocks this operation for '${targetEmail}' (403 domainPolicy)${detail ? `: ${detail}` : ''}. ` +
      `STOP — do not retry and do not ask the user to reconnect; reconnecting grants the same scopes and will fail the same way. ` +
      `Only a Workspace administrator can allow this.`;
  }

  // Genuinely a missing/revoked scope — the original text, now only on the
  // branch where it is actually true.
  if (r.reason && SCOPE_REASONS.has(r.reason)) {
    return `❌ Google denied the request (403 ${r.reason})${detail ? `: ${detail}` : ''}. ` +
      `Google's grant for '${targetEmail}' is missing a scope or was revoked — retrying will NOT fix it. ${reconnect}`;
  }

  // Reason absent or unrecognised: state both plausible causes and allow one
  // retry, rather than asserting the scope cause the way the old text did.
  return `❌ Google denied the request (403${r.reason ? ` ${r.reason}` : ''})${detail ? `: ${detail}` : ''}. ` +
    `This is usually either temporary throttling or a missing/revoked OAuth scope for '${targetEmail}'. ` +
    `Retry ONCE after a short pause — if it fails again it is the grant, not throttling, and reconnecting is the fix: ${reconnectLink(targetEmail)}`;
}

function describeGoogleError(status: number, data: unknown, targetEmail: string): string {
  // Google's `message` usually ends in a period and every call site appends
  // its own, producing "…scopes.." in agent-facing text.
  const detail = ((data as { error?: { message?: string } })?.error?.message
    || (typeof data === 'string' ? data.slice(0, 300) : '')).replace(/\s*\.\s*$/, '');
  const r = extractGoogleErrorReason(data);
  switch (status) {
    case 401:
      return `❌ Google authorization expired for '${targetEmail}'. STOP — do not retry; it will keep failing. ` +
        `Ask the user to reconnect this Google account with this one-click link (it opens Google's consent screen directly): ` +
        `${reconnectLink(targetEmail)} — then retry once after they confirm.`;
    case 403:
      return describe403(detail, targetEmail, r);
    case 404:
      return `❌ Google resource not found (404)${detail ? `: ${detail}` : ''}. ` +
        `The id is wrong, stale, or not visible to this account — verify it against a fresh listing before retrying; the same id unchanged will 404 again.`;
    case 429:
      return '❌ Google API rate limit exceeded (429). Wait a moment and retry.';
    default:
      return `❌ Google API error (${status})${detail ? `: ${detail}` : ''}.`;
  }
}

/**
 * Accumulate wall-clock spent talking to Google onto the tool-call event
 * (grace retries make multiple googleFetch calls per tool call), so slow
 * calls are attributable: google_ms ≈ $mcp_duration_ms means Google was
 * slow; a wide gap means the time went to FGAC (token fetch, rules, DB).
 */
function recordGoogleMs(started: number): void {
  const prev = getToolCallProps().google_ms;
  addToolCallProps({ google_ms: (typeof prev === 'number' ? prev : 0) + (Date.now() - started) });
}

async function googleFetch(
  url: string, token: string, method = 'GET', body?: string, targetEmail = '',
): Promise<GoogleFetchResult> {
  const started = Date.now();
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    // The signal also covers body streaming, so a response that stalls after
    // headers aborts into the same classified branch below.
    text = await res.text();
  } catch (err) {
    recordGoogleMs(started);
    if (isUpstreamTimeout(err)) {
      addToolCallProps({ error_status: 'timeout' });
      const retryAdvice = method === 'GET'
        ? 'Wait a moment and retry ONCE; if it times out again, Google is degraded — tell the user and try later.'
        : 'The request MAY have been applied despite the timeout. Do NOT blindly retry a write — read the data back first, and only retry if the change is missing.';
      return {
        ok: false,
        error: `❌ Google did not answer within ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s. This is Google-side slowness, not a permissions problem. ${retryAdvice}`,
      };
    }
    addToolCallProps({ error_status: 'network' });
    return { ok: false, error: `❌ Could not reach the Google API: ${err instanceof Error ? err.message : 'network error'}.` };
  }
  recordGoogleMs(started);

  let data: unknown = text;
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON body: keep text */ }

  if (!res.ok) {
    // reason/domain are what make the 403 branching (and any later analysis of
    // the 403 mix) possible at all; status alone cannot separate throttling
    // from a revoked grant. See extractGoogleErrorReason for why these are
    // safe to put on an event.
    const r = extractGoogleErrorReason(data);
    addToolCallProps({
      error_status: res.status,
      // Fall back to Google's canonical status string (PERMISSION_DENIED,
      // NOT_FOUND) when the body carries no reason enum — before this, most
      // raw-API errors landed with a null error_reason and could not be
      // triaged by cause at all.
      ...(r.reason || r.status ? { error_reason: r.reason ?? r.status } : {}),
      ...(r.domain ? { error_domain: r.domain } : {}),
    });
    return { ok: false, error: describeGoogleError(res.status, data, targetEmail), status: res.status };
  }
  return { ok: true, data };
}

/**
 * Post-policy Google failure on a per-file (sheets/docs) call. A 403/404
 * HERE — after FGAC's own permission check passed — almost always means the
 * FGAC rule exists but Google never registered a drive.file grant for the
 * file (it was approved via magic link but never picked in the Google
 * Picker; a mistyped id looks identical from outside). The generic "check
 * the ID" text sent the whole 2026-08 connector cohort into a retry loop;
 * say what is actually wrong and where the one-click fix lives.
 *
 * The 403/404 branch is a 🚫 refusal (outcome `denied_by_policy`), not an
 * error and not a ❌ failure: it is a per-file access grant that does not
 * exist yet, answered with the exact one-click setup step — the same class
 * as an FGAC rule denial. The published error-rate math counts ❌ `failed`
 * results as tool errors too (see gmailScopeDenial), which is why the
 * 2026-09-02 isError→❌ demotion was not enough. `denial_code` marks the
 * class; error_status/error_reason props are stamped at the googleFetch
 * layer, so internal observability is unaffected. Other statuses stay
 * errorResult.
 */
function fileGrantErrorResult(kind: DriveFileKind, result: { error: string; status?: number }, fileId: string) {
  if (result.status === 403 || result.status === 404) {
    const d = DRIVE_FILE_KINDS[kind];
    const short = kind === 'sheet' ? 'sheet' : d.noun;
    addToolCallProps({ denial_code: 'file_grant_missing_at_google' });
    // Only the sheets setup page embeds a demo video today — the error must
    // not promise docs users a video that isn't there (QA 19 A12 finding).
    const setupBlurb = kind === 'sheet' ? ' (includes a short how-to video)' : '';
    return textResult(
      `🚫 Not available yet: FGAC allows this ${d.noun}, but Google hasn't shared the ${short} itself with FGAC, so Google rejected the call (${result.status}). ` +
      `This is a one-time setup step only the user can do: they must pick this ${short} in Google's file picker. ` +
      `👉 Send the user here to finish setup${setupBlurb}: ${DASHBOARD_URL}${d.setupPath}?${d.setupIdParam}=${encodeURIComponent(fileId)} ` +
      `Note: a wrong ${d.noun} ID produces this same error — the setup page verifies real access before reporting success, so it resolves either case. Retry after the user confirms.`,
    );
  }
  return errorResult(result.error);
}

/**
 * Post-policy Google failure on a comments call. Comments are content on the
 * file, so a 403/404 here means what it means for the file itself — the FGAC
 * rule exists but Google holds no drive.file grant for the file — and gets
 * the same setup-link answer via fileGrantErrorResult. The one extra cause is
 * a reply addressed to a specific commentId: comment ids are file-scoped and
 * go stale when comments are deleted, and no reconnect or Picker pass fixes
 * that, so that branch must steer to a fresh comments_read first.
 */
function commentsErrorResult(
  kind: DriveFileKind,
  result: { error: string; status?: number },
  fileId: string,
  commentId?: string,
) {
  if (commentId && result.status === 404) {
    // Stale caller-supplied commentId → ❌ textResult (outcome `failed`), not
    // isError and not 🚫: a stale id the agent supplied is a caller-data
    // error, not an access refusal FGAC can honestly claim (contrast
    // fileGrantErrorResult, where a grant is genuinely missing).
    return textResult(
      `❌ Google returned 404 for comment '${commentId}' on this ${DRIVE_FILE_KINDS[kind].noun} — the comment id is stale or belongs to a different file, ` +
      `or the file itself is not granted to FGAC at Google. ` +
      `Do NOT retry the same commentId: re-run comments_read for this file and reply to a comment id from that fresh response. ` +
      `If comments_read also fails with 403/404, the file grant is the problem — follow the setup link that error gives.`,
    );
  }
  return fileGrantErrorResult(kind, result, fileId);
}

/**
 * Post-policy Gmail 404. There is no drive.file grant to fix here — a 404
 * means one of the two ids is stale, and WHICH one is knowable from the call
 * site, because gmail_get_attachment issues two separate requests:
 * the parent message read, then the attachment read. The generic
 * "check the ID and try again" text could not say which id to check, so
 * agents retried the same (messageId, attachmentId) pair unchanged — one
 * production user did so 9 times in a single day.
 *
 * When the parent read SUCCEEDED and the attachment read 404s, the messageId
 * is provably valid and the attachmentId is the bad one. Attachment ids are
 * message-scoped (they are a path segment under the message) and Gmail
 * re-issues them when a message is re-indexed, so an id cached from an
 * earlier gmail_read can go stale while the message stays valid. That is
 * recoverable — but only by re-reading the message, never by retrying the
 * same pair. The reverse advice would be wrong for a bad messageId, which is
 * why the two sites must not share one string.
 *
 * Each branch states a stop condition. The repeat-count signature says the
 * missing piece was the stop, not the explanation.
 *
 * Both 404 branches are ❌ textResult (outcome `failed`), not errorResult
 * and not 🚫: a stale caller-supplied id is a caller-data error the agent
 * fixes by acting differently — there is no grant to repair, so claiming a
 * policy refusal would be dishonest (contrast fileGrantErrorResult).
 * The gmail_404_site prop keeps the two sites separable internally.
 * Non-404 statuses stay errorResult.
 */
function gmailNotFoundResult(
  site: 'message' | 'attachment',
  result: { error: string; status?: number },
  messageId: string,
) {
  if (result.status !== 404) return errorResult(result.error);
  addToolCallProps({ gmail_404_site: site });

  if (site === 'message') {
    return textResult(
      `❌ Gmail has no message with id '${messageId}' for this account (404). ` +
      `The id is wrong, belongs to a different account, or the message was deleted. ` +
      `STOP — do not retry this id; it will keep failing. ` +
      `Re-run gmail_list to get current message ids, or confirm with the user which account the message is in.`,
    );
  }

  return textResult(
    `❌ The message exists, but Gmail has no attachment with that attachmentId on it (404). ` +
    `Attachment ids belong to one specific message and Gmail re-issues them when the message is re-indexed, ` +
    `so an id from an earlier gmail_read (or from a different message) goes stale even though the message is still fine. ` +
    `Do NOT retry the same messageId + attachmentId pair — that is guaranteed to fail again. ` +
    `Fix: re-run gmail_read with messageId '${messageId}', take the attachmentId from the \`attachments\` array in that fresh response, and retry ONCE with it. ` +
    `If that also 404s, stop and tell the user the attachment is no longer retrievable.`,
  );
}

const sheetsErrorResult = (result: { error: string; status?: number }, spreadsheetId: string) =>
  fileGrantErrorResult('sheet', result, spreadsheetId);
const docsErrorResult = (result: { error: string; status?: number }, documentId: string) =>
  fileGrantErrorResult('doc', result, documentId);

async function gmailFetch(token: string, email: string, path: string, method = 'GET', body?: string): Promise<GoogleFetchResult> {
  const userId = email === 'me' ? 'me' : encodeURIComponent(email);
  return googleFetch(`https://www.googleapis.com/gmail/v1/users/${userId}/${path}`, token, method, body, email);
}

async function sheetsFetch(token: string, path: string, method = 'GET', body?: string, targetEmail = ''): Promise<GoogleFetchResult> {
  return googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, token, method, body, targetEmail);
}

async function docsFetch(token: string, path: string, method = 'GET', body?: string, targetEmail = ''): Promise<GoogleFetchResult> {
  return googleFetch(`https://docs.googleapis.com/v1/documents/${path}`, token, method, body, targetEmail);
}

/** How recently a matching per-file rule must have been created for a 403/404
 * to be treated as grant propagation rather than a genuinely missing grant. */
const SHEETS_GRACE_WINDOW_MS = 120_000;
const SHEETS_GRACE_RETRIES = 2;
const SHEETS_GRACE_DELAY_MS = 3_500;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A per-file fetch with a propagation grace window. Approval-time
 * verification passes with the owner's token, yet the MCP call path can
 * still see 403/404 for tens of seconds while Google's per-file drive.file
 * grant settles (observed on three launch-cohort users: one error
 * immediately after approval, success seconds later). When the matching rule
 * is younger than the grace window, a 403/404 is retried with a short pause
 * instead of being surfaced — the agent sees a slower success, not an error.
 * Rules older than the window fail fast exactly as before.
 *
 * Analytics props are prefixed by the kind's service so sheets dashboards
 * keep their historical names (sheets_grace_*) and docs get docs_grace_*.
 */
async function withGrantGrace(
  kind: DriveFileKind,
  perm: FilePermission,
  doFetch: () => Promise<GoogleFetchResult>,
): Promise<GoogleFetchResult> {
  const service = DRIVE_FILE_KINDS[kind].service;
  let result = await doFetch();
  const ruleAt = perm.allowed ? perm.newestRuleAt : null;
  if (!ruleAt) return result;

  const grantAgeSeconds = () => Math.round((Date.now() - ruleAt.getTime()) / 1000);
  const inGrace = () => Date.now() - ruleAt.getTime() < SHEETS_GRACE_WINDOW_MS;
  const retriable = () => !result.ok && (result.status === 403 || result.status === 404);

  if (retriable()) addToolCallProps({ [`${service}_grant_age_seconds`]: grantAgeSeconds() });

  let retries = 0;
  while (retriable() && inGrace() && retries < SHEETS_GRACE_RETRIES) {
    await sleep(SHEETS_GRACE_DELAY_MS);
    retries += 1;
    result = await doFetch();
  }
  if (retries > 0) {
    addToolCallProps({ [`${service}_grace_retries`]: retries, [`${service}_grace_recovered`]: result.ok });
    if (result.ok) {
      // Don't let the first attempt's transient status ride on a success event.
      addToolCallProps({ error_status: undefined, error_reason: undefined, error_domain: undefined });
      console.log(`[MCP] ${service} grace retry recovered after ${retries} attempt(s) (rule age ${grantAgeSeconds()}s)`);
    }
  }
  return result;
}

const withSheetsGrace = (perm: FilePermission, doFetch: () => Promise<GoogleFetchResult>) =>
  withGrantGrace('sheet', perm, doFetch);
const withDocsGrace = (perm: FilePermission, doFetch: () => Promise<GoogleFetchResult>) =>
  withGrantGrace('doc', perm, doFetch);

// ─── docs_edit delete verification ──────────────────────────────────────────
//
// Google can apply a deleteContentRange only partially and still return 200
// (observed 2026-08-30 when a range crossed a table boundary: ~190 chars of a
// body-wide delete survived, response indicated success). The write stays a
// byte-faithful passthrough; when a request array contains a delete we read
// the body end index back and report facts — never our interpretation of the
// content. Verification is best-effort: it can degrade to "unavailable" but
// never turns a successful write into an error.

/** Requests that never move body indices. */
const DOCS_ZERO_DELTA_OPS = new Set([
  'updateParagraphStyle', 'updateTextStyle', 'updateDocumentStyle',
  'updateTableCellStyle', 'updateTableRowStyle', 'updateTableColumnProperties',
  'updateSectionStyle',
]);

type DocsDeleteVerifyPlan =
  | { hasDelete: false }
  | { hasDelete: true; deterministic: boolean; expectedDelta: number };

/**
 * Decide whether a batchUpdate needs read-back verification and whether the
 * net body-length change is exactly computable from the requests alone.
 * Deterministic ops: deleteContentRange removes (endIndex - startIndex)
 * indices, insertText adds the UTF-16 length of its text (JS string .length),
 * style updates move nothing. Anything else — or any op targeting a non-body
 * segment (segmentId) — makes the outcome non-deterministic; we then report
 * before/after indices without an expectation.
 */
function planDocsDeleteVerification(requests: Record<string, unknown>[]): DocsDeleteVerifyPlan {
  let hasDelete = false;
  let deterministic = true;
  let expectedDelta = 0;
  for (const request of requests) {
    for (const [op, rawArgs] of Object.entries(request)) {
      const args = (rawArgs ?? {}) as {
        range?: { startIndex?: unknown; endIndex?: unknown; segmentId?: unknown };
        text?: unknown;
        location?: { segmentId?: unknown };
        endOfSegmentLocation?: { segmentId?: unknown };
      };
      if (op === 'deleteContentRange') {
        hasDelete = true;
        const range = args.range;
        if (range && typeof range.startIndex === 'number' && typeof range.endIndex === 'number' && !range.segmentId) {
          expectedDelta -= range.endIndex - range.startIndex;
        } else {
          deterministic = false;
        }
      } else if (op === 'insertText') {
        const targetsBody = !args.location?.segmentId && !args.endOfSegmentLocation?.segmentId;
        if (typeof args.text === 'string' && targetsBody) {
          expectedDelta += args.text.length;
        } else {
          deterministic = false;
        }
      } else if (!DOCS_ZERO_DELTA_OPS.has(op)) {
        deterministic = false;
      }
    }
  }
  return hasDelete ? { hasDelete, deterministic, expectedDelta } : { hasDelete: false };
}

/** End index of the document body's last structural element, or null when the
 * read fails — callers treat null as "verification unavailable". */
async function fetchDocsBodyEndIndex(token: string, documentId: string, targetEmail: string): Promise<number | null> {
  const result = await docsFetch(token, `${encodeURIComponent(documentId)}?fields=body(content(endIndex))`, 'GET', undefined, targetEmail);
  if (!result.ok) return null;
  const content = (result.data as { body?: { content?: Array<{ endIndex?: number }> } })?.body?.content;
  const last = Array.isArray(content) && content.length > 0 ? content[content.length - 1] : null;
  return typeof last?.endIndex === 'number' ? last.endIndex : null;
}

/** Verification line appended to the docs_edit result, or null for tier 0. */
function docsDeleteVerifyNote(plan: DocsDeleteVerifyPlan, before: number | null, after: number | null): string | null {
  if (!plan.hasDelete) return null;
  if (before === null || after === null) {
    addToolCallProps({ docs_verify_outcome: 'unavailable' });
    return 'verification unavailable';
  }
  if (!plan.deterministic) {
    addToolCallProps({ docs_verify_outcome: 'reported' });
    return `body end ${after} (was ${before})`;
  }
  const expected = before + plan.expectedDelta;
  if (after === expected) {
    addToolCallProps({ docs_verify_outcome: 'verified' });
    return 'verified';
  }
  addToolCallProps({ docs_verify_outcome: 'mismatch', docs_verify_expected: expected, docs_verify_actual: after });
  console.warn(`[MCP] docs_edit delete verification mismatch: body end ${after}, expected ${expected}`);
  return `body end ${after}, expected ${expected} — delete may have partially applied; read the document back.`;
}

async function checkFilePermission(kind: DriveFileKind, userId: string, proxyKeyId: string, fileId: string, isMutating: boolean) {
  // Single choke point every per-file sheets/docs call passes through (typed
  // tools, comments tools, and the raw Google API branch), so stamping the
  // file id here makes per-file time-to-first-success queryable from
  // $mcp_tool_call alone.
  addToolCallProps({ file_id: fileId, file_service: DRIVE_FILE_KINDS[kind].service });
  const d = DRIVE_FILE_KINDS[kind];
  const allRules = await db.select().from(accessRules).where(eq(accessRules.userId, userId));
  const keyAssignments = await db.select().from(keyRuleAssignments).where(eq(keyRuleAssignments.proxyKeyId, proxyKeyId));
  const assignedRuleIds = new Set(keyAssignments.map(a => a.accessRuleId));
  const allAssignments = await db.select().from(keyRuleAssignments);
  const rulesWithAssignments = new Set(allAssignments.map(a => a.accessRuleId));

  const fileRules = allRules.filter(rule => {
    if (rule.service !== d.service) return false;
    const isGlobal = !rulesWithAssignments.has(rule.id);
    const isAssigned = assignedRuleIds.has(rule.id);
    const matchesId = rule.targetResourceId === fileId || rule.regexPattern === fileId;
    return (isGlobal || isAssigned) && matchesId;
  });

  const nounCap = d.noun.charAt(0).toUpperCase() + d.noun.slice(1);
  if (fileRules.length === 0) {
    addToolCallProps({ denial_code: `${d.service}_not_exposed` });
    return { allowed: false as const, denial: 'not_exposed' as const, reason: `🚫 Access Denied: ${nounCap} '${fileId}' is not exposed in your FGAC rules.` };
  }

  if (fileRules.some(r => r.actionType === d.actionTypes.block)) {
    addToolCallProps({ denial_code: `${d.service}_blocked` });
    return { allowed: false as const, denial: 'blocked' as const, reason: `🚫 Access Denied: Access to ${d.noun} '${fileId}' is explicitly blocked.` };
  }

  if (isMutating) {
    const hasReadWrite = fileRules.some(r => r.actionType === d.actionTypes.readWrite);
    if (!hasReadWrite) {
      addToolCallProps({ denial_code: `${d.service}_read_only` });
      return { allowed: false as const, denial: 'read_only' as const, reason: `🚫 Access Denied: Write access to ${d.noun} '${fileId}' is restricted (Read Only).` };
    }
  }

  // Newest matching rule's age drives the post-approval grace retry: a rule
  // created seconds ago means Google's drive.file grant may still be
  // propagating even though approval-time verification passed.
  const newestRuleAt = fileRules.reduce<Date | null>(
    (acc, r) => (!acc || r.createdAt > acc ? r.createdAt : acc), null,
  );
  return { allowed: true as const, newestRuleAt };
}

type FilePermission = Awaited<ReturnType<typeof checkFilePermission>>;
type SheetsPermission = FilePermission;

const checkSheetsPermission = (userId: string, proxyKeyId: string, spreadsheetId: string, isMutating: boolean) =>
  checkFilePermission('sheet', userId, proxyKeyId, spreadsheetId, isMutating);
const checkDocsPermission = (userId: string, proxyKeyId: string, documentId: string, isMutating: boolean) =>
  checkFilePermission('doc', userId, proxyKeyId, documentId, isMutating);

/**
 * Validate — and normalize, when a URL or `<id>/edit` makes the intent
 * unambiguous — a caller-supplied file id BEFORE the rule lookup and before
 * any approval link is minted (parseDriveFileId has the history). Sits at
 * every per-file entry point rather than inside checkFilePermission because
 * callers forward the id to Google and into the link action: the normalized
 * value has to replace theirs, not just the lookup key. A refusal here is a
 * 🚫 with `denial_code` `file_id_malformed` / `file_id_wrong_kind` and NO
 * link — a link for a value Google can never verify is a dead end dressed as
 * a one-click approval. `file_id_input` records how the id arrived
 * (`url` / `suffixed` on extraction, `malformed` on refusal; absent for a
 * bare id) so URL-pasting agents stay countable.
 */
function resolveDriveFileId(kind: 'sheet' | 'doc' | 'file', raw: string): { id: string } | { denial: ReturnType<typeof textResult> } {
  const parsed = parseDriveFileId(raw, kind);
  if (!parsed.ok) {
    addToolCallProps({
      denial_code: parsed.code,
      file_id_input: parsed.code === 'file_id_wrong_kind' ? 'url' : 'malformed',
      ...(kind === 'file' ? {} : { file_service: DRIVE_FILE_KINDS[kind].service }),
    });
    return { denial: textResult(parsed.reason) };
  }
  if (parsed.input !== 'bare') addToolCallProps({ file_id_input: parsed.input });
  return { id: parsed.id };
}

/** Map a sheets denial onto an approvable action matching the access level
 * the denied operation requires (see sheetsApprovalAction in googleApiPolicy). */
function sheetsDenialAction(perm: SheetsPermission, spreadsheetId: string, isMutating: boolean): ApprovalAction | null {
  if (perm.allowed) return null;
  return sheetsApprovalAction(perm.denial, spreadsheetId, isMutating);
}

/** Docs twin of sheetsDenialAction. */
function docsDenialAction(perm: FilePermission, documentId: string, isMutating: boolean): ApprovalAction | null {
  if (perm.allowed) return null;
  return docsApprovalAction(perm.denial, documentId, isMutating);
}

/**
 * Comments address files by bare Drive file id, which doesn't say whether the
 * file is a doc or a sheet — resolve the kind from whichever service's rules
 * mention the id, then run the standard per-file check for that kind. A file
 * no rule mentions denies as not-exposed WITHOUT an approval action: the
 * service is unknown, so no expose action could be minted for it.
 */
async function checkCommentsPermission(
  conn: ConnectionApproved,
  proxyKeyId: string,
  fileId: string,
  isMutating: boolean,
): Promise<{ denial: Awaited<ReturnType<typeof policyDenialWithLink>> } | { kind: DriveFileKind; perm: FilePermission }> {
  const rules = await db.select().from(accessRules).where(eq(accessRules.userId, conn.user.id));
  const kind = ACTIVE_DRIVE_FILE_KINDS.find(k =>
    rules.some(r => r.service === DRIVE_FILE_KINDS[k].service && (r.targetResourceId === fileId || r.regexPattern === fileId)),
  );
  if (!kind) {
    addToolCallProps({ denial_code: 'file_not_exposed' });
    return { denial: textResult(`🚫 Access Denied: File '${fileId}' is not exposed in your FGAC rules. Ask the user to expose the document or spreadsheet via the dashboard picker, or call request_access with the file id.`) };
  }
  const perm = await checkFilePermission(kind, conn.user.id, proxyKeyId, fileId, isMutating);
  if (!perm.allowed) {
    const action = kind === 'doc'
      ? docsApprovalAction(perm.denial, fileId, isMutating)
      : sheetsApprovalAction(perm.denial, fileId, isMutating);
    return { denial: await policyDenialWithLink(conn, proxyKeyId, perm.reason, action) };
  }
  return { kind, perm };
}

const COMMENT_LIST_FIELDS = 'nextPageToken,comments(id,content,resolved,createdTime,modifiedTime,author(displayName),quotedFileContent(value),replies(id,content,action,createdTime,author(displayName)))';

// ─── Gmail Message Parsing (token-frugal responses) ─────────────────────────

const MAX_BODY_CHARS = 20_000;
const MAX_ATTACHMENT_CHARS = 200_000; // base64url chars ≈ 150 KB decoded

/**
 * Generic large-response windowing (plan gmail-attachment-pagination_v3):
 * when a tool's payload exceeds what the CALLER wants in one response, the
 * caller says which section (`offset`) and how much (`limit`, chars) — the
 * agent knows its own harness's tool-result budget, so it sizes windows
 * itself instead of the server guessing. A window is a plain substring of
 * the payload, so contiguous windows concatenate to exactly the original
 * string (for base64url payloads: concatenate first, decode ONCE at the
 * end). Shared today by gmail_get_attachment (base64url data) and
 * docs_read_document (serialized JSON); any tool with an oversized payload
 * can adopt the same envelope.
 */
const RESPONSE_WINDOW_MAX_CHARS = 200_000;

function windowPayload(payload: string, offset: number, limit: number | undefined) {
  const cappedLimit = Math.min(Math.max(1, limit ?? RESPONSE_WINDOW_MAX_CHARS), RESPONSE_WINDOW_MAX_CHARS);
  const data = payload.slice(offset, offset + cappedLimit);
  const nextOffset = offset + data.length < payload.length ? offset + data.length : null;
  addToolCallProps({ window_offset: offset, window_chars: data.length, window_total_chars: payload.length });
  return {
    offset,
    chars_returned: data.length,
    total_chars: payload.length,
    next_offset: nextOffset,
    data,
  };
}

/**
 * The full windowed tool result: envelope + reassembly note, or the ❌
 * out-of-range guidance (outcome `failed`, never isError — same directory
 * rationale as resolveFailure). `encoding: 'base64url'` payloads get the
 * decode-once instruction; plain serialized payloads the concatenate one.
 */
function windowedResult(
  payload: string,
  offset: number | undefined,
  limit: number | undefined,
  extra: Record<string, unknown> = {},
  encoding: 'base64url' | null = null,
) {
  const off = offset ?? 0;
  if (off >= payload.length) {
    return textResult(
      `❌ offset ${off} is at or beyond the end of the payload (${payload.length} chars total). ` +
      `Do not retry this offset — the previous window was the final one, or restart from offset 0.`);
  }
  const win = windowPayload(payload, off, limit);
  const reassemble = encoding === 'base64url'
    ? 'concatenate the data strings in offset order, then base64url-decode the result once'
    : 'concatenate the data strings in offset order to reconstruct the full payload';
  return jsonResult({
    ...extra,
    ...(encoding ? { encoding } : {}),
    ...win,
    note: win.next_offset === null
      ? `Final window — ${reassemble}.`
      : `Partial content — call again with offset: ${win.next_offset} for the next window; ${reassemble}.`,
  });
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

/**
 * Reduce a Gmail `format=full` message to headers, decoded body text, and
 * attachment metadata. The full payload (nested base64 parts, redundant
 * headers) routinely runs 10-50x the size of the content the model needs.
 */
function parseGmailMessage(msg: Record<string, unknown>, opts: { fullBody?: boolean } = {}) {
  const payload = msg.payload as (GmailPart & { headers?: Array<{ name?: string; value?: string }> }) | undefined;
  const headersArr = payload?.headers ?? [];
  const header = (name: string) =>
    headersArr.find(h => h.name?.toLowerCase() === name)?.value;

  let bodyText = '';
  let htmlFallback = '';
  const attachments: Array<{ filename: string; mimeType?: string; attachmentId: string; sizeBytes?: number }> = [];

  const stack: GmailPart[] = payload ? [payload] : [];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.parts) stack.push(...part.parts);
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        sizeBytes: part.body.size,
      });
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText += decodeB64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && !htmlFallback) {
      htmlFallback = decodeB64Url(part.body.data);
    }
  }

  const usedHtmlFallback = !bodyText && !!htmlFallback;
  if (usedHtmlFallback) {
    bodyText = stripHtmlToText(htmlFallback);
  }

  const truncated = !opts.fullBody && bodyText.length > MAX_BODY_CHARS;
  // Response-shape observability: lets a support report ("format=full fails
  // on THIS message") be checked against what the parser actually produced —
  // an attachment-heavy message legitimately parses to a few KB, which reads
  // as "empty" without these. No-op outside a wrapped tool call.
  addToolCallProps({
    parsed_body_chars: bodyText.length,
    parsed_body_truncated: truncated,
    parsed_attachments: attachments.length,
    parsed_html_fallback: usedHtmlFallback,
  });
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    headers: {
      from: header('from'),
      to: header('to'),
      cc: header('cc'),
      subject: header('subject'),
      date: header('date'),
    },
    body: truncated
      ? `${bodyText.slice(0, MAX_BODY_CHARS)}\n…[truncated ${bodyText.length - MAX_BODY_CHARS} characters — re-call gmail_read with offset/limit to window the full message, or use format "metadata"]`
      : bodyText,
    attachments,
  };
}

// ─── Require Approval Wrapper ───────────────────────────────────────────────

type AuthInfo = { extra?: { userId?: string; userAgent?: string; profileSlug?: string }; clientId?: string };

type ApprovalDenied = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function requireApproval(authInfo: AuthInfo | undefined): Promise<ConnectionApproved | ApprovalDenied> {
  const userId = authInfo?.extra?.userId as string | undefined;
  const clientId = authInfo?.clientId;

  if (!userId) {
    return textResult('❌ Authentication failed.');
  }

  // resolveConnection is the first thing every tool does and it is entirely
  // database work — the users lookup, the agent_connections read, the bound
  // proxy-key check. A database failure here used to escape unwrapped, and
  // the MCP SDK printed Drizzle's message (the full SQL plus the caller's
  // Clerk user id) straight into the tool result. Keep the detail in the log.
  let result: ConnectionResult;
  try {
    result = await resolveConnection(userId, clientId, undefined, authInfo?.extra?.profileSlug);
  } catch (err) {
    return errorResult(logAndSanitize('Connection resolution failed', err));
  }

  if (!result.authorized) {
    return textResult(pendingMessage(result));
  }
  // Client-product attribution: today clientName is usually the opaque DCR
  // client_id (only cli-token registrations send a real name), but stamping
  // it means events light up as soon as DCR name capture improves.
  if (result.clientName) addToolCallProps({ client_name: result.clientName });
  return result;
}

// ─── Analytics Instrumentation ──────────────────────────────────────────────

type ToolAnalyticsResult = { isError?: boolean; content?: Array<{ type?: string; text?: string }> };

/**
 * Tool responses follow a strict convention (textResult/errorResult above):
 * isError marks upstream/auth failures, and policy outcomes carry a leading
 * ⏳ (pending approval), 🚫 (denied by FGAC policy), ❌ (failed), or
 * ⚠️ (size-capped: a deliberate refusal to return an oversized payload —
 * the tool worked, so it must not count as a tool error in any error-rate
 * metric; before 2026-08-24 it classified as `failed` and inflated the
 * gmail_get_attachment error rate). Caller/user-fixable Google 403/404
 * guidance was demoted from isError to ❌ `failed` on 2026-09-02, and the
 * subset that is a deterministic grant refusal with remediation (missing
 * scope, file not shared with FGAC at Google) graduated to 🚫
 * `denied_by_policy` on 2026-09-03, since ❌ `failed` still counts in the
 * published error rate — see errorResult's doc-comment for the boundary.
 */
function classifyToolOutcome(result: ToolAnalyticsResult): string {
  if (result.isError) return 'error';
  const text = result.content?.[0]?.text ?? '';
  if (text.startsWith('⏳')) return 'pending_approval';
  if (text.startsWith('🚫')) return 'denied_by_policy';
  if (text.startsWith('⚠️')) return 'size_capped';
  if (text.startsWith('❌')) return 'failed';
  return 'success';
}

function withToolAnalytics<R extends ToolAnalyticsResult>(
  tool: string,
  fn: (params: unknown, extra: { authInfo?: AuthInfo }) => Promise<R> | R,
) {
  return async (params: unknown, extra: { authInfo?: AuthInfo }): Promise<R> => runWithToolCallProps(async () => {
    const started = Date.now();
    // Distinct id = the caller's Clerk user id, matching the dashboard's
    // identify() — MCP usage lands on the same PostHog person.
    // Event/property names follow PostHog's canonical MCP Analytics schema
    // ($mcp_tool_call / $mcp_tool_name / …) so its built-in MCP views resolve
    // the tool name; `outcome` and `client_id` are FGAC-specific extras, and
    // context props (account_email / account_delegated, set during account
    // resolution) ride along so delegation usage is attributable per call.
    const track = (outcome: string) => captureServerEvent(
      extra?.authInfo?.extra?.userId ?? 'anonymous-mcp',
      '$mcp_tool_call',
      {
        $mcp_tool_name: tool,
        $mcp_duration_ms: Date.now() - started,
        $mcp_is_error: outcome === 'error' || outcome === 'exception',
        client_id: extra?.authInfo?.clientId,
        user_agent: extra?.authInfo?.extra?.userAgent,
        outcome,
        ...getToolCallProps(),
      },
    );
    try {
      const result = await fn(params, extra);
      // Response-size observability (plan google-docs-support v5, D7):
      // MCP clients impose their own tool-result caps (Claude Code rejects
      // results over ~25k tokens), so a server-side "success" can still be
      // silently discarded client-side. Stamp the serialized size on EVERY
      // tool result — monitoring only, no size-based behavior — so PostHog
      // can chart how often responses land in the client-rejection zone.
      const responseChars = Array.isArray((result as { content?: unknown }).content)
        ? ((result as { content: Array<{ text?: unknown }> }).content)
            .reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0)
        : 0;
      addToolCallProps({
        response_chars: responseChars,
        response_kb: Math.round(responseChars / 1024),
      });
      track(classifyToolOutcome(result));
      return result;
    } catch (err) {
      track('exception');
      // Catch-all so no unhandled throw from any tool reaches the MCP SDK,
      // which turns `error.message` into the tool result verbatim. Every
      // library in this path — Drizzle, Clerk, jose, fetch — writes messages
      // for developers reading logs, not for an agent's transcript.
      return toolErrorResult(`Unhandled exception in ${tool}`, err) as unknown as R;
    }
  });
}

type ResolvedAccount = { targetEmail: string; token: string; proxyKeyId: string; hasGmailScope?: boolean; hasDriveFileScope?: boolean };
type ResolvedError = { error: string };

/**
 * Account/token resolution failures are the `outcome='failed'` class: they
 * return ❌ text via textResult, so they never reached Google and carry no
 * error_status. Which of the four branches fired was unrecoverable from
 * analytics.
 *
 * `failure_reason` is deliberately a SEPARATE property from `error_status`
 * (which means "Google returned this HTTP status" — these calls never got
 * that far), and these stay `textResult`, NOT `errorResult`. Note the ❌
 * `failed` class still counts in the Connector Directory's published error
 * rate (see errorResult's doc-comment) — that is correct for these: a
 * missing key or inaccessible account is a real malfunction of the
 * connection. The scope pre-flights below graduated to 🚫 refusals
 * (2026-09-03) because they are grant-state denials with a one-click fix,
 * not malfunctions.
 */
type ResolveFailureReason =
  | 'no_proxy_key'
  | 'no_accessible_accounts'
  | 'account_not_permitted'
  | 'google_token_unavailable'
  | 'delegation_inactive'
  | 'gmail_scope_missing';

function resolveFailure(reason: ResolveFailureReason, error: string): ResolvedError {
  addToolCallProps({ failure_reason: reason });
  return { error };
}

async function resolveAccountAndToken(
  conn: ConnectionApproved,
  account?: string,
): Promise<ResolvedAccount | ResolvedError> {
  if (!conn.proxyKeyId) {
    return resolveFailure('no_proxy_key', '❌ No proxy key assigned to this connection. Ask the user to update it in the dashboard.');
  }

  const emails = await getAccessibleEmails(conn.proxyKeyId);
  if (emails.length === 0) {
    return resolveFailure('no_accessible_accounts', '❌ No email accounts are accessible with this proxy key.');
  }

  const targetEmail = account || conn.user.email;
  const access = await checkEmailAccess(conn.proxyKeyId, targetEmail);
  if (!access) {
    const usable = emails.map(e => e.targetEmail).join(', ');
    if (account) {
      // The CALLER chose an account outside the key's scope. The key's account
      // list is user-configured policy, so this is a deterministic 🚫 refusal
      // with a stated fix, not a malfunction — one Claude-desktop scheduled job
      // hit the ❌ form of this every hour for four days (2026-09-05 → 09-08),
      // each hit counting in the published error rate, and the response never
      // said "drop the parameter". Stating the fix was not enough for THAT
      // caller: the job re-sends the same value every hour with a fresh
      // context (23 more hits 2026-09-09 → 09-11), so the text now also says
      // the task itself must change. The implicit case below (no account
      // given, owner's own address not on the key) stays ❌: nothing the
      // caller sent caused it — but it names what would work.
      addToolCallProps({ failure_reason: 'account_not_permitted', denial_code: 'account_not_permitted' });
      return { error: accountNotPermittedByCaller(targetEmail, usable) };
    }
    return resolveFailure('account_not_permitted', accountNotPermittedByDefault(targetEmail, usable));
  }

  // Delegation observability: record which account this call resolved to, so
  // the mcp_tool_call event can attribute usage across own vs delegated
  // mailboxes (one user may access several Gmail accounts).
  addToolCallProps({
    account_email: access.targetEmail,
    account_delegated: !!access.delegationId,
  });

  const googleToken = await getGoogleToken(targetEmail, conn.user);
  if ('failure' in googleToken) {
    // Class-specific text (src/lib/googleTokenFailure.ts): grant states that
    // cannot clear on their own are a 🚫 refusal with denial_code (the tool
    // working as designed — consistent with the scope pre-flights below);
    // transient Clerk trouble that survived the retry stays a ❌ failure
    // and says "retry once" BEFORE "reconnect", because in production that
    // class has been a race on a healthy account every time it was
    // inspected (2026-09-04). Delegated mailboxes are told WHO must open the
    // link: the reconnect link is bound to the owner and refuses anyone else.
    const guidance = tokenFailureGuidance({
      targetEmail,
      keyOwnerEmail: conn.user.email,
      reason: googleToken.failure,
      reconnectUrl: reconnectLink(targetEmail),
      retried: googleToken.retried,
    });
    if (guidance.denialCode) addToolCallProps({ denial_code: guidance.denialCode });
    return resolveFailure(
      googleToken.failure === 'delegation_inactive' ? 'delegation_inactive' : 'google_token_unavailable',
      guidance.text,
    );
  }

  return {
    targetEmail,
    token: googleToken.token,
    proxyKeyId: conn.proxyKeyId,
    hasGmailScope: googleToken.hasGmailScope,
    hasDriveFileScope: googleToken.hasDriveFileScope,
  };
}

/**
 * Pre-flight for Gmail surfaces only (sheets/docs/drive don't need the Gmail
 * scope): a token whose grant lacks the Gmail scope 403s on every Gmail call
 * until the account is reconnected, so calling Google is pointless and the
 * generic 403 text used to send agents into retry loops. Deterministic,
 * never-reached-Google, and carrying the exact remediation, so it is a 🚫
 * refusal (outcome `denied_by_policy`), not a ❌ failure: the published
 * error-rate math counts `failed` results as tool errors too (the directory's
 * 18.3% for google_api_modify, 7d to 2026-09-03, matches error+failed, not
 * error alone), and a grant-state refusal with a one-click fix is the tool
 * working as designed — the same class as an FGAC rule denial.
 * `failure_reason` stays stamped for pre-2026-09-03 query continuity;
 * `denial_code` carries the same string in the denial taxonomy.
 *
 * Two signals, same pattern as google_token_identity_fallback: the tool-call
 * properties attribute the denial to the call; the standalone event is
 * unsampled and independent of $mcp_tool_call, so `uniq(person)` over it is
 * exactly the locked-out population (docs/monitoring.md 7.6).
 */
function gmailScopeDenial(conn: ConnectionApproved, resolved: ResolvedAccount) {
  if (resolved.hasGmailScope !== false) return null;
  addToolCallProps({ failure_reason: 'gmail_scope_missing', denial_code: 'gmail_scope_missing', google_scope_missing: true });
  captureServerEvent(conn.user.clerkUserId, 'google_scope_missing', {
    via: 'mcp',
    scope: 'gmail',
    account_delegated: resolved.targetEmail.toLowerCase() !== conn.user.email.toLowerCase(),
  });
  return textResult(
    `🚫 Not available yet: the Google account '${resolved.targetEmail}' is connected WITHOUT Gmail permission — ` +
    `most likely the Gmail checkbox was left unchecked on Google's consent screen when connecting. ` +
    `STOP — every Gmail call on this account will fail until it is reconnected; retrying will NOT help. ` +
    `👉 Send the account owner this one-click link — it opens Google's consent screen directly; they must approve Gmail access there: ` +
    `${reconnectLink(resolved.targetEmail)} — then retry once after they confirm. ` +
    `Non-Gmail tools (sheets, docs) are unaffected.`,
  );
}

/**
 * Mirror of gmailScopeDenial for the drive.file scope, which every non-Gmail
 * surface (Sheets, Docs, Slides, Drive) rides. Accounts connected before
 * drive.file joined the grant — or with the Drive checkbox left unchecked on
 * Google's consent screen — 403 on every one of these calls (observed as the
 * 403s on POST v4/spreadsheets, 2026-08 production), and the upstream 403
 * body often carries no reason the agent can act on. Deterministic and
 * never-reached-Google, so it is a 🚫 refusal (outcome `denied_by_policy`),
 * not a ❌ failure — same rationale and property treatment as
 * gmailScopeDenial above. Applied by every typed per-file tool (sheets_*,
 * docs_*, comments_*) and by non-Gmail raw google_api_get/modify calls.
 */
function driveFileScopeDenial(conn: ConnectionApproved, resolved: ResolvedAccount) {
  if (resolved.hasDriveFileScope !== false) return null;
  addToolCallProps({ failure_reason: 'drive_file_scope_missing', denial_code: 'drive_file_scope_missing', google_scope_missing: true });
  captureServerEvent(conn.user.clerkUserId, 'google_scope_missing', {
    via: 'mcp',
    scope: 'drive_file',
    account_delegated: resolved.targetEmail.toLowerCase() !== conn.user.email.toLowerCase(),
  });
  return textResult(
    `🚫 Not available yet: the Google account '${resolved.targetEmail}' is connected WITHOUT the Google Drive file permission (drive.file) — ` +
    `most likely the owner signed in to FGAC with Google again since connecting (a plain sign-in resets the Drive permission), ` +
    `the account was connected before FGAC requested it, or the Drive checkbox was left unchecked on Google's consent screen. ` +
    `Every Sheets, Docs, Slides, and Drive call on this account will fail until it is reconnected; retrying will NOT help. ` +
    `👉 Send the account owner this one-click link — it opens Google's consent screen directly; they must approve Drive file access there: ` +
    `${reconnectLink(resolved.targetEmail)} — then retry once after they confirm. ` +
    `Gmail tools are unaffected.`,
  );
}

// ─── Raw Google API Execution ───────────────────────────────────────────────

function serializeBody(body?: string | Record<string, unknown>): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * Classify a raw call and stamp its observability props. Called from the tool
 * handlers BEFORE account resolution, so resolution failures (and
 * unsupported-family denials, which need no account at all) still carry
 * raw_api_endpoint/raw_api_family — until 2026-08 those events landed with
 * null endpoint/family and were unattributable. Raw calls are the
 * highest-volume tool surface, and the classifier already knows the product —
 * stamp it on every call (denials included) so analytics can break raw usage
 * down by Google product and id-stripped endpoint, not just "google_api_get".
 */
function classifyAndStampRawCall(path: string, method: string): RawCallClass {
  const cls = classifyGoogleApiCall(path, method);
  const family = rawApiFamily(cls);
  addToolCallProps({
    raw_api_kind: cls.kind,
    raw_api_endpoint: `${method} ${templateGoogleApiPath(path)}`,
    raw_api_mutating: method !== 'GET',
    ...(family ? { raw_api_family: family } : {}),
  });
  if (cls.kind === 'denied') addToolCallProps({ denial_code: cls.code });
  // Support correlation: the id-stripped template above says WHAT was read,
  // never WHICH message — a reporter's message id could not be matched to
  // its calls (2026-09-03 case). Hash it the same way gmail_read does.
  const resourceId = path.match(/\/(?:messages|threads|drafts)\/([^/?#]+)/)?.[1];
  if (resourceId && !['send', 'import', 'batchModify', 'batchDelete'].includes(resourceId)) {
    addToolCallProps({ resource_id_hash: resourceIdHash(resourceId) });
  }
  return cls;
}

/**
 * Passthrough failures ride Google's own enforcement, and under drive.file a
 * 404 is ambiguous in a way agents cannot know: files the user never exposed
 * to FGAC (and this agent didn't create) are simply invisible and 404
 * identically to a wrong id. The bare "check the ID" framing sent agents into
 * retry loops on ids that were never going to appear (observed on
 * drive/v3/files/{id}/permissions and PATCH drive/v3/files/{id}, 2026-08
 * production); say what the 404 can and cannot prove, and where the fix is.
 *
 * When the path is id-addressed (its analytics template carries an `{id}`),
 * that 404 is the per-file-grant refusal class and answers as 🚫
 * `denied_by_policy` with the user-side fix, same as fileGrantErrorResult
 * (observed: POST drive/v3/files/{id}/copy, 2026-09 production). A 404 on a
 * path WITHOUT an id has no grant to fix — it is a wrong path spelling or a
 * Google routing miss — and stays a genuine error so real breakage (like the
 * pre-2026-08-29 Slides misrouting) keeps showing up in error rates.
 */
function passthroughErrorResult(result: { error: string; status?: number }, path: string) {
  if (result.status !== 404) return errorResult(result.error);
  const explanation =
    `${result.error} ` +
    `NOTE: FGAC's Google grant is per-file (drive.file) — files the user never exposed to FGAC and this agent did not create are INVISIBLE to this token, ` +
    `and Google reports them with this exact 404 even though they exist. A wrong id looks identical, so do NOT retry the same id. ` +
    `If this id is a Google Sheet or Doc, call request_access with the spreadsheetId/documentId to send the user a one-click approval link; ` +
    `for other Drive files, ask the user to expose the file via the FGAC dashboard, or create the file through FGAC so it is granted automatically.`;
  if (!templateGoogleApiPath(path).includes('{id}')) return errorResult(explanation);
  addToolCallProps({ denial_code: 'file_grant_missing_at_google' });
  // The refusal must not carry the upstream ❌ prefix inside it — 🚫 is the
  // outcome marker (classifyToolOutcome reads the first characters).
  return textResult(`🚫 Not available yet: ${explanation.replace(/^❌\s*/, '')}`);
}

/**
 * Shared executor for google_api_get / google_api_modify. `cls` comes from
 * classifyAndStampRawCall in the tool handler; classification is
 * allow-by-default (see googleApiPolicy.ts — sends ride the recipient
 * whitelist, Google's OAuth scopes backstop the rest) and every enforced
 * family maps onto the same FGAC enforcement the dedicated tools use.
 */
async function executeRawGoogleCall(
  conn: ConnectionApproved,
  resolved: ResolvedAccount,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  cls: RawCallClass,
  body?: string | Record<string, unknown>,
) {
  const family = rawApiFamily(cls);
  if (cls.kind === 'denied') {
    // Handlers short-circuit denials before account resolution; kept here so
    // the executor stays total over RawCallClass.
    return textResult(cls.reason);
  }

  // Scope pre-flight, mirroring the dedicated tools: gmail/* needs the Gmail
  // scope; every other family rides drive.file. A token that provably lacks
  // the scope fails deterministically at Google, so calling it is pointless —
  // and its 403 body often gives the agent nothing to act on.
  if (family === 'gmail') {
    const scopeDenial = gmailScopeDenial(conn, resolved);
    if (scopeDenial) return scopeDenial;
  } else {
    const scopeDenial = driveFileScopeDenial(conn, resolved);
    if (scopeDenial) return scopeDenial;
  }

  const cleanPath = path.replace(/^\/+/, '');
  // Route a raw path to the host that owns its API family. Sheets, Docs,
  // Slides, and Forms live on their own subdomains (www.googleapis.com does
  // NOT serve the latter two — routing them there returned bare 404s that
  // read as missing resources); everything else rides www.googleapis.com.
  const rawUrl = (p: string) =>
    p.includes('spreadsheets') ? `https://sheets.googleapis.com/${p.replace(/^sheets\//, '')}`
    : p.includes('documents') ? `https://docs.googleapis.com/${p.replace(/^docs\//, '')}`
    : p.includes('presentations') ? `https://slides.googleapis.com/${p.replace(/^slides\//, '')}`
    : /(^|\/)forms(\/|$)/.test(p) ? `https://forms.googleapis.com/${p.replace(/^forms\//, '')}`
    : `https://www.googleapis.com/${p}`;

  if (cls.kind === 'sheets_create') {
    // Agent-created sheets are allowed and auto-granted to the calling key
    // (read & write): the Sheets policy protects the user's EXISTING sheets,
    // not the agent's own output. The drive.file scope already limits the app
    // to picked files + files it created, so no new Google-side exposure.
    const url = `https://sheets.googleapis.com/${cleanPath.replace(/^sheets\//, '')}`;
    const result = await googleFetch(url, resolved.token, method, serializeBody(body), resolved.targetEmail);
    if (!result.ok) return errorResult(result.error);
    const created = result.data as { spreadsheetId?: unknown; properties?: { title?: unknown } };
    const newId = typeof created?.spreadsheetId === 'string' ? created.spreadsheetId : null;
    if (newId) {
      const title = typeof created?.properties?.title === 'string' ? created.properties.title : null;
      try {
        const [rule] = await db.insert(accessRules).values({
          userId: conn.user.id,
          ruleName: `Agent-created: ${title || newId}`,
          service: 'sheets',
          actionType: 'sheet_read_write',
          targetResourceId: newId,
          resourceName: title,
        }).returning();
        await db.insert(keyRuleAssignments).values({ proxyKeyId: resolved.proxyKeyId, accessRuleId: rule.id });
        captureServerEvent(conn.user.clerkUserId, 'agent_sheet_created', {
          spreadsheet_id: newId, auto_granted: true,
        });
        addToolCallProps({ sheet_created: true });
      } catch (err) {
        // The sheet exists either way; a failed auto-grant just means the next
        // access denies and mints an approval link — degraded, not broken.
        console.error('[MCP] Failed to auto-grant agent-created sheet:', err);
        captureServerEvent(conn.user.clerkUserId, 'agent_sheet_created', {
          spreadsheet_id: newId, auto_granted: false,
        });
      }
    }
    return jsonResult(result.data);
  }

  if (cls.kind === 'docs_create') {
    // Agent-created docs are allowed and auto-granted to the calling key
    // (read & write), mirroring sheets_create: the Docs policy protects the
    // user's EXISTING documents, not the agent's own output. drive.file
    // already limits the app to picked files + files it created.
    const result = await googleFetch(rawUrl(cleanPath), resolved.token, method, serializeBody(body), resolved.targetEmail);
    if (!result.ok) return errorResult(result.error);
    const created = result.data as { documentId?: unknown; title?: unknown };
    const newId = typeof created?.documentId === 'string' ? created.documentId : null;
    if (newId) {
      const title = typeof created?.title === 'string' ? created.title : null;
      try {
        const [rule] = await db.insert(accessRules).values({
          userId: conn.user.id,
          ruleName: `Agent-created: ${title || newId}`,
          service: 'docs',
          actionType: 'doc_read_write',
          targetResourceId: newId,
          resourceName: title,
        }).returning();
        await db.insert(keyRuleAssignments).values({ proxyKeyId: resolved.proxyKeyId, accessRuleId: rule.id });
        captureServerEvent(conn.user.clerkUserId, 'agent_doc_created', {
          document_id: newId, auto_granted: true,
        });
        addToolCallProps({ doc_created: true });
      } catch (err) {
        // The doc exists either way; a failed auto-grant just means the next
        // access denies and mints an approval link — degraded, not broken.
        console.error('[MCP] Failed to auto-grant agent-created doc:', err);
        captureServerEvent(conn.user.clerkUserId, 'agent_doc_created', {
          document_id: newId, auto_granted: false,
        });
      }
    }
    return jsonResult(result.data);
  }

  if (cls.kind === 'file_comments') {
    // Comments are content on the file: they inherit the file's per-file
    // rule (comment writes need Read & Write) instead of scope-only
    // passthrough. Same enforcement as the comments_read / comments_add
    // typed tools.
    const fid = resolveDriveFileId('file', cls.fileId);
    if ('denial' in fid) return fid.denial;
    const check = await checkCommentsPermission(conn, resolved.proxyKeyId, cls.fileId, cls.isMutating);
    if ('denial' in check) return check.denial;
    const result = await withGrantGrace(check.kind, check.perm, () => googleFetch(rawUrl(cleanPath), resolved.token, method, serializeBody(body), resolved.targetEmail));
    if (!result.ok) {
      // A raw reply path addresses a specific comment; its 404 needs the
      // stale-commentId branch, same as comments_add with commentId.
      const commentId = cleanPath.match(/\/comments\/([^/?#]+)/)?.[1];
      return commentsErrorResult(check.kind, result, cls.fileId, commentId && decodeURIComponent(commentId));
    }
    return jsonResult(result.data);
  }

  if (cls.kind === 'passthrough') {
    // Classify-don't-block: unknown Google API families are forwarded with
    // the account's token (Google's scopes are the enforcement backstop) and
    // flagged so demand is visible in analytics before we build rules for it
    // (family/kind/endpoint were already stamped at classification above).
    addToolCallProps({ raw_api_passthrough: true });
    const result = await googleFetch(rawUrl(cleanPath), resolved.token, method, serializeBody(body), resolved.targetEmail);
    if (!result.ok) return passthroughErrorResult(result, cleanPath);
    return jsonResult(result.data);
  }

  if (cls.kind === 'sheets') {
    const sid = resolveDriveFileId('sheet', cls.spreadsheetId);
    if ('denial' in sid) return sid.denial;
    const perm = await checkSheetsPermission(conn.user.id, resolved.proxyKeyId, cls.spreadsheetId, cls.isMutating);
    if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, sheetsDenialAction(perm, cls.spreadsheetId, cls.isMutating));

    const result = await withSheetsGrace(perm, () => googleFetch(rawUrl(cleanPath), resolved.token, method, serializeBody(body), resolved.targetEmail));
    if (!result.ok) return sheetsErrorResult(result, cls.spreadsheetId);
    return jsonResult(result.data);
  }

  if (cls.kind === 'docs') {
    const did = resolveDriveFileId('doc', cls.documentId);
    if ('denial' in did) return did.denial;
    const perm = await checkDocsPermission(conn.user.id, resolved.proxyKeyId, cls.documentId, cls.isMutating);
    if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, docsDenialAction(perm, cls.documentId, cls.isMutating));

    const result = await withDocsGrace(perm, () => googleFetch(rawUrl(cleanPath), resolved.token, method, serializeBody(body), resolved.targetEmail));
    if (!result.ok) return docsErrorResult(result, cls.documentId);
    return jsonResult(result.data);
  }

  const rules = await loadApplicableRules(conn.user.id, resolved.proxyKeyId, resolved.targetEmail);

  if (cls.kind === 'gmail_send') {
    const denial = checkSendWhitelist(rules, extractSendRecipients(body));
    if (denial) return sendDenialWithLinks(conn, resolved.proxyKeyId, denial);
  }

  if (cls.kind === 'gmail_draft_send') {
    // drafts/send delivers mail, so it rides the same recipient whitelist as
    // messages/send — but the recipients live in the STORED draft, not the
    // request body. Resolve them server-side: fetch the draft (format=raw)
    // and parse To/Cc/Bcc out of it, unioned with any inline message.raw the
    // body carries (drafts.send can update the draft while sending). Every
    // address from either source must be whitelisted; anything unresolvable
    // denies — never forward blind.
    // Resolution failures deny WITHOUT approval links: the fix is the draft
    // or its id, not a whitelist grant — a "send to anyone" link here would
    // point the user at the wrong remedy. Whitelist violations below still
    // mint links via sendDenialWithLinks.
    const draftDenial = (detail: string) => {
      addToolCallProps({ denial_code: 'recipients_undetermined' });
      return textResult(`🚫 ${detail} Nothing was sent — drafts/send is denied whenever the draft's recipients cannot be determined and verified against the send whitelist.`);
    };
    const { draftId, bodyRecipients } = extractDraftSendInfo(body);
    if (!draftId) {
      return draftDenial('Could not determine which draft to send. Provide the draft id in the body: {"id": "<draftId>"}.');
    }
    // Query-stripped: the caller's path may carry ?alt=json etc., which would
    // otherwise leave `/send` in place and fetch the wrong URL.
    const draftPath = cleanPath.split(/[?#]/)[0].replace(/\/send$/i, `/${encodeURIComponent(draftId)}`) + '?format=raw';
    const draftResult = await googleFetch(`https://www.googleapis.com/${draftPath}`, resolved.token, 'GET', undefined, resolved.targetEmail);
    if (!draftResult.ok) {
      // A bogus id surfaced Google's bare 404 here before (QA finding,
      // 2026-08-30), which read as "the send endpoint 404ed" — say what was
      // actually being fetched and that the send was refused.
      return draftDenial(`The draft could not be fetched to verify its recipients (${draftResult.error}). Confirm the draft id via google_api_get gmail/v1/users/me/drafts and retry.`);
    }
    const draftRaw = (draftResult.data as { message?: { raw?: unknown } })?.message?.raw;
    const draftRecipients = typeof draftRaw === 'string' ? extractSendRecipients({ raw: draftRaw }) : null;
    const recipients = [...new Set([...(draftRecipients ?? []), ...(bodyRecipients ?? [])])];
    if (recipients.length === 0) {
      return draftDenial('The draft has no parseable To/Cc/Bcc recipients. Update the draft with standard recipient headers, then retry drafts/send.');
    }
    const denial = checkSendWhitelist(rules, recipients);
    if (denial) return sendDenialWithLinks(conn, resolved.proxyKeyId, denial);
  }

  const url = `https://www.googleapis.com/${cleanPath}`;
  const result = await googleFetch(url, resolved.token, method, serializeBody(body), resolved.targetEmail);
  if (!result.ok) return errorResult(result.error);

  if (cls.kind === 'gmail_read') {
    const restriction = checkReadRestrictions(rules, result.data);
    if (restriction) {
      captureServerEvent(conn.user.clerkUserId, 'read_restriction_enforced', { via: 'google_api_get', restriction });
      return textResult(restriction);
    }
  }

  return jsonResult(result.data);
}

// ─── MCP Handler ────────────────────────────────────────────────────────────

function toolConfig<S extends z.ZodRawShape>(def: FgacToolDef, inputSchema: S) {
  return {
    title: def.title,
    description: def.description,
    inputSchema,
    annotations: toolAnnotations(def),
  };
}

const handler = createMcpHandler(
  (server) => {
    // Every registered tool is wrapped with a PostHog `$mcp_tool_call` capture.
    // Patching registerTool here keeps the registrations below untouched (their
    // schema-inferred param types intact) and instruments future tools too.
    const rawRegisterTool = server.registerTool.bind(server) as (
      name: string, config: unknown, cb: unknown,
    ) => ReturnType<typeof server.registerTool>;
    server.registerTool = ((name: string, config: unknown, cb: unknown) =>
      rawRegisterTool(name, config, withToolAnalytics(name, cb as Parameters<typeof withToolAnalytics>[1]))
    ) as unknown as typeof server.registerTool;

    // ── list_accounts ─────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.list_accounts.name,
      toolConfig(TOOL_DEFS.list_accounts, {}),
      async (_params, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;
        if (!conn.proxyKeyId) {
          return textResult('❌ No proxy key assigned.');
        }
        const emails = await getAccessibleEmails(conn.proxyKeyId);

        // Per-account Google scope state, so the agent can see a
        // missing-scope account BEFORE its first failing call. Three-state:
        // Clerk not reporting scope metadata is 'unknown', never coerced to
        // missing (same convention the scope denials enforce). Probes are
        // quiet (no PostHog captures — see getGoogleToken) and individually
        // time-bounded: this is the first tool most agents call, and N
        // accounts riding the full 15 s Clerk timeout each is unacceptable.
        const scopeState = (has: boolean | undefined) =>
          has === undefined ? 'unknown' : has ? 'granted' : 'missing';
        const probes = await Promise.allSettled(
          emails.map(e => withTimeout(
            getGoogleToken(e.targetEmail, conn.user, { quiet: true }),
            LIST_ACCOUNTS_SCOPE_PROBE_TIMEOUT_MS,
          )),
        );
        const accountDetails = emails.map((e, i) => {
          const probe = probes[i];
          const settled = probe.status === 'fulfilled' ? probe.value : null;
          const token = settled && !('failure' in settled) ? settled : null;
          const failure = settled && 'failure' in settled ? settled.failure : null;
          const gmail = token ? scopeState(token.hasGmailScope) : 'unknown';
          const driveFile = token ? scopeState(token.hasDriveFileScope) : 'unknown';
          // A definitive scope miss — or a token failure a reconnect
          // actually repairs (no grant, cannot refresh) — gets the bound
          // reconnect link. A timed-out probe, a transient Clerk error, a
          // missing owner account, or an inactive delegation stays
          // link-free: none of those is fixed by reconnecting, and a false
          // link here sends the agent (and the user) to repair a grant that
          // is fine or does not exist.
          const needsReconnect = (failure !== null && reconnectRepairs(failure))
            || gmail === 'missing' || driveFile === 'missing';
          return {
            email: e.targetEmail,
            delegated: !!e.delegationId,
            google_token: failure ? 'unavailable' : token ? 'ok' : 'unknown',
            ...(failure ? { google_token_failure: failure } : {}),
            gmail,
            drive_file: driveFile,
            ...(needsReconnect ? {
              reconnect_url: reconnectLink(e.targetEmail),
              // The link is bound to the mailbox owner and refuses anyone
              // else — for a delegated mailbox the key owner cannot use it.
              reconnect_by: e.delegationId
                ? `the owner of '${e.targetEmail}' (not this user) — they must open reconnect_url while signed in to FGAC as that account`
                : 'this user',
            } : {}),
          };
        });
        const driveMissing = accountDetails.find(d => d.drive_file === 'missing');
        // A dead grant that a reconnect repairs gets a top-level nudge, not
        // just a per-entry field: list_accounts is the agent's first call,
        // and on 2026-09-08/09 the affected agents called it right after
        // their first failure and got `google_token: 'unavailable'` with no
        // instruction — then kept retrying (14 identical Sheets failures).
        const tokenBroken = accountDetails.find(d => d.google_token === 'unavailable' && d.reconnect_url);

        // Onboarding nudge: list_accounts is most new users' first (and for
        // many, only) call — 2026-08 launch analytics showed a large cohort
        // stopping right here. Tell the agent what a useful next step is and
        // how more mailboxes get added, so the dead end becomes a path.
        return jsonResult({
          accounts: emails.map(e => e.targetEmail),
          account_details: accountDetails,
          default: conn.user.email,
          nickname: conn.nickname,
          next_steps: {
            ...(tokenBroken ? {
              reconnect: `'${tokenBroken.email}' has no working Google grant (${tokenBroken.google_token_failure}) — EVERY call on it will fail until it is reconnected, so do not retry. Give the user this one-click link, to be opened by ${tokenBroken.reconnect_by}: ${tokenBroken.reconnect_url}`,
            } : {}),
            gmail: "Read a mailbox with gmail_list (pass account: '<address>' to target a specific one; defaults to the primary). Reads work out of the box.",
            sheets: driveMissing
              ? `'${driveMissing.email}' is connected WITHOUT the drive.file scope — every Sheets call on it will fail until the account owner reconnects: ${driveMissing.reconnect_url}`
              : 'Spreadsheet access is granted per sheet: call sheets_get_spreadsheet with a spreadsheetId, or request_access — a denial returns a one-click approval link for the user.',
            docs: driveMissing
              ? `'${driveMissing.email}' is connected WITHOUT the drive.file scope — every Docs call on it will fail until the account owner reconnects: ${driveMissing.reconnect_url}`
              : 'Google Docs access is granted per document: call docs_read_document with a documentId, or request_access — a denial returns a one-click approval link for the user.',
            sending: 'Email sending is off by default; the first gmail_send returns a one-click approval link the user can use to whitelist the recipient.',
            raw_api: "Anything the typed tools can't express — Gmail mailbox writes (labels, drafts, archive/mark-read, trash) and threads, Drive listing and export, creating new docs, sheets, or slides — is reachable via google_api_get / google_api_modify under the same rules (see their descriptions). The Google grant covers ONLY Gmail plus per-file Drive access (Sheets/Docs/Slides/Drive files the user picked or this agent created); People/Contacts, Calendar, Tasks, and other Google APIs are not available and calls to them are refused.",
          },
          add_more_accounts: {
            // Every extra mailbox — the user's own second account included —
            // arrives via delegation from its own FGAC signup. There is no
            // in-dashboard "link a second Google account" flow; describing
            // one here sent users hunting for it (support case 2026-08-24).
            own_account: `To add another Gmail account the user owns: sign in to ${DASHBOARD_URL} AS that account (e.g. in another browser profile), then on its Accounts page use "Delegations You've Granted" to delegate that mailbox to this user's email. It then appears here automatically. Walkthrough: ${DASHBOARD_URL}/use-cases/multiple-gmail-accounts`,
            someone_elses: `To access someone else's mailbox: that person signs up at ${DASHBOARD_URL} and uses "Delegations You've Granted" on their own Accounts page to delegate their mailbox to this user. It then appears here automatically.`,
          },
        });
      }
    );

    // ── gmail_list ────────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.gmail_list.name,
      toolConfig(TOOL_DEFS.gmail_list, {
        account: z.string().optional().describe('Email account to use. Defaults to primary.'),
        query: z.string().optional().describe('Gmail search query (e.g., "is:unread")'),
        max: z.number().optional().describe('Max results (default: 10)'),
      }),
      async ({ account, query, max }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = gmailScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const params = new URLSearchParams();
        if (query) params.set('q', query);
        params.set('maxResults', String(max || 10));

        const result = await gmailFetch(resolved.token, resolved.targetEmail, `messages?${params}`);
        if (!result.ok) return errorResult(result.error);
        return jsonResult(result.data);
      }
    );

    // ── gmail_read ────────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.gmail_read.name,
      toolConfig(TOOL_DEFS.gmail_read, {
        account: z.string().optional().describe('Email account to use.'),
        messageId: z.string().describe('Gmail message ID'),
        format: z.enum(['full', 'metadata', 'minimal']).optional().describe('Response format. "full" (default) returns parsed headers, body text, and attachment metadata.'),
        offset: z.number().int().min(0).optional().describe('Start position (chars into the serialized response, body UNtruncated) for a windowed read of a long message. Use the next_offset from the previous response to continue; start at 0.'),
        limit: z.number().int().min(1).optional().describe('Max chars to return in this response (server caps at 200000). Size this to YOUR tool-result budget. Passing offset or limit switches to the windowed envelope.'),
      }),
      async ({ account, messageId, format, offset, limit }, { authInfo }) => {
        // Request fingerprint, stamped before any check can short-circuit:
        // which message (hashed — see resourceIdHash), which format, whether
        // the caller windowed. Without these a reporter's "format=full fails
        // on message X" could not be matched to its events (2026-09-03 case).
        addToolCallProps({
          message_id_hash: resourceIdHash(messageId),
          format: format ?? 'full',
          windowed: offset !== undefined || limit !== undefined,
        });
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = gmailScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        // Read-time enforcement: label blacklist/whitelist + content blacklist
        const rules = await loadApplicableRules(conn.user.id, resolved.proxyKeyId, resolved.targetEmail);
        const result = await gmailFetch(resolved.token, resolved.targetEmail, `messages/${messageId}?format=${format || 'full'}`);
        if (!result.ok) return gmailNotFoundResult('message', result, messageId);

        const restriction = checkReadRestrictions(rules, result.data);
        if (restriction) {
          captureServerEvent(conn.user.clerkUserId, 'read_restriction_enforced', { via: 'gmail_read', restriction });
          return textResult(restriction);
        }

        // Rules were evaluated on the complete payload; the response is the
        // parsed, token-frugal view unless a lighter format was requested.
        // Windowed reads (offset/limit) serialize the parsed view with the
        // body UNtruncated — the 20k inline truncation exists to protect the
        // default response, and a caller windowing explicitly has taken
        // charge of its own budget.
        const parsed = (!format || format === 'full');
        if (offset !== undefined || limit !== undefined) {
          const payload = JSON.stringify(parsed
            ? parseGmailMessage(result.data as Record<string, unknown>, { fullBody: true })
            : result.data);
          return windowedResult(payload, offset, limit, { messageId });
        }
        if (parsed) {
          return jsonResult(parseGmailMessage(result.data as Record<string, unknown>));
        }
        return jsonResult(result.data);
      }
    );

    // ── gmail_get_attachment ──────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.gmail_get_attachment.name,
      toolConfig(TOOL_DEFS.gmail_get_attachment, {
        messageId: z.string().describe('Gmail message ID containing the attachment'),
        attachmentId: z.string().optional().describe('Attachment ID, taken from the `attachments` array of a gmail_read on THIS messageId. Ids are message-scoped and are re-issued when the message is re-indexed; a stale id is healed automatically when the message has exactly one attachment. Prefer `filename` when you know it — filenames never go stale.'),
        filename: z.string().optional().describe('Attachment filename as shown in gmail_read `attachments` (case-insensitive), as an alternative to attachmentId. If several attachments share the name, the error lists them so you can pick one by attachmentId.'),
        account: z.string().optional().describe('Email account to use.'),
        offset: z.number().int().min(0).optional().describe('Start position (chars into the base64url data) for a windowed read of a large attachment. Use the next_offset from the previous response to continue; start at 0.'),
        limit: z.number().int().min(1).optional().describe('Max chars of base64url data to return in this response (server caps at 200000). Size this to YOUR tool-result budget. Passing offset or limit switches to the windowed envelope.'),
      }),
      async ({ messageId, attachmentId, filename, account, offset, limit }, { authInfo }) => {
        addToolCallProps({
          message_id_hash: resourceIdHash(messageId),
          windowed: offset !== undefined || limit !== undefined,
        });
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        if (!attachmentId && !filename) {
          return errorResult('❌ Provide either attachmentId or filename to identify the attachment.');
        }

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = gmailScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        // Read-time enforcement on the parent message (labels + content rules):
        // an attachment is only as readable as the email that carries it
        const rules = await loadApplicableRules(conn.user.id, resolved.proxyKeyId, resolved.targetEmail);
        const parentResult = await gmailFetch(resolved.token, resolved.targetEmail, `messages/${messageId}?format=full`);
        if (!parentResult.ok) return gmailNotFoundResult('message', parentResult, messageId);

        const restriction = checkReadRestrictions(rules, parentResult.data);
        if (restriction) {
          captureServerEvent(conn.user.clerkUserId, 'read_restriction_enforced', { via: 'gmail_get_attachment', restriction });
          return textResult(restriction);
        }

        // The parent read above is FRESH, so its attachment ids are the ones
        // Gmail currently honours — the list both selector paths resolve
        // against, and the authority the 404 self-heal below retries from.
        // (Attachment ids are ephemeral: Gmail re-issues them on re-index,
        // which is why an id cached from an earlier gmail_read can 404 while
        // the message stays valid — the dominant failure of this tool per the
        // 2026-08 directory metrics.)
        const freshAttachments = parseGmailMessage(parentResult.data as Record<string, unknown>).attachments;
        const listFresh = () => freshAttachments
          .map(a => `- '${a.filename}' (${a.mimeType || 'unknown type'}, ~${Math.round((a.sizeBytes || 0) / 1024)} KB, attachmentId: ${a.attachmentId})`)
          .join('\n');

        let targetId: string;
        if (attachmentId) {
          addToolCallProps({ attachment_selector: 'id' });
          targetId = attachmentId;
        } else {
          addToolCallProps({ attachment_selector: 'filename' });
          const wanted = (filename as string).toLowerCase();
          const matches = freshAttachments.filter(a => a.filename.toLowerCase() === wanted);
          if (matches.length === 0) {
            return errorResult(freshAttachments.length === 0
              ? `❌ Message '${messageId}' has no attachments.`
              : `❌ No attachment named '${filename}' on message '${messageId}'. It currently has:\n${listFresh()}\nRetry ONCE with one of these filenames or attachmentIds; if none is the one you need, it is not on this message.`);
          }
          if (matches.length > 1) {
            return errorResult(
              `❌ ${matches.length} attachments on message '${messageId}' are named '${filename}':\n${listFresh()}\n` +
              `Retry ONCE with the attachmentId of the one you need.`);
          }
          targetId = matches[0].attachmentId;
        }

        // Declared size from the parent's MIME metadata, stamped BEFORE the
        // attachment fetch: if that fetch fails, the event still says how big
        // the attachment was, so error rows are attributable to size vs
        // genuine upstream failure. (attachment_kb below is the measured
        // truth when the fetch succeeds and overwrites nothing — different
        // property name on purpose.)
        const declaredSize = (function findDeclared(part?: { body?: { attachmentId?: string; size?: number }; parts?: unknown[] }): number | undefined {
          if (!part) return undefined;
          if (part.body?.attachmentId === targetId) return part.body.size;
          for (const child of (part.parts as typeof part[] | undefined) ?? []) {
            const found = findDeclared(child);
            if (found !== undefined) return found;
          }
          return undefined;
        })((parentResult.data as { payload?: { body?: { attachmentId?: string; size?: number }; parts?: unknown[] } }).payload);
        if (declaredSize !== undefined) {
          addToolCallProps({ attachment_declared_kb: Math.round(declaredSize / 1024) });
        }

        let attachmentResult = await gmailFetch(
          resolved.token,
          resolved.targetEmail,
          `messages/${messageId}/attachments/${targetId}`
        );
        // Reaching here means the parent read succeeded, so a failure now is
        // provably the attachmentId, not the messageId. Google's split
        // (measured 2026-08-28 against production): a well-formed token it has
        // invalidated (message re-indexed) → 404; a malformed/truncated token
        // → 400 "Invalid attachment token". Both mean "this id will never
        // work, the message is fine", and the recovery is identical — so when
        // the caller supplied the id themselves, heal it server-side instead
        // of erroring: the fresh parent already says which ids are current.
        if (!attachmentResult.ok && (attachmentResult.status === 404 || attachmentResult.status === 400) && attachmentId) {
          const suppliedIdIsCurrent = freshAttachments.some(a => a.attachmentId === attachmentId);
          if (freshAttachments.length === 0) {
            addToolCallProps({ attachment_selfheal: 'no_attachments' });
            return errorResult(
              `❌ Message '${messageId}' has no attachments (${attachmentResult.status}). The attachmentId may belong to a different message — ` +
              `STOP retrying this pair and re-check which message carries the attachment via gmail_read.`);
          }
          if (!suppliedIdIsCurrent && freshAttachments.length === 1) {
            // The heal has just identified the attachment the caller meant
            // (the message's only one), so its declared size is knowable now
            // even though the supplied id missed the findDeclared lookup
            // above — stamp it so retry_failed rows are size-attributable.
            // (QA 16 A8: this was the only reachable fetch-failure branch
            // with an identifiable target and it stamped nothing.)
            if (freshAttachments[0].sizeBytes) {
              addToolCallProps({ attachment_declared_kb: Math.round(freshAttachments[0].sizeBytes / 1024) });
            }
            const retry = await gmailFetch(
              resolved.token,
              resolved.targetEmail,
              `messages/${messageId}/attachments/${freshAttachments[0].attachmentId}`
            );
            if (retry.ok) {
              // Transparent recovery: the caller's id was stale, the message
              // has exactly one attachment, so the fresh id is unambiguously
              // the one they meant. Counts as a success, not an error — so
              // the failed first attempt's status/reason must not ride on
              // the success event (same rule as the sheets grace retry).
              addToolCallProps({
                attachment_selfheal: 'recovered',
                error_status: undefined, error_reason: undefined, error_domain: undefined,
              });
              attachmentResult = retry;
            } else {
              addToolCallProps({ attachment_selfheal: 'retry_failed' });
            }
          } else if (!suppliedIdIsCurrent) {
            addToolCallProps({ attachment_selfheal: 'ambiguous' });
            return errorResult(
              `❌ Gmail rejected that attachmentId (${attachmentResult.status}) — it is stale or invalid; Gmail re-issues ids when a message is re-indexed. Message '${messageId}' currently has:\n${listFresh()}\n` +
              `Retry ONCE with the matching attachmentId above (or call again with the filename parameter instead). ` +
              `Do NOT retry the old id — it is guaranteed to fail again.`);
          }
          // suppliedIdIsCurrent but Google still 404s: not a staleness case —
          // fall through to the generic per-site text.
        }
        if (!attachmentResult.ok) return gmailNotFoundResult('attachment', attachmentResult, messageId);

        const attachment = attachmentResult.data as { size?: number; data?: string };
        // Size on EVERY outcome (port of 5aa23bd): the generic response_chars
        // only sees the short ⚠️ message on over-cap failures, so the true
        // attachment size must be stamped before the cap check or analytics
        // can't tell a 200 KB refusal from a 2 MB one.
        const attachmentChars = attachment.data?.length ?? 0;
        const approxKb = Math.round((attachmentChars * 3) / 4 / 1024);
        addToolCallProps({ attachment_chars: attachmentChars, attachment_kb: approxKb });

        // Large-attachment windowing (plan gmail-attachment-pagination_v3):
        // Gmail's attachments.get has no partial fetch (path params only), so
        // each windowed call re-downloads the full body server-side — fine at
        // observed volume. The caller sizes windows to its own tool-result
        // budget via offset/limit; windows are substrings of the base64url
        // data, so the agent concatenates them in order and decodes ONCE.
        const wantsWindow = offset !== undefined || limit !== undefined;
        const data = attachment.data ?? '';

        if (!wantsWindow) {
          if (attachmentChars > MAX_ATTACHMENT_CHARS) {
            return textResult(
              `⚠️ Attachment is ~${approxKb} KB, which exceeds the ~150 KB limit for a single MCP response. ` +
              `Retrieve it in windows: call again with offset: 0 and a limit sized to your tool-result budget (chars of base64url data, max 200000). ` +
              `Each response reports total_chars and next_offset — concatenate the data strings in offset order, then base64url-decode the result once. ` +
              `Or ask the user to retrieve it directly from Gmail.`);
          }
          return jsonResult(attachment);
        }

        return windowedResult(data, offset, limit, { size: attachment.size }, 'base64url');
      }
    );

    // ── gmail_send ────────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.gmail_send.name,
      toolConfig(TOOL_DEFS.gmail_send, {
        account: z.string().optional().describe('Email account to send from.'),
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject line'),
        body: z.string().describe('Email body (plain text)'),
      }),
      async ({ account, to, subject, body }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = gmailScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        // Enforce send whitelist
        const rules = await loadApplicableRules(conn.user.id, resolved.proxyKeyId, resolved.targetEmail);
        const denial = checkSendWhitelist(rules, [to]);
        if (denial) return sendDenialWithLinks(conn, resolved.proxyKeyId, denial);

        // Build RFC 2822 message
        const raw = Buffer.from(
          `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
        ).toString('base64url');

        const result = await gmailFetch(resolved.token, resolved.targetEmail, 'messages/send', 'POST', JSON.stringify({ raw }));
        if (!result.ok) return errorResult(result.error);
        return jsonResult(result.data);
      }
    );

    // ── gmail_labels ──────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.gmail_labels.name,
      toolConfig(TOOL_DEFS.gmail_labels, {
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = gmailScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const result = await gmailFetch(resolved.token, resolved.targetEmail, 'labels');
        if (!result.ok) return errorResult(result.error);
        return jsonResult(result.data);
      }
    );

    // ── sheets_get_spreadsheet ────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.sheets_get_spreadsheet.name,
      toolConfig(TOOL_DEFS.sheets_get_spreadsheet, {
        spreadsheetId: z.string().describe('Google Spreadsheet ID (e.g. 1BxiMVs0...) — the segment after /d/ in the sheet URL; a full URL is accepted and the id extracted'),
        account: z.string().optional().describe('Email account to use.'),
        offset: z.number().int().min(0).optional().describe('Start position (chars into the serialized JSON response) for a windowed read of large metadata. Use the next_offset from the previous response to continue; start at 0.'),
        limit: z.number().int().min(1).optional().describe('Max chars to return in this response (server caps at 200000). Size this to YOUR tool-result budget. Passing offset or limit switches to the windowed envelope.'),
      }),
      async ({ spreadsheetId, account, offset, limit }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const sid = resolveDriveFileId('sheet', spreadsheetId);
        if ('denial' in sid) return sid.denial;
        spreadsheetId = sid.id;
        const perm = await checkSheetsPermission(conn.user.id, resolved.proxyKeyId, spreadsheetId, false);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, sheetsDenialAction(perm, spreadsheetId, false));

        const result = await withSheetsGrace(perm, () => sheetsFetch(resolved.token, `${spreadsheetId}`, 'GET', undefined, resolved.targetEmail));
        if (!result.ok) return sheetsErrorResult(result, spreadsheetId);
        if (offset !== undefined || limit !== undefined) {
          // Pretty-printed to match the windowless jsonResult serialization —
          // windows must reassemble byte-identical to the unwindowed read.
          return windowedResult(JSON.stringify(result.data, null, 2), offset, limit, { spreadsheetId });
        }
        return jsonResult(result.data);
      }
    );

    // ── sheets_read_range ─────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.sheets_read_range.name,
      toolConfig(TOOL_DEFS.sheets_read_range, {
        spreadsheetId: z.string().describe('Google Spreadsheet ID'),
        range: z.string().describe("Cell range (e.g. 'Sheet1'!A1:D20 or 'Sheet1')"),
        account: z.string().optional().describe('Email account to use.'),
        offset: z.number().int().min(0).optional().describe('Start position (chars into the serialized JSON response) for a windowed read of a large range. Prefer narrowing the range first. Use the next_offset from the previous response to continue; start at 0.'),
        limit: z.number().int().min(1).optional().describe('Max chars to return in this response (server caps at 200000). Size this to YOUR tool-result budget. Passing offset or limit switches to the windowed envelope.'),
      }),
      async ({ spreadsheetId, range, account, offset, limit }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const sid = resolveDriveFileId('sheet', spreadsheetId);
        if ('denial' in sid) return sid.denial;
        spreadsheetId = sid.id;
        const perm = await checkSheetsPermission(conn.user.id, resolved.proxyKeyId, spreadsheetId, false);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, sheetsDenialAction(perm, spreadsheetId, false));

        const encodedRange = encodeURIComponent(range);
        const result = await withSheetsGrace(perm, () => sheetsFetch(resolved.token, `${spreadsheetId}/values/${encodedRange}`, 'GET', undefined, resolved.targetEmail));
        if (!result.ok) return sheetsErrorResult(result, spreadsheetId);
        if (offset !== undefined || limit !== undefined) {
          return windowedResult(JSON.stringify(result.data, null, 2), offset, limit, { spreadsheetId, range });
        }
        return jsonResult(result.data);
      }
    );

    // ── sheets_update_range ───────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.sheets_update_range.name,
      toolConfig(TOOL_DEFS.sheets_update_range, {
        spreadsheetId: z.string().describe('Google Spreadsheet ID'),
        range: z.string().describe("Cell range (e.g. 'Sheet1'!A1:B2)"),
        values: z.array(z.array(z.any())).describe('2D array of cell values'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ spreadsheetId, range, values, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const sid = resolveDriveFileId('sheet', spreadsheetId);
        if ('denial' in sid) return sid.denial;
        spreadsheetId = sid.id;
        const perm = await checkSheetsPermission(conn.user.id, resolved.proxyKeyId, spreadsheetId, true);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, sheetsDenialAction(perm, spreadsheetId, true));

        const encodedRange = encodeURIComponent(range);
        const body = JSON.stringify({ values, range });
        const result = await withSheetsGrace(perm, () => sheetsFetch(resolved.token, `${spreadsheetId}/values/${encodedRange}?valueInputOption=USER_ENTERED`, 'PUT', body, resolved.targetEmail));
        if (!result.ok) return sheetsErrorResult(result, spreadsheetId);
        return jsonResult({
          ...(result.data as Record<string, unknown>),
          fgac_hint: 'Values written. Formatting, charts, and structural changes: sheets_edit (same rule authorizes both).',
        });
      }
    );

    // ── sheets_append_rows ────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.sheets_append_rows.name,
      toolConfig(TOOL_DEFS.sheets_append_rows, {
        spreadsheetId: z.string().describe('Google Spreadsheet ID'),
        range: z.string().describe("Sheet tab or range to append to (e.g. 'Sheet1')"),
        values: z.array(z.array(z.any())).describe('2D array of rows to append'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ spreadsheetId, range, values, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const sid = resolveDriveFileId('sheet', spreadsheetId);
        if ('denial' in sid) return sid.denial;
        spreadsheetId = sid.id;
        const perm = await checkSheetsPermission(conn.user.id, resolved.proxyKeyId, spreadsheetId, true);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, sheetsDenialAction(perm, spreadsheetId, true));

        const encodedRange = encodeURIComponent(range);
        const body = JSON.stringify({ values });
        const result = await withSheetsGrace(perm, () => sheetsFetch(resolved.token, `${spreadsheetId}/values/${encodedRange}:append?valueInputOption=USER_ENTERED`, 'POST', body, resolved.targetEmail));
        if (!result.ok) return sheetsErrorResult(result, spreadsheetId);
        return jsonResult({
          ...(result.data as Record<string, unknown>),
          fgac_hint: 'Rows appended as values. Formatting or structural changes: sheets_edit (same rule authorizes both).',
        });
      }
    );

    // ── sheets_edit ───────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.sheets_edit.name,
      toolConfig(TOOL_DEFS.sheets_edit, {
        spreadsheetId: z.string().describe('Google Spreadsheet ID'),
        requests: z.array(z.record(z.string(), z.any())).min(1).describe('Sheets API batchUpdate request objects, applied in order (e.g. repeatCell, addSheet, updateSheetProperties, addChart, mergeCells, setDataValidation)'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ spreadsheetId, requests, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const sid = resolveDriveFileId('sheet', spreadsheetId);
        if ('denial' in sid) return sid.denial;
        spreadsheetId = sid.id;
        const perm = await checkSheetsPermission(conn.user.id, resolved.proxyKeyId, spreadsheetId, true);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, sheetsDenialAction(perm, spreadsheetId, true));

        const body = JSON.stringify({ requests });
        const result = await withSheetsGrace(perm, () => sheetsFetch(resolved.token, `${spreadsheetId}:batchUpdate`, 'POST', body, resolved.targetEmail));
        if (!result.ok) return sheetsErrorResult(result, spreadsheetId);
        return jsonResult(result.data);
      }
    );

    // ── docs_read_document ────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.docs_read_document.name,
      toolConfig(TOOL_DEFS.docs_read_document, {
        documentId: z.string().describe('Google Docs document ID (e.g. 1NQiAY...) — the segment after /d/ in the doc URL; a full URL is accepted and the id extracted'),
        fields: z.string().optional().describe('Optional Docs API field mask to trim the response (e.g. "title,body.content"). Use when a full read is too large.'),
        account: z.string().optional().describe('Email account to use.'),
        offset: z.number().int().min(0).optional().describe('Start position (chars into the serialized JSON response) for a windowed read of a large document. Use the next_offset from the previous response to continue; start at 0.'),
        limit: z.number().int().min(1).optional().describe('Max chars to return in this response (server caps at 200000). Size this to YOUR tool-result budget. Passing offset or limit switches to the windowed envelope.'),
      }),
      async ({ documentId, fields, account, offset, limit }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const did = resolveDriveFileId('doc', documentId);
        if ('denial' in did) return did.denial;
        documentId = did.id;
        const perm = await checkDocsPermission(conn.user.id, resolved.proxyKeyId, documentId, false);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, docsDenialAction(perm, documentId, false));

        const query = fields ? `?fields=${encodeURIComponent(fields)}` : '';
        const result = await withDocsGrace(perm, () => docsFetch(resolved.token, `${encodeURIComponent(documentId)}${query}`, 'GET', undefined, resolved.targetEmail));
        if (!result.ok) return docsErrorResult(result, documentId);
        // Same windowing pattern as gmail_get_attachment: on request, a
        // substring of the serialized JSON response — windows concatenate to
        // the exact document JSON. Combine with `fields` to narrow first.
        if (offset !== undefined || limit !== undefined) {
          return windowedResult(JSON.stringify(result.data, null, 2), offset, limit, { documentId });
        }
        return jsonResult(result.data);
      }
    );

    // ── docs_edit ─────────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.docs_edit.name,
      toolConfig(TOOL_DEFS.docs_edit, {
        documentId: z.string().describe('Google Docs document ID'),
        requests: z.array(z.record(z.string(), z.any())).min(1).describe('Docs API batchUpdate request objects, applied in order (e.g. insertText, insertTable, updateTextStyle, updateParagraphStyle, replaceAllText, insertInlineImage)'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ documentId, requests, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const did = resolveDriveFileId('doc', documentId);
        if ('denial' in did) return did.denial;
        documentId = did.id;
        const perm = await checkDocsPermission(conn.user.id, resolved.proxyKeyId, documentId, true);
        if (!perm.allowed) return policyDenialWithLink(conn, resolved.proxyKeyId, perm.reason, docsDenialAction(perm, documentId, true));

        const body = JSON.stringify({ requests });
        const verifyPlan = planDocsDeleteVerification(requests);
        const endBefore = verifyPlan.hasDelete
          ? await fetchDocsBodyEndIndex(resolved.token, documentId, resolved.targetEmail)
          : null;
        const result = await withDocsGrace(perm, () => docsFetch(resolved.token, `${encodeURIComponent(documentId)}:batchUpdate`, 'POST', body, resolved.targetEmail));
        if (!result.ok) return docsErrorResult(result, documentId);
        if (!verifyPlan.hasDelete) return jsonResult(result.data);

        const endAfter = await fetchDocsBodyEndIndex(resolved.token, documentId, resolved.targetEmail);
        const note = docsDeleteVerifyNote(verifyPlan, endBefore, endAfter);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result.data, null, 2) },
            ...(note ? [{ type: 'text' as const, text: note }] : []),
          ],
        };
      }
    );

    // ── comments_read ─────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.comments_read.name,
      toolConfig(TOOL_DEFS.comments_read, {
        fileId: z.string().describe('Google Docs document ID or Google Sheets spreadsheet ID'),
        pageToken: z.string().optional().describe('nextPageToken from a previous page of results'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ fileId, pageToken, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const fid = resolveDriveFileId('file', fileId);
        if ('denial' in fid) return fid.denial;
        fileId = fid.id;
        const check = await checkCommentsPermission(conn, resolved.proxyKeyId, fileId, false);
        if ('denial' in check) return check.denial;

        const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?fields=${encodeURIComponent(COMMENT_LIST_FIELDS)}&pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const result = await withGrantGrace(check.kind, check.perm, () => googleFetch(url, resolved.token, 'GET', undefined, resolved.targetEmail));
        if (!result.ok) return fileGrantErrorResult(check.kind, result, fileId);
        return jsonResult(result.data);
      }
    );

    // ── comments_add ──────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.comments_add.name,
      toolConfig(TOOL_DEFS.comments_add, {
        fileId: z.string().describe('Google Docs document ID or Google Sheets spreadsheet ID'),
        content: z.string().describe('Comment or reply text'),
        commentId: z.string().optional().describe('Existing comment ID to reply to (from comments_read). Omit to create a new file-level comment.'),
        resolve: z.boolean().optional().describe('With commentId: also mark the comment resolved (Drive reply action "resolve")'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ fileId, content, commentId, resolve, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;
        if (resolve && !commentId) {
          return textResult('❌ resolve requires commentId — resolving happens via a reply to an existing comment.');
        }

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);
        const scopeDenial = driveFileScopeDenial(conn, resolved);
        if (scopeDenial) return scopeDenial;

        const fid = resolveDriveFileId('file', fileId);
        if ('denial' in fid) return fid.denial;
        fileId = fid.id;
        const check = await checkCommentsPermission(conn, resolved.proxyKeyId, fileId, true);
        if ('denial' in check) return check.denial;

        const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
        const url = commentId
          ? `${base}/comments/${encodeURIComponent(commentId)}/replies?fields=${encodeURIComponent('id,content,action,createdTime')}`
          : `${base}/comments?fields=${encodeURIComponent('id,content,createdTime')}`;
        const payload = JSON.stringify(commentId && resolve ? { content, action: 'resolve' } : { content });
        const result = await withGrantGrace(check.kind, check.perm, () => googleFetch(url, resolved.token, 'POST', payload, resolved.targetEmail));
        if (!result.ok) return commentsErrorResult(check.kind, result, fileId, commentId);
        return jsonResult(result.data);
      }
    );

    // ── google_api_get ────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.google_api_get.name,
      toolConfig(TOOL_DEFS.google_api_get, {
        path: z.string().describe('API path (e.g. "gmail/v1/users/me/messages" or "v4/spreadsheets/1BxiM.../values/Sheet1")'),
        account: z.string().optional().describe('Email account to use.'),
        offset: z.number().int().min(0).optional().describe('Start position (chars into the serialized response) for a windowed read of a large payload. Use the next_offset from the previous response to continue; start at 0.'),
        limit: z.number().int().min(1).optional().describe('Max chars to return in this response (server caps at 200000). Size this to YOUR tool-result budget. Passing offset or limit switches successful responses to the windowed envelope.'),
      }),
      async ({ path: rawPath, account, offset, limit }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        // Canonicalize bare Drive spellings (`v3/files/…` → `drive/v3/files/…`)
        // before anything reads the path, so classification, per-file comments
        // enforcement, host routing, and the stamped endpoint template agree
        // (see canonicalizeGoogleApiPath).
        const path = canonicalizeGoogleApiPath(rawPath);
        // Classify before resolving the account: resolution failures keep
        // their raw_api_* props, and denials that need no account (batch,
        // unsupported families) answer without a token fetch.
        const cls = classifyAndStampRawCall(path, 'GET');
        if (cls.kind === 'denied') return textResult(cls.reason);

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);

        const res = await executeRawGoogleCall(conn, resolved, path, 'GET', cls);
        // Windowing applies to the SUCCESSFUL payload only — denials, errors,
        // and policy messages (⏳🚫⚠️❌ prefixes, per classifyToolOutcome's
        // convention) pass through whole so their guidance is never sliced.
        if (offset !== undefined || limit !== undefined) {
          const text = res.content?.[0]?.text ?? '';
          if (!(res as { isError?: boolean }).isError && text && !/^[⏳🚫❌]|^⚠️/u.test(text)) {
            return windowedResult(text, offset, limit, { path });
          }
        }
        return res;
      }
    );

    // ── google_api_modify ─────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.google_api_modify.name,
      toolConfig(TOOL_DEFS.google_api_modify, {
        path: z.string().describe('API path (e.g. "gmail/v1/users/me/messages/send" or "v4/spreadsheets/1BxiM.../values/Sheet1:append")'),
        method: z.enum(['POST', 'PUT', 'PATCH']).optional().describe('HTTP method (default: POST)'),
        body: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe('Request body (JSON object or string)'),
        account: z.string().optional().describe('Email account to use.'),
      }),
      async ({ path: rawPath, method = 'POST', body, account }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;

        // Canonicalize + classify before resolving the account — see google_api_get.
        const path = canonicalizeGoogleApiPath(rawPath);
        const cls = classifyAndStampRawCall(path, method);
        if (cls.kind === 'denied') return textResult(cls.reason);

        const resolved = await resolveAccountAndToken(conn, account);
        if ('error' in resolved) return textResult(resolved.error);

        return executeRawGoogleCall(conn, resolved, path, method, cls, body);
      }
    );

    // ── request_access ────────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.request_access.name,
      toolConfig(TOOL_DEFS.request_access, {
        type: z.enum(['send', 'sheets_read', 'sheets_write', 'docs_read', 'docs_write']).describe('What to request: permission to send email to a recipient, or read / read-write access to a spreadsheet or document'),
        recipient: z.string().optional().describe('Email address to whitelist (required for type "send")'),
        spreadsheetId: z.string().optional().describe('Google Spreadsheet ID (required for sheets types) — the segment after /d/ in the sheet URL; a full URL is accepted'),
        documentId: z.string().optional().describe('Google Docs document ID (required for docs types) — the segment after /d/ in the doc URL; a full URL is accepted'),
        resourceName: z.string().max(200).optional().describe('Title of the spreadsheet or document, when you know it (from the user\'s message or an earlier call). Shown on the approval page so the user can find the file by name in Google\'s picker — without it they only see the file id.'),
      }),
      async ({ type, recipient, spreadsheetId, documentId, resourceName }, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;
        if (!conn.proxyKeyId) {
          return textResult('❌ No proxy key assigned to this connection.');
        }

        const REQUESTABLE = 'Requestable permissions: sending to a specific recipient, or read/read-write access to a specific spreadsheet or document.';
        const title = cleanResourceName(resourceName);
        const named = title ? { resourceName: title } : {};
        let action: ApprovalAction;
        if (type === 'send') {
          if (!recipient || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(recipient)) {
            return textResult(`🚫 A valid "recipient" email address is required to request send access. ${REQUESTABLE}`);
          }
          action = { action: 'send_whitelist', recipient };
        } else if (type === 'docs_read' || type === 'docs_write') {
          if (!documentId) {
            return textResult(`🚫 A "documentId" is required to request document access. ${REQUESTABLE}`);
          }
          const did = resolveDriveFileId('doc', documentId);
          if ('denial' in did) return did.denial;
          documentId = did.id;
          action = type === 'docs_read'
            ? { action: 'docs_expose', documentId, ...named }
            : { action: 'docs_write', documentId, ...named };
        } else {
          if (!spreadsheetId) {
            return textResult(`🚫 A "spreadsheetId" is required to request spreadsheet access. ${REQUESTABLE}`);
          }
          const sid = resolveDriveFileId('sheet', spreadsheetId);
          if ('denial' in sid) return sid.denial;
          spreadsheetId = sid.id;
          action = type === 'sheets_read'
            ? { action: 'sheets_expose', spreadsheetId, ...named }
            : { action: 'sheets_write', spreadsheetId, ...named };
        }

        const { url, requestId, targetHash } = await mintApprovalLink(DASHBOARD_URL, conn.user.id, conn.proxyKeyId, action);
        // The title rides in the request ledger, never in the URL (the link
        // stays deterministic); the approve page reads it back by request_id.
        const mintCount = await recordApprovalMint({
          requestId, userId: conn.user.id, proxyKeyId: conn.proxyKeyId, action: action.action, targetHash,
          ...named,
        });
        // A re-request without a title still has one if an earlier mint stored
        // it — the response should say so rather than ask the agent again
        // (observed in QA 2026-09-08).
        const storedTitle = title ?? (action.action === 'send_whitelist' ? null : await getApprovalRequestResourceName(requestId));
        captureServerEvent(conn.user.clerkUserId, 'approval_link_minted', {
          action: action.action, via: 'request_access', request_id: requestId, target_hash: targetHash,
          mint_count: mintCount, has_resource_name: !!storedTitle, resource_name_supplied: !!title,
        });
        addToolCallProps({ approval_request_id: requestId });
        return jsonResult({
          status: 'approval_required',
          summary: action.action === 'send_whitelist'
            ? `Requesting permission to send email to ${recipient}`
            : action.action.startsWith('docs')
              ? `Requesting ${type === 'docs_read' ? 'read-only' : 'read & write'} access to document ${storedTitle ? `"${storedTitle}" (${documentId})` : documentId}`
              : `Requesting ${type === 'sheets_read' ? 'read-only' : 'read & write'} access to spreadsheet ${storedTitle ? `"${storedTitle}" (${spreadsheetId})` : spreadsheetId}`,
          approvalUrl: url,
          note: 'Nothing has been granted. Show the approval link to the user VERBATIM as a clickable URL — only they can approve it. The link does not expire and stays valid, so re-requesting produces the same URL rather than a new one. Do not retry the original operation until they confirm.'
            + (action.action === 'send_whitelist' ? '' : storedTitle
              ? ` The approval page shows the file as "${storedTitle}".`
              : ' Tell the user the file\'s NAME along with the link: the approval page can only show Google\'s file id, and the user has to find the file by name in Google\'s picker. Re-call this tool with resourceName if you know the title.'),
        });
      }
    );

    // ── get_my_permissions ────────────────────────────────────────────
    server.registerTool(
      TOOL_DEFS.get_my_permissions.name,
      toolConfig(TOOL_DEFS.get_my_permissions, {}),
      async (_params, { authInfo }) => {
        const conn = await requireApproval(authInfo);
        if ('content' in conn) return conn;
        if (!conn.proxyKeyId) {
          return textResult('❌ No proxy key assigned.');
        }

        const emails = await getAccessibleEmails(conn.proxyKeyId);
        const key = await db.select().from(proxyKeys)
          .where(eq(proxyKeys.id, conn.proxyKeyId)).then(r => r[0]);

        // Only the rules that actually apply to THIS key: global rules
        // (no assignments) plus rules assigned to it. Returning the owner's
        // full rule set leaked rules scoped to other keys/profiles.
        const allRules = await db.select().from(accessRules)
          .where(eq(accessRules.userId, conn.user.id));
        const allAssignments = await db.select().from(keyRuleAssignments);
        const rulesWithAssignments = new Set(allAssignments.map(a => a.accessRuleId));
        const assignedToThisKey = new Set(
          allAssignments.filter(a => a.proxyKeyId === conn.proxyKeyId).map(a => a.accessRuleId),
        );
        const applicableRules = allRules.filter(r =>
          !rulesWithAssignments.has(r.id) || assignedToThisKey.has(r.id),
        );

        return jsonResult({
          connection: { id: conn.connectionId, nickname: conn.nickname },
          proxyKey: { id: key?.id, label: key?.label },
          accessibleEmails: emails.map(e => e.targetEmail),
          // Implicit posture, stated explicitly: an empty rules array does
          // NOT mean "no access" — auditors reading this output must see
          // what the key can reach by default (tester finding, 2026-08-15).
          defaults: {
            gmailRead: 'ALLOWED by default for every accessible email; read-block rules (label/content) below restrict it',
            gmailSend: 'DENIED unless a send_whitelist rule matches the recipient (applies to messages/send AND drafts/send — draft recipients are resolved server-side)',
            gmailWrite: 'ALLOWED by default via google_api_modify: labels, drafts, messages modify/trash/untrash/batchModify, insert/import — everything the gmail.modify grant covers except sending (whitelisted above), settings writes (Google scopes FGAC does not hold), and permanent deletion (below)',
            sheets: 'DENIED unless a per-spreadsheet rule below exposes the sheet',
            docs: 'DENIED unless a per-document rule below exposes the document',
            deletion: 'NEVER available through any tool',
            rawApi: 'google_api_get / google_api_modify expose the Google API surface the grant covers under these same rules; Drive and Slides calls are forwarded subject to the per-file drive.file scope the user granted; POST v4/spreadsheets and POST v1/documents create new files auto-granted to this key; APIs outside the grant (People/Contacts, Calendar, Tasks, …) are refused with a clear denial',
          },
          rules: applicableRules.map(r => ({
            name: r.ruleName,
            type: r.actionType,
            pattern: r.regexPattern,
            email: r.targetEmail || 'all',
            scope: rulesWithAssignments.has(r.id) ? 'this-key' : 'global',
            // Per-file rules: without the file id an agent cannot locate
            // the file it was granted access to.
            ...(r.service === 'sheets'
              ? { spreadsheetId: r.targetResourceId, resourceName: r.resourceName }
              : {}),
            ...(r.service === 'docs'
              ? { documentId: r.targetResourceId, resourceName: r.resourceName }
              : {}),
          })),
        });
      }
    );
  },
  {
    serverInfo: {
      name: 'fgac',
      version: '1.3.0',
    },
    // Surfaced in the `initialize` result and loaded into the client's context
    // before any tool is called. Agents read tool catalogs as paths (task →
    // first plausible tool → stop), so the shortcut/full-surface relationship
    // must be stated up front, not only inside individual descriptions.
    //
    // The first two sentences are the whole onboarding surface for most
    // connectors: 2026-08-29 analysis of the silent-connector cohort showed
    // every measurable zero-call user DOES complete the initialize handshake
    // (Claude.ai web 8:1 over Claude Code, most across many sessions), so
    // this string reaches their context repeatedly while list_accounts's
    // next_steps block never does — a user whose agent calls nothing never
    // sees a tool result. Two failure modes it must counter: the agent
    // claiming it cannot access the user's mail despite the connector, and
    // a just-connected user never being shown what a first use looks like.
    instructions:
      "These tools give live access to the Gmail, Google Docs, and Google Sheets accounts the user has already connected — mailbox reads work immediately, with no further setup. " +
      "When the user mentions their email, documents, or spreadsheets, reach for these tools instead of saying you cannot access their data. " +
      "If this connector has not been used yet, call list_accounts first: it returns the reachable mailboxes plus next-step guidance, and makes an easy first demonstration to offer (e.g. summarizing recent unread mail). " +
      'FGAC proxies Google Workspace behind per-user access rules enforced upstream at the proxy — every tool passes through the same enforcement. ' +
      'The typed tools are shortcuts for common operations: docs_edit and sheets_edit accept native Google batchUpdate requests (tables, text styles, ' +
      'cell formatting, charts, sheet tabs), comments_read and comments_add cover Drive-API comments on docs and sheets, and the values/gmail tools ' +
      'handle the simple cases. The full Google API surface is available through google_api_get (reads) and google_api_modify (writes) — Gmail threads, ' +
      'drafts, labels, and mailbox organization (archive, mark read, trash), Drive file listing and export, creating new documents or spreadsheets. Fall back to them instead of treating an operation as ' +
      'unsupported. A denied call is not a dead end: it returns a one-click approval link — show it to the user and retry after they approve.',
  },
  {
    basePath: '/api',
    verboseLogs: false,
  }
);

// ─── Authentication ─────────────────────────────────────────────────────────

/**
 * The only issuer this server accepts tokens from: the Clerk frontend API
 * derived from our own publishable key. Deriving the JWKS location from the
 * token's `iss` claim would let ANY issuer mint accepted tokens.
 */
function expectedClerkIssuer(): string | null {
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!pk) return null;
  try {
    const domain = Buffer.from(pk.replace(/^pk_(test|live)_/, ''), 'base64')
      .toString('utf8')
      .replace(/\$$/, '');
    return domain ? `https://${domain}` : null;
  } catch {
    return null;
  }
}

/**
 * Kill switch for the auth optimizations below (JWKS singleton + strategy
 * memo). Set MCP_AUTH_OPTIMIZATIONS=disabled to restore the legacy behavior
 * (fresh JWKS per call, fixed clerk→direct try-order) without a code revert.
 */
const authOptimizationsEnabled = () => process.env.MCP_AUTH_OPTIMIZATIONS !== 'disabled';

/**
 * Kill switch for the connection-touch memo (src/lib/connectionTouchMemo.ts):
 * set MCP_CONNECTION_TOUCH_MEMO=disabled to run the eager resolveConnection
 * on every request again.
 */
const connectionTouchMemoEnabled = () => process.env.MCP_CONNECTION_TOUCH_MEMO !== 'disabled';

/**
 * Optimization A: one remote JWKS per function instance instead of per
 * request. jose caches fetched keys inside this object — it refetches
 * immediately when it sees an unknown `kid` (rate-limited by
 * cooldownDuration) and expires known keys after cacheMaxAge, so a retired
 * signing key is trusted for at most 5 minutes. These are public keys; the
 * security control is the pinned-issuer check in the caller, which is
 * unchanged.
 */
let jwksSingleton: { issuer: string; jwks: JWTVerifyGetKey } | null = null;

async function getClerkJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const { createRemoteJWKSet } = await import('jose');
  const url = new URL(`${issuer}/.well-known/jwks.json`);
  if (!authOptimizationsEnabled()) return createRemoteJWKSet(url);
  if (!jwksSingleton || jwksSingleton.issuer !== issuer) {
    jwksSingleton = {
      issuer,
      jwks: createRemoteJWKSet(url, { cooldownDuration: 30_000, cacheMaxAge: 300_000 }),
    };
  }
  return jwksSingleton.jwks;
}

/**
 * Optimization B: remember which verification strategy last worked for each
 * OAuth client so established CLI clients skip the doomed Clerk auth()
 * attempt. Routing hint ONLY — both strategies remain fail-closed and the
 * other one still runs when the preferred one fails, so a wrong (or
 * attacker-planted) memo entry can never grant access, only reorder two
 * verifiers. Bounded LRU so bogus client_ids can't grow it without limit.
 */
const STRATEGY_MEMO_MAX = 500;
const strategyMemo = new Map<string, 'clerk' | 'direct'>();

function strategyMemoGet(clientId: string): 'clerk' | 'direct' | undefined {
  const v = strategyMemo.get(clientId);
  if (v !== undefined) {
    strategyMemo.delete(clientId);
    strategyMemo.set(clientId, v);
  }
  return v;
}

function strategyMemoSet(clientId: string, strategy: 'clerk' | 'direct'): void {
  if (strategyMemo.has(clientId)) {
    strategyMemo.delete(clientId);
  } else if (strategyMemo.size >= STRATEGY_MEMO_MAX) {
    const oldest = strategyMemo.keys().next().value;
    if (oldest !== undefined) strategyMemo.delete(oldest);
  }
  strategyMemo.set(clientId, strategy);
}

/**
 * client_id from the UNVERIFIED token payload — used only to look up the
 * strategy memo and label auth metrics, never to authorize.
 *
 * Both claims are caller-controlled on a failed auth (anyone can mint an
 * unsigned JWT with any header/payload), and both now travel into analytics on
 * `mcp_auth_attempt`. Truncate them: a real Clerk client_id/kid is well under
 * this, while an unbounded value would let an unauthenticated caller inflate
 * every event it triggers — and would grow strategy-memo keys without limit
 * even though the memo caps entry *count*.
 */
const MAX_CLAIM_LEN = 128;

function unverifiedTokenClaims(token?: string): { clientId?: string; kid?: string } {
  if (!token) return {};
  const claim = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_CLAIM_LEN) : undefined;
  try {
    const [headerB64, payloadB64] = token.split('.');
    if (!payloadB64) return {};
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    return { clientId: claim(payload.client_id), kid: claim(header.kid) };
  } catch {
    return {};
  }
}

/**
 * Direct JWT verification fallback for CLI/non-browser OAuth tokens.
 * Used when Clerk's auth()+verifyClerkToken fails to extract userId/clientId.
 * Fails closed unless the token's issuer is exactly our Clerk instance.
 */
async function verifyClerkJwtDirect(token: string) {
  try {
    const { jwtVerify } = await import('jose');
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return undefined;
    const rawPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const issuer = rawPayload.iss;

    const expected = expectedClerkIssuer();
    if (!expected || issuer !== expected) {
      console.error(`[MCP] Rejecting token from unexpected issuer '${issuer}' (expected '${expected ?? 'unavailable'}')`);
      return undefined;
    }

    const JWKS = await getClerkJwks(issuer);
    const { payload: verified } = await jwtVerify(token, JWKS, { issuer, clockTolerance: 30 });
    const sub = verified.sub;
    const cid = (verified as Record<string, unknown>).client_id as string | undefined;
    if (!sub || !cid) return undefined;

    return {
      token,
      scopes: ((verified as Record<string, unknown>).scope as string || '').split(' '),
      clientId: cid,
      extra: { userId: sub },
    };
  } catch (err) {
    console.error('[MCP] Direct JWT verification failed:', err);
    return undefined;
  }
}

// Success events are sampled 1-in-20 PER REQUEST; failures always capture.
// Lives in src/lib/authSampling.ts — read its header before touching the gate:
// two prior versions keyed the draw off the token itself, which is not a
// sample of requests and made `ok` counts unusable for volume estimation.

const verifyMcpAuth = async (req: Request, bearerToken?: string) => {
  let authInfo: ReturnType<typeof verifyClerkToken> | Awaited<ReturnType<typeof verifyClerkJwtDirect>> | undefined;
  let strategyUsed: 'clerk' | 'direct' | 'none' = 'none';
  let clerkErrorClass: string | undefined;

  const { clientId: clientIdHint, kid } = unverifiedTokenClaims(bearerToken);
  const memoStrategy =
    authOptimizationsEnabled() && clientIdHint ? strategyMemoGet(clientIdHint) : undefined;

  // Strategy 1: Clerk's built-in auth() + verifyClerkToken
  const tryClerk = async () => {
    try {
      const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
      const result = verifyClerkToken(clerkAuth, bearerToken);
      if (result?.extra?.userId) {
        authInfo = result;
        strategyUsed = 'clerk';
      }
    } catch (error) {
      clerkErrorClass = error instanceof Error ? error.name : 'unknown';
      console.warn('[MCP] Clerk auth() failed:', error);
    }
  };

  // Strategy 2: Direct JWT verification (fallback for CLI/non-browser contexts)
  const tryDirect = async () => {
    if (!bearerToken) return;
    const result = await verifyClerkJwtDirect(bearerToken);
    if (result) {
      authInfo = result;
      strategyUsed = 'direct';
    }
  };

  // Optimization B: try the strategy that last worked for this client first;
  // the other still runs on a miss, so try-order never changes the outcome.
  if (memoStrategy === 'direct') {
    await tryDirect();
    if (!authInfo) await tryClerk();
  } else {
    await tryClerk();
    if (!authInfo) {
      if (!memoStrategy) console.log('[MCP] Falling back to direct JWT verification');
      await tryDirect();
    }
  }

  if (authInfo && clientIdHint && strategyUsed !== 'none' && authOptimizationsEnabled()) {
    strategyMemoSet(clientIdHint, strategyUsed);
  }

  // Client self-identification: in stateless streamable HTTP every POST gets
  // a fresh McpServer, so the `initialize` request is the ONLY place the
  // client's name/version exist server-side — and this auth wrapper is the
  // only code that still holds the raw Request. Parsed from a clone;
  // undefined for every other request.
  const clientInfo = await parseInitializeClientInfo(req);
  const userAgent = req.headers.get('user-agent') ?? undefined;
  // Registry crawler / health probe / our own probe / Claude product / other —
  // a measurement label (nothing is authorized or rate-limited on it) that
  // lets the auth alert and the install funnel leave scanner traffic out.
  const clientClass = classifyMcpClient({ userAgent, clientName: clientInfo?.name });
  // Set by middleware when the client connected via /api/mcp/<slug>.
  const profileSlug = req.headers.get('x-fgac-profile-slug') ?? undefined;

  // Auth-health instrumentation: every failure, sampled successes. This is
  // the alerting substrate for the JWKS/strategy optimizations — an auth
  // regression shows up here (and as vanishing $mcp_tool_call volume) long
  // before anyone reads function logs.
  const outcome = authInfo ? 'ok' : bearerToken ? 'invalid_token' : 'no_token';
  const captureAuthAttempt = outcome !== 'ok' || inSuccessSample();
  // Eager-resolve cost telemetry, filled in below and captured with the auth
  // attempt (the memo's hit rate and the DB touch's latency are only
  // observable here — tool calls carry their own duration).
  let connectionResolve: 'ran' | 'skipped' | 'error' | undefined;
  let connectionResolveMs: number | undefined;
  const captureAuthAttemptNow = () => {
    if (!captureAuthAttempt) return;
    captureServerEvent(
      (authInfo?.extra?.userId as string | undefined) ?? 'anonymous-mcp',
      'mcp_auth_attempt',
      {
        outcome,
        client_id: (authInfo as { clientId?: string } | undefined)?.clientId ?? clientIdHint,
        strategy_used: strategyUsed,
        memo_hit: memoStrategy !== undefined,
        optimizations_enabled: authOptimizationsEnabled(),
        success_sample_rate: AUTH_SUCCESS_SAMPLE,
        error_class: clerkErrorClass,
        kid: outcome === 'invalid_token' ? kid : undefined,
        method: req.method,
        connection_resolve: connectionResolve,
        connection_resolve_ms: connectionResolveMs,
        // Who failed (added 2026-09-10, the day after the MCP Registry listing
        // brought ~60 crawlers): a 401 spike is diagnosable from this event
        // alone instead of by joining connector_install_started by minute.
        user_agent: userAgent,
        client_name: clientInfo?.name,
        ...clientClass,
      },
    );
  };

  // Install-funnel measurement (pre-Clerk visibility): an unauthenticated MCP
  // request is the first FGAC-owned touchpoint when a client adds the
  // connector — the 401 issued below is what sends it into OAuth discovery.
  // Anonymous by design (distinct_id is already excluded from user metrics);
  // this is a rate metric, not an identity metric. reason='no_token' on POST
  // approximates fresh install attempts; 'invalid_token' is mostly token
  // expiry/refresh noise from established clients.
  // `install_fingerprint` (salted hash of ip+ua) is the uniqueness key:
  // distinct_id stays 'anonymous-mcp' so person-space is untouched, and
  // uniq(properties.install_fingerprint) becomes the real installer count —
  // raw daily totals are 401/retry volume (exactly the mcp_auth_attempt
  // failure counts above), not people. An unauthenticated `initialize`
  // additionally self-reports the client product.
  if (!authInfo) {
    captureServerEvent('anonymous-mcp', 'connector_install_started', {
      touchpoint: 'mcp_401',
      reason: bearerToken ? 'invalid_token' : 'no_token',
      method: req.method,
      user_agent: userAgent,
      install_fingerprint: installFingerprint(req),
      client_name: clientInfo?.name,
      client_version: clientInfo?.version,
      ...clientClass,
    });
  }

  // Eagerly create/touch agent_connection on ANY authenticated request
  // (including initialize), so connections appear in the dashboard immediately.
  // Tool handlers still call requireApproval() as a fallback safety net.
  // Awaited: fire-and-forget raced the tool handler's own resolveConnection
  // on a client's very first call and surfaced a SQL error (QA cap 06 A3).
  if (authInfo) {
    const userId = authInfo.extra?.userId as string | undefined;
    const clientId = (authInfo as Record<string, unknown>).clientId as string | undefined;
    // withToolAnalytics sees only authInfo, never the Request — ride the
    // user-agent along so $mcp_tool_call can be split by client product.
    (authInfo as { extra?: Record<string, unknown> }).extra = { ...authInfo.extra, userAgent, profileSlug };
    // Once-per-MCP-session product attribution (the initialize handshake).
    // Deliberately NOT coalesced: automation that spawns a fresh Claude Code
    // process every ~30 s (2026-09-08) makes this the largest event in the
    // project, but the per-event timestamps and versions are what exposed
    // that pattern (docs/monitoring.md 7.16); volume is ~6% of the plan.
    if (clientInfo && userId) {
      captureServerEvent(userId, 'mcp_client_initialize', {
        client_name: clientInfo.name,
        client_version: clientInfo.version,
        client_id: clientId,
        user_agent: userAgent,
      });
    }
    if (userId && clientId) {
      // The touch is four sequential Neon round trips whose result nothing
      // here consumes (tool handlers re-resolve in requireApproval). Skip it
      // while the same client was touched within the memo window — an
      // initialize still runs until the row's product name is backfilled.
      const memoOn = connectionTouchMemoEnabled();
      if (memoOn && shouldSkipEagerResolve(userId, clientId, !!clientInfo)) {
        connectionResolve = 'skipped';
      } else {
        const t0 = performance.now();
        try {
          const result = await resolveConnection(userId, clientId, clientInfo, profileSlug);
          connectionResolve = 'ran';
          if (memoOn && result.authorized) {
            recordEagerResolve(userId, clientId, result.clientName !== clientId);
          }
        } catch (err) {
          connectionResolve = 'error';
          console.error('[MCP] Eager connection creation failed:', describeErrorForLog(err));
        }
        connectionResolveMs = Math.round(performance.now() - t0);
      }
    }
  }

  captureAuthAttemptNow();
  return authInfo;
};

// ─── Transport-layer observability ──────────────────────────────────────────

const TRANSPORT_REJECT_STATUSES = new Set([400, 404, 406, 415]);
const MAX_REJECT_BODY_CHARS = 100_000;

/**
 * Everything the MCP transport refuses BEFORE a tool callback runs was
 * invisible: the SDK writes its own 4xx (unsupported protocol version,
 * batched initialize, missing Accept) and its own `isError` tool results for
 * argument-validation failures and unknown tools, none of which pass through
 * withToolAnalytics — so a client that kept sending calls the transport
 * rejected produced ZERO events and looked like a client that never called
 * (2026-09-03 support case: HTTP 400s at human cadence, unattributable).
 *
 * Runs inside experimental_withMcpAuth, so `req.auth` is resolved and every
 * event here lands on the caller's person. Three captures:
 *   - mcp_transport_rejected: our own 400 for an unparseable JSON body (the
 *     handler awaits `req.json()` unguarded and otherwise never answers —
 *     the request hangs to the function timeout), plus every SDK 4xx with
 *     its JSON-RPC error message, classified by `reason` (see
 *     classifyTransportRejection — `discover_probe` is expected traffic
 *     from MCP 2026-07-28 clients, not a refused user).
 *   - mcp_input_validation_failed: SDK-emitted `isError` results for
 *     -32602 (invalid arguments / unknown tool), detected from a tee of the
 *     POST response body AFTER it has been returned, so the client is never
 *     delayed. GET (the long-lived SSE stream) is never buffered.
 */
type AuthedRequest = Request & { auth?: { clientId?: string; extra?: { userId?: string } } };

const withTransportObservability =
  (h: (req: Request) => Promise<Response>) =>
  async (req: Request): Promise<Response> => {
    const auth = (req as AuthedRequest).auth;
    const distinctId = auth?.extra?.userId ?? 'anonymous-mcp';
    const base = () => ({
      client_id: auth?.clientId,
      user_agent: req.headers.get('user-agent') ?? undefined,
      protocol_version_header: req.headers.get('mcp-protocol-version') ?? undefined,
      method: req.method,
    });

    let envelope: ReturnType<typeof parseRpcEnvelope> | undefined;
    if (req.method === 'POST' && (req.headers.get('content-type') ?? '').includes('application/json')) {
      let text = '';
      try { text = await req.clone().text(); } catch { /* unreadable body: let the handler decide */ }
      envelope = parseRpcEnvelope(text);
      if (envelope.parseError) {
        captureServerEvent(distinctId, 'mcp_transport_rejected', {
          ...base(), status: 400, reason: 'parse_error', body_chars: text.length,
        });
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: request body is not valid JSON' }, id: null },
          { status: 400 },
        );
      }
    }

    const res = await h(req);

    if (TRANSPORT_REJECT_STATUSES.has(res.status)) {
      let message: string | undefined;
      try {
        const body = await res.clone().text();
        const parsed = JSON.parse(body.slice(0, MAX_REJECT_BODY_CHARS)) as { error?: { message?: unknown } };
        message = typeof parsed?.error?.message === 'string' ? parsed.error.message.slice(0, 300) : body.slice(0, 300);
      } catch { /* non-JSON rejection body */ }
      // `reason` separates the 2026-07-28 `server/discover` probe (benign: the
      // client falls back to `initialize` on this very 400) from a client the
      // SDK genuinely refuses — the runbook reads them oppositely (7.9).
      captureServerEvent(distinctId, 'mcp_transport_rejected', {
        ...base(), status: res.status, ...classifyTransportRejection(message, envelope?.methods), message,
        rpc_methods: envelope?.methods, tool: envelope?.toolName,
      });
      return res;
    }

    if (req.method === 'POST' && envelope?.toolName && res.ok && res.body) {
      const tool = envelope.toolName;
      const tee = res.clone();
      after(async () => {
        try {
          const body = await tee.text();
          if (!/"isError"\s*:\s*true/.test(body)) return;
          const m = body.match(/MCP error -32602: (Input validation error|Tool [^"\\]{1,64} not found)[^"\\]{0,300}/);
          if (!m) return;
          captureServerEvent(distinctId, 'mcp_input_validation_failed', {
            ...base(), tool, kind: m[1].startsWith('Tool') ? 'unknown_tool' : 'invalid_arguments', message: m[0].slice(0, 300),
          });
        } catch { /* tee read failed — nothing to record */ }
      });
    }
    return res;
  };

// All verbs run behind auth: unauthenticated requests — including the
// streamable-HTTP GET (SSE) and DELETE (session teardown) — must get the
// 401 + WWW-Authenticate handshake, not an unauthenticated handler.
const authedHandler = experimental_withMcpAuth(
  withTransportObservability(handler),
  verifyMcpAuth,
  {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
  }
);

// experimental_withMcpAuth takes resourceMetadataPath as a module-level
// constant, but profile-addressed URLs (/api/mcp/<slug>, rewritten by
// middleware with the slug in a header) need their 401s to point at the
// per-slug metadata document — the MCP spec requires the advertised
// `resource` to match the URL the client connected to exactly. Patch the
// pointer on the way out.
const withProfileResourceMetadata =
  (h: (req: Request) => Promise<Response>) =>
  async (req: Request): Promise<Response> => {
    const slug = req.headers.get('x-fgac-profile-slug');
    // The middleware rewrite routes /api/mcp/<slug> to this file, but the
    // handler still sees the ORIGINAL external URL in req.url — and
    // mcp-handler 404s on anything that isn't exactly '/api/mcp'. Normalize
    // before handing over; the slug survives in the header.
    if (slug) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/mcp') {
        url.pathname = '/api/mcp';
        req = new Request(url, req);
      }
    }
    const res = await h(req);
    if (!slug || res.status !== 401) return res;
    const www = res.headers.get('WWW-Authenticate');
    if (!www || !www.includes('resource_metadata=')) return res;
    const headers = new Headers(res.headers);
    headers.set(
      'WWW-Authenticate',
      www.replace(
        /resource_metadata="([^"]+?)\/?"/,
        (_m, base) => `resource_metadata="${base}/${slug}"`,
      ),
    );
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

const profileAwareHandler = withProfileResourceMetadata(authedHandler);

export const POST = profileAwareHandler;
export const GET = profileAwareHandler;
export const DELETE = profileAwareHandler;

// Headroom for the sheets grant-propagation grace retries (≤ ~7 s added on
// top of normal Google latency) — never let them race the function timeout.
// googleFetch aborts each Google exchange at GOOGLE_FETCH_TIMEOUT_MS (50 s),
// so a hung upstream call is classified and captured before this kill fires.
export const maxDuration = 60;
