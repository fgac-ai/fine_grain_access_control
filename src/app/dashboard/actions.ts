"use server";

import { db } from "@/db";
import { users, proxyKeys, emailDelegations, keyEmailAccess, accessRules, keyRuleAssignments } from "@/db/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { findActiveDelegation } from "@/db/delegationQueries";
import { syncDefaultProfileDelegatedAccess } from "@/db/defaultProfile";
import { currentUser, clerkClient } from "@clerk/nextjs/server";
import { clerkPrimaryEmail } from "@/lib/clerkPrimaryEmail";
import { resolveDbUser } from "@/db/userHelpers";
import { revalidatePath } from "next/cache";
import { validateRulePattern, patternKind, assertStorablePattern } from "@/lib/rulePatterns";
import { slugifyProfileLabel } from "@/lib/profileSlugs";
import type { ApprovalSearchParams, ApprovalPayload } from "@/lib/approvalLinks";
import { DRIVE_FILE_KINDS, kindForService, kindForActionType, kindForApprovalAction, type DriveFileKind } from "@/lib/driveFileKinds";
import { grantActiveForApproval } from "@/lib/approvalGrantState";
import { maskEmail } from "@/lib/maskEmail";
import { isDelegateTarget, type DelegationVia } from "@/lib/secondAccount";
import * as jose from "jose";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Every dashboard mutation must refresh /dashboard AND the per-profile
 * routes under /dashboard/agents/[slug] (plus /dashboard/accounts) — the
 * 'layout' scope covers the whole segment. A plain
 * revalidatePath("/dashboard") would leave the slug routes stale, which
 * silently breaks every mutation now that profiles live on their own routes.
 */
function revalidateDashboard() {
  revalidatePath("/dashboard", "layout");
}

/**
 * getDbUser() throws for two reasons a PUBLIC-facing page must not 500 on:
 * signed out ("Unauthorized"), and Clerk-authenticated but with no users row
 * yet ("User not found in DB" — a bystander who has a Clerk session but has
 * never visited the dashboard, which is what auto-provisions the row).
 *
 * Approval links are shareable by nature, so both cases are reachable by
 * anyone who receives a leaked link. QA 2026-08-26 caught the second one as an
 * unhandled 500 on /dashboard/approve.
 */
async function tryGetDbUser() {
  try {
    return await getDbUser();
  } catch {
    return null;
  }
}

async function getDbUser() {
  const user = await currentUser();
  if (!user) throw new Error("Unauthorized");

  const dbUser = await db.select().from(users).where(eq(users.clerkUserId, user.id)).limit(1).then(res => res[0]);
  if (!dbUser) throw new Error("User not found in DB");

  return dbUser;
}

// ─── Email Delegations ──────────────────────────────────────────────────────

export type DelegationActionResult = { ok: true } | { ok: false; error: string };

/**
 * Resolve the delegate's user row for an address typed into the form.
 *
 * The plain `users.email` match misses two people who DO hold FGAC accounts
 * (support case 2026-09-01): a delegate whose `users.email` drifted away from
 * the address they sign in with (see
 * docs/bug_reports/identity_email_drift_breaks_token_lookup.md), and one who
 * signed up with Clerk but whose users row hasn't been provisioned yet (the
 * first dashboard/MCP visit does that). Both hold a Clerk account with a
 * verified claim to the address, so on a miss ask Clerk who owns it and
 * resolve THEIR row — `resolveDbUser` both heals the drift (email sync +
 * own-mailbox access-row re-point, exactly as a dashboard load would) and
 * provisions the missing row.
 */
async function findDelegateUser(delegateEmail: string) {
  // Tombstoned rows (Clerk account deleted) are excluded — delegating to a
  // retired identity would grant access nobody can exercise, and would be
  // resurrected if that address signed up again. Newest first, since
  // historical data contains duplicate rows per email.
  const byEmail = await db.select().from(users)
    .where(and(eq(users.email, delegateEmail), isNull(users.deletedAt)))
    .orderBy(desc(users.createdAt))
    .limit(1).then(res => res[0]);
  if (byEmail) return byEmail;

  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ emailAddress: [delegateEmail] });
    // Only a VERIFIED claim to the address counts — an unverified address on
    // someone's Clerk profile must not receive a delegation.
    const clerkUser = data.find(u => u.emailAddresses.some(
      e => e.emailAddress.toLowerCase() === delegateEmail && e.verification?.status === 'verified',
    ));
    if (!clerkUser) return undefined;
    return await resolveDbUser(clerkUser.id, clerkPrimaryEmail(clerkUser) ?? delegateEmail);
  } catch (err) {
    console.error("[createDelegation] Clerk delegate lookup failed:", err);
    return undefined;
  }
}

/**
 * Create a delegation: the current user (owner) grants another user (delegate)
 * permission to create API keys that access the owner's Gmail.
 */
export async function createDelegation(formData: FormData): Promise<DelegationActionResult> {
  const dbUser = await getDbUser();
  const delegateEmail = (formData.get("delegateEmail") as string)?.trim().toLowerCase();

  // Expected-case refusals are RETURNED, never thrown: production replaces a
  // thrown server-action message with an opaque digest, so the form rendered
  // gibberish precisely when the user needed telling what to do (support case
  // 2026-09-01). Same contract as RuleActionResult below. A quiet `return`
  // without the error is equally wrong — it closes the form as if the
  // delegation had succeeded.
  if (!delegateEmail) {
    return { ok: false, error: "Enter the email address of the person you want to delegate to." };
  }

  // Can't delegate to yourself
  if (delegateEmail === dbUser.email.toLowerCase()) {
    return { ok: false, error: "You already have full access to your own mailbox." };
  }

  const delegateUser = await findDelegateUser(delegateEmail);

  if (!delegateUser) {
    // There is deliberately no invite flow — the delegate must already have an
    // FGAC account. Say so, instead of closing the form as if it worked.
    return {
      ok: false,
      error: `No FGAC account found for ${delegateEmail}. Ask them to sign up at fgac.ai with that Google account first, then grant access again.`,
    };
  }

  await grantDelegation(dbUser, delegateUser, { via: 'form' });
  revalidateDashboard();
  return { ok: true };
}

/**
 * One-click delegation to a known account — the second-account repair
 * (src/lib/secondAccount.ts). The signed-in user is the OWNER of the mailbox
 * being delegated, exactly as in createDelegation; the difference is that the
 * recipient arrives as a `users.id` (from the delegate link or the dashboard
 * prompt) instead of a typed address, and the caller says which surface
 * asked, so `delegation_created.via` can measure each one's conversion.
 */
export async function delegateToUser(
  targetUserId: string,
  via: Exclude<DelegationVia, 'form' | 'approve_wall'>,
  props: { prior_gap_s?: number } = {},
): Promise<DelegationActionResult & { maskedEmail?: string }> {
  const dbUser = await getDbUser();
  if (!isDelegateTarget(targetUserId)) return { ok: false, error: 'This link is not a valid account link.' };
  const target = await db.select().from(users)
    .where(and(eq(users.id, targetUserId), isNull(users.deletedAt)))
    .limit(1).then(res => res[0]);
  if (!target) return { ok: false, error: 'That FGAC account no longer exists.' };
  if (target.id === dbUser.id || target.email.toLowerCase() === dbUser.email.toLowerCase()) {
    return { ok: false, error: 'This is your own account link — open it signed in as the account you want to add.' };
  }
  await grantDelegation(dbUser, target, { via, ...props });
  revalidateDashboard();
  return { ok: true, maskedEmail: maskEmail(target.email) };
}

/**
 * The wrong-account wall's repair: the visitor signed in as a DIFFERENT
 * account than the approval link's owner delegates their own mailbox to that
 * owner. Same authorization as the wall itself — the owner is resolved from
 * the link's key id and the signature re-verified against them, so a forged
 * link resolves nobody and nothing is written. The visitor is the owner of
 * the mailbox being granted, which is the only party who can grant it.
 */
export async function delegateToApprovalOwner(
  link: ApprovalSearchParams,
  props: { prior_session_matches: boolean },
): Promise<DelegationActionResult & { maskedEmail?: string }> {
  const dbUser = await getDbUser();
  const owner = await resolveApprovalOwner(link);
  if (!owner) return { ok: false, error: 'This approval link could not be verified.' };
  if (owner.ownerId === dbUser.id || owner.ownerEmail.toLowerCase() === dbUser.email.toLowerCase()) {
    return { ok: false, error: 'You are already signed in as the account this link belongs to.' };
  }
  const target = await db.select().from(users)
    .where(and(eq(users.id, owner.ownerId), isNull(users.deletedAt)))
    .limit(1).then(res => res[0]);
  if (!target) return { ok: false, error: 'That FGAC account no longer exists.' };
  await grantDelegation(dbUser, target, { via: 'approve_wall', ...props, action: owner.action });
  // Accounts page only — NOT the 'layout' scope. Revalidating the layout
  // re-renders /dashboard/approve inside this action's response, and the
  // server now says "already attached": the card's done state (with its
  // "Switch to <owner>" button) was replaced after ~250 ms (local QA
  // 2026-09-21). The visitor's own Accounts page is what changed.
  revalidatePath("/dashboard/accounts");
  return { ok: true, maskedEmail: maskEmail(target.email) };
}

/**
 * Shared write behind every delegation path: create or re-activate the
 * owner → delegate row, attach the mailbox to the delegate's Default Profile,
 * and record `delegation_created` with the surface that asked.
 */
async function grantDelegation(
  dbUser: { id: string; email: string; clerkUserId: string },
  delegateUser: { id: string; email: string },
  props: { via: DelegationVia } & Record<string, unknown>,
): Promise<void> {
  const delegateEmail = delegateUser.email.toLowerCase();
  // Check for existing active delegation
  const existing = await db.select().from(emailDelegations)
    .where(and(
      eq(emailDelegations.ownerUserId, dbUser.id),
      eq(emailDelegations.delegateUserId, delegateUser.id),
    ))
    .limit(1).then(res => res[0]);

  if (existing && existing.status === 'active') {
    console.log("[createDelegation] Delegation already active");
    // Self-heal: re-materialize onto the delegate's Default Profile in case a
    // prior sync was missed (e.g. the profile didn't exist yet).
    await syncDefaultProfileDelegatedAccess(delegateUser.email);
    return;
  }

  if (existing && existing.status === 'revoked') {
    // Re-activate the existing delegation. Revocation deleted the
    // key_email_access rows, so the default-profile sync below must re-add them.
    await db.update(emailDelegations).set({
      status: 'active',
      revokedAt: null,
    }).where(eq(emailDelegations.id, existing.id));
  } else {
    // Create new delegation
    await db.insert(emailDelegations).values({
      ownerUserId: dbUser.id,
      delegateUserId: delegateUser.id,
      status: 'active',
    });
  }

  // The delegate's Default Profile gets the mailbox immediately — delegation is
  // the owner's explicit grant, and instant-start connections run on the
  // default key. Custom profiles remain per-mailbox opt-in.
  await syncDefaultProfileDelegatedAccess(delegateUser.email);

  const { captureServerEvent } = await import("@/lib/posthogServer");
  captureServerEvent(dbUser.clerkUserId, "delegation_created", {
    delegate_email: delegateEmail,
    reactivated: existing?.status === 'revoked',
    ...props,
  });
}

/**
 * Revoke a delegation. Only the owner can revoke.
 */
export async function revokeDelegation(delegationId: string) {
  const dbUser = await getDbUser();

  const delegation = await db.select().from(emailDelegations)
    .where(eq(emailDelegations.id, delegationId))
    .limit(1).then(res => res[0]);

  if (!delegation || delegation.ownerUserId !== dbUser.id) {
    throw new Error("Unauthorized");
  }

  await db.update(emailDelegations).set({
    status: 'revoked',
    revokedAt: new Date(),
  }).where(eq(emailDelegations.id, delegationId));

  // Tear down the access this delegation granted. Flipping the status alone left
  // the delegate's key_email_access rows in place, and the proxy authorises on
  // those rows — so "revoked" delegations kept working. The proxy now re-checks
  // the delegation too, but the rows should not linger regardless.
  await db.delete(keyEmailAccess).where(eq(keyEmailAccess.delegationId, delegationId));

  revalidateDashboard();
}

// ─── Pending approvals (dashboard banner) ───────────────────────────────────

/**
 * "Dismiss" on a pending-approvals banner entry. Hides the request until the
 * agent mints its link again (src/lib/approvalPending.ts). Scoped to the
 * signed-in owner: a request id alone cannot hide someone else's entry.
 */
export async function dismissPendingApproval(requestId: string) {
  const dbUser = await getDbUser();
  const { dismissApprovalRequest } = await import("@/lib/approvalRequests");
  const { captureServerEvent } = await import("@/lib/posthogServer");
  const action = await dismissApprovalRequest(requestId, dbUser.id);
  if (action) {
    captureServerEvent(dbUser.clerkUserId, "approval_banner_dismissed", { request_id: requestId, action });
  }
  revalidateDashboard();
}

// ─── Proxy Keys ─────────────────────────────────────────────────────────────

export async function createProxyKey(formData: FormData) {
  const dbUser = await getDbUser();
  const label = formData.get("label") as string;
  const emailAddresses = formData.getAll("emails") as string[];

  // Profile adoption is otherwise invisible in PostHog (no event carries a
  // key id), so the daily review needs the attempt AND the refusal reasons
  // to tell "nobody wants profiles" from "people try and fail". The reasons
  // are the refusals below, by design; the label itself is never captured.
  const profileEvent = async (event: 'agent_profile_created' | 'agent_profile_create_failed', props: Record<string, unknown>) => {
    const { captureServerEvent } = await import("@/lib/posthogServer");
    captureServerEvent(dbUser.clerkUserId, event, { accounts: emailAddresses.length, ...props });
  };

  // Returned, not thrown, like every refusal below — production masks thrown
  // server-action messages (see DelegationActionResult).
  if (!label) {
    await profileEvent('agent_profile_create_failed', { reason: 'missing_label' });
    return { error: "Label is required." };
  }

  // Profile labels double as MCP URL slugs (/api/mcp/<slug>, see
  // src/lib/profileSlugs.ts). Two labels that slugify identically would make
  // the URL ambiguous, so block the collision here — labels are immutable
  // after creation, which makes this the only enforcement point. Returned as
  // a value, not thrown: production masks server-action error messages, and
  // the user needs to see WHY the label was refused.
  const slug = slugifyProfileLabel(label);
  if (!slug) {
    await profileEvent('agent_profile_create_failed', { reason: 'unslugifiable_label' });
    return { error: "Label must contain at least one letter or number." };
  }
  const existingKeys = await db.query.proxyKeys.findMany({
    where: and(eq(proxyKeys.userId, dbUser.id), isNull(proxyKeys.revokedAt)),
  });
  const clash = existingKeys.find(k => slugifyProfileLabel(k.label) === slug);
  if (clash) {
    await profileEvent('agent_profile_create_failed', { reason: 'slug_clash', existing_profiles: existingKeys.length });
    return {
      error: `A profile named "${clash.label}" already uses the URL slug "${slug}". Pick a label that differs by more than punctuation or casing.`,
    };
  }

  // Resolve the delegation backing every non-own address BEFORE creating the
  // key: a refusal after the insert used to leave an orphaned key with partial
  // access. Every non-own address must be backed by an ACTIVE delegation,
  // recorded on the row so revocation can tear it down again.
  const grants: { email: string; delegationId: string | null }[] = [];
  for (const email of emailAddresses) {
    let delegationId: string | null = null;

    if (email.toLowerCase() !== dbUser.email.toLowerCase()) {
      // Matched on both emails: the previous `.limit(1)` lookup of the owner
      // row picked arbitrarily among duplicate rows for the same address, so a
      // real delegation could come back empty.
      const delegation = await findActiveDelegation(email, dbUser.email);

      if (!delegation) {
        // Previously this fell through and inserted the row with a null
        // delegationId — granting access that no delegation backed, that
        // revocation could not remove, and that looked like the user's own
        // mailbox to every downstream check.
        await profileEvent('agent_profile_create_failed', { reason: 'no_delegation', existing_profiles: existingKeys.length });
        return { error: `No active delegation grants you access to ${email}.` };
      }

      delegationId = delegation.id;
    }

    grants.push({ email, delegationId });
  }

  // Generate RSA Keypair for Service Account compatibility
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const publicKeyPem = await jose.exportSPKI(publicKey);
  const privateKeyPem = await jose.exportPKCS8(privateKey);

  // Create the key
  const proxyKeyString = `sk_proxy_${crypto.randomUUID().replace(/-/g, '')}`;
  const newKey = await db.insert(proxyKeys).values({
    userId: dbUser.id,
    key: proxyKeyString,
    publicKey: publicKeyPem,
    label,
  }).returning().then(res => res[0]);

  await profileEvent('agent_profile_created', {
    delegated_accounts: grants.filter(g => g.delegationId).length,
    // Live profiles BEFORE this one (the Default Profile counts): 1 = the
    // user's first non-default profile, the adoption moment the review watches.
    existing_profiles: existingKeys.length,
  });

  for (const { email, delegationId } of grants) {
    await db.insert(keyEmailAccess).values({
      proxyKeyId: newKey.id,
      delegationId,
      targetEmail: email,
    });

    const { captureServerEvent } = await import("@/lib/posthogServer");
    captureServerEvent(dbUser.clerkUserId, "account_linked", {
      target_email: email,
      delegated: !!delegationId,
      via: "create_key",
    });
  }

  revalidateDashboard();

  // We return the private key and proxy key string so the UI can construct the generated JSON
  return {
    proxyKey: proxyKeyString,
    privateKey: privateKeyPem,
  };
}

export async function revokeProxyKey(keyId: string) {
  const dbUser = await getDbUser();

  const key = await db.select().from(proxyKeys).where(eq(proxyKeys.id, keyId)).limit(1).then(res => res[0]);
  if (!key || key.userId !== dbUser.id) throw new Error("Unauthorized");

  await db.update(proxyKeys).set({ revokedAt: new Date() }).where(eq(proxyKeys.id, keyId));
  revalidateDashboard();
}

export async function rollProxyKey(keyId: string) {
  const dbUser = await getDbUser();

  const oldKey = await db.select().from(proxyKeys).where(eq(proxyKeys.id, keyId)).limit(1).then(res => res[0]);
  if (!oldKey || oldKey.userId !== dbUser.id) throw new Error("Unauthorized");

  // Get old key's email access
  const oldEmailAccess = await db.select().from(keyEmailAccess).where(eq(keyEmailAccess.proxyKeyId, keyId));

  // Get old key's rule assignments
  const oldRuleAssignments = await db.select().from(keyRuleAssignments).where(eq(keyRuleAssignments.proxyKeyId, keyId));

  // Create new key with same label
  const newKey = await db.insert(proxyKeys).values({
    userId: dbUser.id,
    key: `sk_proxy_${crypto.randomUUID().replace(/-/g, '')}`,
    label: oldKey.label,
  }).returning().then(res => res[0]);

  // Copy email access
  for (const ea of oldEmailAccess) {
    await db.insert(keyEmailAccess).values({
      proxyKeyId: newKey.id,
      delegationId: ea.delegationId,
      targetEmail: ea.targetEmail,
    });
  }

  // Copy rule assignments
  for (const ra of oldRuleAssignments) {
    await db.insert(keyRuleAssignments).values({
      proxyKeyId: newKey.id,
      accessRuleId: ra.accessRuleId,
    });
  }

  // Revoke old key
  await db.update(proxyKeys).set({ revokedAt: new Date() }).where(eq(proxyKeys.id, keyId));

  revalidateDashboard();
}

// ─── Access Rules ───────────────────────────────────────────────────────────

/**
 * Server actions that a modal submits must RETURN their failure, never throw.
 * Next.js redacts thrown server-action messages in production and replaces them
 * with an opaque digest, so a thrown validation error reaches the browser as a
 * blank 500 — which is precisely why the 2026-04-10 pattern regression went
 * unnoticed for four months. A returned value is not redacted.
 */
export type RuleActionResult = { ok: true } | { ok: false; error: string };

/**
 * Rule-save telemetry. The pattern itself is NEVER sent: send_whitelist
 * patterns are real email addresses. Shape and length carry the signal.
 */
async function reportRuleSave(
  clerkUserId: string,
  event: "rule_saved" | "rule_save_failed",
  props: Record<string, unknown>,
) {
  const { captureServerEvent } = await import("@/lib/posthogServer");
  captureServerEvent(clerkUserId, event, props);
}


export async function createRule(formData: FormData): Promise<RuleActionResult> {
  const dbUser = await getDbUser();
  const ruleName = formData.get("ruleName") as string;
  const service = formData.get("service") as string;
  const actionType = formData.get("actionType") as string;
  const rawPattern = formData.get("regexPattern") as string;
  const targetEmail = formData.get("targetEmail") as string || null;
  const keyIds = formData.getAll("keyIds") as string[];

  if (!ruleName || !service || !actionType) {
    console.error("[createRule] Missing required fields:", { ruleName, service, actionType });
    await reportRuleSave(dbUser.clerkUserId, "rule_save_failed", {
      mode: "create", service, action_type: actionType, via: "dashboard_manual",
      reason: "missing_fields",
    });
    return { ok: false, error: "Rule name, service and action type are all required." };
  }

  let finalRegexPattern: string | null = null;
  let targetResourceId: string | null = null;

  if (kindForService(service)) {
    targetResourceId = rawPattern;
  } else {
    finalRegexPattern = rawPattern;
    if (finalRegexPattern) {
      const check = validateRulePattern(finalRegexPattern);
      if (!check.ok) {
        await reportRuleSave(dbUser.clerkUserId, "rule_save_failed", {
          mode: "create", service, action_type: actionType, via: "dashboard_manual",
          reason: check.reason,
          pattern_kind: patternKind(finalRegexPattern),
          pattern_length: finalRegexPattern.length,
        });
        return { ok: false, error: check.message };
      }
    }
  }

  const newRule = await db.insert(accessRules).values({
    userId: dbUser.id,
    ruleName,
    service,
    actionType,
    regexPattern: finalRegexPattern,
    targetResourceId,
    targetEmail: targetEmail || null,
  }).returning().then(res => res[0]);

  for (const keyId of keyIds) {
    await db.insert(keyRuleAssignments).values({
      proxyKeyId: keyId,
      accessRuleId: newRule.id,
    });
  }

  await reportRuleSave(dbUser.clerkUserId, "rule_saved", {
    mode: "create", service, action_type: actionType, via: "dashboard_manual",
    scoped: !!targetEmail, assigned_keys: keyIds.length,
    ...(targetResourceId ? { file_id: targetResourceId } : {}),
    ...(finalRegexPattern ? {
      pattern_kind: patternKind(finalRegexPattern),
      pattern_length: finalRegexPattern.length,
    } : {}),
  });

  // A hand-typed file id has no Picker pick behind it, so Google may hold no
  // drive.file grant — the same stranded-rule dead end the magic-link flow
  // verifies against. Record the grant state at rule birth so these rules are
  // visible in the funnel instead of silently broken. Telemetry only: a
  // Google hiccup must never fail rule creation.
  if (kindForService(service) && targetResourceId) {
    try {
      const { verifyFileGrant, getOwnerGoogleToken } = await import("@/lib/driveFileGrantCheck");
      const { captureServerEvent } = await import("@/lib/posthogServer");
      const kind = kindForService(service)!;
      const d = DRIVE_FILE_KINDS[kind];
      const token = await getOwnerGoogleToken(dbUser.clerkUserId);
      const grant = token
        ? await verifyFileGrant(kind, token, targetResourceId)
        : { state: 'missing' as const };
      captureServerEvent(
        dbUser.clerkUserId,
        d.grantAnalytics.verificationEvent,
        {
          result: grant.state,
          via: "dashboard_manual",
          [d.createdAnalytics.idProp]: targetResourceId,
        },
      );
    } catch (err) {
      console.error("[createRule] grant verification failed:", err);
    }
  }

  revalidateDashboard();
  return { ok: true };
}

export async function updateRule(formData: FormData): Promise<RuleActionResult> {
  const dbUser = await getDbUser();
  const ruleId = formData.get("ruleId") as string;
  const ruleName = formData.get("ruleName") as string;
  const service = formData.get("service") as string;
  const actionType = formData.get("actionType") as string;
  const rawPattern = formData.get("regexPattern") as string;
  const targetEmail = formData.get("targetEmail") as string || null;
  const keyIds = formData.getAll("keyIds") as string[];

  if (!ruleId || !ruleName || !service || !actionType) {
    console.error("[updateRule] Missing required fields");
    await reportRuleSave(dbUser.clerkUserId, "rule_save_failed", {
      mode: "update", service, action_type: actionType, via: "dashboard_manual",
      reason: "missing_fields",
    });
    return { ok: false, error: "Rule name, service and action type are all required." };
  }

  let finalRegexPattern: string | null = null;
  let targetResourceId: string | null = null;

  if (kindForService(service)) {
    targetResourceId = rawPattern;
  } else {
    finalRegexPattern = rawPattern;
    if (finalRegexPattern) {
      const check = validateRulePattern(finalRegexPattern);
      if (!check.ok) {
        await reportRuleSave(dbUser.clerkUserId, "rule_save_failed", {
          mode: "update", service, action_type: actionType, via: "dashboard_manual",
          reason: check.reason,
          pattern_kind: patternKind(finalRegexPattern),
          pattern_length: finalRegexPattern.length,
        });
        return { ok: false, error: check.message };
      }
    }
  }

  // Verify ownership
  const rule = await db.select().from(accessRules).where(eq(accessRules.id, ruleId)).limit(1).then(res => res[0]);
  if (!rule || rule.userId !== dbUser.id) {
    await reportRuleSave(dbUser.clerkUserId, "rule_save_failed", {
      mode: "update", service, action_type: actionType, via: "dashboard_manual",
      reason: "not_found_or_forbidden",
    });
    return { ok: false, error: "That rule no longer exists, or it is not yours to edit." };
  }

  // Update the rule
  await db.update(accessRules).set({
    ruleName,
    service,
    actionType,
    regexPattern: finalRegexPattern,
    targetResourceId: kindForService(service) ? targetResourceId : rule.targetResourceId,
    targetEmail: targetEmail || null,
  }).where(eq(accessRules.id, ruleId));

  // Reconcile key assignments: remove old, add new
  await db.delete(keyRuleAssignments).where(eq(keyRuleAssignments.accessRuleId, ruleId));
  for (const keyId of keyIds) {
    await db.insert(keyRuleAssignments).values({
      proxyKeyId: keyId,
      accessRuleId: ruleId,
    });
  }

  await reportRuleSave(dbUser.clerkUserId, "rule_saved", {
    mode: "update", service, action_type: actionType, via: "dashboard_manual",
    scoped: !!targetEmail, assigned_keys: keyIds.length,
    ...(targetResourceId ? { file_id: targetResourceId } : {}),
    ...(finalRegexPattern ? {
      pattern_kind: patternKind(finalRegexPattern),
      pattern_length: finalRegexPattern.length,
    } : {}),
  });

  revalidateDashboard();
  return { ok: true };
}

export async function deleteRule(id: string) {
  const dbUser = await getDbUser();

  const rule = await db.select().from(accessRules).where(eq(accessRules.id, id)).limit(1).then(res => res[0]);
  if (!rule || rule.userId !== dbUser.id) {
    throw new Error("Unauthorized or Rule not found");
  }

  await db.delete(accessRules).where(eq(accessRules.id, id));
  revalidateDashboard();
}

/**
 * Persist files picked in the Google Picker as access rules (shared by the
 * sheets, docs, and slides exposure flows).
 *
 * With a profileId the exposure is scoped to that profile; without one it is
 * global. Existing rules are never narrowed: a global rule stays global, and a
 * profile-scoped rule gains the new assignment instead of replacing the set.
 */
export async function exposeFilesFromPicker(
  kind: DriveFileKind,
  picked: { id: string; name: string }[],
  profileId?: string,
) {
  const d = DRIVE_FILE_KINDS[kind];
  const dbUser = await getDbUser();

  if (profileId) {
    const key = await db.select().from(proxyKeys)
      .where(and(eq(proxyKeys.id, profileId), eq(proxyKeys.userId, dbUser.id)))
      .limit(1).then(res => res[0]);
    if (!key) throw new Error("Unauthorized or profile not found");
  }

  const fallbackNoun = d.nounCap;
  for (const file of picked) {
    if (!file?.id) continue;
    const name = file.name || `${fallbackNoun} (${file.id.slice(0, 8)})`;

    const existing = await db.select().from(accessRules)
      .where(and(
        eq(accessRules.userId, dbUser.id),
        eq(accessRules.service, d.service),
        eq(accessRules.targetResourceId, file.id),
      ))
      .limit(1).then(res => res[0]);

    if (existing) {
      await db.update(accessRules)
        .set({ ruleName: name, resourceName: name, updatedAt: new Date() })
        .where(eq(accessRules.id, existing.id));

      if (profileId) {
        const assignments = await db.select().from(keyRuleAssignments)
          .where(eq(keyRuleAssignments.accessRuleId, existing.id));
        const alreadyGlobal = assignments.length === 0;
        const alreadyAssigned = assignments.some(a => a.proxyKeyId === profileId);
        if (!alreadyGlobal && !alreadyAssigned) {
          await db.insert(keyRuleAssignments)
            .values({ accessRuleId: existing.id, proxyKeyId: profileId });
        }
      }
    } else {
      const [rule] = await db.insert(accessRules)
        .values({
          userId: dbUser.id,
          ruleName: name,
          service: d.service,
          actionType: d.actionTypes.read,
          targetResourceId: file.id,
          resourceName: name,
        })
        .returning();

      if (profileId) {
        await db.insert(keyRuleAssignments)
          .values({ accessRuleId: rule.id, proxyKeyId: profileId });
      }
    }

    // A picker pick registers the drive.file grant, so this event IS the
    // funnel's dashboard-path success end state.
    await reportRuleSave(dbUser.clerkUserId, "rule_saved", {
      mode: existing ? "update" : "create",
      service: d.service,
      action_type: existing ? existing.actionType : d.actionTypes.read,
      via: "dashboard_picker",
      file_id: file.id,
      profile_scoped: !!profileId,
    });
  }

  revalidateDashboard();
  revalidatePath("/dashboard/accounts");
}

/**
 * Change the permission level on a per-file rule (sheet / doc / slide) in
 * place. The block level intentionally keeps the underlying Google grant
 * while denying access, so a file can be suspended and restored without
 * re-running the Google Picker flow.
 */
export async function setSheetRulePermission(ruleId: string, actionType: string) {
  const dbUser = await getDbUser();

  // Any per-file kind's permission family (sheet_* / doc_* / slide_*).
  const kind = kindForActionType(actionType);
  if (!kind) {
    throw new Error(`Invalid file permission: ${actionType}`);
  }

  const rule = await db.select().from(accessRules).where(eq(accessRules.id, ruleId)).limit(1).then(res => res[0]);
  if (!rule || rule.userId !== dbUser.id) {
    throw new Error("Unauthorized or Rule not found");
  }
  // The action-type family must match the rule's service — a sheets rule can
  // never end up with doc_* or slide_* permissions or vice versa.
  if (rule.service !== DRIVE_FILE_KINDS[kind].service) {
    throw new Error("Permission type does not match the rule's service");
  }

  await db.update(accessRules)
    .set({ actionType, updatedAt: new Date() })
    .where(eq(accessRules.id, ruleId));

  revalidateDashboard();
}

/**
 * Attach existing rules to one agent profile without touching their other
 * assignments. Used by the "Apply a rule" popover, which reuses rules across
 * profiles rather than duplicating them.
 */
export async function assignRulesToKey(keyId: string, ruleIds: string[]) {
  const dbUser = await getDbUser();

  const key = await db.select().from(proxyKeys).where(eq(proxyKeys.id, keyId)).limit(1).then(res => res[0]);
  if (!key || key.userId !== dbUser.id) {
    throw new Error("Unauthorized or Profile not found");
  }

  for (const ruleId of ruleIds) {
    const rule = await db.select().from(accessRules).where(eq(accessRules.id, ruleId)).limit(1).then(res => res[0]);
    if (!rule || rule.userId !== dbUser.id) {
      throw new Error("Unauthorized or Rule not found");
    }

    // The (proxy_key_id, access_rule_id) unique index makes a repeat click a
    // no-op rather than an error.
    await db.insert(keyRuleAssignments)
      .values({ proxyKeyId: keyId, accessRuleId: ruleId })
      .onConflictDoNothing();
  }

  revalidateDashboard();
}

/**
 * Detach one rule from one profile. The rule itself survives — it may still be
 * assigned elsewhere. Note that removing the LAST assignment turns the rule
 * global (applies to every key), which is why the UI warns before doing it.
 */
export async function unassignRuleFromKey(keyId: string, ruleId: string) {
  const dbUser = await getDbUser();

  const rule = await db.select().from(accessRules).where(eq(accessRules.id, ruleId)).limit(1).then(res => res[0]);
  if (!rule || rule.userId !== dbUser.id) {
    throw new Error("Unauthorized or Rule not found");
  }

  await db.delete(keyRuleAssignments).where(and(
    eq(keyRuleAssignments.proxyKeyId, keyId),
    eq(keyRuleAssignments.accessRuleId, ruleId),
  ));

  revalidateDashboard();
}

export async function applyRecommendedSecurityRules() {
  const dbUser = await getDbUser();

  // Guard: skip if user already has read_blacklist rules (prevents duplicates
  // when the "Quick Add 2FA Block" button is clicked multiple times)
  const existing = await db.select().from(accessRules)
    .where(and(
      eq(accessRules.userId, dbUser.id),
      eq(accessRules.actionType, 'read_blacklist'),
    ));
  if (existing.length > 0) {
    revalidateDashboard();
    return;
  }

  const rulesToInsert = [
    {
      userId: dbUser.id,
      ruleName: "Block 2FA Codes",
      service: "gmail",
      actionType: "read_blacklist",
      regexPattern: "2FA Code"
    },
    {
      userId: dbUser.id,
      ruleName: "Block Password Resets",
      service: "gmail",
      actionType: "read_blacklist",
      regexPattern: "Password Reset"
    },
    {
      userId: dbUser.id,
      ruleName: "Block Sign In Alerts",
      service: "gmail",
      actionType: "read_blacklist",
      // "sign-in" (hyphenated) is the idiom security alerts actually use
      // ("New sign-in on Mac", "Unusual sign-in activity"); the previous
      // "Sign In" (spaced) matched conversational prose ("sign in to the
      // portal") instead — blocking business mail while missing the alerts
      // (support case, 2026-09-03).
      regexPattern: "sign-in"
    },
    {
      userId: dbUser.id,
      ruleName: "Block Verification Codes",
      service: "gmail",
      actionType: "read_blacklist",
      regexPattern: "Verification Code"
    }
  ];

  for (const r of rulesToInsert) {
    assertStorablePattern(r.regexPattern, 'applyRecommendedSecurityRules');
  }
  await db.insert(accessRules).values(rulesToInsert);
  const { captureServerEvent } = await import("@/lib/posthogServer");
  captureServerEvent(dbUser.clerkUserId, "shield_enabled", { rules: rulesToInsert.length });
  revalidateDashboard();
}

// ─── Send to Anyone ────────────────────────────────────────────────────────

/**
 * Grant a profile an all-recipients send whitelist ('*' pattern). Shared by
 * the dashboard one-click button and the send_all magic link.
 *
 * Reuses an existing '*' rule only when it already has assignments — adding
 * an assignment to a GLOBAL rule (zero assignments) would silently narrow it
 * to this one key, revoking sending everywhere else. Returns false when the
 * key already has the grant (directly or via a global rule).
 */
async function grantSendToAnyone(dbUserId: string, keyId: string): Promise<boolean> {
  const candidates = await db.select().from(accessRules).where(and(
    eq(accessRules.userId, dbUserId),
    eq(accessRules.service, 'gmail'),
    eq(accessRules.actionType, 'send_whitelist'),
    eq(accessRules.regexPattern, '*'),
  ));

  let reusable: typeof candidates[number] | null = null;
  for (const rule of candidates) {
    const assignments = await db.select().from(keyRuleAssignments)
      .where(eq(keyRuleAssignments.accessRuleId, rule.id));
    if (assignments.length === 0) return false; // global — already covers this key
    if (assignments.some(a => a.proxyKeyId === keyId)) return false; // already granted
    reusable = reusable ?? rule;
  }

  let rule = reusable;
  if (!rule) {
    assertStorablePattern('*', 'grantSendToAnyone');
    [rule] = await db.insert(accessRules).values({
      userId: dbUserId,
      ruleName: 'Send to Anyone',
      service: 'gmail',
      actionType: 'send_whitelist',
      regexPattern: '*',
    }).returning();
  }

  await db.insert(keyRuleAssignments).values({ proxyKeyId: keyId, accessRuleId: rule.id });
  return true;
}

/**
 * One-click "let this profile email anyone" — the escape hatch for users who
 * don't want to whitelist recipients one at a time. Deliberately per-profile
 * (surfaced on the Default Profile in the UI) and reversible by deleting the
 * 'Send to Anyone' rule.
 */
export async function enableSendToAnyone(keyId: string) {
  const dbUser = await getDbUser();

  const key = await db.select().from(proxyKeys)
    .where(and(eq(proxyKeys.id, keyId), eq(proxyKeys.userId, dbUser.id), isNull(proxyKeys.revokedAt)))
    .limit(1).then(r => r[0]);
  if (!key) throw new Error("Unauthorized");

  const granted = await grantSendToAnyone(dbUser.id, key.id);
  if (granted) {
    const { captureServerEvent } = await import("@/lib/posthogServer");
    captureServerEvent(dbUser.clerkUserId, "send_all_enabled", { source: "dashboard" });
  }
  revalidateDashboard();
}

// ─── Magic-Link Approvals (connector-growth Phase C) ───────────────────────

export type MagicApprovalResult =
  | {
      ok: true;
      description: string;
      /** Set when the FGAC rule was created but Google has no drive.file
       * grant for the file yet — the approve page must route the user into
       * the kind's Picker recovery page (`DRIVE_FILE_KINDS[kind].setupPath`)
       * instead of claiming the agent can retry. */
      needsFileGrant?: { kind: DriveFileKind; fileId: string; resourceName?: string };
      /** Set on successful per-file approvals: the primary file a rule was
       * created for. The approve page's success card polls the Google grant
       * for this id before telling the user "the agent can retry now"
       * (drive.file grants are eventually consistent — see driveFileGrantCheck). */
      grantedFile?: { kind: DriveFileKind; fileId: string };
    }
  | {
      ok: false;
      reason: string;
      /** Nothing was written and the user can retry from the same page
       * (e.g. drive.file propagation lag on a just-picked sheet). The
       * approve page must return to the live link URL with this notice —
       * never to a parameter-less "Approval failed" dead end (a user hit
       * exactly that on 2026-08-19: "the link is still valid" on a page
       * that had lost the link). */
      retryable?: boolean;
    };

/** What the approve page needs to render the wrong-account card. */
export interface WrongAccountDetails {
  maskedOwnerEmail: string;
  keyLabel: string;
  action: string;
  /** The REAL analytics request id, recomputed against the resolved owner. */
  requestId: string;
  /** Whoever actually opened the link — their own email, shown unmasked. */
  signedInEmail: string;
  /** The owner's Clerk id — SERVER-ONLY, for the second-account marker
   *  comparison (src/lib/secondAccount.ts). Never rendered. */
  ownerClerkUserId: string;
  /** The visitor's mailbox is already delegated to the owner: the wall's
   *  repair has been done and only the account switch remains. */
  delegationActive: boolean;
}

interface ApprovalOwner {
  ownerId: string;
  ownerEmail: string;
  ownerClerkUserId: string;
  keyLabel: string;
  action: string;
  requestId: string;
}

/**
 * Distinguish "wrong signed-in user" from a forged link. `k` (proxyKeyId) is
 * in the URL in cleartext, so it resolves the link's true owner:
 * proxy_keys.id → userId → users.email. Recomputing the HMAC against the
 * RESOLVED owner proves FGAC authored this exact link for that user —
 * a tampered link verifies against nobody and stays generically invalid
 * (QA capability 14 A7). Returning the owner's email is safe only behind
 * that proof, and it leaves the server masked regardless.
 */
async function resolveApprovalOwner(params: ApprovalSearchParams): Promise<ApprovalOwner | null> {
  if (!params.k || !params.a || !params.s) return null;
  const { verifyApprovalParams } = await import("@/lib/approvalLinks");
  // Revoked keys are deliberately included: the owner should still be told to
  // switch accounts, and then sees the honest "profile was revoked" message.
  const row = await db.select({ label: proxyKeys.label, ownerId: users.id, ownerEmail: users.email, ownerClerkUserId: users.clerkUserId })
    .from(proxyKeys)
    .innerJoin(users, eq(users.id, proxyKeys.userId))
    .where(eq(proxyKeys.id, params.k))
    .limit(1).then(r => r[0]);
  if (!row) return null;
  const verified = await verifyApprovalParams(row.ownerId, params);
  if (!verified.ok) return null;
  return {
    ownerId: row.ownerId,
    ownerEmail: row.ownerEmail,
    ownerClerkUserId: row.ownerClerkUserId,
    keyLabel: row.label,
    action: verified.payload.action,
    requestId: verified.payload.requestId,
  };
}

async function resolveWrongAccountLink(
  params: ApprovalSearchParams,
  signedIn: { email: string },
): Promise<Omit<WrongAccountDetails, "signedInEmail"> | null> {
  const owner = await resolveApprovalOwner(params);
  if (!owner) return null;
  // Is the visitor's mailbox already delegated to the owner? Then the wall's
  // repair is done and the card must not offer it again.
  const active = await findActiveDelegation(signedIn.email, owner.ownerEmail).catch(() => null);
  return {
    maskedOwnerEmail: maskEmail(owner.ownerEmail),
    keyLabel: owner.keyLabel,
    action: owner.action,
    requestId: owner.requestId,
    ownerClerkUserId: owner.ownerClerkUserId,
    delegationActive: active !== null,
  };
}

/**
 * Pre-flight state of an approval link, so the approve page can render the
 * truth at load time instead of letting the user click into an error.
 *
 * Collapsed from five states to three on 2026-08-25. With links no longer
 * single-use or expiring, "used" is neither knowable nor meaningful — the
 * only question that matters is whether the grant it describes is ALREADY
 * ACTIVE. `used_inactive` and `expired` are gone, and with them both dead
 * ends the launch cohort rage-clicked.
 *
 * `wrong_account` re-added 2026-08-30: the pre-08-25 JWT links had an
 * explicit different-account branch, and folding userId into the HMAC made a
 * wrong-account open indistinguishable from a forged link — a support-visible
 * regression. No approval is possible from this state; it is purely the
 * diagnosis the user needs to switch accounts.
 */
export async function resolveApprovalLink(params: ApprovalSearchParams): Promise<
  | { status: "invalid" }
  | { status: "wrong_account"; details: WrongAccountDetails }
  | { status: "fresh" | "already_granted"; payload: ApprovalPayload }
> {
  const { verifyApprovalParams } = await import("@/lib/approvalLinks");
  // A visitor with no FGAC account (or none yet) is not the owner of any link,
  // so this is exactly the "invalid" case — never a 500. Kept distinct from
  // wrong_account: with no users row there is no signed-in FGAC identity to
  // contrast the owner against, and the generic card already says to sign in
  // as the account the agent is connected to.
  const dbUser = await tryGetDbUser();
  if (!dbUser) return { status: "invalid" };
  const verified = await verifyApprovalParams(dbUser.id, params);
  if (!verified.ok) {
    const wrong = await resolveWrongAccountLink(params, dbUser);
    if (wrong) return { status: "wrong_account", details: { ...wrong, signedInEmail: dbUser.email } };
    return { status: "invalid" };
  }
  const p = verified.payload;
  const active = await grantActiveForApproval(p, p.proxyKeyId);
  return { status: active ? "already_granted" : "fresh", payload: p };
}

/**
 * Shared picker-first approval for per-file (sheets/docs) magic links.
 * Extracted from the sheets branch of approveMagicLink when Docs support
 * landed — behavior for sheets is unchanged (same events, same copy).
 *
 * The pick is the real authorization moment — it registers the Google-side
 * drive.file grant AND confirms the file's identity. Rules are created only
 * for picked ids Google confirms the owner's token can reach; the token's id
 * gets NO rule unless it is among them (no phantom rules for ids the agent
 * guessed wrong). drive.file grants are eventually consistent: verifying a
 * pick in the seconds right after a first-time consent (the hottest path for
 * new users) can see "missing" for a file Google IS sharing — same race as
 * the MCP-side grace retries, so the pick gets the same grace instead of
 * failing the user's first approval (observed live 2026-08-19).
 */
async function applyFileGrantApproval(opts: {
  kind: DriveFileKind;
  dbUser: { id: string; clerkUserId: string };
  key: { id: string };
  p: { requestId: string; action: string; resourceName?: string };
  fileId: string;
  readWrite: boolean;
  picked?: { id: string; name?: string }[];
  describe: () => string;
}): Promise<MagicApprovalResult> {
  const { kind, dbUser, key, p, fileId, readWrite, picked, describe } = opts;
  const { verifyFileGrant, getOwnerGoogleToken } = await import("@/lib/driveFileGrantCheck");
  const { markApprovalRequestApproved } = await import("@/lib/approvalRequests");
  const { captureServerEvent } = await import("@/lib/posthogServer");
  const d = DRIVE_FILE_KINDS[kind];
  // Kind-specific analytics/copy from the descriptor: sheets keeps its
  // historical event and prop names and its short noun ("sheet(s)").
  const verificationEvent = d.grantAnalytics.verificationEvent;
  const idProp = d.createdAnalytics.idProp;
  const short = d.shortNoun;
  const googleToken = await getOwnerGoogleToken(dbUser.clerkUserId);

  const grantedResult = (grantedId: string, description: string): MagicApprovalResult =>
    ({ ok: true, description, grantedFile: { kind, fileId: grantedId } });

  const insertFileRule = async (id: string, name: string | null) => {
    const [rule] = await db.insert(accessRules).values({
      userId: dbUser.id,
      ruleName: `${readWrite ? "Read & Write" : "Read Only"}: ${name || id}`,
      service: d.service,
      actionType: readWrite ? d.actionTypes.readWrite : d.actionTypes.read,
      targetResourceId: id,
      resourceName: name,
    }).returning();
    await db.insert(keyRuleAssignments).values({ proxyKeyId: key.id, accessRuleId: rule.id });
    captureServerEvent(dbUser.clerkUserId, "rule_saved", {
      mode: "create",
      service: d.service,
      action_type: readWrite ? d.actionTypes.readWrite : d.actionTypes.read,
      via: "magic_link",
      file_id: id,
      request_id: p.requestId,
    });
  };

  if (picked && picked.length > 0) {
    // Replay dedupe (2026-09-05). This path used to skip the grant-level
    // idempotency check entirely (a pick may substitute a different file), so
    // every extra submit of the same form re-verified each pick with Google,
    // inserted ANOTHER rule per pick, and re-fired approval_link_approved —
    // one production link wrote 11 rules for one sheet in 12 s. Picks whose
    // grant is already live are settled here without a Google call; if that
    // is all of them, the submit is a replay and writes nothing.
    const fileAction = readWrite ? d.approvalActions.write : d.approvalActions.expose;
    const alreadyActive: string[] = [];
    const toVerify: { id: string; name?: string }[] = [];
    for (const s of picked.slice(0, 10)) {
      if (typeof s?.id !== "string" || !s.id) continue;
      const active = await grantActiveForApproval(
        { action: fileAction, userId: dbUser.id, [d.idKey]: s.id },
        key.id,
      );
      if (active) alreadyActive.push(s.id); else toVerify.push(s);
    }
    if (toVerify.length === 0 && alreadyActive.length > 0) {
      captureServerEvent(dbUser.clerkUserId, "approval_link_replayed", {
        action: p.action, request_id: p.requestId, path: "picked", picked_count: alreadyActive.length,
      });
      return grantedResult(
        alreadyActive[0],
        `${describe()} — this was already approved, so nothing changed. The agent can retry its request now.`,
      );
    }
    const verifyPicks = async () => {
      const out: { id: string; name: string | null }[] = [];
      for (const s of toVerify) {
        const check = googleToken
          ? await verifyFileGrant(kind, googleToken, s.id)
          : { state: "missing" as const };
        if (check.state === "ok") {
          out.push({ id: s.id, name: (typeof s.name === "string" && s.name) || ("title" in check ? check.title : null) });
        }
      }
      return out;
    };
    let verified = await verifyPicks();
    for (let attempt = 0; verified.length === 0 && attempt < 2; attempt++) {
      await new Promise(r => setTimeout(r, 3500));
      verified = await verifyPicks();
    }
    if (verified.length === 0) {
      // Read-only failure — the link was NOT consumed; the user can retry.
      // Captured since 2026-09-08: this loop was invisible (only successes
      // fired the verification event), yet one launch-cohort user hit it 12
      // times in two minutes at the ~8 s cadence of the two grace waits above
      // before giving up on the page and granting from the dashboard instead.
      captureServerEvent(dbUser.clerkUserId, verificationEvent, {
        result: "missing", via: "magic_link", picked_count: toVerify.length, request_id: p.requestId,
      });
      return {
        ok: false,
        retryable: true,
        reason: `Google hasn't finished sharing the picked ${short}(s) with FGAC yet. Wait a few seconds and pick again — this link is still valid.`,
      };
    }
    for (const v of verified) await insertFileRule(v.id, v.name);

    // Substitution is judged over everything the user picked, including picks
    // settled above as already granted, so a re-pick of the agent's own file
    // does not read as a substitution just because it needed no new rule.
    const substituted = !verified.some(v => v.id === fileId) && !alreadyActive.includes(fileId);
    captureServerEvent(dbUser.clerkUserId, verificationEvent, {
      result: "ok", via: "magic_link", [idProp]: verified[0].id, request_id: p.requestId,
    });
    await markApprovalRequestApproved(p.requestId);
    captureServerEvent(dbUser.clerkUserId, "approval_link_approved", {
      action: p.action, substituted, granted_count: verified.length,
      already_active_count: alreadyActive.length, request_id: p.requestId,
    });
    revalidateDashboard();
    const names = verified.map(v => v.name || v.id).join(", ");
    const level = readWrite ? "read & write" : "read-only";
    return grantedResult(
      verified[0].id,
      substituted
        ? `Granted ${level} access to ${names}. That's the ${short} you picked — not the ID the agent originally sent, which you don't appear to have. The agent will find the right ${short} in its permissions.`
        : `Granted ${level} access to ${names}.`,
    );
  }

  // Fallback path (no pick info — verification was inconclusive at page
  // load, or a client without the picker flow). Create the rule, verify
  // the Google half, and route to the recovery page when it's missing —
  // never claim "retry now" for a file Google can't reach (the
  // approve→retry→404 dead end the 2026-08 launch cohort churned on).
  await insertFileRule(fileId, p.resourceName || null);
  const grant = googleToken
    ? await verifyFileGrant(kind, googleToken, fileId)
    : { state: "missing" as const };
  captureServerEvent(dbUser.clerkUserId, verificationEvent, {
    result: grant.state,
    via: "magic_link",
    [idProp]: fileId,
    request_id: p.requestId,
  });
  if (grant.state === "missing") {
    await markApprovalRequestApproved(p.requestId);
    captureServerEvent(dbUser.clerkUserId, "approval_link_approved", { action: p.action, request_id: p.requestId });
    revalidateDashboard();
    return {
      ok: true,
      description: describe(),
      needsFileGrant: { kind, fileId, resourceName: p.resourceName || undefined },
    };
  }
  await markApprovalRequestApproved(p.requestId);
  captureServerEvent(dbUser.clerkUserId, "approval_link_approved", { action: p.action, request_id: p.requestId });
  revalidateDashboard();
  return grantedResult(fileId, describe());
}

/**
 * Verify a deterministic approval link and apply exactly the grant it
 * describes.
 *
 * Security gates, in order:
 *   1. HMAC recomputed with the SIGNED-IN user — a link authored for anyone
 *      else fails to verify, which is what binds the owner without putting a
 *      user id in the URL.
 *   2. The proxy key is looked up LIVE, scoped to that user and not revoked.
 *      This is the real authorization; the signature only proves FGAC
 *      authored the URL.
 *
 * There is no expiry gate and no single-use gate (both retired 2026-08-25).
 * Replay safety now comes from grant-level idempotency below: if the grant is
 * already active, nothing is written and success is reported. Re-approving
 * after a REVOCATION deliberately re-grants — the URL is permanent by design,
 * and doing so needs the owner's session plus an explicit click.
 */
export async function approveMagicLink(
  params: ApprovalSearchParams,
  sheetsWriteChoice?: boolean,
  /** Sheets the user just picked in the Google Picker (picker-first flow).
   * Client-supplied and therefore untrusted: rules are created only for
   * picked ids that verify against Google with the owner's token. */
  pickedSheets?: { id: string; name?: string }[],
): Promise<MagicApprovalResult> {
  const { verifyApprovalParams, describeApproval } = await import("@/lib/approvalLinks");
  const { markApprovalRequestApproved } = await import("@/lib/approvalRequests");
  const { captureServerEvent } = await import("@/lib/posthogServer");

  // Must RESOLVE, not throw: a rejected server action leaves the submit button
  // stuck on "Approving…" with no error (QA 2026-08-26, session expired
  // while the page was open).
  const dbUser = await tryGetDbUser();
  if (!dbUser) {
    return {
      ok: false,
      reason: "Your session has expired or this account has no FGAC profile. Sign in as the account the agent is connected to, then open the link again — it stays valid.",
    };
  }

  const verified = await verifyApprovalParams(dbUser.id, params);
  if (!verified.ok) {
    // Stale form POST from a session that switched accounts after the page
    // rendered: give the same wrong-account diagnosis the page itself shows.
    const wrong = await resolveWrongAccountLink(params, dbUser);
    if (wrong) {
      return {
        ok: false,
        reason: `This link was issued for ${wrong.maskedOwnerEmail} (profile "${wrong.keyLabel}"), but you are signed in as ${dbUser.email}. Sign out, sign back in as ${wrong.maskedOwnerEmail}, then open the link again — it stays valid.`,
      };
    }
    return {
      ok: false,
      reason: "This approval link is not valid for your account. If an agent gave it to you, make sure you are signed in as the account the agent is connected to.",
    };
  }
  const p = verified.payload;

  const key = await db.select().from(proxyKeys)
    .where(and(eq(proxyKeys.id, p.proxyKeyId), eq(proxyKeys.userId, dbUser.id), isNull(proxyKeys.revokedAt)))
    .limit(1).then(r => r[0]);
  if (!key) {
    return { ok: false, reason: "The agent profile this link targets no longer exists or was revoked." };
  }

  // Grant-level idempotency, replacing single-use. Re-approving a grant that
  // is already active writes nothing and reports success, so a double submit
  // cannot create a duplicate rule. The effective action accounts for the
  // read→write upgrade choice, so upgrading an existing read grant is NOT
  // short-circuited as "already approved".
  const wantsWrite = sheetsWriteChoice === true;
  const linkKind = kindForApprovalAction(p.action);
  const effectiveAction =
    linkKind && wantsWrite && p.action === DRIVE_FILE_KINDS[linkKind].approvalActions.expose
      ? DRIVE_FILE_KINDS[linkKind].approvalActions.write
      : p.action;
  if (!pickedSheets?.length && await grantActiveForApproval({ ...p, action: effectiveAction }, key.id)) {
    // Replays are counted, not hidden: approval_link_approved fires only when a
    // grant is written, so per-link conversion stays a uniq(request_id) join
    // and this event is the duplicate-submit rate (docs/monitoring.md 7.14).
    captureServerEvent(dbUser.clerkUserId, "approval_link_replayed", {
      action: p.action, request_id: p.requestId, path: "grant_active",
    });
    return {
      ok: true,
      description: `${describeApproval(p)} — this was already approved, so nothing changed. The agent can retry its request now.`,
    };
  }

  if (p.action === "send_whitelist" && p.recipient) {
    const escaped = p.recipient.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const [rule] = await db.insert(accessRules).values({
      userId: dbUser.id,
      ruleName: `Allow sending to ${p.recipient}`,
      service: "gmail",
      actionType: "send_whitelist",
      regexPattern: `^${escaped}$`,
    }).returning();
    await db.insert(keyRuleAssignments).values({ proxyKeyId: key.id, accessRuleId: rule.id });
  } else if (p.action === "send_all") {
    await grantSendToAnyone(dbUser.id, key.id);
  } else if (linkKind && p[DRIVE_FILE_KINDS[linkKind].idKey]) {
    return applyFileGrantApproval({
      kind: linkKind,
      dbUser, key, p,
      fileId: p[DRIVE_FILE_KINDS[linkKind].idKey]!,
      readWrite: p.action === DRIVE_FILE_KINDS[linkKind].approvalActions.write || sheetsWriteChoice === true,
      picked: pickedSheets,
      describe: () => describeApproval(p),
    });
  } else {
    return { ok: false, reason: "This approval link is malformed." };
  }

  await markApprovalRequestApproved(p.requestId);
  captureServerEvent(dbUser.clerkUserId, "approval_link_approved", { action: p.action, request_id: p.requestId });
  revalidateDashboard();
  return { ok: true, description: describeApproval(p) };
}
