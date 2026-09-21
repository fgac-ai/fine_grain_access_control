import { db } from '@/db';
import { accessRules, keyRuleAssignments } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { DRIVE_FILE_KINDS, kindForApprovalAction } from '@/lib/driveFileKinds';

/**
 * Is the grant a magic-link payload describes currently active for its key?
 *
 * Since single-use was retired (2026-08-25) this is the ONLY replay guard:
 * re-approving an already-active grant writes nothing and reports success,
 * so a double submit cannot duplicate a rule. Re-approving after the grant
 * was REVOKED deliberately re-grants -- the URL is permanent by design, and
 * doing so requires the owner's session plus an explicit click on a page
 * naming the grant, the same bar as re-adding the rule in the dashboard.
 *
 * Lives outside `dashboard/actions.ts` ("use server") so the pending-approvals
 * banner can call it without exposing it as a server action.
 */
export async function grantActiveForApproval(
  p: { action: string; userId: string; recipient?: string; spreadsheetId?: string; documentId?: string; presentationId?: string },
  keyId: string,
): Promise<boolean> {
  const assignedOrGlobal = async (ruleId: string): Promise<boolean> => {
    const asgn = await db.select().from(keyRuleAssignments)
      .where(eq(keyRuleAssignments.accessRuleId, ruleId));
    return asgn.length === 0 || asgn.some(a => a.proxyKeyId === keyId);
  };

  if ((p.action === 'send_whitelist' && p.recipient) || p.action === 'send_all') {
    const escaped = p.recipient?.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const wanted = p.action === 'send_all' ? ['*'] : [`^${escaped}$`, '*'];
    const rules = await db.select().from(accessRules).where(and(
      eq(accessRules.userId, p.userId),
      eq(accessRules.service, 'gmail'),
      eq(accessRules.actionType, 'send_whitelist'),
    ));
    for (const r of rules) {
      if (!r.regexPattern || !wanted.includes(r.regexPattern)) continue;
      if (await assignedOrGlobal(r.id)) return true;
    }
    return false;
  }

  // Per-file grants, any kind: the action name resolves the kind, the kind's
  // id key names the file, and its action types say which levels satisfy it.
  const fileKind = kindForApprovalAction(p.action);
  const fileId = fileKind ? p[DRIVE_FILE_KINDS[fileKind].idKey] : undefined;
  if (fileKind && fileId) {
    const d = DRIVE_FILE_KINDS[fileKind];
    const needed = p.action === d.approvalActions.write
      ? [d.actionTypes.readWrite]
      : [d.actionTypes.read, d.actionTypes.readWrite];
    const rules = await db.select().from(accessRules).where(and(
      eq(accessRules.userId, p.userId),
      eq(accessRules.service, d.service),
    ));
    for (const r of rules) {
      if (r.targetResourceId !== fileId || !needed.includes(r.actionType)) continue;
      if (await assignedOrGlobal(r.id)) return true;
    }
    return false;
  }

  return false;
}
