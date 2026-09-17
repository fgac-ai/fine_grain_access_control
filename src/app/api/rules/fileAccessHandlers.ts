import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { users, accessRules, keyRuleAssignments, proxyKeys } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { verifyFileGrant, getOwnerGoogleToken, type FileGrantState } from '@/lib/driveFileGrantCheck';
import { DRIVE_FILE_KINDS, type DriveFileKind } from '@/lib/driveFileKinds';
import { captureServerEvent } from '@/lib/posthogServer';

/**
 * Shared implementations behind the per-kind rule routes:
 *   /api/rules/verify-sheets-access  /api/rules/grant-sheets-access
 *   /api/rules/verify-docs-access    /api/rules/grant-docs-access
 *   /api/rules/verify-slides-access  /api/rules/grant-slides-access
 * Extracted from the sheets routes when Docs support landed — sheets request
 * and response shapes (param names, response keys, analytics event names)
 * are unchanged; docs and slides mirror them with their own nouns, all read
 * from the kind descriptor.
 */

const kindNames = (kind: DriveFileKind) => {
  const d = DRIVE_FILE_KINDS[kind];
  return {
    d,
    idParam: d.setupIdParam,                          // sid | did | pid
    idKey: d.idKey,                                   // response key
    idProp: d.createdAnalytics.idProp,                // analytics prop
    recoveredEvent: d.grantAnalytics.recoveredEvent,
    verificationEvent: d.grantAnalytics.verificationEvent,
    rulesKey: d.rulesKey,
    fallbackNoun: d.nounCap,
  };
};

/**
 * GET verify-<kind>s-access[?sid|did=<fileId>][&context=recovery]
 *
 * For the signed-in user, checks whether Google actually grants us access to
 * the file(s) behind their rules (FGAC rule ≠ Google grant — see
 * driveFileGrantCheck.ts). Without an id, verifies every rule of this kind
 * and returns a map; with one, verifies just that file (it does not need an
 * existing rule — the approval flow verifies before the page settles).
 *
 * `context=recovery` marks a re-check issued by the recovery UI right after a
 * Picker pick; a verified `ok` in that context is the "user completed the
 * recovery loop" signal and fires <kind>s_grant_recovered.
 */
export async function verifyFileAccessGET(kind: DriveFileKind, request: NextRequest) {
  const n = kindNames(kind);
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const fileId = searchParams.get(n.idParam);
    const context = searchParams.get('context');

    const token = await getOwnerGoogleToken(clerkUserId);

    if (fileId) {
      const result: FileGrantState = token
        ? await verifyFileGrant(kind, token, fileId)
        : { state: 'missing' };
      if (context === 'recovery') {
        // Every recovery re-check is captured, not just the successes —
        // attempts that stay 'missing' are the funnel's stuck users.
        captureServerEvent(clerkUserId, n.verificationEvent, {
          result: result.state, via: 'recovery', [n.idProp]: fileId,
        });
        if (result.state === 'ok') {
          captureServerEvent(clerkUserId, n.recoveredEvent, { [n.idProp]: fileId });
        }
      }
      // link_open = the approve page checking the grant before showing the
      // flow — the top of the picker-first funnel. post_approval = the
      // success card confirming the grant settled before telling the user
      // "the agent can retry now" (grant-race fix).
      if (context === 'link_open' || context === 'post_approval') {
        captureServerEvent(clerkUserId, n.verificationEvent, {
          result: result.state, via: context, [n.idProp]: fileId,
        });
      }
      return NextResponse.json({ [n.idKey]: fileId, ...result });
    }

    const dbUser = await db.select().from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1).then(r => r[0]);
    if (!dbUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const rules = await db.select().from(accessRules).where(
      and(eq(accessRules.userId, dbUser.id), eq(accessRules.service, n.d.service)),
    );

    // Distinct file ids only — several rules can share one file.
    const ids = [...new Set(rules.map(r => r.targetResourceId).filter((v): v is string => !!v))];
    // Capped fan-out: this runs on every dashboard load, so 40 exposed files
    // must not mean 40 parallel Google calls.
    const CONCURRENCY = 5;
    const entries: (readonly [string, FileGrantState])[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = await Promise.all(ids.slice(i, i + CONCURRENCY).map(async id => {
        const result: FileGrantState = token
          ? await verifyFileGrant(kind, token, id)
          : { state: 'missing' };
        return [id, result] as const;
      }));
      entries.push(...batch);
    }

    // Best-effort write-back of live titles: Drive renames otherwise never
    // reach access_rules.resource_name, so server-rendered surfaces,
    // get_my_permissions, and approval-page copy keep the grant-time name
    // forever. The grants response is the source of truth for the browser
    // either way — a write-back failure must never fail the response.
    try {
      const changed: { id: string; title: string }[] = [];
      for (const [id, result] of entries) {
        if (result.state !== 'ok' || !result.title) continue;
        const title = result.title;
        if (rules.some(r => r.targetResourceId === id && r.resourceName !== title)) {
          changed.push({ id, title });
        }
      }
      if (changed.length > 0) {
        await Promise.all(changed.map(({ id, title }) =>
          db.update(accessRules)
            .set({ resourceName: title, updatedAt: new Date() })
            .where(and(
              eq(accessRules.userId, dbUser.id),
              eq(accessRules.service, n.d.service),
              eq(accessRules.targetResourceId, id),
            )),
        ));
      }
    } catch (err) {
      console.error(`Live-title write-back failed for ${n.d.service}:`, err);
    }

    return NextResponse.json({ grants: Object.fromEntries(entries) });
  } catch (error) {
    console.error(`Error verifying ${n.d.service} access:`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** GET grant-<kind>s-access — list this kind's rules for the current user. */
export async function grantFileAccessGET(kind: DriveFileKind) {
  const n = kindNames(kind);
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const dbUser = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1)
      .then(res => res[0]);

    if (!dbUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const rules = await db
      .select()
      .from(accessRules)
      .where(
        and(
          eq(accessRules.userId, dbUser.id),
          eq(accessRules.service, n.d.service)
        )
      );

    const ruleAssignments = await db.select().from(keyRuleAssignments);
    const rulesWithKeys = rules.map(rule => {
      const assignedKeyIds = ruleAssignments
        .filter(a => a.accessRuleId === rule.id)
        .map(a => a.proxyKeyId);
      return {
        ...rule,
        assignedKeyIds
      };
    });

    return NextResponse.json({ [n.rulesKey]: rulesWithKeys });
  } catch (error) {
    console.error(`Error fetching ${n.d.service} rules:`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** POST grant-<kind>s-access — create or update one of this kind's rules. */
export async function grantFileAccessPOST(kind: DriveFileKind, request: NextRequest) {
  const n = kindNames(kind);
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const dbUser = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1)
      .then(res => res[0]);

    if (!dbUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const body = await request.json();
    const { targetResourceId, resourceName, actionType, proxyKeyIds } = body;

    if (!targetResourceId) {
      return NextResponse.json({ error: `targetResourceId (${n.idKey}) is required` }, { status: 400 });
    }

    const validActionTypes = [n.d.actionTypes.read, n.d.actionTypes.readWrite, n.d.actionTypes.block];
    const chosenActionType = validActionTypes.includes(actionType) ? actionType : n.d.actionTypes.read;

    // Check if a rule for this file already exists for this user
    const existingRule = await db
      .select()
      .from(accessRules)
      .where(
        and(
          eq(accessRules.userId, dbUser.id),
          eq(accessRules.service, n.d.service),
          eq(accessRules.targetResourceId, targetResourceId)
        )
      )
      .limit(1)
      .then(res => res[0]);

    let ruleId: string;

    if (existingRule) {
      ruleId = existingRule.id;
      await db
        .update(accessRules)
        .set({
          ruleName: resourceName || existingRule.ruleName,
          resourceName: resourceName || existingRule.resourceName,
          actionType: chosenActionType,
          updatedAt: new Date()
        })
        .where(eq(accessRules.id, ruleId));
    } else {
      const [newRule] = await db
        .insert(accessRules)
        .values({
          userId: dbUser.id,
          ruleName: resourceName || `${n.fallbackNoun} ${targetResourceId.slice(0, 8)}...`,
          service: n.d.service,
          actionType: chosenActionType,
          targetResourceId,
          resourceName: resourceName || `${n.fallbackNoun} (${targetResourceId.slice(0, 8)})`
        })
        .returning();
      ruleId = newRule.id;
    }

    // Sync Key Rule Assignments if proxyKeyIds provided
    if (Array.isArray(proxyKeyIds)) {
      await db.delete(keyRuleAssignments).where(eq(keyRuleAssignments.accessRuleId, ruleId));

      if (proxyKeyIds.length > 0) {
        const userKeys = await db
          .select()
          .from(proxyKeys)
          .where(
            and(
              eq(proxyKeys.userId, dbUser.id),
              inArray(proxyKeys.id, proxyKeyIds)
            )
          );

        const validKeyIds = userKeys.map(k => k.id);
        if (validKeyIds.length > 0) {
          await db.insert(keyRuleAssignments).values(
            validKeyIds.map(keyId => ({
              proxyKeyId: keyId,
              accessRuleId: ruleId
            }))
          );
        }
      }
    }

    // via 'grant_api': this REST seam serves both the dashboard's Picker
    // manager (ExposedFilesManager) and any direct API caller — the only
    // reachable path for a hand-typed sheet/doc id, since the manual rule
    // modal is Gmail-only. file_id joins to $mcp_tool_call.file_id.
    captureServerEvent(clerkUserId, 'rule_saved', {
      mode: existingRule ? 'update' : 'create',
      service: n.d.service,
      action_type: chosenActionType,
      via: 'grant_api',
      file_id: targetResourceId,
      ...(Array.isArray(proxyKeyIds) ? { assigned_keys: proxyKeyIds.length } : {}),
    });

    // A rule created here may have no Picker pick behind it (hand-typed or
    // API-supplied id), so Google may hold no drive.file grant — the same
    // stranded-at-birth dead end the magic-link flow verifies against.
    // Record the grant state at birth so these rules are visible in the
    // funnel instead of silently broken. Telemetry only: a Google hiccup
    // must never fail rule creation.
    if (!existingRule) {
      try {
        const token = await getOwnerGoogleToken(clerkUserId);
        const grant: FileGrantState = token
          ? await verifyFileGrant(kind, token, targetResourceId)
          : { state: 'missing' };
        captureServerEvent(clerkUserId, n.verificationEvent, {
          result: grant.state, via: 'grant_api', [n.idProp]: targetResourceId,
        });
      } catch (err) {
        console.error(`Birth grant verification failed for ${n.d.service}:`, err);
      }
    }

    return NextResponse.json({ success: true, ruleId });
  } catch (error) {
    console.error(`Error saving ${n.d.service} rule:`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** DELETE grant-<kind>s-access?ruleId=… — delete one of this kind's rules. */
export async function grantFileAccessDELETE(kind: DriveFileKind, request: NextRequest) {
  const n = kindNames(kind);
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const dbUser = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1)
      .then(res => res[0]);

    if (!dbUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const ruleId = searchParams.get('ruleId');

    if (!ruleId) {
      return NextResponse.json({ error: 'ruleId parameter is required' }, { status: 400 });
    }

    await db
      .delete(accessRules)
      .where(
        and(
          eq(accessRules.id, ruleId),
          eq(accessRules.userId, dbUser.id)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(`Error deleting ${n.d.service} rule:`, error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
